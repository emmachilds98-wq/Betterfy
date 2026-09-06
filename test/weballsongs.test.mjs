import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// "All Songs" is a real Spotify playlist Betterfy creates once and tops up on
// request — every track in the library, in one place, so Shuffle has
// something better than "whichever playlist happens to be biggest" to default
// to. The whole point is that running it again costs nothing: it must find
// the same playlist rather than making a second one, and it must never
// re-add a track that is already there.

const BUNDLE = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');

function slice(from, to, what) {
  const i = BUNDLE.indexOf(from), j = BUNDLE.indexOf(to);
  assert.ok(i > 0 && j > i, `${what} not found — rebuild with npm run build:web`);
  return BUNDLE.slice(i, j);
}

/** Just enough IndexedDB for the app's `idb` helper, held in memory. */
function fakeIndexedDB() {
  const data = new Map();
  const later = (r, prop, value) => setTimeout(() => { r.result = value; r[prop]?.call(r); }, 0);
  const store = {
    get: k => { const r = {}; later(r, 'onsuccess', data.get(k)); return r; },
    getAllKeys: () => { const r = {}; later(r, 'onsuccess', [...data.keys()]); return r; },
    put: (v, k) => data.set(k, JSON.parse(JSON.stringify(v))),
    delete: k => data.delete(k),
    clear: () => data.clear(),
  };
  return {
    data,
    open: () => {
      const req = {};
      setTimeout(() => {
        req.result = {
          createObjectStore: () => store,
          transaction: () => { const tx = { objectStore: () => store }; setTimeout(() => tx.oncomplete?.(), 0); return tx; },
        };
        req.onsuccess?.();
      }, 0);
      return req;
    },
  };
}

const ok = body => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });
// Cross-realm arrays/objects (built inside the vm) fail strict deepEqual
// against same-shaped ones from this realm even when identical in content.
const own = x => JSON.parse(JSON.stringify(x));

const track = id => ({ id, name: 't' + id, artists: [{ id: 'a1', name: 'Artist' }] });

/**
 * @param {object|null} existing - a playlist already sitting in the account,
 *   as { id, name, owner, trackIds }, or null for "never made one yet".
 */
