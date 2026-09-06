import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Reading a whole library cold is hundreds of calls — which is exactly what a
// home-screen app does, because iOS gives it its own storage and so its own
// empty cache. These tests run the shipped sync against a scripted Spotify that
// rate-limits, to pin down that it paces itself, waits out a 429 for as long as
// it was asked to, and resumes rather than starting the whole read again.

const BUNDLE = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');

function slice() {
  const from = BUNDLE.indexOf('const RATE_LIMITED');
  const to = BUNDLE.indexOf('/* ---------- axis classification');
  assert.ok(from > 0 && to > from, 'sync block not found — rebuild with npm run build:web');
  return BUNDLE.slice(from, to);
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

const track = (id, name) => ({ id, name, duration_ms: 1000, external_ids: { isrc: 'X' + id },
  album: { id: 'al', name: 'Album', release_date: '2020', album_type: 'album', images: [{ width: 300, url: 'u' }] },
  artists: [{ id: 'ar', name: 'Artist' }] });

/**
 * A Spotify that answers from a fixture and can be told to rate-limit.
 * `limit(url, nth)` returns seconds of Retry-After, or 0 to answer normally.
 */
function load({ playlists = [], liked = [], limit = () => 0, refuse = () => false } = {}) {
  const calls = [];
  const idb = fakeIndexedDB();
  const body = url => {
    if (url.endsWith('/me')) return { id: 'emma', display_name: 'Emma' };
    if (url.includes('/me/playlists')) return { items: playlists.map(p => ({ id: p.id, name: p.name,
      owner: { id: 'emma' }, snapshot_id: p.snapshot_id })), next: null };
    if (url.includes('/me/tracks')) return { items: liked.map(t => ({ added_at: '2024-01-01', track: t })), next: null };
    const p = playlists.find(p => url.includes('/playlists/' + p.id + '/'));
    return { items: (p?.tracks ?? []).map(t => ({ added_at: '2024-01-01', item: t })), next: null };
  };
  const sandbox = {
    clientId: () => 'test-client',
    REDIRECT: 'https://example.test/Betterfy/',
    indexedDB: idb,
    localStorage: {
      getItem: () => JSON.stringify({ access_token: 'tok', refresh_token: 'r', expires_at: Date.now() + 3600e3 }),
      setItem: () => {}, removeItem: () => {},
    },
    fetch: async url => {
      calls.push(url);
      const nth = calls.filter(c => c === url).length;
      if (refuse(url)) return { ok: false, status: 403, headers: { get: () => null },
        json: async () => ({ error: { message: 'Forbidden' } }) };
      const retry = limit(url, nth);
      if (retry) return { ok: false, status: 429, headers: { get: h => h === 'retry-after' ? String(retry) : null },
        json: async () => { throw new SyntaxError('plain text'); } };
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => body(url) };
    },
    URLSearchParams, setTimeout, clearTimeout, console,
  };
  vm.createContext(sandbox);
  vm.runInContext(slice(), sandbox);
  // The contextified object itself, not a copy — a copy is no longer a vm.Context.
  return Object.assign(sandbox, { calls, store: idb.data, hits: u => calls.filter(c => c.includes(u)).length });
}

// Arrays built inside the vm have that realm's prototype, so bring them home
// before comparing them.
const own = x => JSON.parse(JSON.stringify(x));

const LIB = {
  playlists: [
    { id: 'p1', name: 'House', snapshot_id: 's1', tracks: [track('t1', 'One')] },
    { id: 'p2', name: 'Jungle', snapshot_id: 's2', tracks: [track('t2', 'Two')] },
    { id: 'p3', name: 'Ambient', snapshot_id: 's3', tracks: [track('t3', 'Three')] },
  ],
  liked: [track('t9', 'Liked')],
};

test('a cold read of a library comes back whole', async () => {
  const app = load(LIB);
  const lib = await app.syncLibrary(false, () => {});
  assert.deepEqual(own(lib.playlists.map(p => p.name)), ['House', 'Jungle', 'Ambient']);
  assert.deepEqual(own(lib.playlists.map(p => p.tracks.length)), [1, 1, 1]);
  assert.equal(lib.liked.length, 1);
  assert.equal(lib.user.name, 'Emma');
});

test('every call is paced, so a big library does not arrive as a burst', async () => {
  const app = load(LIB);
  const began = Date.now();
  await app.syncLibrary(false, () => {});
  // /me, /me/playlists, three playlists, /me/tracks — six calls, five gaps.
  assert.equal(app.calls.length, 6);
  assert.ok(Date.now() - began >= 5 * 70, `six calls went out in ${Date.now() - began}ms`);
});

test('a 429 is waited out for as long as Spotify asked, then the read carries on', async () => {
  // The regression this guards: capping the wait below Retry-After means coming
  // back early, spending an attempt and earning another 429.
  const app = load({ ...LIB, limit: (url, nth) => url.includes('/playlists/p2/') && nth === 1 ? 1 : 0 });
  const began = Date.now();
  const lib = await app.syncLibrary(false, () => {});
  assert.ok(Date.now() - began >= 1000, 'came back before the second Spotify asked for');
  assert.equal(lib.playlists.length, 3);
  assert.equal(lib.playlists[1].tracks.length, 1, 'the rate-limited playlist still has its tracks');
});

