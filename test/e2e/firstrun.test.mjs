// A new account's first analysis starts by itself (2026-11-17, owner's ask):
// File opens on the progress strip, never on the "Analyse my library" button,
// stays usable while it runs, and the Engine's map is learned in the worker
// without "Learn my library" being pressed. Nothing is written to Spotify.
import test from 'node:test';
import assert from 'node:assert/strict';
import { skip, launch, openApp, ready, fileCard, until } from './harness.mjs';

let browser, app;
test.before(async () => { if (!skip) browser = await launch(); });
test.after(async () => { await browser?.close(); });
test.afterEach(async () => { if (app) { await app.close(); app = null; } });

test('first load: the analysis and the Engine map start by themselves, File stays usable', { skip, timeout: 240000 }, async () => {
  app = await openApp(browser, { kind: 'typical', phone: false });
  const { page } = app;
  await ready(page);
  assert.equal(await page.locator('#analyseGo').count(), 0, 'no button to press on a first load');
  await until(() => page.evaluate(() => !!localStorage.getItem('bf_analysed')), 'the first analysis to start by itself', 20000);
  await fileCard(page, 120000);
  assert.ok(await page.locator('#swipeCard').isVisible(), 'File is usable while it runs');
  await until(() => page.evaluate(() => ENG.status === 'ready'), 'the Engine map to be learned by itself', 200000);
  assert.equal(await page.evaluate(() => ENG.where), 'worker', 'learned off the page');
  await page.evaluate(() => go('engine'));
  await page.waitForTimeout(300);
  assert.doesNotMatch(await page.locator('#app').innerText(), /Learn my library/);
  assert.equal(app.fake.writes().length, 0, 'nothing written to Spotify');
  assert.deepEqual(app.errors, []);
});

test('a reload learns the map again from the cache, and offers no button', { skip, timeout: 240000 }, async () => {
  app = await openApp(browser, { kind: 'typical', phone: false });
  const { page } = app;
  await ready(page);
  await until(() => page.evaluate(() => ENG.status === 'ready'), 'the first map', 200000);
  await page.reload();
  await ready(page);
  await until(() => page.evaluate(() => ENG.status === 'ready'), 'the map again after a reload', 60000);
  assert.equal(await page.evaluate(() => ENG.from), 'cache');
  assert.equal(await page.locator('#analyseGo').count(), 0);
  assert.deepEqual(app.errors, []);
});
