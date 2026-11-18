// BUILD-7 P1: on a large account (5,000 liked, 60 playlists) the first File card
// used to wait for the whole library read, ~168 Spotify calls paced at 250 ms
// (web/app/auth.js MIN_GAP): ~42 s with the page hidden (Q1's number). Now the
// playlists are read whole, File draws from the first liked page, and the rest
// is read behind it; the counts come right when it ends.
import test from 'node:test';
import assert from 'node:assert/strict';
import { skip, launch, openApp, whole } from './harness.mjs';

/** The before number was ~42 s on a CI-like box; the playlists alone are ~63 paced calls (~16 s). */
const FIRST_CARD_BUDGET_MS = 25000;

let browser;
test.before(async () => { if (!skip) browser = await launch(); });
test.after(async () => { await browser?.close(); });

test('large library: first card early, the rest read behind it, counts right at the end', { skip, timeout: 240000 }, async () => {
  const app = await openApp(browser, { kind: 'large' });
  try {
    const { page, fake } = app;
    await page.waitForSelector('#swipeCard[data-best]', { timeout: 60000 });
    const at = await page.evaluate(() => performance.now());
    const early = await page.evaluate(() => ({
      partial: !!LIB.partial, liked: LIB.liked.length, playlists: LIB.playlists.length,
      tracks: LIB.playlists.reduce((n, p) => n + p.tracks.length, 0),
      reading: document.querySelector('#fileStatus .st-reading')?.textContent ?? '',
      short: document.querySelectorAll('#fileStatus .st-short').length,
      track: R.backlog[S.inboxAt].id,
    }));
    console.log(`first card at ${Math.round(at)} ms, ${early.liked} liked in hand, "${early.reading}"`);
    assert.ok(at < FIRST_CARD_BUDGET_MS, `first card at ${Math.round(at)} ms`);
    assert.ok(early.partial && early.liked < 1000, 'drawn from part of the liked songs');
    assert.equal(early.playlists, fake.account.playlists.length, 'every playlist is in');
    assert.equal(early.tracks, fake.account.playlists.reduce((n, p) => n + p.tracks.length, 0), 'and all their tracks');
    assert.match(early.reading, /^reading liked songs [\d,]+\/5,025$/);
    assert.equal(early.short, 0, 'no "sync again to read the rest" while it is still reading');
    assert.ok(!fake.writes().length, 'nothing written to Spotify');

    await whole(page, 150000);
    const done = await page.evaluate(async () => ({
      liked: LIB.liked.length, backlog: R.backlog.length, likedIn: R.likedIn?.liked,
      reading: document.querySelectorAll('#fileStatus .st-reading').length,
      file: document.querySelector('#fileStatus .st-file')?.textContent ?? '',
      track: R.backlog[S.inboxAt]?.id, hidden: document.querySelector('#app').hidden,
      cached: (await idb.get('library'))?.liked?.length, cachedPartial: !!(await idb.get('library'))?.partial,
    }));
    const liked = new Set(fake.liked()).size;
    assert.equal(done.liked, liked, 'every liked song read');
    assert.equal(done.backlog, liked, 'every liked song waits in File');
    assert.equal(done.reading, 0, 'the read says nothing once it is done');
    assert.match(done.file, /^5,025 to file$/, 'the whole count, no "so far"');
    assert.equal(done.track, early.track, 'the same card stays on screen');
    assert.ok(!done.hidden, 'the page never went back to the landing screen');
    assert.equal(done.cached, liked, 'the whole library is the cache');
    assert.ok(!done.cachedPartial);
    assert.ok(!fake.writes().length, 'still nothing written');
    assert.deepEqual(app.errors, []);
  } finally { await app.close(); }
});

test('a partial library left in the cache is read again, not trusted', { skip, timeout: 120000 }, async () => {
  const app = await openApp(browser, { kind: 'small' });
  try {
    const { page, fake } = app;
    await whole(page);
    const n = await page.evaluate(() => LIB.liked.length);
    await page.evaluate(async () => {
      const lib = await idb.get('library');
      await idb.set('library', { ...lib, liked: lib.liked.slice(0, 3), partial: true });
    });
    const before = fake.log.filter(l => l.path.startsWith('/me/tracks')).length;
    await page.reload();
    await whole(page);
    assert.equal(await page.evaluate(() => LIB.liked.length), n, 'the whole list again');
    assert.ok(fake.log.filter(l => l.path.startsWith('/me/tracks')).length > before, 'liked songs were asked for again');
    assert.deepEqual(app.errors, []);
  } finally { await app.close(); }
});
