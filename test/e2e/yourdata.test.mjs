// Settings › Your data (BUILD-6 F7, F8) in a real browser against the fake
// Spotify: the backup downloads a file of the account's playlists, the file
// restores into another account as private playlists (some tracks only by
// ISRC) with one Undo, and "Wipe this device" leaves no IndexedDB key and no
// localStorage key but the theme.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { skip, launch, openApp, ready, until } from './harness.mjs';
import { makeAccount } from '../fixtures/accounts.mjs';

let browser;
test.before(async () => { if (!skip) browser = await launch(); });
test.after(async () => { await browser?.close(); });

async function openYourData(page) {
  await page.click('#btnSettings');
  await page.waitForSelector('#settingsPanel.open');
  if (!(await page.locator('#src-data').count())) await page.click('[data-uhtoggle="sources"]');
  await page.waitForSelector('#src-data');
}

test('backup downloads the playlists; the file restores into another account, and Undo takes it back', { skip }, async () => {
  const A = makeAccount('small');
  const a = await openApp(browser, { account: A });
  let file;
  try {
    await ready(a.page);
    await openYourData(a.page);
    const text = await a.page.locator('#src-data').innerText();
    assert.match(text, /What is kept, and why \(\d+\)/);
    assert.match(text, /Who hears from Betterfy/);
    const [dl] = await Promise.all([a.page.waitForEvent('download'), a.page.click('[data-act="bkSave"]')]);
    assert.match(dl.suggestedFilename(), /^betterfy-playlists-\d{4}-\d\d-\d\d\.json$/);
    file = JSON.parse(await readFile(await dl.path(), 'utf8'));
    assert.equal(file.playlists.length, A.playlists.length);
    assert.equal(a.fake.writes().length, 0, 'a backup writes nothing to Spotify');
    assert.deepEqual(a.errors, []);
  } finally { await a.close(); }

  // Someone else's account: none of these playlists, and every fifth track id no longer resolves.
  const relinked = new Set();
  const catalog = [...new Map([...A.liked, ...A.playlists.flatMap(p => p.tracks)].map(t => [t.id, t])).values()]
    .map((t, i) => (i % 5 ? t : (relinked.add(t.id), { ...t, id: 'rl' + t.id.slice(2) })));
  const b = await openApp(browser, { account: { me: { id: 'stranger', display_name: 'B' }, playlists: [], liked: [], catalog, strictIds: true } });
  try {
    const { page, fake } = b;
    await ready(page);
    await openYourData(page);
    await page.setInputFiles('#bkFile', { name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) });
    await page.waitForSelector('.bkprev [data-act="bkGo"]');
    assert.equal(await page.locator('.bkprev input[data-act="bkPick"]').count(), A.playlists.length, 'the preview lists every playlist');
    assert.equal(await page.locator('.bkprev .tag.warn').count(), 0, 'none exists here yet');
    await page.click('[data-act="bkGo"]');
    await page.waitForSelector('[data-act="bkUndo"]', { timeout: 30000 });
    const made = fake.playlists();
    assert.equal(made.length, A.playlists.length);
    for (const o of A.playlists) {
      const got = made.find(p => p.name === o.name);
      assert.equal(got.public, false);
      assert.deepEqual(got.tracks.map(t => t.isrc), o.tracks.map(t => t.external_ids.isrc), `"${o.name}" restored track for track`);
    }
    assert.ok([...relinked].some(id => A.playlists.some(p => p.tracks.some(t => t.id === id))), 'some tracks could only be found by ISRC');
    await page.click('[data-act="bkUndo"]');
    await until(() => fake.playlists().length === 0, 'the restored playlists to be removed', 15000);
    assert.deepEqual(b.errors, []);
  } finally { await b.close(); }
});

test('wipe asks first, in the page, then leaves no IndexedDB key and no localStorage key but the theme', { skip }, async () => {
  const app = await openApp(browser, { kind: 'small' });
  try {
    const { page, ctx, fake } = app;
    await ready(page);
    const kvCount = () => page.evaluate(() => new Promise(ok => {
      const r = indexedDB.open('betterfy', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => { const q = r.result.transaction('kv').objectStore('kv').count(); q.onsuccess = () => { ok(q.result); r.result.close(); }; };
    }));
    assert.ok(await kvCount() > 0, 'the library copy is there before');
    await page.evaluate(() => { saveTheme(); localStorage.setItem('bf_shuf_test', 'x'); });
    await openYourData(page);
    let dialogs = 0;
    page.on('dialog', d => { dialogs++; d.dismiss(); });
    await page.click('[data-act="wipeAsk"]');
    await page.waitForSelector('.bkwipe [data-act="wipeGo"]');
    // The page reloads to the landing screen afterwards; serve a blank page there instead,
    // so the app does not boot again and write its keys back before they are read.
    await ctx.route(u => new URL(u).origin === fake.url && new URL(u).pathname === '/', r =>
      r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>wiped</title>' }));
    await Promise.all([page.waitForURL(fake.url + '/'), page.click('[data-act="wipeGo"]')]);
    assert.equal(dialogs, 0, 'no browser dialog');
    const left = await page.evaluate(() => Object.keys(localStorage).sort());
    // The test harness signs every fresh page in by putting bf_tok back; nothing else may be there.
    assert.deepEqual(left.filter(k => k !== 'bf_tok'), ['betterfy-theme']);
    assert.equal(await kvCount(), 0, 'zero IndexedDB keys');
    const dbs = await page.evaluate(async () => (await indexedDB.databases()).map(d => d.name));
    assert.ok(!dbs.includes('betterfy-audio'), 'the listening database is gone');
    assert.deepEqual(app.errors, []);
  } finally { await app.close(); }
});
