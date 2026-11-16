// The teach questions on File (BUILD-6 SG) in a real browser. Shut by default: a
// synthetic account has no Score run, and no measurement means no card. With the
// measurement handed to the page (a Score run that passed writes the same
// `bf_teach`), Start finds the questions, one tap files the track into the fake
// Spotify as an ordinary History entry, and Undo takes it back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { skip, launch, openApp, ready, fileCard, until } from './harness.mjs';

let browser, app;
test.before(async () => { if (!skip) browser = await launch(); });
test.after(async () => { await browser?.close(); });
test.afterEach(async () => { if (app) { await app.close(); app = null; } });

test('no measurement, or one that did not beat: no teach card', { skip }, async () => {
  app = await openApp(browser, { kind: 'typical' });
  const { page } = app;
  await ready(page);
  await fileCard(page);
  assert.equal(await page.locator('.teach').count(), 0);
  await page.evaluate(() => { localStorage.setItem('bf_teach', JSON.stringify({ pass: false, why: 'the answers did not move the score enough' })); render(); });
  assert.equal(await page.locator('.teach').count(), 0);
  assert.deepEqual(app.errors, []);
});

test('teach questions: Start, one tap files it with one History entry, Undo takes it back', { skip, timeout: 120000 }, async () => {
  app = await openApp(browser, { kind: 'typical' });
  const { page, fake } = app;
  await ready(page);
  await fileCard(page);
  const onScreen = await page.evaluate(() => {
    localStorage.setItem('bf_teach', JSON.stringify({ pass: true, why: 'beats', before: 0.4, after: 0.45, asked: 20, scored: 80 }));
    render();
    return R.backlog[S.inboxAt].id;
  });
  await page.waitForSelector('.teach [data-teach="start"]');
  assert.match(await page.locator('.teach').innerText(), /from 40% to 45% right/);
  await page.click('.teach [data-teach="start"]');
  await page.waitForSelector('.teach [data-teach="file"]', { timeout: 90000 });
  const n = await page.locator('.teach .teach-q').count();
  assert.ok(n >= 2 && n <= 10, `${n} questions`);
  // One question per artist.
  const artists = await page.evaluate(() => TEACH_UI.items.map(q => artistKeyOf(q.row)));
  assert.equal(new Set(artists).size, artists.length);

  const btn = page.locator('.teach [data-teach="file"]').first();
  const id = await btn.getAttribute('data-id'), pl = await btn.getAttribute('data-pl');
  const before = fake.playlist(pl).length;
  await btn.click();
  await until(() => fake.playlist(pl).includes(id), 'the track to be filed');
  await until(async () => (await page.evaluate(() => getLog()))
    .some(e => e.op === 'add' && e.via === 'teach' && e.trackIds.includes(id) && !e.undoneAt), 'its History entry');
  assert.equal(await page.locator(`.teach [data-teach="file"][data-id="${id}"]`).count(), 0, 'the question is answered');
  assert.ok(await page.evaluate(x => !R.backlog.some(b => b.id === x), id), 'off the File queue');
  if (onScreen !== id) assert.equal(await page.evaluate(() => R.backlog[S.inboxAt].id), onScreen, 'the deck stays on its card');

  await until(async () => /^Filed “/.test(await page.locator('#toast').innerText()), 'the toast');
  await page.click('#undoBtn');
  await until(() => !fake.playlist(pl).includes(id), 'Undo to take it out again');
  assert.equal(fake.playlist(pl).length, before);

  // "Not sure" drops a question without writing anything.
  const pass = page.locator('.teach [data-teach="pass"]').first();
  if (await pass.count()) {
    const pid = await pass.getAttribute('data-id');
    await pass.click();
    assert.equal(await page.locator(`.teach [data-id="${pid}"]`).count(), 0);
  }
  assert.deepEqual(app.errors, []);
});
