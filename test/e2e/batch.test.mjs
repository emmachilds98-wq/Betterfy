// "File the N sure ones" and its one undo. A synthetic account has no Score run
// behind it, so there is no calibrated "sure" verdict to find; the spec hands the
// page the Engine's verdict (the one function File asks) for the first cards and
// drives the real button, the real writes and the real undo from there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { skip, launch, openApp, ready, fileCard, until } from './harness.mjs';

let browser, app;
test.before(async () => { if (!skip) browser = await launch(); });
test.after(async () => { await browser?.close(); });
test.afterEach(async () => { if (app) { await app.close(); app = null; } });

test('File the sure ones files them in one go and one Undo takes them back', { skip }, async () => {
  app = await openApp(browser, { kind: 'typical' });
  const { page, fake } = app;
  await ready(page);
  await fileCard(page);
  // Three cards that have a leading pick are judged "confident" (a calibrated HIGH).
  const sure = await page.evaluate(() => {
    const ids = R.backlog.filter(r => filePicks(r)[0]).slice(0, 3).map(r => r.id);
    const verdicts = new Map(ids.map(id => [id, { kind: 'confident', playlists: [] }]));
    window.engineDecisionOf = id => verdicts.get(id) ?? null;
    render();
    return ids.map(id => ({ id, pl: filePicks(R.backlog.find(r => r.id === id))[0].id }));
  });
  assert.equal(sure.length, 3);
  // A confident verdict alone is not Sure: the pick must be backed by sound or
  // filing history (USER-REVIEW item 2). Count the tags-only ones out.
  const unbacked = await page.evaluate(ids => ids.filter(id => !pickBacked(filePicks(R.backlog.find(r => r.id === id))[0])).length,
    sure.map(s => s.id));
  if (unbacked === 3) assert.equal(await page.locator('[data-act="filesure"]').count(), 0, 'tags-only picks are never Sure');
  // The synthetic account has no sound, so stand in for the backing here and test the batch itself.
  await page.evaluate(() => { window.backedBand = b => b ?? null; render(); });
  const before = Object.fromEntries(sure.map(s => [s.pl, fake.playlist(s.pl).length]));
  await page.waitForSelector('[data-act="filesure"]');
  assert.match(await page.locator('[data-act="filesure"]').innerText(), /File the 3 sure ones/);
  const queue = await page.evaluate(() => R.backlog.length);
  await page.click('[data-act="filesure"]');
  await until(() => sure.every(s => fake.playlist(s.pl).includes(s.id)), 'all three to be filed');
  await until(async () => (await page.evaluate(() => R.backlog.length)) === queue - 3, 'the queue to shrink by 3');
  await until(async () => /Filed 3 sure/.test(await page.locator('#toast').innerText()), 'the toast');

  await page.click('#undoBtn');
  await until(() => sure.every(s => !fake.playlist(s.pl).includes(s.id)), 'the undo to remove them again');
  for (const [pl, n] of Object.entries(before)) assert.equal(fake.playlist(pl).length, n, 'playlist back to its size');
  assert.equal(app.errors.length, 0);
});
