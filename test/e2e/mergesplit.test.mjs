// The merge/split wizard (BUILD-6 F4) in a real browser against the fake Spotify.
// The bar (BUILD-6-PLAN §4.1 F4): a merge and a split each run, and one undo each
// leaves every playlist byte-for-byte as it was, with no extra playlists.
//
// The twins are handed to the page (the engine's bucketPairs writes the same
// `ENG.pairs` once it has run), and so is the split when the account's tags do not
// propose one (gapsCompute writes the same `GAPS.splits`), so the spec drives the
// wizard as it shows once those offers exist.
import test from 'node:test';
import assert from 'node:assert/strict';
import { skip, launch, openApp, ready, fileCard, until } from './harness.mjs';

let browser, app;
test.before(async () => { if (!skip) browser = await launch(); });
test.after(async () => { await browser?.close(); });
test.afterEach(async () => { if (app) { await app.close(); app = null; } });

const state = fake => JSON.stringify(fake.playlists());
const created = fake => fake.playlists().filter(p => /^plnew/.test(p.id));

test('merge twins and split a playlist, then one undo each restores every playlist exactly', { skip }, async () => {
  app = await openApp(browser, { kind: 'typical' });
  const { page, fake } = app;
  await ready(page);
  await fileCard(page);
  const before = state(fake);
  const [a, b] = await page.evaluate(() => {
    const [a, b] = LIB.playlists.filter(p => p.tracks.length >= 10);
    ENG.pairs = [{ verdict: 'indistinguishable', a: { id: a.id, name: a.name, n: a.tracks.length },
      b: { id: b.id, name: b.name, n: b.tracks.length }, similarity: 0.99, overlap: 0 }];
    return [a, b].map(p => ({ id: p.id, name: p.name }));
  });

  // --- merge: from Library's twins section ---
  await page.click('.nav[data-v="lists"]');
  await page.waitForSelector('text=Playlists that sound the same');
  await page.click(`[data-act="wizmerge"][data-a="${a.id}"]`);
  await page.waitForSelector('#plSheet.open [data-act="wizgo"]');
  assert.match(await page.locator('#plSheet h2').innerText(), /Merge two playlists/);
  await page.click('#plSheet [data-act="wizgo"]');
  await until(() => created(fake).length === 1, 'the merged playlist');
  await page.waitForSelector('#plSheet [data-act="wizundo"]');
  const merged = created(fake)[0];
  const expect = [...new Set([...fake.account.playlists.find(p => p.id === a.id).tracks, ...fake.account.playlists.find(p => p.id === b.id).tracks].map(t => t.id))];
  assert.deepEqual(merged.tracks.map(t => t.id), expect, 'everything in both, each once, in order');
  assert.equal(merged.public, false, 'private');
  assert.equal(JSON.stringify(fake.playlists().filter(p => !/^plnew/.test(p.id))), before, 'the originals are untouched');
  assert.ok(!fake.writes().some(w => w.path.includes(a.id) || w.path.includes(b.id)), 'nothing was written to either twin');

  // --- split: a "two genres" offer on a playlist's sheet ---
  await page.click('#plSheet [data-act="wizback"]');
  await page.keyboard.press('Escape');
  const sp = await page.evaluate(() => {
    const p = LIB.playlists.filter(x => x.tracks.length >= 10)[2];
    if (GAPS.status !== 'ready' || !(GAPS.splits ?? []).some(x => x.playlistId === p.id)) {
      const ids = p.tracks.map(t => t.id);
      GAPS.status = 'ready'; GAPS.for = R;
      GAPS.splits = [{ playlistId: p.id, name: p.name, total: ids.length, nested: false, named: null, parts: [
        { concept: 'x', label: 'First half', rest: false, size: 5, share: 0.5, ids: ids.slice(0, 5) },
        { concept: 'y', label: 'Second half', rest: false, size: ids.length - 5, share: 0.5, ids: ids.slice(5) }] }];
    }
    return { id: p.id, n: p.tracks.length };
  });
  await page.locator(`[data-act="plopen"][data-pl="${sp.id}"]`).click();
  await page.click(`#plSheet [data-act="wizsplit"][data-pl="${sp.id}"]`);
  await page.waitForSelector('#plSheet [data-act="wizmove"]');
  const moved = await page.locator('#plSheet [data-act="wizmove"]').first().getAttribute('data-tid');
  await page.locator('#plSheet [data-act="wizmove"]').first().click();
  await page.fill('#plSheet #wiznm1', 'Split part two');
  await page.click('#plSheet [data-act="wizgo"]');
  await until(() => created(fake).length === 3, 'both parts of the split');
  await until(async () => /^Made 2 playlists/.test(await page.locator('#toast').innerText()), 'the toast');
  const parts = created(fake).slice(1);
  assert.deepEqual(parts.map(p => p.name).slice(1), ['Split part two'], 'a renamed part keeps its name');
  assert.ok(parts[1].tracks.some(t => t.id === moved), 'the moved track went with its new part');
  assert.equal(parts[0].tracks.length + parts[1].tracks.length, sp.n, 'every track in one part or the other');

  const groups = await page.evaluate(async () => (await getLog()).filter(e => e.created && /^(merged|split) from/.test(e.reason))
    .map(e => [e.group, e.reason.split(' ')[0]]));
  assert.equal(groups.length, 3);
  assert.equal(new Set(groups.filter(g => g[1] === 'split').map(g => g[0])).size, 1, 'the split is one History group');

  // --- one undo for the split (its toast), one for the merge (History) ---
  await page.click('#undoBtn');
  await until(() => created(fake).length === 1, 'one Undo to delete both split parts');
  await page.keyboard.press('Escape');
  await page.click('#btnSettings');
  await page.waitForSelector('#settingsPanel.open');
  await page.click('[data-uhtoggle="history"]');
  await page.locator('[data-uh="history"] [data-act="undo"]').first().click();
  await until(() => created(fake).length === 0, 'History’s Undo to delete the merged playlist');

  assert.equal(state(fake), before, 'every playlist byte-for-byte as before, and none left over');
  assert.deepEqual(app.errors, []);
});
