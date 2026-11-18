// F5 "since you last opened" (docs/archive/BUILD-6-PLAN.md): a first visit shows no
// digest; file a card, open the app again, and File leads with what was filed;
// Details opens it up and the ✕ puts it away, both counted in this browser only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { skip, launch, openApp, ready, swipe, fileCard, until } from './harness.mjs';

let browser, app;
test.before(async () => { if (!skip) browser = await launch(); });
test.after(async () => { await browser?.close(); });
test.afterEach(async () => {
  if (app) { assert.deepEqual(app.errors, [], 'no uncaught page errors'); await app.close(); app = null; }
});

test('the digest shows what was filed since the last open, opens up, and dismisses', { skip }, async () => {
  app = await openApp(browser, { kind: 'typical' });
  const { page } = app;
  await ready(page);
  const c = await fileCard(page);
  assert.equal(await page.$('#digestCard'), null, 'nothing to look back on yet');
  const writesBefore = app.fake.writes().length;
  await swipe(page, '#swipeCard', 220);
  await until(() => app.fake.writes().length > writesBefore, 'the filing to reach Spotify');
  await until(() => page.evaluate(() => getLog().then(l => l.some(e => e.reason === 'filed from inbox'))), 'the filing in History');
  assert.ok(await page.evaluate(() => !!localStorage.getItem('bf_digest_seen')), 'this open was kept as the next baseline');

  // Open the app again: the filing happened since the last open.
  const before = app.fake.log.length;
  await page.reload();
  await ready(page);
  await page.waitForSelector('#digestCard', { timeout: 30000 });
  const head = await page.textContent('#digestHead');
  assert.match(head, /Since you last opened/);
  assert.match(await page.textContent('#digestCard .dg-sum'), /\b1 filed\b/);
  // The figure is History's: the same count, read back from the log.
  const filed = await page.evaluate(() => getLog().then(l => new Set(l.filter(e => e.reason === 'filed from inbox' && !e.undoneAt).flatMap(e => e.trackIds)).size));
  assert.equal(filed, 1);
  assert.ok(c.track);

  await page.click('#digestCard [data-act="digestMore"]');
  await page.waitForSelector('#digestCard .dg-lines');
  assert.match(await page.textContent('#digestCard .dg-lines'), /Filed 1 song, none moved or undone since/);

  await page.click('#digestCard [data-act="digestHide"]');
  await page.waitForSelector('#digestCard', { state: 'detached' });
  const m = await page.evaluate(() => JSON.parse(localStorage.getItem('bf_digest_measure')));
  assert.deepEqual(m, { shown: 1, expanded: 1, dismissed: 1 });
  // The deck is still there under it.
  await page.waitForSelector('#swipeCard');
  // The card made no request of its own: nothing went to Spotify that a plain reload does not send.
  assert.ok(!app.fake.log.slice(before).some(r => r.method !== 'GET'), 'no writes from showing the digest');
});
