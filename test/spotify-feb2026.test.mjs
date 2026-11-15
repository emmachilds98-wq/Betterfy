import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { loadPage, slice, own, BUNDLE } from './fixtures/page-spotify.mjs';

// What Spotify's February 2026 Web API changes quietly broke, and the fixes
// (docs/BUILD-5-PLAN.md §6.6, B12–B14):
//
//   B12  DELETE /playlists/{id}/items is documented as `{ items: [{ uri }] }`,
//        max 100 per call. The page and actions.mjs sent `{ tracks }`, unchunked.
//   B13  `linked_from` and `popularity` are gone from track objects: relinked
//        tracks are matched by ISRC, and a repeat's keeper is no longer "the
//        most popular" (now always arbitrary) but the release in more
//        playlists, then the earliest added.
//   B14  DELETE /playlists/{id}/followers was removed; a playlist leaves the
//        library through DELETE /me/library?uris=spotify:playlist:{id}.
//
// None of this is checked against live Spotify here — the fakes follow the
// reference as documented.

const deletes = app => app.calls.filter(c => c.method === 'DELETE');

/* ---- B12: the page's deletes ---- */

test('delTracks sends the documented `items` body', async () => {
  const app = loadPage({ playlists: { p: ['a', 'b', 'c'] } });
  await app.run("delTracks('p', ['b'])");
  const [d] = deletes(app);
  assert.match(d.url, /\/playlists\/p\/items$/);
  assert.deepEqual(d.body, { items: [{ uri: 'spotify:track:b' }] });
  assert.deepEqual(app.ids('p'), ['a', 'c']);
});

test('delTracks chunks to 100 per request, one after another', async () => {
  const ids = Array.from({ length: 250 }, (_, i) => 't' + i);
  const app = loadPage({ playlists: { p: [...ids, 'keep'] } });
  await app.run(`delTracks('p', ${JSON.stringify(ids)})`);
  assert.deepEqual(deletes(app).map(d => d.body.items.length), [100, 100, 50]);
  assert.deepEqual(app.ids('p'), ['keep']);
});

test('the legacy `tracks` body is sent only when `items` is refused with a 400', async () => {
  const app = loadPage({ playlists: { p: ['a', 'b'] }, rejectDelete: body => (body.items ? 400 : null) });
  await app.run("delTracks('p', ['a'])");
  const ds = deletes(app);
  assert.equal(ds.length, 2);
  assert.ok(ds[0].body.items, 'items first');
  assert.deepEqual(ds[1].body, { tracks: [{ uri: 'spotify:track:a' }] }, 'then the legacy body');
  assert.deepEqual(app.ids('p'), ['b']);
});

test('any other refusal is not papered over with the legacy body', async () => {
  const app = loadPage({ playlists: { p: ['a'] }, rejectDelete: () => 403 });
  await assert.rejects(() => app.run("delTracks('p', ['a'])"));
  assert.ok(deletes(app).every(d => d.body.items), 'never retried as `tracks`');
});

