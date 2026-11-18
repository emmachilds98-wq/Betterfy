// Discover must not offer a song again once it was added from there (the owner's bug, 2026-11-18),
// and a nearly empty deck is refilled by itself. Fake Spotify; the picks are catalogue tracks the
// account does not own, put on the deck directly (the finding step needs Last.fm, which is not here).
import test from 'node:test';
import assert from 'node:assert/strict';
import { skip, launch, openApp, whole, until } from './harness.mjs';
import { makeAccount } from '../fixtures/accounts.mjs';

let browser;
test.before(async () => { if (!skip) browser = await launch(); });
test.after(async () => { await browser?.close(); });

function account() {
  const acc = makeAccount('small');
  const art = acc.playlists[0].tracks[0].artists[0];
  acc.catalog = [1, 2, 3, 4, 5].map(i => ({ id: 'dp' + i, name: 'Pick ' + i, duration_ms: 200000, artists: [{ id: 'dpa' + i, name: 'Newcomer ' + i }],
    track_number: 1, external_ids: { isrc: 'DP' + i }, album: { id: 'dpal' + i, name: 'Al ' + i, release_date: '2024-01-01', album_type: 'single', artists: [art], images: [] } }));
  return acc;
}
const deck = ids => ids.map(i => ({ id: 'dp' + i, artist: 'Newcomer ' + i, track: 'Pick ' + i, artists: [{ id: 'dpa' + i, name: 'Newcomer ' + i }], suggest: [] }));

test('a pick added to a playlist does not come back after a reload', { skip, timeout: 180000 }, async () => {
  const app = await openApp(browser, { account: account(), phone: false });
  try {
    const { page } = app;
    await whole(page);
    const pl = await page.evaluate(() => LIB.playlists.find(p => !isMirrorPlaylist(p)).id);
    await page.evaluate(d => { S.discover = d; S.discAt = 0; S.discoverFrom = 'test'; discSave(); go('discover'); }, deck([1, 2, 3, 4, 5]));
    await page.waitForSelector('#discAnyPl');
    await page.selectOption('#discAnyPl', pl);
    await until(() => page.evaluate(() => S.discover.length === 4), 'the pick to leave the deck');
    const saved = await until(() => page.evaluate(async () => { const s = await idb.get('disc:picks'); return s?.picks?.length === 4 && s.picks.map(p => p.id); }), 'the shortened deck to be saved');
    assert.ok(!saved.includes('dp1'), 'the saved picks no longer hold the added song');

    await page.reload();
    await whole(page);
    await page.evaluate(() => discRestore());
    await until(() => page.evaluate(() => (S.discover ?? []).length > 0), 'the deck to come back');
    assert.ok(!(await page.evaluate(() => S.discover.map(p => p.id))).includes('dp1'), 'the added song is not offered again');

    // Even if the saved picks still held it (an older build), History keeps it off: put it back and restore.
    await page.evaluate(async d => { S.discover = []; DISC_RESTORED = null; await idb.set('disc:picks', { at: Date.now(), picks: d }); await discRestore(); }, deck([1, 2]));
    assert.deepEqual(await page.evaluate(() => S.discover.map(p => p.id)), ['dp2'], 'the log keeps a repeat out');
  } finally { await app.close(); }
});

test('a nearly empty deck is topped up behind the card you are on', { skip, timeout: 180000 }, async () => {
  const app = await openApp(browser, { account: account(), phone: false });
  try {
    const { page } = app;
    await whole(page);
    await page.evaluate(d => { S.discover = d; S.discAt = 1; }, deck([1, 2]));
    // Stand in for the finding step: one new pick, and one already on screen.
    await page.evaluate(() => { runDiscovery = async (_s, o) => { window.__ran = o;
      const add = [{ id: 'dp1', artist: 'Newcomer 1', track: 'Pick 1' }, { id: 'dp3', artist: 'Newcomer 3', track: 'Pick 3', artists: [{ name: 'Newcomer 3' }] }];
      S.discover = [...S.discover, ...discStillNew(add.filter(a => !S.discover.some(x => x.id === a.id)))]; return true; }; });
    assert.equal(await page.evaluate(() => discTopUp({ now: Date.now() + 1e9 })), true);
    assert.deepEqual(await page.evaluate(() => window.__ran), { quiet: true, append: true });
    assert.deepEqual(await page.evaluate(() => S.discover.map(p => p.id)), ['dp1', 'dp2', 'dp3']);
    assert.equal(await page.evaluate(() => S.discAt), 1, 'the card on screen did not move');
  } finally { await app.close(); }
});
