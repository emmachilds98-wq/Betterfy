// BUILD-7 U3, on the fake account: File asks one sound-label question a
// session, about the track just filed, under the card and never in place of a
// Sure card's File button; the answer lands in the same store Sources uses.
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

/** Heard records for every queued track (high energy, vocal, two moods), held whatever listening does meanwhile. */
const hear = page => page.evaluate(async () => {
  await audioLoad();
  const recs = new Map(R.backlog.map(b => [b.id, { v: 1, id: b.id,
    heads: { v: '1.0.0', moods: [['dark', 0.6], ['energetic', 0.4]], voice: 0.9 }, dsp: { energy: 0.8 } }]));
  Object.defineProperty(AUDIO, 'records', { get: () => recs, set() {}, configurable: true });
  LABELCHECKS ??= {};
  render();
});

/** Make the card on screen a Sure one (history-backed HIGH pick); returns its state. */
const sure = page => page.evaluate(() => {
  const t = R.backlog[Math.min(S.inboxAt, R.backlog.length - 1)];
  const ids = Object.keys(CFG).filter(id => CFG[id].target);
  t.suggest = [{ id: ids[0], name: CFG[ids[0]].name, score: 0.82, axis: 'genre', band: 'HIGH', via: 'history', count: 3, total: 4 },
               { id: ids[1], name: CFG[ids[1]].name, score: 0.4, axis: 'genre', via: 'tags' }];
  render();
  return document.querySelector('#swipeCard').dataset.state;
});

const fileOne = async page => {
  const left = await page.evaluate(() => R.backlog.length);
  await page.click('#swipeCard [data-act="filesel"]');
  await until(() => page.evaluate(n => R.backlog.length < n && !S.filing, left), 'the filing to land');
  await page.waitForTimeout(350);   // the flight lock
};

test('one question a session, after the card, never replacing a Sure card\'s File button', { skip }, async () => {
  const { page } = app;
  await fileCard(page);
  await hear(page);
  assert.equal(await sure(page), 'sure');
  assert.equal(await page.$('#labelAsk'), null, 'nothing filed or playing yet: no question');

  await fileOne(page);
  assert.equal(await sure(page), 'sure');
  await page.waitForSelector('#labelAsk', { timeout: 8000 });
  assert.match(await page.textContent('#labelAsk'), /Quick check on .+: Does this sound dark and energetic\?/);
  assert.equal(await page.$('#swipeCard #labelAsk'), null, 'not inside the card');
  // The Sure card keeps its filled File button, and the question has none of its own.
  await page.waitForSelector('#swipeCard .fileacts [data-act="filesel"].go');
  assert.equal(await page.$('#labelAsk [data-act="filesel"]'), null);

  await page.click('#labelAsk [data-lok="1"]');
  await page.waitForSelector('#labelAsk.lblask-done');
  assert.match(await page.textContent('#labelAsk'), /Thanks\. That counts toward showing mood labels\. 1 of 20 answers needed\./);
  const stored = await page.evaluate(async () => {
    const all = await idb.get(BetterfyAudio.CHECKS_KEY), mine = all?.[LIB.user.id] ?? {};
    return Object.values(mine).map(c => ({ mood: c.mood, from: c.from?.mood }));
  });
  assert.deepEqual(stored, [{ mood: true, from: 'file' }]);

  // The next filings ask nothing more.
  for (let k = 0; k < 2; k++) {
    await sure(page);
    await fileOne(page);
    assert.equal(await page.$('#labelAsk'), null, `no second question (filing ${k + 2})`);
  }

  // Nor does a reload in the same tab.
  await page.reload();
  await ready(page);
  await fileCard(page);
  await hear(page);
  await sure(page);
  await fileOne(page);
  assert.equal(await page.$('#labelAsk'), null, 'the same session after a reload');
});

test('"Not sure" stores nothing and spends the session\'s question', { skip }, async () => {
  const { page } = app;
  await fileCard(page);
  await hear(page);
  await sure(page);
  await fileOne(page);
  await page.waitForSelector('#labelAsk', { timeout: 8000 });
  await page.click('#labelAsk [data-lok="pass"]');
  await page.waitForSelector('#labelAsk.lblask-done');
  assert.equal(await page.evaluate(() => Object.keys(LABELCHECKS?.[LIB.user.id] ?? {}).length), 0);
  await sure(page);
  await fileOne(page);
  assert.equal(await page.$('#labelAsk'), null);
});
