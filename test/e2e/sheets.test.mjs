// The card's ⋯ menu, the Library detail sheet and the Settings sheet, and the
// browser's back button closing each sheet instead of leaving the app.
import test from 'node:test';
import assert from 'node:assert/strict';
import { skip, launch, openApp, ready, fileCard, until } from './harness.mjs';

let browser, app;
test.before(async () => { if (!skip) browser = await launch(); });
test.after(async () => { await browser?.close(); });
test.beforeEach(async () => { if (!skip) { app = await openApp(browser, { kind: 'typical' }); await ready(app.page); } });
test.afterEach(async () => {
  if (app) { assert.deepEqual(app.errors, [], 'no uncaught page errors'); await app.close(); app = null; }
});

test('the ⋯ menu opens on the File card and offers Unlike', { skip }, async () => {
  const { page } = app;
  await fileCard(page);
  const more = page.locator('#swipeCard details.cardmore');
  assert.equal(await more.evaluate(d => d.open), false);
  await more.locator('summary').click();
  assert.equal(await more.evaluate(d => d.open), true);
  assert.ok(await more.locator('button[data-act="unlike"]').isVisible());
});

test('a Library row opens the playlist sheet and Back closes it', { skip }, async () => {
  const { page } = app;
  await fileCard(page);
  await page.click('.nav[data-v="lists"]');
  await page.waitForSelector('[data-act="plopen"]');
  await page.locator('[data-act="plopen"]').first().click();
  await page.waitForSelector('#plSheet.open');
  assert.ok(await page.evaluate(() => !!S.plSheet), 'the app records an open sheet');
  assert.match(page.url(), /pl:/, 'the sheet has its own history entry');
  await page.goBack();
  await until(async () => !(await page.evaluate(() => document.querySelector('#plSheet')?.classList.contains('open'))), 'the sheet to close');
  assert.equal(await page.evaluate(() => view), 'lists', 'still on Library, not thrown out of the app');
});

test('Settings opens from the gear, Back closes it, and ✕ closes it too', { skip }, async () => {
  const { page } = app;
  await fileCard(page);
  await page.click('#btnSettings');
  await page.waitForSelector('#settingsPanel.open');
  await page.goBack();
  await until(async () => !(await page.evaluate(() => document.querySelector('#settingsPanel').classList.contains('open'))), 'Settings to close on Back');
  assert.equal(await page.evaluate(() => view), 'inbox');
  await page.click('#btnSettings');
  await page.waitForSelector('#settingsPanel.open');
  await page.click('#closeSettings');
  await until(async () => !(await page.evaluate(() => document.querySelector('#settingsPanel').classList.contains('open'))), 'Settings to close on ✕');
});
