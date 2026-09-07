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
//
// Three things break that in a real account, and all three are covered below.
// The playlist gets renamed, and a lookup by name builds a second one. A track
// comes back from Spotify under a different id than the one that was added
// (relinking), and looks missing on every refresh forever. And a run from
// before either fix left duplicates behind, which nothing ever cleared out.

const BUNDLE = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
const MIRROR = 'All Songs — Betterfy';

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

/** A playlist slot: the id Spotify shows, and the id that was actually added. */
const slot = s => (typeof s === 'string' ? { id: s, from: null } : { id: s.id ?? null, from: s.from ?? null });

/**
 * @param {object|null} existing - a playlist already sitting in the account, as
 *   { id, name, owner, trackIds }, or null for "never made one yet". trackIds
 *   entries may be a bare id, or { id, from } to model a relinked track, or
 *   { id: null } to model a local file that holds a position but has no id.
 * @param {string|null} pinned - the id a previous run remembered, if any.
 */
function load({ playlists = [], liked = [], existing = null, pinned = null } = {}) {
  let mine = existing ? { ...existing, slots: (existing.trackIds ?? []).map(slot) } : null;
  const created = [];
  const store = new Map([['bf_tok', JSON.stringify(
    { access_token: 'tok', refresh_token: 'r', expires_at: Date.now() + 3600e3 })]]);
  if (pinned) store.set('bf_allsongs', pinned);
  const sandbox = {
    clientId: () => 'test-client',
    REDIRECT: 'https://example.test/Betterfy/',
    indexedDB: fakeIndexedDB(),
    LS: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) },
    fetch: async (url, opts = {}) => {
      const method = opts.method ?? 'GET';
      const body = opts.body ? JSON.parse(opts.body) : null;
      if (url.includes('/me/playlists') && method === 'GET')
        return ok({ items: mine ? [{ id: mine.id, name: mine.name, owner: mine.owner, snapshot_id: 's1' }] : [], next: null });
      if (url.includes('/me/playlists') && method === 'POST') {
        mine = { id: 'as1', name: body.name, owner: { id: 'emma' }, slots: [] };
        created.push(body.name);
        return ok({ id: mine.id, name: mine.name, owner: mine.owner, snapshot_id: 's1' });
      }
      const items = url.match(/\/playlists\/([^/?]+)\/items/);
      if (items && method === 'GET') {
        const slots = mine?.id === items[1] ? mine.slots : [];
        return ok({ next: null, items: slots.map(s => ({
          item: s.id ? { id: s.id, ...(s.from ? { linked_from: { id: s.from } } : {}) } : null })) });
      }
      if (items && method === 'POST') {
        if (mine?.id === items[1]) mine.slots.push(...body.uris.map(u => slot(u.replace('spotify:track:', ''))));
        return ok({ snapshot_id: 's2' });
      }
      if (items && method === 'DELETE') {
        // Spotify removes by position against one snapshot, so gone positions
        // must not shift the ones still to be removed in the same request.
        const gone = new Set(body.tracks.flatMap(t => t.positions ?? []));
        for (const t of body.tracks)
          assert.ok(Array.isArray(t.positions), 'the mirror never deletes by uri — that would take out the copy that stays');
        if (mine?.id === items[1]) mine.slots = mine.slots.filter((_, i) => !gone.has(i));
        return ok({ snapshot_id: 's3' });
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
  vm.runInContext(slice("const ALL_SONGS_KEY = 'bf_allsongs';", 'const isMirrorPlaylist', 'the mirror pin'), sandbox);
  vm.runInContext(slice('async function logAction(entry)', '/* ---------- player: Spotify Connect', 'log/write-helper block'), sandbox);
  vm.runInContext(slice('const ALL_SONGS_NAME', 'function vShuffle()', 'All Songs block'), sandbox);
  return Object.assign(sandbox, {
    mineNow: () => mine,
    idsNow: () => (mine?.slots ?? []).map(s => s.id),
    created,
    pinNow: () => store.get('bf_allsongs') ?? null,
  });
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
  assert.deepEqual(app.idsNow().sort(), ['t1', 't2', 't3']);
});

test('the same track filed in two playlists and liked is only added once', async () => {
  const shared = track('t1');
  const app = load({
    playlists: [{ id: 'p1', name: 'House', tracks: [shared] }, { id: 'p2', name: 'Also House', tracks: [shared] }],
    liked: [shared],
  });
  await app.syncAllSongsPlaylist();
  assert.deepEqual(app.idsNow(), ['t1']);
});

