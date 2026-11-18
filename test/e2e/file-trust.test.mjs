// BUILD-7 U1, File you can trust at a glance, on the fake account: a tags-only
// pick never wears the Sure look, a backed agreeing one does, the top pick says
// why in words, and the 30-day kept-rate line waits for 20 filings.
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

/** Give the card on screen these two picks and repaint; returns its state. */
const withPicks = (page, top) => page.evaluate(top => {
  const t = R.backlog[Math.min(S.inboxAt, R.backlog.length - 1)];
  const ids = Object.keys(CFG).filter(id => CFG[id].target);
  t.suggest = [{ id: ids[0], name: CFG[ids[0]].name, score: 0.82, axis: 'genre', ...top },
               { id: ids[1], name: CFG[ids[1]].name, score: 0.4, axis: 'genre', via: 'tags' }];
  render();
  return document.querySelector('#swipeCard').dataset.state;
}, top);

test('a tags-only HIGH pick is never Sure; a history-backed one is, with its reason in words', { skip }, async () => {
  const { page } = app;
  await fileCard(page);
  assert.notEqual(await withPicks(page, { band: 'HIGH', via: 'tags' }), 'sure', 'tags alone are a choice');
  assert.equal(await page.$('#swipeCard .pick.best'), null, 'nothing lit green');
  assert.equal(await page.$('#swipeCard .fileacts .go'), null, 'File is not filled');
  assert.match(await page.textContent('#swipeCard .wayline'), / or /);
  assert.match(await page.textContent('#swipeCard .pick .evline'), /not heard yet/);

  assert.equal(await withPicks(page, { band: 'HIGH', via: 'history', count: 3, total: 4 }), 'sure');
  await page.waitForSelector('#swipeCard .pick.best');
  await page.waitForSelector('#swipeCard .fileacts .go');
  assert.match(await page.textContent('#swipeCard .pick.best .evline'), /3 of 4 other tracks by this artist are already here/);
  assert.doesNotMatch(await page.textContent('#swipeCard .pick.best .evline'), /%/);
});

test('the kept-rate line appears at 20 filings in the last 30 days, not at 19', { skip }, async () => {
  const { page } = app;
  await fileCard(page);
  const seed = n => page.evaluate(async n => {
    const now = Date.now();
    const log = Array.from({ length: n }, (_, k) => ({ at: new Date(now - (k + 1) * 36e5).toISOString(), op: 'add',
      playlistId: 'pl', playlistName: 'pl', trackIds: ['seed' + k], reason: 'filed from inbox' })).reverse();
    log.push({ at: new Date(now - 6e5).toISOString(), op: 'add', playlistId: 'pl', trackIds: ['back'],
               reason: 'filed from inbox', undoneAt: new Date(now - 3e5).toISOString() });
    await idb.set('actions', log);
    S.kept = null; render();
  }, n);
  await seed(18);   // 18 kept + 1 undone = 19 filings
  await until(() => page.evaluate(() => S.kept?.status === 'ready'), 'the kept rate read from History');
  assert.equal(await page.$('.keptline'), null, 'not shown below 20');
  await seed(19);   // 20 filings, 19 stayed
  await page.waitForSelector('.keptline', { timeout: 8000 });
  assert.equal(await page.textContent('.keptline'), 'Last 30 days: 95% of the picks you filed stayed');
});

test('after filing the second pick, the next card by that artist says what it learned', { skip }, async () => {
  const { page } = app;
  await fileCard(page);
  // Two cards by one artist, the first on screen.
  const name = await page.evaluate(() => {
    const at = Math.min(S.inboxAt, R.backlog.length - 1), t = R.backlog[at];
    const twin = R.backlog.find((b, k) => k !== at && b.id !== t.id);
    twin.artists = [...t.artists]; twin.artist = t.artist;
    const ids = Object.keys(CFG).filter(id => CFG[id].target);
    t.suggest = [{ id: ids[0], name: CFG[ids[0]].name, score: 0.8, via: 'tags' }, { id: ids[1], name: CFG[ids[1]].name, score: 0.5, via: 'tags' }];
    render();
    return CFG[ids[1]].name;
  });
  await page.click('#swipeCard .pick >> nth=1');
  await page.click('#swipeCard [data-act="filesel"]');
  await until(() => page.evaluate(() => S.learned?.kind === 'picked'), 'the correction to be noted');
  // The queue may re-sort behind the filing: go to that artist's other card.
  await page.evaluate(() => { S.inboxAt = R.backlog.findIndex(b => b.artists?.[0]?.id === S.learned.artistId); render(); });
  await page.waitForSelector('#swipeCard .learnline', { timeout: 8000 });
  assert.match(await page.textContent('#swipeCard .learnline'), new RegExp(`Learned: you file .+ in ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.`));
});
