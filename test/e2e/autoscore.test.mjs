// Score + Tune by itself (docs/NEXT-WORKPLAN.md package 1) and whole-library
// listening on a computer (package 6), in a real browser on a fake account.
// The first check's one-minute wait is shortened for the test
// (BF_AUTOSCORE_MS); nothing is pressed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { skip, launch, openApp, ready, until } from './harness.mjs';

let browser, app;
test.before(async () => { if (!skip) browser = await launch(); });
test.after(async () => { await browser?.close(); });
test.afterEach(async () => { if (app) { await app.close(); app = null; } });

test('a Score + Tune run starts and finishes by itself, and the Engine screen says so', { skip, timeout: 240000 }, async () => {
  app = await openApp(browser, { kind: 'typical', phone: false });
  const { page, ctx } = app;
  await ready(page);
  // Similar artists would ask Deezer and ListenBrainz, which the test routes to nowhere.
  await ctx.addInitScript(() => { if (window !== window.top) return; globalThis.BF_AUTOSCORE_MS = 300; localStorage.setItem('bf_bridge_off', '1'); });
  await page.reload();
  await ready(page);
  assert.equal(await page.evaluate(() => audioSettings().scope), 'all', 'a computer hears the whole library by default');

  await until(() => page.evaluate(() => AUTOSCORE_RUN.running || !!localStorage.getItem('bf_autoscore')), 'the run to start by itself', 20000);
  const rec = await until(() => page.evaluate(() => JSON.parse(localStorage.getItem('bf_autoscore') || 'null')), 'the run to finish', 200000);
  assert.equal(rec.why, 'first');
  assert.equal(rec.ok, true);
  assert.ok(await page.evaluate(() => !!ENG.val && !ENG.val.error && !!TUNE.res), 'Score and Tune both ran');
  // Nothing due straight after a run.
  assert.equal(await page.evaluate(() => autoScoreDue()), null);

  await page.evaluate(() => go('engine'));
  await page.waitForSelector('#autoScore');
  assert.match(await page.locator('#autoScore').innerText(), /^Last scored (just now|\d+ min ago), on its first check\./);
  assert.ok(await page.locator('[data-act="copy"]').count(), 'the results are there to copy');
  assert.deepEqual(app.errors, []);
});

test('a phone keeps the narrow listening scope by default', { skip }, async () => {
  app = await openApp(browser, { kind: 'small' });
  await ready(app.page);
  assert.equal(await app.page.evaluate(() => audioSettings().scope), 'playing+unfiled');
});
