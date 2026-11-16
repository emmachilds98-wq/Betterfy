// Fill this playlist (BUILD-6 F2) in a real browser: the Library sheet ranks the
// liked-but-unfiled tracks, Add writes to the fake Spotify as one History entry and
// Undo takes it back, and "Add all shown" is one write and one entry for the lot.
// The account's measure is handed to the page (a Score run would write the same
// `bf_fill`), so the spec drives the section as it shows once it has passed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { skip, launch, openApp, ready, fileCard, until } from './harness.mjs';

let browser, app;
test.before(async () => { if (!skip) browser = await launch(); });
test.after(async () => { await browser?.close(); });
test.afterEach(async () => { if (app) { await app.close(); app = null; } });

const fillLog = page => page.evaluate(async () => (await getLog()).filter(e => e.reason === 'fill this playlist' && !e.undoneAt).length);

test('Fill this playlist: Add, Undo, and Add all as one History entry', { skip }, async () => {
  app = await openApp(browser, { kind: 'typical' });
  const { page, fake } = app;
  await ready(page);
  await fileCard(page);
  const pl = await page.evaluate(() => {
    localStorage.setItem('bf_fill', JSON.stringify({ recall: 0.6, random: 0.03, playlists: 14 }));
    return LIB.playlists.find(p => p.tracks.length >= 10).id;
  });
  await page.click('.nav[data-v="lists"]');
  await page.locator(`[data-act="plopen"][data-pl="${pl}"]`).click();
  await page.waitForSelector('#plSheet.open');
  await page.waitForSelector('#plSheet [data-act="filladd"]', { timeout: 30000 });

  const before = fake.playlist(pl).length;
  const first = await page.locator('#plSheet [data-act="filladd"]').first().getAttribute('data-tid');
  await page.locator('#plSheet [data-act="filladd"]').first().click();
  await until(() => fake.playlist(pl).includes(first), 'the track to be added');
  await until(async () => /^Added “/.test(await page.locator('#toast').innerText()), 'the toast');
  assert.equal(await fillLog(page), 1, 'one History entry');
  assert.ok(await page.evaluate(id => !R.backlog.some(b => b.id === id), first), 'off the File queue');

  await page.click('#undoBtn');
  await until(() => !fake.playlist(pl).includes(first), 'Undo to take it out again');
  assert.equal(fake.playlist(pl).length, before);

  await page.waitForSelector('#plSheet [data-act="fillall"]', { timeout: 30000 });
  const shown = await page.locator('#plSheet [data-act="filladd"]').evaluateAll(els => els.map(e => e.dataset.tid));
  assert.ok(shown.length > 1);
  await page.click('#plSheet [data-act="fillall"]');
  await until(() => shown.every(id => fake.playlist(pl).includes(id)), 'every shown track to be added');
  // The fake sees the tracks as soon as Spotify would, a moment before the page
  // logs the write; the toast comes after the log, so count once it shows.
  await until(async () => new RegExp(`Added ${shown.length} tracks`).test(await page.locator('#toast').innerText()), 'the toast');
  assert.equal(await fillLog(page), 1, 'Add all is one History entry');
  await page.click('#undoBtn');
  await until(() => shown.every(id => !fake.playlist(pl).includes(id)), 'one Undo to take them all out');
  assert.equal(fake.playlist(pl).length, before);
  assert.deepEqual(app.errors, []);
});
