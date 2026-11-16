// Playlist backup and restore, and "Wipe this device" (BUILD-6 F7, F8).
//
// The number and its bar (BUILD-6 §4.1 F8): a round trip on the fake Spotify
// server. A synthetic account's library is read by the page's own sync, saved
// as a backup file, and restored into a second account that has none of those
// playlists and where some track ids no longer resolve (they come back under a
// new id with the same ISRC, as relinked or re-released tracks do). The
// restored set must equal the original: same playlists, same counts, same
// ISRCs in the same order. The page's real Spotify code (sp, addChunk,
// logAction) talks HTTP to the fake; only the request pacing is switched off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { slice } from './fixtures/page-spotify.mjs';
import { startFakeSpotify } from './fixtures/fake-spotify.mjs';
import { makeAccount } from './fixtures/accounts.mjs';

const own = x => JSON.parse(JSON.stringify(x));
const SRC = f => readFileSync(new URL('../web/app/' + f, import.meta.url), 'utf8');

/** In-memory IndexedDB for the page's idb helper (the same shape page-spotify.mjs fakes). */
function fakeIndexedDB() {
  const data = new Map();
  const later = (r, value) => setTimeout(() => { r.result = value; r.onsuccess?.call(r); }, 0);
  const store = {
    get: k => { const r = {}; later(r, data.has(k) ? structuredClone(data.get(k)) : undefined); return r; },
    getAllKeys: () => { const r = {}; later(r, [...data.keys()]); return r; },
    put: (v, k) => data.set(k, structuredClone(v)), delete: k => data.delete(k), clear: () => data.clear(),
  };
  return { data, open: () => { const req = {}; setTimeout(() => { req.result = { createObjectStore: () => store,
    transaction: () => { const tx = { objectStore: () => store }; setTimeout(() => tx.oncomplete?.(), 0); return tx; } }; req.onsuccess?.(); }, 0); return req; } };
}

/** The page's Spotify, library-read, History and backup code, pointed at a fake Spotify server. */
function pageOn(fake) {
  const store = new Map([['bf_tok', JSON.stringify({ access_token: 'tok', refresh_token: 'r', expires_at: Date.now() + 3600e3 })]]);
  const box = {
    clientId: () => 'test-client', REDIRECT: 'https://example.test/', indexedDB: fakeIndexedDB(),
    LS: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
    fetch: (url, opts) => fetch(String(url).replace('https://api.spotify.com', fake.url), opts),
    AbortController, URLSearchParams, URL, setTimeout, clearTimeout, console, structuredClone,
    LIB: { user: { id: fake.account.me.id }, playlists: [], liked: [] }, CFG: {}, TAGS: {}, S: {}, R: null,
    toast: () => {}, render: () => {},
  };
  vm.createContext(box);
  vm.runInContext(slice('const RATE_LIMITED', '/* ---------- axis classification', 'spotify/idb block'), box);
  vm.runInContext(slice('async function logAction(entry)', '/* ---------- player: Spotify Connect', 'log/write-helper block'), box);
  vm.runInContext(SRC('datakeys.js') + SRC('backup.js'), box);
  vm.runInContext('pace = async () => {};', box);   // the 250 ms courtesy gap between calls, not under test
  const run = c => vm.runInContext(c, box);
  const deps = () => ({ sp: run('sp'), addChunk: run('addChunk'), logAction: run('logAction'), newGroup: run('newGroup'),
    findIsrc: async isrc => (await run('sp')(`/search?q=${encodeURIComponent('isrc:' + isrc)}&type=track&limit=1`))?.tracks?.items?.[0]?.id ?? null });
  return { box, run, deps, log: () => box.indexedDB.data.get('actions') ?? [] };
}

