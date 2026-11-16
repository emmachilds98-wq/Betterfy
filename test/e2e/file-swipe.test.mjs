// File screen gestures against a fake Spotify: swipe right files, a fast flick
// files, the card flies out and the next one arrives, swipe left skips.
import test from 'node:test';
import assert from 'node:assert/strict';
import { skip, launch, openApp, ready, swipe, fileCard, until } from './harness.mjs';

let browser, app;
test.before(async () => { if (!skip) browser = await launch(); });
test.after(async () => { await browser?.close(); });
test.beforeEach(async () => { if (!skip) { app = await openApp(browser, { kind: 'typical' }); await ready(app.page); } });
test.afterEach(async () => {
  if (app) { assert.deepEqual(app.errors, [], 'no uncaught page errors'); await app.close(); app = null; }
});

const filedInto = (app, pl, track) => app.fake.writes().some(w => w.method === 'POST'
  && w.path === `/playlists/${pl}/items` && w.body?.uris?.includes('spotify:track:' + track));

test('swiping right files the card into its best playlist, and the write reaches Spotify', { skip }, async () => {
  const { page, fake } = app;
  const c = await fileCard(page);
  await swipe(page, '#swipeCard', 220);
  await until(() => filedInto(app, c.best, c.track), 'the POST to the best playlist');
  assert.ok(fake.playlist(c.best).includes(c.track), 'the fake playlist now holds the track');
  assert.equal(await page.evaluate(() => R.backlog.length), c.left - 1);
});

test('a fast short flick files too', { skip }, async () => {
  const { page } = app;
  const c = await fileCard(page);
  await swipe(page, "#swipeCard", 66, 40);   // under the 76px distance, but fast enough to survive a loaded CI box
  await until(() => filedInto(app, c.best, c.track), 'the flick to file');
});

test('a slow short drag does not file; it springs back', { skip }, async () => {
  const { page, fake } = app;
  const c = await fileCard(page);
  await swipe(page, '#swipeCard', 40, 700);
  await page.waitForTimeout(400);
  assert.equal(fake.writes().length, 0);
  assert.equal(await page.evaluate(() => R.backlog.length), c.left);
});

test('filing flies a ghost card out and the next card takes its place', { skip }, async () => {
  const { page } = app;
  const c = await fileCard(page);
  await swipe(page, '#swipeCard', 220);
  // The ghost is a fixed clone, aria-hidden, that lives ~450ms.
  await page.waitForSelector('body > .swipecard[aria-hidden="true"]', { state: 'attached', timeout: 2000 });
  await until(async () => (await page.evaluate(() => document.querySelectorAll('body > .swipecard[aria-hidden]').length)) === 0, 'the ghost to leave');
  const now = await page.evaluate(() => ({ id: R.backlog[Math.min(S.inboxAt, R.backlog.length - 1)].id, card: !!document.querySelector('#swipeCard') }));
  assert.ok(now.card, 'a card is still on screen');
  assert.notEqual(now.id, c.track, 'and it is the next track, not the filed one');
});

test('swiping left skips: nothing is written, the card moves on', { skip }, async () => {
  const { page, fake } = app;
  const c = await fileCard(page);
  await swipe(page, '#swipeCard', -220);
  await until(async () => (await page.evaluate(id => R.backlog[Math.min(S.inboxAt, R.backlog.length - 1)].id !== id, c.track)), 'the next card');
  assert.equal(fake.writes().length, 0, 'a skip never writes to Spotify');
  assert.equal(await page.evaluate(() => R.backlog.length), c.left, 'and the card is still in the queue');
});
