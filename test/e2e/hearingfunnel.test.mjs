// SOUND-ENGINE-PLAN L4 on the fake account: Settings > Listening says in plain
// words how much of the library is heard and why the rest is not, and the Score
// report carries the same lines. With nothing heard it says so.
import test from 'node:test';
import assert from 'node:assert/strict';
import { skip, launch, openApp, ready } from './harness.mjs';

let browser, app;
test.before(async () => { if (!skip) browser = await launch(); });
test.after(async () => { await browser?.close(); });
test.beforeEach(async () => { if (!skip) { app = await openApp(browser, { kind: 'typical' }); await ready(app.page); } });
test.afterEach(async () => {
  if (app) { assert.deepEqual(app.errors, [], 'no uncaught page errors'); await app.close(); app = null; }
});

const open = page => page.evaluate(async () => { await audioLoad(); openSettings(true); openUnderHood('sources'); });

test('Settings > Listening and the Score report show the funnel, with the miss reasons', { skip, timeout: 120000 }, async () => {
  const { page } = app;
  const facts = await page.evaluate(async () => {
    await audioLoad();
    const ids = [...new Set([...(LIB.liked ?? []), ...LIB.playlists.flatMap(p => p.tracks ?? [])].map(t => t.id))];
    const recs = new Map();
    ids.slice(0, 5).forEach(id => recs.set(id, { v: 1, id }));
    recs.set(ids[5], { id: ids[5], miss: 'NOT_ON_DEEZER' });
    recs.set(ids[6], { id: ids[6], miss: 'NO_PREVIEW' });
    recs.set(ids[7], { id: ids[7], miss: 'NO_PREVIEW' });
    Object.defineProperty(AUDIO, 'records', { get: () => recs, set() {}, configurable: true });
    return { total: ids.length };
  });
  await open(page);
  await page.waitForSelector('#hearingFunnelText');
  const text = await page.locator('#hearingFunnelText').innerText();
  assert.match(text, new RegExp(`^Heard 5 of ${facts.total}\\. `));
  assert.match(text, /Not on Deezer 1, no preview 2/);
  await page.locator('#hearingFunnel summary').click();
  assert.match(await page.locator('#hearingFunnel details').innerText(), /Found on Deezer/);
  const lines = await page.evaluate(() => hearingReportLines());
  assert.match(lines[0], /^Hearing: Heard 5 of /);
  assert.match(lines.join('\n'), /biggest miss \(2\): Deezer has it but no clip/);
});

test('with no audio heard, the report line says nothing heard yet', { skip, timeout: 120000 }, async () => {
  const { page } = app;
  await page.evaluate(async () => { await audioLoad(); Object.defineProperty(AUDIO, 'records', { get: () => new Map(), set() {}, configurable: true }); });
  const lines = await page.evaluate(() => hearingReportLines());
  assert.match(lines[0], /^Hearing: Nothing heard yet\./);
});