/** Account B: nothing of A's, but Spotify still knows A's tracks; every `relinkEvery`-th now answers under a new id. */
function strangerWith(a, relinkEvery = 9) {
  const seen = new Map();
  for (const t of [...a.liked, ...a.playlists.flatMap(p => p.tracks)]) seen.set(t.id, t);
  const relinked = new Set();
  const catalog = [...seen.values()].map((t, i) => {
    if (i % relinkEvery) return t;
    relinked.add(t.id);
    return { ...t, id: 'rl' + t.id.slice(2) };
  });
  return { account: { me: { id: 'stranger', display_name: 'Someone else' }, playlists: [], liked: [], catalog, strictIds: true }, relinked };
}

test('round trip: backed up from one account, restored into another, the set is the same (ISRC-matched, counts equal)', async t => {
  const A = makeAccount('typical');
  const fa = await startFakeSpotify(A);
  const { account, relinked } = strangerWith(A);
  const fb = await startFakeSpotify(account);
  try {
    // Back up, from what the page's own sync holds.
    const pa = pageOn(fa);
    const lib = await pa.run('syncLibrary(true)');
    const text = JSON.stringify(pa.run('backupBuild')(lib, { [A.playlists[0].id]: 'my first' }));
    assert.equal(fa.writes().length, 0, 'backing up writes nothing to Spotify');
    const file = JSON.parse(text);
    assert.equal(file.playlists.length, A.playlists.length);
    assert.equal(file.playlists[0].description, 'my first');
    assert.ok(file.playlists.every(p => p.tracks.every(t => t.id && t.isrc && t.added_at)), 'ids, ISRCs and dates added');

    // Restore into the other account.
    const pb = pageOn(fb);
    const backup = pb.run('backupParse')(text);
    const plan = pb.run('restorePlan')(backup, []);
    assert.ok(plan.every(r => r.pick && !r.exists), 'nothing exists there yet, so all are picked');
    const res = own(await pb.run('restoreRun')(plan, pb.deps()));

    const made = fb.playlists();
    assert.equal(made.length, A.playlists.length, 'one new playlist per backed-up playlist');
    let byIsrc = 0, total = 0;
    for (const orig of A.playlists) {
      const got = made.find(p => p.name === orig.name);
      assert.ok(got, `"${orig.name}" restored`);
      assert.equal(got.public, false, 'restored as private');
      assert.equal(got.tracks.length, orig.tracks.length, `"${orig.name}": counts equal`);
      assert.deepEqual(got.tracks.map(t => t.isrc), orig.tracks.map(t => t.external_ids.isrc), `"${orig.name}": same ISRCs, same order`);
      byIsrc += orig.tracks.filter(t => relinked.has(t.id)).length;
      total += orig.tracks.length;
    }
    assert.equal(made.find(p => p.name === A.playlists[0].name).description, 'my first', 'description carried over');
    assert.ok(byIsrc > 0, 'the fixture really has tracks only reachable by ISRC');
    assert.equal(res.made.reduce((s, m) => s + m.byIsrc, 0), byIsrc, 'every relinked track was found by its ISRC');
    assert.equal(res.made.reduce((s, m) => s + m.added, 0), total);
    assert.equal(res.made.reduce((s, m) => s + m.missing, 0), 0);
    t.diagnostic(`round trip: ${made.length} playlists, ${total} tracks, ${byIsrc} by ISRC, 0 missing`);

    // One History group, one entry per playlist; one Undo takes it all back.
    const log = pb.log();
    assert.equal(log.length, A.playlists.length);
    assert.equal(new Set(log.map(e => e.group)).size, 1, 'one group');
    assert.ok(log.every(e => e.op === 'add' && e.created && e.group === res.group));
    await pb.run('restoreUndoRun')(res.group, { getLog: pb.run('getLog'), undoAction: pb.run('undoAction'), sp: pb.run('sp') });
    assert.equal(fb.playlists().length, 0, 'undo removes the restored playlists');
  } finally { await fa.close(); await fb.close(); }
});

