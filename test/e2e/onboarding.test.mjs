// O1: a new account's first run ends in a first filing or the right empty
// state, never a dead end (BUILD-6 plan §4.1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { skip, launch, openApp, ready, swipe, fileCard, until } from './harness.mjs';

let browser;
test.before(async () => { if (!skip) browser = await launch(); });
test.after(async () => { await browser?.close(); });

test('empty library: says what to do, offers no analysis, writes nothing', { skip }, async () => {
  const app = await openApp(browser, { kind: 'empty' });
  try {
    await ready(app.page);
    await app.page.waitForSelector('.empty-state');
    const text = await app.page.locator('#app').innerText();
    assert.match(text, /library is empty/i);
    assert.match(text, /like some songs/i);
    assert.equal(await app.page.locator('#analyseGo').count(), 0, 'nothing to analyse');
    assert.equal(await app.page.locator('.st-onb').count(), 0, 'no first-run count over nothing');
    assert.deepEqual(app.errors, []);
    assert.equal(app.fake.writes().length, 0);
  } finally { await app.close(); }
});

test('no genre playlists: File offers "Start these playlists", and the strip counts to five', { skip }, async () => {
  const app = await openApp(browser, { kind: 'small' });
  try {
    const { page } = app;
    await ready(page);
    await page.waitForSelector('#swipeCard');
    await page.waitForSelector('.today .st-onb');
    assert.match(await page.locator('.st-onb').innerText(), /first 5 filed: 0\/5/);
    await page.waitForSelector('.panel.cold #fcold-h', { timeout: 20000 });
    const before = app.fake.writes().length;
    await page.click('.panel.cold [data-act="coldStart"]');
    await until(() => app.fake.writes().some(w => w.method === 'POST' && /\/playlists/.test(w.path)), 'the new playlist to be made');
    assert.ok(app.fake.writes().length > before);
    assert.deepEqual(app.errors, []);
  } finally { await app.close(); }
});

test('typical account: first filing, then the strip goes after five', { skip }, async () => {
  const app = await openApp(browser, { kind: 'typical' });
  try {
    const { page } = app;
    await ready(page);
    await fileCard(page);
    assert.match(await page.locator('.st-onb').innerText(), /0\/5/);
    for (let k = 0; k < 5; k++) {
      const c = await fileCard(page);
      await swipe(page, '#swipeCard', 220);
      // Liked Songs is the inbox: a card already in its best playlist is filed with no write.
      await until(async () => app.fake.writes().some(w => w.path === `/playlists/${c.best}/items` && w.body?.uris?.includes('spotify:track:' + c.track))
        || await page.evaluate(id => !R.backlog.some(b => b.id === id), c.track), 'filing ' + (k + 1));
      await page.waitForTimeout(700);
    }
    await until(() => page.evaluate(() => !!localStorage.getItem('bf_onb_done')).then(Boolean), 'the strip to finish', 10000).catch(() => {});
    assert.equal(await page.locator('.st-onb').count(), 0, 'the count goes from the header');
    assert.deepEqual(app.errors, []);
  } finally { await app.close(); }
});

test('large library: File is usable while Analyse runs', { skip, timeout: 240000 }, async () => {
  const app = await openApp(browser, { kind: 'large' });
  try {
    const { page } = app;
    await ready(page);
    const c = await fileCard(page, 180000);
    assert.ok(c.left > 1000);
    await page.waitForTimeout(500);
    assert.ok(await page.locator('#swipeCard').isVisible(), 'the card is still there');
    assert.deepEqual(app.errors, []);
  } finally { await app.close(); }
});
