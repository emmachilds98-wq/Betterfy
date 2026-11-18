// D6: liked songs are read incrementally. A no-change read costs one page of
// /me/tracks instead of a hundred; new likes are merged in from the head; an
// unlike is caught by the count check or, failing that, the weekly full read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { skip, launch, openApp, whole } from './harness.mjs';

let browser;
test.before(async () => { if (!skip) browser = await launch(); });
test.after(async () => { await browser?.close(); });

const sync = page => page.evaluate(async () => {
  const lib = await syncLibrary(false);   // playlists skipped by snapshot id, liked read from the head
  return { n: lib.liked.length, ids: lib.liked.map(t => t.id) };
});
const gets = (fake, from) => fake.log.slice(from).filter(l => l.method === 'GET' && !l.path.startsWith('/me/top/'));   // the listening fetch is not the sync
const likedGets = (fake, from) => gets(fake, from).filter(l => l.path.startsWith('/me/tracks'));
const call = (page, method, id) => page.evaluate(([m, i]) =>
  fetch('https://api.spotify.com/v1/me/tracks?ids=' + i, { method: m, headers: { authorization: 'Bearer x' } }), [method, id]);

test('liked sync: head-only when nothing changed, merges new likes, reconciles unlikes', { skip }, async () => {
  const app = await openApp(browser, { kind: 'large' });
  try {
    const { page, fake } = app;
    await whole(page);
    const full = fake.liked().length;
    assert.ok(full >= 5000);
    const outside = () => fake.account.playlists.flatMap(p => p.tracks).map(t => t.id).filter(id => !fake.liked().includes(id));

    let at = fake.log.length;
    assert.equal((await sync(page)).n, full);
    console.log(`no-change sync: ${gets(fake, at).length} requests (${likedGets(fake, at).length} liked)`);
    assert.ok(gets(fake, at).length < 5, `no-change sync took ${gets(fake, at).length} requests`);

    // A new like arrives at the head and is merged without a full read.
    const extra = outside()[0];
    await call(page, 'PUT', extra);
    at = fake.log.length;
    const added = await sync(page);
    assert.equal(added.n, full + 1);
    assert.equal(added.ids[0], extra);
    assert.ok(likedGets(fake, at).length <= 2, 'a new like costs one liked page');

    // An unlike changes the count, so the head read hands over to a full read.
    const gone = fake.liked()[40];
    await call(page, 'DELETE', gone);
    at = fake.log.length;
    const un = await sync(page);
    assert.ok(!un.ids.includes(gone), 'unlike caught by the count check');
    assert.ok(likedGets(fake, at).length > 50, 'that one was a full read');

    // Swap one like for another: the new like at the head makes the count disagree
    // with what the head read expects, so this is caught without waiting a week.
    const swapOut = fake.liked()[60], swapIn = outside()[0];
    await call(page, 'DELETE', swapOut);
    await call(page, 'PUT', swapIn);
    at = fake.log.length;
    const swapped = await sync(page);
    assert.ok(swapped.ids.includes(swapIn) && !swapped.ids.includes(swapOut), 'a swap is reconciled');

    // And once a week the whole list is re-read regardless, as a backstop.
    await page.evaluate(async () => { const l = await idb.get('library'); l.liked_full_at = Date.now() - 8 * 864e5; await idb.set('library', l); });
    at = fake.log.length;
    await sync(page);
    assert.ok(likedGets(fake, at).length > 50, 'a week-old list is read in full');
    at = fake.log.length;
    await sync(page);
    assert.ok(likedGets(fake, at).length <= 1, 'and the next read is back to the head');
    assert.deepEqual(app.errors, []);
  } finally { await app.close(); }
});
