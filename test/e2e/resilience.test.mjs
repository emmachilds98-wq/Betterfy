// E1 error resilience, by fault injection on the fake server: a 429 is a visible
// state and never double-writes; a token that expires halfway through a batch is
// refreshed and the batch carries on; a batch that fails partway is reconciled
// against what Spotify really holds, with "Retry the rest"; a write whose answer
// is lost is not sent twice; and the ⋯ menu survives a repaint.
import test from 'node:test';
import assert from 'node:assert/strict';
import { skip, launch, openApp, ready, fileCard, swipe, until } from './harness.mjs';

let browser, app;
test.before(async () => { if (!skip) browser = await launch(); });
test.after(async () => { await browser?.close(); });
test.afterEach(async () => { if (app) { await app.close(); app = null; } });

/** Declare cards sure, preferring ones whose leading picks are different playlists. */
async function makeSure(page, n = 3) {
  const sure = await page.evaluate(n => {
    const all = R.backlog.filter(r => filePicks(r)[0]).map(r => ({ id: r.id, pl: filePicks(r)[0].id }));
    const seen = new Set(), pick = [];
    for (const c of all) if (!seen.has(c.pl) && pick.length < n) { seen.add(c.pl); pick.push(c); }
    for (const c of all) if (pick.length < n && !pick.includes(c)) pick.push(c);
    const verdicts = new Map(pick.map(c => [c.id, { kind: 'confident', playlists: [] }]));
    window.engineDecisionOf = id => verdicts.get(id) ?? null;
    // No sound in a synthetic account: stand in for the backing Sure needs (USER-REVIEW item 2).
    window.backedBand = b => b ?? null;
    render();
    return pick;
  }, n);
  await page.waitForSelector('[data-act="filesure"]');
  return sure;
}
const dupes = (fake, pl) => { const a = fake.playlist(pl); return a.length - new Set(a).size; };
const groups = page => page.evaluate(async () => {
  const log = (await getLog()).filter(x => x.band === 'sure' && x.op === 'add');
  return [...new Set(log.map(x => x.group))];
});

test('a 429 shows a slow-down state, then the write lands once', { skip }, async () => {
  app = await openApp(browser, { kind: 'typical' });
  const { page, fake, errors } = app;
  await ready(page);
  const c = await fileCard(page);
  const before = fake.playlist(c.best).length;
  fake.sw.rate429 = 1;
  await swipe(page, '#swipeCard', 220);
  await until(async () => /slow down/.test(await page.locator('#slowdown').innerText().catch(() => '')), 'the slow-down note');
  assert.match(await page.locator('#slowdown').innerText(), /retrying in \d+s/);
  await until(() => fake.playlist(c.best).includes(c.track), 'the write after the 429', 15000);
  await until(async () => (await page.locator('#slowdown').count()) === 0, 'the note to clear');
  assert.equal(fake.playlist(c.best).length, before + 1, 'added exactly once');
  assert.equal(fake.writes().filter(w => w.method === 'POST' && w.path.includes(c.best)).length, 2, 'the refused POST and its single retry');
  assert.deepEqual(errors, []);
});

test('a token that expires mid-batch is refreshed and the batch finishes in one group', { skip }, async () => {
  app = await openApp(browser, { kind: 'typical' });
  const { page, fake, errors } = app;
  await ready(page); await fileCard(page);
  const sure = await makeSure(page);
  fake.sw.expireAfterWrites = 1;
  await page.click('[data-act="filesure"]');
  await until(() => sure.every(s => fake.playlist(s.pl).includes(s.id)), 'every card to land', 15000);
  assert.ok(fake.log.some(l => l.path === '/api/token'), 'the token was refreshed');
  for (const s of sure) assert.equal(dupes(fake, s.pl), 0, 'no duplicates');
  await until(async () => (await groups(page)).length === 1, 'one History group');
  assert.deepEqual(errors, []);
});

test('a batch that fails partway is reconciled and the rest can be retried', { skip }, async () => {
  app = await openApp(browser, { kind: 'typical' });
  const { page, fake, errors } = app;
  await ready(page); await fileCard(page);
  const sure = await makeSure(page);
  const pls = new Set(sure.map(s => s.pl));
  fake.sw.failAfterWrites = 1;
  await page.click('[data-act="filesure"]');
  await until(async () => /Retry the rest/.test(await page.locator('#toast').innerText()), 'the partial-failure toast');
  const landed = sure.filter(s => fake.playlist(s.pl).includes(s.id));
  assert.equal(landed.length, pls.size === 1 ? sure.length : 1, 'what Spotify holds is what landed');
  // History lists exactly what landed; the queue lost exactly those.
  const state = await page.evaluate(async ids => ({
    log: (await getLog()).filter(x => x.band === 'sure' && x.op === 'add').flatMap(x => x.trackIds),
    queued: ids.filter(id => R.backlog.some(b => b.id === id)) }), sure.map(s => s.id));
  assert.deepEqual([...state.log].sort(), landed.map(s => s.id).sort(), 'the log matches Spotify');
  assert.deepEqual(state.queued.sort(), sure.filter(s => !landed.includes(s)).map(s => s.id).sort(), 'unlanded cards stay');
  if (landed.length < sure.length) {
    // The toast offers the rest (the card no longer repeats it, DESIGN-PLAN C1).
    assert.match(await page.locator('#toast').innerText(), /landed/);
    fake.sw.failAfterWrites = -1;
    await page.locator('#toast button', { hasText: 'Retry the rest' }).click();
    await until(() => sure.every(s => fake.playlist(s.pl).includes(s.id)), 'the rest to land');
    for (const s of sure) assert.equal(dupes(fake, s.pl), 0, 'no duplicates');
    await until(async () => (await groups(page)).length === 1, 'still one History group');
  }
  assert.deepEqual(errors, []);
});

test('a write whose answer is lost is found by re-reading, not sent twice', { skip }, async () => {
  app = await openApp(browser, { kind: 'typical' });
  const { page, fake, errors } = app;
  await ready(page);
  const c = await fileCard(page);
  const before = fake.playlist(c.best).length;
  fake.sw.loseResponse = 1;
  await swipe(page, '#swipeCard', 220);
  await until(() => fake.playlist(c.best).includes(c.track), 'the write to land');
  await until(async () => (await page.evaluate(id => R.backlog.some(b => b.id === id), c.track)) === false, 'the card to stay filed');
  await page.waitForTimeout(500);
  assert.equal(fake.playlist(c.best).length, before + 1, 'one copy, not two');
  assert.equal(fake.writes().filter(w => w.method === 'POST' && w.path.includes(c.best)).length, 1, 'never re-sent');
  assert.deepEqual(errors, []);
});

test('the ⋯ menu stays open across a repaint', { skip }, async () => {
  app = await openApp(browser, { kind: 'typical' });
  const { page, errors } = app;
  await ready(page); await fileCard(page);
  const more = page.locator('#swipeCard details.cardmore');
  await more.locator('summary').click();
  assert.equal(await more.evaluate(d => d.open), true);
  await page.evaluate(() => render());     // what a late listening re-sort does
  await page.waitForTimeout(100);
  assert.equal(await page.locator('#swipeCard details.cardmore').evaluate(d => d.open), true, 'still open');
  assert.deepEqual(errors, []);
});