test('restoring into the same account never writes to an existing playlist', async () => {
  const A = makeAccount('small');
  const fa = await startFakeSpotify(A);
  try {
    const pa = pageOn(fa);
    const lib = await pa.run('syncLibrary(true)');
    const before = own(fa.playlists());
    const backup = pa.run('backupParse')(JSON.stringify(pa.run('backupBuild')(lib)));
    const plan = pa.run('restorePlan')(backup, lib.playlists);
    assert.ok(plan.every(r => r.exists && !r.pick), 'every playlist is recognised as existing and left unticked');
    plan[1].pick = true;   // the listener ticks one anyway
    const res = own(await pa.run('restoreRun')(plan, pa.deps()));
    assert.equal(res.made.length, 1);
    assert.equal(res.made[0].name, A.playlists[1].name + ' (restored)', 'a copy beside it, with a name that says so');
    const wrote = fa.writes();
    assert.ok(wrote.every(w => w.path === '/me/playlists' || w.path.startsWith(`/playlists/${res.made[0].id}/`)),
      'the only writes are the new playlist and adds to it: ' + wrote.map(w => w.method + ' ' + w.path).join(', '));
    for (const p of before) assert.deepEqual(fa.playlists().find(x => x.id === p.id).tracks, p.tracks, `"${p.name}" untouched`);
  } finally { await fa.close(); }
});

test('a backup file is checked before anything is shown', async () => {
  const fa = await startFakeSpotify(makeAccount('empty'));
  try {
    const parse = pageOn(fa).run('backupParse');
    assert.throws(() => parse('not json'), /not JSON/);
    assert.throws(() => parse('{"playlists":[]}'), /not a Betterfy playlist backup/);
    assert.throws(() => parse('{"format":"betterfy-playlists","version":99,"playlists":[]}'), /newer Betterfy/);
    const b = own(parse(JSON.stringify({ format: 'betterfy-playlists', version: 1, junk: 1, playlists: [
      { id: 'p', name: '  ', evil: '<script>', tracks: [{ id: 'bad id', isrc: 'gb-xyz', extra: 1 }, { id: 'a'.repeat(22), isrc: 'gbabc1234567' }] }] })));
    assert.equal(b.junk, undefined, 'unknown fields are dropped');
    assert.equal(b.playlists[0].name, 'Untitled');
    assert.deepEqual(b.playlists[0].tracks.map(t => [t.id, t.isrc]), [[null, null], ['a'.repeat(22), 'GBABC1234567']]);
  } finally { await fa.close(); }
});

test('wipe: no registered key is left on the device but the theme', async () => {
  const box = { console, setTimeout };
  vm.createContext(box);
  vm.runInContext(SRC('datakeys.js') + SRC('backup.js') + '\n;this.DATA_KEYS = DATA_KEYS; this.wipeRun = wipeRun;', box);
  const keys = own(box.DATA_KEYS);
  // A browser's localStorage, with every local key the registry names (and a family member for each prefix).
  const ls = new Map();
  const local = { get length() { return ls.size; }, key: i => [...ls.keys()][i] ?? null,
    getItem: k => ls.get(k) ?? null, setItem: (k, v) => ls.set(k, String(v)), removeItem: k => ls.delete(k) };
  for (const k of keys) if (k.where === 'local') ls.set(k.prefix ? k.key + 'abc123' : k.key, '1');
  ls.set('bf_left_by_an_old_build', '1');
  const session = new Map([['bf_verifier', 'v']]);
  const kv = new Map(keys.filter(k => k.where === 'idb').map(k => [k.prefix ? k.key + 'x' : k.key, {}]));
  const deleted = [];
  const removed = await box.wipeRun({
    LS: local, local, keys,
    session: { removeItem: k => session.delete(k) },
    idb: { clear: async () => kv.clear() },
    indexedDB: { deleteDatabase: name => { deleted.push(name); const r = {}; setTimeout(() => r.onsuccess?.(), 0); return r; } },
  });
  assert.deepEqual([...ls.keys()], ['betterfy-theme'], 'only the theme is left in localStorage');
  assert.equal(session.size, 0, 'sessionStorage is clear');
  assert.equal(kv.size, 0, 'the "betterfy" key store is empty');
  assert.deepEqual(deleted, ['betterfy-audio'], 'the listening database is deleted');
  assert.ok(removed.includes('bf_left_by_an_old_build'), 'a stray bf_* key from an older build goes too');
});
