// What happens when Spotify misbehaves: a refused write puts the card back
// (the filing is optimistic), an expired token is refreshed once and the call
// retried, and a 429 is waited out rather than shown as a sign-out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { skip, launch, openApp, ready, swipe, fileCard, until } from './harness.mjs';

let browser, app;
test.before(async () => { if (!skip) browser = await launch(); });
test.after(async () => { await browser?.close(); });
test.afterEach(async () => {
  if (app) { await app.close(); app = null; }
});
const open = async o => { app = await openApp(browser, { kind: 'typical', ...o }); await ready(app.page); return app; };

test('a write Spotify refuses puts the card back and says why', { skip }, async () => {
  const { page, fake, errors } = await open();
  const c = await fileCard(page);
  fake.sw.failWrites = true;
  await swipe(page, '#swipeCard', 220);
  await until(async () => /Failed/.test(await page.locator('#toast').innerText()), 'the failure toast');
  await until(async () => (await page.evaluate(() => R.backlog.length)) === c.left, 'the card to come back to the queue');
  const now = await page.evaluate(() => ({ id: R.backlog[Math.min(S.inboxAt, R.backlog.length - 1)].id, card: !!document.querySelector('#swipeCard') }));
  assert.equal(now.id, c.track, 'the same card is back on top');
  assert.ok(now.card);
  assert.ok(!fake.playlist(c.best).includes(c.track), 'and nothing was added');
  assert.deepEqual(errors, []);
  // Once Spotify behaves again, filing works from the restored card.
  fake.sw.failWrites = false;
  await page.waitForTimeout(400);   // the flight lock
  await swipe(page, '#swipeCard', 220);
  await until(() => fake.playlist(c.best).includes(c.track), 'the retry to land');
});

test('an expired token is refreshed once and the write still lands', { skip }, async () => {
  const { page, fake, errors } = await open();
  const c = await fileCard(page);
  fake.sw.expire401 = 1;
  await swipe(page, '#swipeCard', 220);
  await until(() => fake.playlist(c.best).includes(c.track), 'the write after a refresh');
  assert.ok(fake.log.some(l => l.path === '/api/token'), 'the page asked /api/token for a new token');
  assert.deepEqual(errors, []);
});

test('a 429 is waited out and the filing completes', { skip }, async () => {
  const { page, fake, errors } = await open();
  const c = await fileCard(page);
  fake.sw.rate429 = 1;
  await swipe(page, '#swipeCard', 220);
  await until(() => fake.playlist(c.best).includes(c.track), 'the write after a 429', 15000);
  assert.ok(await page.evaluate(() => !!localStorage.getItem('bf_tok')), 'still signed in');
  assert.deepEqual(errors, []);
});