function load({ playlists = [], liked = [], existing = null } = {}) {
  let mine = existing ? { ...existing } : null;
  const created = [];
  const sandbox = {
    clientId: () => 'test-client',
    REDIRECT: 'https://example.test/Betterfy/',
    indexedDB: fakeIndexedDB(),
    LS: { getItem: () => JSON.stringify({ access_token: 'tok', refresh_token: 'r', expires_at: Date.now() + 3600e3 }),
                    setItem: () => {}, removeItem: () => {} },
    fetch: async (url, opts = {}) => {
      const method = opts.method ?? 'GET';
      const body = opts.body ? JSON.parse(opts.body) : null;
      if (url.includes('/me/playlists') && method === 'GET')
        return ok({ items: mine ? [{ id: mine.id, name: mine.name, owner: mine.owner, snapshot_id: 's1' }] : [], next: null });
      if (url.includes('/me/playlists') && method === 'POST') {
        mine = { id: 'as1', name: body.name, owner: { id: 'emma' }, trackIds: [] };
        created.push(body.name);
        return ok({ id: mine.id, name: mine.name, owner: mine.owner, snapshot_id: 's1' });
      }
      const items = url.match(/\/playlists\/([^/]+)\/items/);
      if (items && method === 'GET') {
        const ids = mine?.id === items[1] ? mine.trackIds : [];
        return ok({ items: ids.map(id => ({ item: { id } })), next: null });
      }
      if (items && method === 'POST') {
        const ids = body.uris.map(u => u.replace('spotify:track:', ''));
        if (mine?.id === items[1]) mine.trackIds.push(...ids);
        return ok({ snapshot_id: 's2' });
      }
      throw new Error(`unexpected fetch ${method} ${url}`);
    },
    URLSearchParams, setTimeout, clearTimeout, console,
    LIB: { user: { id: 'emma' }, playlists, liked },
    CFG: {},
    TAGS: {},
    S: {},
    R: null,
    buildReports: (lib, cfg, tags) => ({ builtWith: { lib, cfg, tags } }),
    toast: () => {},
    render: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(slice('const RATE_LIMITED', '/* ---------- axis classification', 'spotify/idb block'), sandbox);
  vm.runInContext(slice('async function logAction(entry)', '/* ---------- player: Spotify Connect', 'log/write-helper block'), sandbox);
  vm.runInContext(slice('const ALL_SONGS_NAME', 'function vShuffle()', 'All Songs block'), sandbox);
  return Object.assign(sandbox, { mineNow: () => mine, created });
}

test('with no library at all, it refuses rather than creating an empty playlist', async () => {
  const app = load({ playlists: [], liked: [] });
  let told;
  app.toast = m => { told = m; };
  await app.syncAllSongsPlaylist();
  assert.equal(app.mineNow(), null);
  assert.match(told, /sync your library first/);
});

test('the first run creates the playlist and adds everything', async () => {
  const app = load({
    playlists: [{ id: 'p1', name: 'House', tracks: [track('t1'), track('t2')] }],
    liked: [track('t3')],
  });
  await app.syncAllSongsPlaylist();
  assert.equal(app.created.length, 1, 'exactly one playlist created');
  assert.deepEqual(app.mineNow().trackIds.sort(), ['t1', 't2', 't3']);
});

test('the same track filed in two playlists and liked is only added once', async () => {
  const shared = track('t1');
  const app = load({
    playlists: [{ id: 'p1', name: 'House', tracks: [shared] }, { id: 'p2', name: 'Also House', tracks: [shared] }],
    liked: [shared],
  });
  await app.syncAllSongsPlaylist();
  assert.deepEqual(app.mineNow().trackIds, ['t1']);
});

test('running it again finds the same playlist rather than making another one', async () => {
  const app = load({
    playlists: [{ id: 'p1', name: 'House', tracks: [track('t1')] }],
    existing: { id: 'as1', name: 'All Songs — Betterfy', owner: { id: 'emma' }, trackIds: ['t1'] },
  });
  await app.syncAllSongsPlaylist();
  assert.equal(app.created.length, 0, 'no second playlist made');
  assert.deepEqual(app.mineNow().trackIds, ['t1'], 'and the already-present track is not sent again');
});

test('refreshing after new tracks were filed adds only what is missing', async () => {
  const app = load({
    playlists: [{ id: 'p1', name: 'House', tracks: [track('t1'), track('t2')] }],
    existing: { id: 'as1', name: 'All Songs — Betterfy', owner: { id: 'emma' }, trackIds: ['t1'] },
  });
  await app.syncAllSongsPlaylist();
  assert.deepEqual(app.mineNow().trackIds.sort(), ['t1', 't2']);
});

test('a playlist owned by someone else with the same name is never mistaken for it', async () => {
  const app = load({
    playlists: [{ id: 'p1', name: 'House', tracks: [track('t1')] }],
    existing: { id: 'someone-elses', name: 'All Songs — Betterfy', owner: { id: 'a-friend' }, trackIds: ['t9'] },
  });
  await app.syncAllSongsPlaylist();
  assert.equal(app.created.length, 1, 'a new one of your own is made instead');
});

test('the result is reflected into LIB immediately, without a full re-sync', async () => {
  const app = load({ playlists: [{ id: 'p1', name: 'House', tracks: [track('t1')] }], liked: [] });
  await app.syncAllSongsPlaylist();
  const entry = app.LIB.playlists.find(p => p.name === 'All Songs — Betterfy');
  assert.ok(entry, 'the new playlist appears in LIB.playlists');
  assert.deepEqual(own(entry.tracks.map(t => t.id)), ['t1']);
});

test('it is filed as context, not a genre/mood target — nothing should suggest moving tracks into it', async () => {
  const app = load({ playlists: [{ id: 'p1', name: 'House', tracks: [track('t1')] }], liked: [] });
  await app.syncAllSongsPlaylist();
  const id = app.mineNow().id;
  assert.equal(app.CFG[id].axis, 'context');
  assert.equal(app.CFG[id].target, false);
});

test('Shuffle prefers it over any single playlist, once one exists', () => {
  const from = BUNDLE.indexOf('function vShuffle()');
  const to = BUNDLE.indexOf('function vDiscover()');
  assert.ok(from > 0 && to > from, 'vShuffle not found — rebuild with npm run build:web');
  const body = BUNDLE.slice(from, to);
  assert.match(body, /allSongs\?\.id \?\? pls\[0\]\?\.id/,
    'the shuffle source must fall back to the All Songs playlist before the biggest bucket');
});