test('running it again finds the same playlist rather than making another one', async () => {
  const app = load({
    playlists: [{ id: 'p1', name: 'House', tracks: [track('t1')] }],
    existing: { id: 'as1', name: MIRROR, owner: { id: 'emma' }, trackIds: ['t1'] },
  });
  await app.syncAllSongsPlaylist();
  assert.equal(app.created.length, 0, 'no second playlist made');
  assert.deepEqual(app.idsNow(), ['t1'], 'and the already-present track is not sent again');
});

test('refreshing after new tracks were filed adds only what is missing', async () => {
  const app = load({
    playlists: [{ id: 'p1', name: 'House', tracks: [track('t1'), track('t2')] }],
    existing: { id: 'as1', name: MIRROR, owner: { id: 'emma' }, trackIds: ['t1'] },
  });
  await app.syncAllSongsPlaylist();
  assert.deepEqual(app.idsNow().sort(), ['t1', 't2']);
});

test('a playlist owned by someone else with the same name is never mistaken for it', async () => {
  const app = load({
    playlists: [{ id: 'p1', name: 'House', tracks: [track('t1')] }],
    existing: { id: 'someone-elses', name: MIRROR, owner: { id: 'a-friend' }, trackIds: ['t9'] },
  });
  await app.syncAllSongsPlaylist();
  assert.equal(app.created.length, 1, 'a new one of your own is made instead');
});

/* ---- finding it again after it has been renamed ---- */

test('the playlist it used is remembered by id, not just found by name', async () => {
  const app = load({ playlists: [{ id: 'p1', name: 'House', tracks: [track('t1')] }] });
  await app.syncAllSongsPlaylist();
  assert.equal(app.pinNow(), app.mineNow().id, 'the id is written down for next time');
});

test('a mirror you have renamed is topped up, not rebuilt beside itself', async () => {
  // Renaming it is the first thing anyone does to a playlist they mean to
  // keep. Found by name only, the next refresh could not see it — so it built
  // a second one and poured a copy of the whole library into that.
  const app = load({
    playlists: [{ id: 'p1', name: 'House', tracks: [track('t1'), track('t2')] }],
    existing: { id: 'as1', name: 'Everything', owner: { id: 'emma' }, trackIds: ['t1'] },
    pinned: 'as1',
  });
  await app.syncAllSongsPlaylist();
  assert.equal(app.created.length, 0, 'no second playlist');
  assert.deepEqual(app.idsNow().sort(), ['t1', 't2'], 'only what was missing went in');
  assert.equal(app.mineNow().name, 'Everything', 'and it keeps the name you gave it');
});

test('a mirror you have deleted is built fresh rather than topped up unseen', async () => {
  // Spotify does not delete a playlist, it unfollows it — GET /playlists/{id}
  // answers for one you threw away. Requiring it to still be in your library
  // is what makes deleting it and pressing the button mean "make a new one".
  const app = load({
    playlists: [{ id: 'p1', name: 'House', tracks: [track('t1')] }],
    pinned: 'deleted-one',
  });
  await app.syncAllSongsPlaylist();
  assert.deepEqual(own(app.created), [MIRROR]);
  assert.equal(app.pinNow(), app.mineNow().id, 'and the new one is what gets remembered');
});

/* ---- relinking: the id you add is not always the id you read back ---- */

test('a track Spotify hands back under a different id is not added a second time', async () => {
  // Relinking swaps a track for whichever pressing is playable in your market
  // and returns the original under linked_from. Matching on the visible id
  // alone, the track looked missing on every refresh and was added every time.
  const app = load({
    playlists: [{ id: 'p1', name: 'House', tracks: [track('t1'), track('t2')] }],
    existing: { id: 'as1', name: MIRROR, owner: { id: 'emma' },
                trackIds: [{ id: 'market-t1', from: 't1' }, 't2'] },
    pinned: 'as1',
  });
  await app.syncAllSongsPlaylist();
  assert.deepEqual(app.idsNow(), ['market-t1', 't2'], 'nothing was added, and nothing was disturbed');
});

/* ---- clearing out damage an earlier run left behind ---- */

