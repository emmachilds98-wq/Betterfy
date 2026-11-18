// Release Radar on the fake Spotify (docs/RELEASE-RADAR-PLAN.md phases 4-5):
// Start, a partial radar that says it is partial, the filters, and the owned
// marker, with every request going through the page's own sp().
import test from 'node:test';
import assert from 'node:assert/strict';
import { skip, launch, openApp, ready, until } from './harness.mjs';
import { makeAccount } from '../fixtures/accounts.mjs';

let browser;
test.before(async () => { if (!skip) browser = await launch(); });
test.after(async () => { await browser?.close(); });

/** The account check runs by itself on the first Discover visit (BUILD-7 R1): wait for its answer. */
const probed = page => until(() => page.evaluate(() => RADAR.check && !RADAR.probe?.running && RADAR.check), 'the account check', 20000);

const day = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

/** A small account, trimmed to a handful of artists so the sync is short, with releases to find. */
function radarAccount() {
  const acc = makeAccount('small');
  acc.playlists = acc.playlists.slice(0, 2).map(p => ({ ...p, tracks: p.tracks.slice(0, 3) }));
  acc.liked = acc.liked.slice(0, 3);
  const [x, y] = [acc.playlists[0].tracks[0].artists[0], acc.playlists[1].tracks[0].artists[0]];
  // A recent release the listener already owns: the owned marker.
  const own = acc.liked[0];
  own.album = { ...own.album, name: 'Owned Lately', release_date: day(12), album_type: 'single' };
  const tr = (id, artists, album) => ({ id, name: 'Song ' + id, duration_ms: 200000, artists, track_number: 1,
    external_ids: { isrc: 'RR' + id }, album });
  const al = (id, name, date, type, artists) => ({ id, name, release_date: date, album_type: type, artists, images: [] });
  const single = al('rr_single', 'Brand New Single', day(3), 'single', [x]);
  const lp = al('rr_album', 'Long Player', day(45), 'album', [y]);
  const guest = al('rr_guest', 'Host Track (Remix)', day(20), 'single', [{ id: 'rr_host', name: 'Host' }]);
  acc.releases = [
    { tracks: [tr('rrs1', [x], single)] },
    { tracks: [1, 2, 3, 4, 5].map(i => tr('rra' + i, [y], lp)) },
    { tracks: [tr('rrg1', [{ id: 'rr_host', name: 'Host' }, x], guest)] },
  ];
  return acc;
}

test('radar: Start, partial progress said out loud, filters, the owned marker', { skip }, async () => {
  const app = await openApp(browser, { account: radarAccount() });
  try {
    const { page, fake } = app;
    await ready(page);
    await page.evaluate(() => go('discover'));
    await page.click('[data-act="discSide"][data-side="radar"]');   // L3: Find new music leads
    await page.waitForSelector('#rrStart');
    assert.match(await page.locator('#radar').innerText(), /about \d+ minutes?/, 'an honest estimate before Start');
    assert.equal((await probed(page)).ok, true, 'the account check ran by itself and passed');

    fake.sw.latencyMs = 120;   // slow enough to see the radar part-read
    const from = fake.log.length;
    await page.click('#rrStart');
    const partial = await until(async () => {
      const t = await page.locator('#rrLine').innerText().catch(() => '');
      return /Reading \d+ of \d+ artists/.test(t) && t;
    }, 'the progress line', 20000);
    assert.doesNotMatch(partial, /last checked/, 'never called complete while reading');

    await page.waitForFunction(() => /artists · last checked/.test(document.querySelector('#rrLine')?.textContent ?? ''), null, { timeout: 90000 });
    fake.sw.latencyMs = 0;
    const calls = fake.log.slice(from).map(l => l.path);
    assert.ok(calls.some(c => /^\/artists\/[^/]+\/albums\?/.test(c)), 'it read artists');
    assert.ok(!calls.some(c => /^\/(albums|tracks)\?ids=/.test(c)), 'no removed batch endpoint');
    for (const c of calls.filter(c => /\/albums\?/.test(c))) {
      const u = new URL(c, 'https://x');
      assert.ok(+u.searchParams.get('limit') <= 10);
      assert.equal(u.searchParams.get('include_groups').split(',').length, 1);
      assert.equal(u.searchParams.get('market'), 'from_token');
    }

    const titles = () => page.locator('.rr-feed .rr-t').allInnerTexts();
    const all = await titles();
    assert.ok(all.some(t => t.startsWith('Brand New Single')), all.join(' | '));
    assert.ok(all.some(t => t.startsWith('Long Player')));
    assert.ok(!all.some(t => t.startsWith('Host Track')), 'a feature stays out of the main chronology');
    const owned = page.locator('.rr-row', { hasText: 'Owned Lately' });
    assert.equal(await owned.locator('.rr-own').innerText(), 'owned');
    assert.equal(await page.locator('.rr-row', { hasText: 'Brand New Single' }).locator('.rr-own').count(), 0, 'absence is silent');
    assert.ok(await page.locator('.rr-month').count() >= 2, 'month headers');

    await page.click('[data-act="rrFilter"][data-f="singles"]');
    const singles = await titles();
    assert.ok(singles.length && singles.every(t => /Single|EP/i.test(t)), singles.join(' | '));
    assert.ok(!singles.some(t => t.startsWith('Long Player')));

    await page.click('[data-act="rrFilter"][data-f="albums"]');
    assert.deepEqual((await titles()).map(t => t.split('\n')[0].replace(/(Single|EP)$/i, '')), ['Long Player']);

    await page.click('[data-act="rrFilter"][data-f="features"]');
    assert.ok((await titles()).some(t => t.startsWith('Host Track')));

    await page.click('[data-act="rrFilter"][data-f="unheard"]');
    assert.ok(!(await titles()).some(t => t.startsWith('Owned Lately')), 'Unheard leaves out what you own');

    await page.click('[data-act="rrFilter"][data-f="reissues"]');
    await page.waitForSelector('#radar .empty-state');
    await page.click('#radar [data-clear]');
    assert.ok((await titles()).length >= 3);

    // Dismiss hides a row for good.
    await page.click('.rr-row:has-text("Long Player") [data-act="rrDismiss"]');
    await until(async () => !(await titles()).some(t => t.startsWith('Long Player')), 'the row to go');
    assert.deepEqual(app.errors, []);
  } finally { await app.close(); }
});

