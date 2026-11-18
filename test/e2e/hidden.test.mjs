// Tidy › Hard to find, on the fake Spotify: a song added long ago is held under an
// old id while search shows the current release, so Spotify shows no tick. The check
// finds it, the fix asks first, then swaps the copy in place in every playlist (and
// in Liked Songs), and History's Undo puts the old copy back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { skip, launch, openApp, ready, until } from './harness.mjs';
import { makeAccount } from '../fixtures/accounts.mjs';

let browser, app;
test.before(async () => { if (!skip) browser = await launch(); });
test.after(async () => { await browser?.close(); });
test.afterEach(async () => { if (app) { await app.close(); app = null; } });

function account() {
  const acc = makeAccount('small');
  const old = acc.playlists[0].tracks[0];          // in a playlist and liked (makeAccount likes the first of each)
  const twin = { ...old, id: 'fxcurrent0000000000001', album: { ...old.album, id: 'alnew', name: 'Remastered Collection', release_date: '2024' } };
  acc.catalog = [twin];
  acc.searchText = true;
  return { acc, old, twin };
}

test('a song search shows as another version is found, and the fix swaps it in place after a confirm', { skip }, async () => {
  const { acc, old, twin } = account();
  app = await openApp(browser, { account: acc, phone: false });
  const { page, fake } = app;
  await ready(page);
  await page.evaluate(() => { go('tidy'); S.tidySec = 'hidden'; render(); });
  await page.waitForSelector('[data-act="hdRun"]');
  await page.click('[data-act="hdRun"]');
  await until(() => page.$(`[data-act="hdFix"][data-from="${old.id}"]`), 'the flagged row', 30000);
  const pl = acc.playlists[0].id;
  const before = fake.playlist(pl);
  await page.click(`[data-act="hdFix"][data-from="${old.id}"]`);
  assert.match(await page.textContent('#main'), /Swap in 1 playlist and Liked Songs\?/);
  assert.deepEqual(fake.playlist(pl), before, 'nothing written before the confirm');
  await page.click('[data-act="hdYes"]');
  await until(() => fake.playlist(pl).includes(twin.id) && !fake.playlist(pl).includes(old.id), 'the swap to land', 15000);
  await until(async () => !(await page.$(`#main [data-from="${old.id}"]`)), 'the row to leave', 15000);
  const after = fake.playlist(pl);
  assert.equal(after[0], twin.id, 'the search version sits where the old copy was');
  assert.ok(!after.includes(old.id));
  assert.equal(after.length, before.length);
  await until(() => fake.log.some(x => x.method === 'PUT' && /me\/(library|tracks)/.test(x.path) && x.path.includes(twin.id)), 'liked as well', 15000);

  // Find a song answers from the library at once, and says where it sits.
  await page.fill('#hdSearch', twin.name);
  await until(async () => /Liked/.test(await page.textContent('.hd-find')), 'library answer');
  await page.screenshot({ path: process.env.HIDDEN_SHOT ?? '/dev/null' }).catch(() => {});

  // Undo from History puts the old copy back where it was and takes the new one out.
  await page.evaluate(async () => { const e = (await getLog()).find(x => x.reason === 'version search shows'); await undoAction(e.at); });
  assert.deepEqual(fake.playlist(pl), before);
  assert.deepEqual(app.errors, []);
});