test('copies an earlier run duplicated are cleared out, one of each kept', async () => {
  const app = load({
    playlists: [{ id: 'p1', name: 'House', tracks: [track('t1'), track('t2')] }],
    existing: { id: 'as1', name: MIRROR, owner: { id: 'emma' },
                trackIds: ['t1', 't2', 't1', 't1', 't2'] },
    pinned: 'as1',
  });
  let told;
  app.toast = m => { told = m; };
  await app.syncAllSongsPlaylist();
  assert.deepEqual(app.idsNow(), ['t1', 't2'], 'the first copy of each stays, the rest go');
  assert.match(told, /3 duplicates cleared out/);
});

test('the surviving copy is the earliest one, whatever else was removed', async () => {
  // Deleting by uri would take out every copy including the keeper; deleting
  // by position from the end backwards is what keeps the indices honest.
  const app = load({
    playlists: [{ id: 'p1', name: 'House', tracks: [track('t1'), track('t2'), track('t3')] }],
    existing: { id: 'as1', name: MIRROR, owner: { id: 'emma' },
                trackIds: ['t1', 't2', 't1', 't3', 't2', 't1'] },
    pinned: 'as1',
  });
  await app.syncAllSongsPlaylist();
  assert.deepEqual(app.idsNow(), ['t1', 't2', 't3']);
});

test('a local file holds its slot, so the wrong track is never removed', async () => {
  // A local file has no id and still occupies a position. Skipping it while
  // counting positions puts every index after it out by one.
  const app = load({
    playlists: [{ id: 'p1', name: 'House', tracks: [track('t1')] }],
    existing: { id: 'as1', name: MIRROR, owner: { id: 'emma' },
                trackIds: [{ id: null }, 't1', 't1'] },
    pinned: 'as1',
  });
  await app.syncAllSongsPlaylist();
  assert.deepEqual(app.idsNow(), [null, 't1'], 'the local file is left exactly where it was');
});

test('a mirror with no duplicates in it is never sent a delete at all', async () => {
  const app = load({
    playlists: [{ id: 'p1', name: 'House', tracks: [track('t1')] }],
    existing: { id: 'as1', name: MIRROR, owner: { id: 'emma' }, trackIds: ['t1'] },
    pinned: 'as1',
  });
  let told;
  app.toast = m => { told = m; };
  await app.syncAllSongsPlaylist();
  assert.match(told, /already up to date/);
});

/* ---- the rest of the refresh ---- */

test('the result is reflected into LIB immediately, without a full re-sync', async () => {
  const app = load({ playlists: [{ id: 'p1', name: 'House', tracks: [track('t1')] }], liked: [] });
  await app.syncAllSongsPlaylist();
  const entry = app.LIB.playlists.find(p => p.name === MIRROR);
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

test('what the playlist really holds is read back after a prune, not assumed', () => {
  // Removing surplus copies is the one destructive step in the refresh. If a
  // delete ever took out more than the surplus, the add below has to put it
  // back — which it only can if the state it works from was read, not guessed.
  const body = slice('let entries = fresh ? [] : await playlistEntries', 'const missing = all.filter', 'the prune/read-back');
  assert.match(body, /if \(pruned\) entries = await playlistEntries\(pl\.id\);/);
});

test('a delete that removed too much is healed by the very next refresh', async () => {
  const app = load({
    playlists: [{ id: 'p1', name: 'House', tracks: [track('t1'), track('t2')] }],
    existing: { id: 'as1', name: MIRROR, owner: { id: 'emma' }, trackIds: ['t1', 't2', 't1'] },
    pinned: 'as1',
  });
  // Stand in for an endpoint that ignores `positions` and takes out every copy.
  const real = app.fetch;
  app.fetch = async (url, opts = {}) => {
    if ((opts.method ?? 'GET') === 'DELETE' && /\/playlists\/[^/?]+\/items/.test(url)) {
      const body = JSON.parse(opts.body);
      const ids = new Set(body.tracks.map(t => t.uri.replace('spotify:track:', '')));
      const m = app.mineNow();
      m.slots = m.slots.filter(sl => !ids.has(sl.id));
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ snapshot_id: 's3' }) };
    }
    return real(url, opts);
  };
  await app.syncAllSongsPlaylist();
  assert.deepEqual(app.idsNow().sort(), ['t1', 't2'], 'over-deleted tracks come straight back, once each');
});