test('a rate limit that will not lift stops the read instead of banking empty playlists', async () => {
  const app = load({ ...LIB, limit: url => url.includes('/playlists/p2/') ? 3600 : 0 });
  await assert.rejects(() => app.syncLibrary(false, () => {}), e => {
    assert.equal(e.retryable, true);
    assert.match(e.message, /pause|too many requests/i);
    return true;
  });
  // p2 is what failed; recording it as an empty playlist would silently lose it.
  assert.equal(app.store.get('part:p2'), undefined);
  assert.equal(app.store.get('library'), undefined);
});

test('a read interrupted by a rate limit resumes instead of starting over', async () => {
  const stop = { on: true };
  const app = load({ ...LIB, limit: url => stop.on && url.includes('/playlists/p3/') ? 3600 : 0 });
  await assert.rejects(() => app.syncLibrary(false, () => {}));
  assert.ok(app.store.get('part:p1'), 'the playlists already read are banked');
  assert.ok(app.store.get('part:p2'));

  stop.on = false;
  const before = app.hits('/playlists/p1/');
  const lib = await app.syncLibrary(false, () => {});
  assert.equal(app.hits('/playlists/p1/'), before, 'a banked playlist is not read a second time');
  assert.equal(lib.playlists.length, 3);
  assert.deepEqual(own(lib.playlists.map(p => p.tracks.length)), [1, 1, 1]);
});

/* ---------- bounding the silent wait ----------
 * A single 429 used to be worth sitting out for up to ten minutes, up to
 * eight times in a row per call — over an hour of "Spotify asked for a
 * pause — carrying on in Xs" resetting itself, which is what people were
 * reporting as the app being stuck. A short throttle is still waited out
 * quietly; anything longer is surfaced instead, with the real wait attached
 * so the fallback screen can retry itself once it has passed. */

test('a pause longer than the short-throttle budget is surfaced immediately, not sat through', async () => {
  const app = load({ ...LIB, limit: url => url.includes('/playlists/p2/') ? 25 : 0 });
  const began = Date.now();
  await assert.rejects(() => app.syncLibrary(false, () => {}), e => {
    assert.equal(e.retryable, true);
    assert.equal(e.retryAfterMs, 25000, 'so the fallback screen can retry itself once that has passed');
    return true;
  });
  assert.ok(Date.now() - began < 5000,
    'a 25s Retry-After must not be sat through silently before surfacing it — that is what "stuck" was');
});

test('the automatic hold has a bound, so a long pause cannot be sat through for an hour', () => {
  const m = BUNDLE.match(/const AUTO_HOLD_MAX = (\d+);/);
  const b = BUNDLE.match(/const AUTO_HOLD_BUDGET = (\d+);/);
  assert.ok(m && b, 'AUTO_HOLD_MAX / AUTO_HOLD_BUDGET not found — rebuild with npm run build:web');
  assert.ok(+m[1] <= 30000, 'a single silent wait must stay short');
  assert.ok(+b[1] <= 120000, 'the total silent wait per call must stay bounded');
});

test('a finished read clears the banked pieces', async () => {
  const app = load(LIB);
  await app.syncLibrary(false, () => {});
  assert.deepEqual([...app.store.keys()].filter(k => k.startsWith('part:')), []);
  assert.ok(app.store.get('library'));
});

test('a playlist whose snapshot id has not moved is not read again', async () => {
  const app = load(LIB);
  await app.syncLibrary(false, () => {});
  const before = app.hits('/playlists/');
  await app.syncLibrary(false, () => {});
  assert.equal(app.hits('/playlists/'), before, 'nothing changed, so nothing was re-read');
});

test('a playlist that has changed is re-read, and its neighbours are not', async () => {
  const app = load(LIB);
  await app.syncLibrary(false, () => {});
  const p1 = app.hits('/playlists/p1/'), p2 = app.hits('/playlists/p2/');
  LIB.playlists[1].snapshot_id = 's2-moved';
  try {
    await app.syncLibrary(false, () => {});
    assert.equal(app.hits('/playlists/p1/'), p1);
    assert.equal(app.hits('/playlists/p2/'), p2 + 1);
  } finally { LIB.playlists[1].snapshot_id = 's2'; }
});

test('a forced re-read goes back to Spotify for everything', async () => {
  const app = load(LIB);
  await app.syncLibrary(false, () => {});
  const before = app.hits('/playlists/p1/');
  await app.syncLibrary(true, () => {});
  assert.equal(app.hits('/playlists/p1/'), before + 1);
});

test('a playlist Spotify refuses is skipped rather than failing the whole read', async () => {
  // A 403 is not a rate limit, so it stays what it always was: skip that one.
  const app = load({ ...LIB, refuse: url => url.includes('/playlists/p2/') });
  const lib = await app.syncLibrary(false, () => {});
  assert.equal(lib.playlists.length, 3);
  assert.deepEqual(own(lib.playlists.map(p => p.tracks.length)), [1, 0, 1]);
  assert.ok(app.store.get('library'), 'the rest of the library still lands');
});

test('a pause tells the screen how long it has to wait', async () => {
  const app = load({ ...LIB, limit: (url, nth) => url.includes('/playlists/p1/') && nth === 1 ? 1 : 0 });
  const seen = [];
  app.report = s => seen.push(s);
  vm.runInContext('onHold = s => report(s)', app);
  await app.syncLibrary(false, () => {});
  assert.ok(seen.length > 0, 'a rate-limit pause must say so rather than looking hung');
  assert.equal(seen[seen.length - 1], 0, 'and say when it is over');
});
