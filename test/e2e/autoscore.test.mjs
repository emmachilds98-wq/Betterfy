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
  // The weakest playlists, read off the engine that places, kept for Library and listening.
  const weak = await page.evaluate(() => JSON.parse(localStorage.getItem('bf_weak') || 'null'));
  assert.ok(weak && Array.isArray(weak.rows), 'the weak-playlist diagnosis is kept');
  assert.ok(await page.evaluate(() => Array.isArray(ENG.val.weak)), 'and is on the Score result');

  await page.evaluate(() => go('engine'));
  await page.waitForSelector('#autoScore');
  assert.match(await page.locator('#autoScore').innerText(), /^Last scored (just now|\d+ min ago), on its first check\./);
  assert.ok(await page.locator('[data-act="copy"]').count(), 'the results are there to copy');
  assert.match(await page.locator('.card').filter({ hasText: 'Playlists it understands least' }).first().innerText(),
               /by the engine that files|None: every genre playlist/);
  // Past runs (BUILD-7 M1): the run is kept with its full report, and still there after a reload.
  const hist = await until(() => page.evaluate(() => {
    const l = JSON.parse(localStorage.getItem('bf_run_history') || '[]').filter(r => r.kind === 'score');
    return l.length && l[0].tuned ? l : null; }), 'the run to be kept with its Tune block', 20000);
  assert.equal(hist[0].why, 'first');
  assert.match(hist[0].text, /This engine: top-1 \d+%/);
  assert.match(hist[0].text, /Tune|tune/i);
  await page.reload();
  await ready(page);
  await page.evaluate(() => go('engine'));
  await page.waitForSelector('#pastRuns [data-act="histCopy"]', { timeout: 60000 });
  assert.match(await page.locator('#pastRuns').innerText(), /Score · .*\n.*top-1 \d+%/);
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.locator('#pastRuns [data-act="histCopy"]').first().click();
  const copied = await until(() => page.evaluate(() => navigator.clipboard.readText().catch(() => '')), 'the copy', 5000);
  assert.equal(copied, hist[0].text);
  assert.deepEqual(app.errors, []);
});

test('a phone keeps the narrow listening scope by default', { skip }, async () => {
  app = await openApp(browser, { kind: 'small' });
  await ready(app.page);
  assert.equal(await app.page.evaluate(() => audioSettings().scope), 'playing+unfiled');
});

test('a run from before Past runs existed shows as one rebuilt entry, ready to copy', { skip, timeout: 120000 }, async () => {
  app = await openApp(browser, { kind: 'typical', phone: false });
  const { page, ctx } = app;
  await ready(page);
  await ctx.addInitScript(() => {
    if (window !== window.top || localStorage.getItem('bf_run_history')) return;
    localStorage.setItem('bf_engscore', JSON.stringify({ top1: 0.61, top3: 0.8, scored: 600, at: Date.now() - 864e5 }));
    localStorage.setItem('bf_autoscore', JSON.stringify({ at: Date.now() - 864e5, heard: 420, why: 'listened', ok: true }));
  });
  await page.reload();
  await ready(page);
  await until(() => page.evaluate(() => localStorage.getItem('bf_run_history')), 'the rebuilt entry to be kept', 20000);
  await page.evaluate(() => go('engine'));
  await page.waitForSelector('#pastRuns');
  assert.match(await page.locator('#pastRuns').innerText(), /top-1 61% · top-3 80% · headline only/);
  const text = await page.evaluate(() => runHistoryView()[0].text);
  assert.match(text, /rebuilt from what this device kept/);
  assert.match(text, /listening had heard 420 tracks then/);
  // The end of a listening run is written down once, from the controller's own view model.
  await page.evaluate(() => { runHistoryWatch('listen', { state: 'running', done: 0, total: 3 });
                              runHistoryWatch('listen', { state: 'done', done: 3, total: 3, heard: 3, missed: {} });
                              runHistoryWatch('listen', { state: 'done', done: 3, total: 3, heard: 3, missed: {} }); });
  const listens = await page.evaluate(() => runHistoryView().filter(r => r.kind === 'listen'));
  assert.equal(listens.length, 1);
  assert.match(listens[0].text, /This run: 3 of 3 tracks/);
  assert.deepEqual(app.errors, []);
});