test('the All Songs prune sends `items` too, positions still attached, chunked to 100', () => {
  const body = slice('async function pruneMirrorDuplicates', 'async function syncAllSongsPlaylist', 'pruneMirrorDuplicates');
  assert.match(body, /await plDelete\(id, \[\.\.\.byUri\]\.map\(\(\[uri, positions\]\) => \(\{ uri, positions \}\)\)\);/);
  assert.doesNotMatch(body, /\{ tracks:/);
  const legacy = [...BUNDLE.matchAll(/'DELETE', ?\{ ?tracks:/g)];
  assert.equal(legacy.length, 1, 'the only `tracks` DELETE body left is the fallback');
  assert.ok(slice('async function plDelete', 'const delTracks', 'plDelete').includes("'DELETE', { tracks: part }"),
    'and it lives in plDelete, behind the 400');
});

/* ---- B13: no linked_from, no popularity ---- */

test('playlistEntries no longer asks for linked_from, and reads each slot\'s ISRC', async () => {
  const app = loadPage({ playlists: { p: [{ id: 'a', isrc: 'GBAAA0000001' }, { id: null }, 'b'] } });
  const out = own(await app.run("playlistEntries('p')"));
  const get = app.calls.find(c => c.method === 'GET');
  assert.doesNotMatch(get.url, /linked_from/);
  assert.match(get.url, /external_ids\(isrc\)/);
  assert.deepEqual(out, [{ id: 'a', isrc: 'GBAAA0000001', pos: 0 }, { id: null, isrc: null, pos: 1 },
                         { id: 'b', isrc: null, pos: 2 }]);
});

test('popularity and linked_from are asked for nowhere', () => {
  const fields = slice("const FIELDS = '", '\n', 'FIELDS');
  assert.doesNotMatch(fields, /popularity|linked_from/);
  assert.match(fields, /external_ids/, 'ISRC is still read (restored March 2026)');
  const snap = readFileSync(new URL('../snapshot.mjs', import.meta.url), 'utf8');
  const snapFields = snap.slice(snap.indexOf("const FIELDS = '"), snap.indexOf('\n', snap.indexOf("const FIELDS = '")));
  assert.doesNotMatch(snapFields, /popularity|linked_from/);
  assert.doesNotMatch(snap, /popularity: [at]\.popularity/, 'snapshot.mjs keeps no popularity field');
  assert.doesNotMatch(BUNDLE, /linked_from\(id\)|\.linked_from\?\./);
});

/** buildReports with the scoring core it is bundled alongside (as in webmirror.test.mjs). */
function reports(lib) {
  const sandbox = { console, FB: {}, LS: { getItem: () => null, setItem: () => {} } };
  vm.createContext(sandbox);
  vm.runInContext(slice('/* Generated by bundler.mjs', '/* ---------- storage ----------', 'scoring core'), sandbox);
  vm.runInContext('const mmss = ms => ms == null ? "—" : Math.floor(ms/60000) + ":" + String(Math.round(ms%60000/1000)).padStart(2,"0");', sandbox);
  vm.runInContext(slice('/* ---------- reports (mirrors', '/* ===================== UI', 'reports'), sandbox);
  vm.runInContext("const ALL_SONGS_NAME = 'All Songs — Betterfy';", sandbox);
  return sandbox.buildReports(lib, {}, {});
}
const tr = (id, added, over = {}) => ({ id, name: 'Rinse It', artists: [{ id: 'a1', name: 'Tim Reaper' }],
  album: 'Album ' + id, duration_ms: 200000, isrc: 'GBAAA0000001', added_at: added, ...over });

test('a repeat keeps the release filed in more playlists', () => {
  const r = reports({ user: { id: 'u' }, liked: [], playlists: [
    { id: 'p1', name: 'Jungle', tracks: [tr('single', '2024-01-01T00:00:00Z'), tr('album', '2025-01-01T00:00:00Z')] },
    { id: 'p2', name: 'Rollers', tracks: [tr('album', '2025-02-01T00:00:00Z')] },
  ] });
  const w = r.within.find(x => x.playlistId === 'p1');
  assert.equal(w.keep.id, 'album', 'in two playlists beats being added first');
  assert.deepEqual(own(w.drop.map(d => d.id)), ['single']);
});

test('with equal playlist counts, the copy added first is kept', () => {
  const r = reports({ user: { id: 'u' }, liked: [], playlists: [
    { id: 'p1', name: 'Jungle', tracks: [tr('late', '2025-06-01T00:00:00Z'), tr('early', '2023-06-01T00:00:00Z')] },
  ] });
  assert.equal(r.within[0].keep.id, 'early');
});

test('popularity no longer decides anything, even where an old snapshot still has it', () => {
  const r = reports({ user: { id: 'u' }, liked: [], playlists: [
    { id: 'p1', name: 'Jungle', tracks: [tr('early', '2023-06-01T00:00:00Z', { popularity: 1 }),
                                         tr('popular', '2025-06-01T00:00:00Z', { popularity: 90 })] },
  ] });
  assert.equal(r.within[0].keep.id, 'early');
  assert.equal('popularity' in r.within[0].keep, false);
});

/* ---- actions.mjs (the Node side): B12 and B14 ---- */

/** actions.mjs with `api` and the log stubbed out, run as a plain script. */
function actions({ reject = () => null } = {}) {
  const calls = [], logged = [];
  const src = readFileSync(new URL('../legacy/actions.mjs', import.meta.url), 'utf8')
    .replace(/^import .*$/gm, '')
    .replace(/^export /gm, '');
  const sandbox = {
    calls, logged, console,
    randomUUID: () => 'uuid-' + calls.length,
    appendFileSync: (_f, line) => logged.push(JSON.parse(line)),
    existsSync: () => false, readFileSync: () => '', writeFileSync: () => {},
    api: async (path, opts = {}) => {
      const method = opts.method ?? 'GET', body = opts.body ? JSON.parse(opts.body) : null;
      calls.push({ method, path, body });
      const status = reject({ method, path, body });
      if (status) throw new Error(`${status} https://api.spotify.com/v1${path}\n{}`);
      if (method === 'GET') return { items: [], next: null };
      return null;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox;
}

test('actions.mjs removes with the `items` body, chunked to 100', async () => {
  const a = actions();
  const ids = Array.from({ length: 150 }, (_, i) => 't' + i);
  await a.removeFrom('p', 'P', ids, 'test');
  const ds = a.calls.filter(c => c.method === 'DELETE');
  assert.deepEqual(ds.map(d => d.body.items.length), [100, 50]);
  assert.ok(ds.every(d => /\/playlists\/p\/items$/.test(d.path) && !d.body.tracks));
});

test('actions.mjs falls back to `tracks` only on a 400 for the `items` body', async () => {
  const a = actions({ reject: c => (c.method === 'DELETE' && c.body.items ? 400 : null) });
  await a.undo({ op: 'add', at: 'x', playlistId: 'p', trackIds: ['t1'] });
  const ds = a.calls.filter(c => c.method === 'DELETE');
  assert.deepEqual(ds.map(d => Object.keys(d.body)[0]), ['items', 'tracks']);
});

test('undoing a playlist creation uses DELETE /me/library, not the removed /followers', async () => {
  const a = actions();
  await a.undo({ op: 'create-playlist', at: 'x', playlistId: 'pl9', playlistName: 'New' });
  assert.deepEqual(a.calls.map(c => `${c.method} ${c.path}`), ['DELETE /me/library?uris=spotify:playlist:pl9']);
});

test('…and only reaches for /followers if /me/library is refused with 403/404', async () => {
  const a = actions({ reject: c => (c.path.startsWith('/me/library') ? 404 : null) });
  await a.undo({ op: 'create-playlist', at: 'x', playlistId: 'pl9', playlistName: 'New' });
  assert.deepEqual(a.calls.map(c => `${c.method} ${c.path}`),
    ['DELETE /me/library?uris=spotify:playlist:pl9', 'DELETE /playlists/pl9/followers']);
});

test('the page has no /followers call left to fix', () => {
  assert.doesNotMatch(BUNDLE, /\/followers['`]/);
});
