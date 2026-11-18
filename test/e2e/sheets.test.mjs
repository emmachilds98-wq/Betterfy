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

test('the ⋯ menu opens on the File card and offers Remove from Liked (DESIGN-PLAN M2)', { skip }, async () => {
  const { page } = app;
  await fileCard(page);
  const more = page.locator('#swipeCard details.cardmore');
  assert.equal(await more.evaluate(d => d.open), false);
  await more.locator('summary').click();
  assert.equal(await more.evaluate(d => d.open), true);
  // Under "Already in…" instead when the song sits in a playlist: one way per card, never both.
  const inPl = await page.locator('#swipeCard .already').count();
  assert.equal(await more.locator('button[data-act="unlikeask"]').count(), inPl ? 0 : 1);
  assert.equal(await more.locator('button[data-act="unlike"]').count(), 0, 'no one-tap Unlike');
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

test('Settings is one list of collapsible sections in a fixed order, Listening open first, Disconnect last (owner\'s ask 2026-11-18)', { skip }, async () => {
  const { page } = app;
  await fileCard(page);
  await page.click('#btnSettings');
  await page.waitForSelector('#settingsPanel.open');
  await page.waitForSelector('#uh-sources-h');
  const heads = () => page.$$eval('#settingsPanel .uhhead', els => els.map(e => ({ id: e.dataset.uhtoggle, open: e.getAttribute('aria-expanded') === 'true', line: e.querySelector('.uhs').textContent.trim() })));
  const order = ['engine', 'sources', 'helpers', 'data', 'history', 'appearance', 'about'];
  let hs = await heads();
  assert.deepEqual(hs.map(h => h.id), order);
  assert.deepEqual(hs.filter(h => h.open).map(h => h.id), ['sources'], 'only the most used one is open to begin with');
  for (const h of hs) assert.ok(h.line.length > 3 && !/undefined|NaN|ARMS_|UNDECIDED/.test(h.line), `${h.id} says where it stands while closed: "${h.line}"`);
  assert.match(hs.find(h => h.id === 'sources').line, /^(On|Off)/);
  assert.match(hs.find(h => h.id === 'helpers').line, /\d+ of \d+ on/);
  // Disconnect is after every section.
  assert.ok(await page.evaluate(() => !!(document.querySelector('#uh-about-h').compareDocumentPosition(document.querySelector('#disconnect')) & Node.DOCUMENT_POSITION_FOLLOWING)));
  // Each section expands and shows a body, then collapses again.
  for (const id of order) {
    if (id === 'sources') await page.click('#uh-sources-h');   // close the open one first
    else await page.click(`#uh-${id}-h`);
    const open = async () => (await heads()).find(h => h.id === id).open;
    if (id === 'sources') { assert.equal(await open(), false); await page.click('#uh-sources-h'); }
    await until(open, `${id} to open`);
    assert.ok(await page.locator(`#uh-${id}-b`).isVisible(), `${id} shows its body`);
    assert.ok((await page.locator(`#uh-${id}-b`).innerText()).trim().length > 20, `${id} has something in it`);
    if (id !== 'sources') { await page.click(`#uh-${id}-h`); assert.equal(await open(), false, `${id} closes`); await page.waitForTimeout(50); assert.equal(await page.locator(`#uh-${id}-b`).isVisible(), false); }
  }
  // The old routes land on the right section.
  await page.evaluate(() => go('engine'));
  await page.waitForSelector('[data-uh="engine"]');
  assert.equal((await heads()).find(h => h.id === 'engine').open, true, '#/engine opens the score section');
  // Back closes the sheet and focus returns to the gear; so does Escape.
  await page.goBack();
  await until(async () => !(await page.evaluate(() => document.querySelector('#settingsPanel').classList.contains('open'))), 'Back to close Settings');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'btnSettings', 'focus returns to the gear');
  await page.click('#btnSettings');
  await page.waitForSelector('#settingsPanel.open');
  await page.keyboard.press('Escape');
  await until(async () => !(await page.evaluate(() => document.querySelector('#settingsPanel').classList.contains('open'))), 'Escape to close Settings');
});