test('radar: a quota stop mid-sync keeps what was read and says how far it got', { skip }, async () => {
  const app = await openApp(browser, { account: radarAccount() });
  try {
    const { page, fake } = app;
    await ready(page);
    await page.evaluate(() => go('discover'));
    await page.click('[data-act="discSide"][data-side="radar"]');   // L3: Find new music leads
    await page.waitForSelector('#rrStart');
    await probed(page);
    fake.sw.latencyMs = 80;
    const from = fake.log.length;
    await page.click('#rrStart');
    await until(async () => fake.log.slice(from).filter(l => /\/albums\?/.test(l.path)).length >= 4, 'a few artists read', 30000);
    fake.sw.quota = true;   // the app's quota is gone: sp() says so at once rather than holding
    await page.waitForFunction(() => /Stopped after/.test(document.querySelector('#rrLine')?.textContent ?? ''), null, { timeout: 90000 });
    fake.sw.quota = false; fake.sw.latencyMs = 0;
    const line = await page.locator('#rrLine').innerText();
    assert.match(line, /Start again picks up where it stopped/);
    assert.match(line, /quota/i, 'sp()\'s own words about the quota');
    assert.ok(await page.locator('.rr-row').count() > 0 || /Stopped after [1-9]/.test(line), 'what was read stays');
    assert.equal(await page.locator('#rrStart').innerText(), 'Start again');
    // Resume: finishes, and only what was not read is asked for again.
    const before = fake.log.length;
    await page.click('#rrStart');
    await page.waitForFunction(() => /artists · last checked/.test(document.querySelector('#rrLine')?.textContent ?? ''), null, { timeout: 90000 });
    assert.ok(fake.log.length > before);
  } finally { await app.close(); }
});

test('radar: the account check runs by itself once, is kept, and shows in Settings (BUILD-7 R1)', { skip }, async () => {
  const app = await openApp(browser, { account: radarAccount() });
  try {
    const { page, fake } = app;
    await ready(page);
    await page.evaluate(() => go('discover'));
    const kept = await probed(page);
    assert.equal(kept.ok, true);
    assert.ok(kept.account, 'kept for this account');
    const stored = await page.evaluate(() => idb.get('radar:probe'));
    assert.equal(stored.account, kept.account, 'kept in IndexedDB radar:probe');
    assert.equal(stored.build, await page.evaluate(() => BUILD));
    // Once per account per build: another visit asks Spotify nothing more for it.
    const n = fake.log.length;
    await page.evaluate(() => radarProbeAuto());
    assert.equal(fake.log.slice(n).filter(l => /limit=50/.test(l.path)).length, 0, 'not checked again');
    await page.click('[data-act="discSide"][data-side="radar"]');
    assert.equal(await page.locator('#radar').innerText().then(t => /isn’t sharing/.test(t)), false, 'a good answer stays out of the way');
    const row = await page.evaluate(() => helperRowsNow().find(r => r.id === 'radar'));
    assert.match(row.did, /Checked on this account[^:]*: Spotify answers everything it needs/);
    assert.deepEqual(app.errors, []);
  } finally { await app.close(); }
});

for (const [sw, why] of [['refuseArtistAlbums', 'a refused artist-albums route'], ['albumsNoDates', 'a reshaped answer']]) {
  test(`radar: ${why} shows one plain line and starts no sync (BUILD-7 R1)`, { skip }, async () => {
    const app = await openApp(browser, { account: radarAccount() });
    try {
      const { page, fake } = app;
      await ready(page);
      fake.sw[sw] = true;
      await page.evaluate(() => go('discover'));
      await page.click('[data-act="discSide"][data-side="radar"]');
      const kept = await probed(page);
      assert.equal(kept.ok, false);
      await page.waitForFunction(() => /isn’t sharing new releases with this account right now/.test(document.querySelector('#radar')?.textContent ?? ''), null, { timeout: 10000 });
      assert.equal(await page.locator('#rrStart').count(), 0, 'no Start while held');
      // The automatic start holds too.
      assert.equal(await page.evaluate(() => radarAuto({ delay: 0 })), false);
      assert.equal(await page.evaluate(() => RADAR.index), null, 'no sync ran');
      const row = await page.evaluate(() => helperRowsNow().find(r => r.id === 'radar'));
      assert.equal(row.kind, 'warn');
      assert.match(row.did, /Spotify refused list/);
      // Once Spotify answers again, Check again lets it run.
      fake.sw[sw] = false;
      await page.click('#radar [data-act="rrProbe"]');
      await until(() => page.evaluate(() => RADAR.check?.ok === true), 'a passing check', 20000);
      assert.equal(await page.evaluate(() => radarGo({ byHand: true })), true, 'the radar runs once the check passes');
    } finally { await app.close(); }
  });
}
