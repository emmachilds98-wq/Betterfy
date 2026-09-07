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
 * A Spotify that answers from a fixture and can be told to misbehave.
 * `limit(url, nth)` returns seconds of Retry-After, or 0 to answer normally.
 * `fail(url, nth)`  returns 'drop' (the connection goes), 'hang' (nothing ever
 *                   comes back), or an HTTP status, or 0 to answer normally.
 * `saved`           seeds stored state — for what a reopened page remembers.
 */
function load({ playlists = [], liked = [], limit = () => 0, refuse = () => false,
                fail = () => 0, quota = () => false, saved = {} } = {}) {
  const calls = [];
  const idb = fakeIndexedDB();
  const body = url => {
    if (url.includes('accounts.spotify.com')) return { access_token: 'fresh', expires_in: 3600 };
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
    LS: {
      // Key-aware, because the pace the last read settled on is remembered
      // under its own key now and must not come back as a parsed token.
      store: { bf_tok: JSON.stringify({ access_token: 'tok', refresh_token: 'r', expires_at: Date.now() + 3600e3 }), ...saved },
      getItem(k) { return this.store[k] ?? null; },
      setItem(k, v) { this.store[k] = String(v); },
      removeItem(k) { delete this.store[k]; },
    },
    fetch: async (url, opts = {}) => {
      calls.push(url);
      const nth = calls.filter(c => c === url).length;
      const broke = fail(url, nth);
      // A dropped fetch is a TypeError with no status on it — that is exactly
      // the shape the sync used to mistake for a permanent answer.
      if (broke === 'drop') throw new TypeError('Load failed');
      // A hung one never settles; only the deadline's abort ends it.
      if (broke === 'hang') return new Promise((_, bad) => {
        opts.signal?.addEventListener('abort', () => bad(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
      if (broke) return { ok: false, status: broke, headers: { get: () => null },
        json: async () => ({ error: { message: 'Server error' } }) };
      if (refuse(url)) return { ok: false, status: 403, headers: { get: () => null },
        json: async () => ({ error: { message: 'Forbidden' } }) };
      if (quota(url, nth)) return { ok: false, status: 429, headers: { get: () => null },
        json: async () => ({ error: { status: 429, message: 'Too many requests', reason: 'QUOTA_EXCEEDED' } }) };
      const retry = limit(url, nth);
      if (retry) return { ok: false, status: 429, headers: { get: h => h === 'retry-after' ? String(retry) : null },
        json: async () => { throw new SyntaxError('plain text'); } };
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => body(url) };
    },
    URLSearchParams, setTimeout, clearTimeout, console, AbortController,
  };
  vm.createContext(sandbox);
  vm.runInContext(slice(), sandbox);
  // The contextified object itself, not a copy — a copy is no longer a vm.Context.
  return Object.assign(sandbox, { calls, store: idb.data,
    hits: u => calls.filter(c => c.includes(u)).length,
    exact: u => calls.filter(c => c.endsWith(u)).length });
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

/* ---------- a phone's network ----------
 * The read is hundreds of calls over several minutes on a phone, and a phone
 * drops requests: it changes cell, it hands over to Wi-Fi, it leaves one
 * hanging. A dropped fetch throws a TypeError, which carried no `retryable`
 * flag — so a single blip was read as a permanent answer, and the two
 * permanent answers on offer were both wrong. Either the playlist in flight
 * was banked as empty (losing every track in it until somebody edited it), or
 * the whole read gave up behind a Start over button that cleared the token —
 * which sent people to the accounts service, which is rate-limited per app,
 * which answered 429. That is the loop: one dropped request, and the app is
 * asking you to sign in again into a sign-in that will not complete. */

test('a dropped connection is asked again, and the read still comes back whole', async () => {
  const app = load({ ...LIB, fail: (url, nth) => url.includes('/playlists/p2/') && nth === 1 ? 'drop' : 0 });
  const lib = await app.syncLibrary(false, () => {});
  assert.equal(lib.playlists.length, 3);
  assert.deepEqual(own(lib.playlists.map(p => p.tracks.length)), [1, 1, 1],
    'the playlist whose request was dropped still has its tracks');
});

test('a connection that stays down stops the read as retryable, not as a dead sign-in', async () => {
  const app = load({ ...LIB, fail: url => url.includes('/playlists/p2/') ? 'drop' : 0 });
  await assert.rejects(() => app.syncLibrary(false, () => {}), e => {
    assert.equal(e.retryable, true, 'a network blip must never read as "signed out"');
    return true;
  });
});

test('a dropped connection never banks the playlist it dropped on as empty', async () => {
  // The regression: recording p2 as an empty playlist under its live snapshot
  // id meant it stayed empty on every later read too, because the snapshot
  // matched and nothing looked wrong.
  const app = load({ ...LIB, fail: url => url.includes('/playlists/p2/') ? 'drop' : 0 });
  await assert.rejects(() => app.syncLibrary(false, () => {}));
  assert.equal(app.store.get('part:p2'), undefined);
  assert.equal(app.store.get('library'), undefined);
});

test('a 5xx is asked again rather than treated as an empty playlist', async () => {
  const app = load({ ...LIB, fail: (url, nth) => url.includes('/playlists/p3/') && nth === 1 ? 503 : 0 });
  const lib = await app.syncLibrary(false, () => {});
  assert.deepEqual(own(lib.playlists.map(p => p.tracks.length)), [1, 1, 1]);
});

test('a 5xx that will not clear is retryable too', async () => {
  const app = load({ ...LIB, fail: url => url.includes('/playlists/p3/') ? 502 : 0 });
  await assert.rejects(() => app.syncLibrary(false, () => {}), e => {
    assert.equal(e.retryable, true);
    return true;
  });
});

test('a request that hangs is abandoned at its deadline', async () => {
  // fetch() has no timeout of its own. Without one, "Reading House…" is where
  // the app sits until somebody force-quits it.
  const app = load({ ...LIB, fail: () => 'hang' });
  const began = Date.now();
  await assert.rejects(() => app.fetchDeadline('https://api.spotify.com/v1/me', {}, 120));
  assert.ok(Date.now() - began < 5000, 'a hung request must not hold the read open');
});

test('the deadline is short enough to be worth having', () => {
  const m = BUNDLE.match(/const CALL_TIMEOUT = (\d+);/);
  assert.ok(m, 'CALL_TIMEOUT not found — rebuild with npm run build:web');
  assert.ok(+m[1] <= 60000, 'a deadline nobody waits out is not a deadline');
});

test('an abandoned request is asked again, like any other dropped one', async () => {
  const app = load({ ...LIB, fail: (url, nth) => url.includes('/playlists/p1/') && nth === 1 ? 'hang' : 0 });
  // The real deadline is twenty seconds; nudge this one so the test is not.
  vm.runInContext('const _f = fetchDeadline; fetchDeadline = (u, o) => _f(u, o, 120);', app);
  const lib = await app.syncLibrary(false, () => {});
  assert.deepEqual(own(lib.playlists.map(p => p.tracks.length)), [1, 1, 1]);
});

test('a playlist Spotify refuses keeps no snapshot id, so the next read asks again', async () => {
  // Skipping a refused playlist is right; freezing it as empty for good is not.
  const stubborn = { on: true };
  const app = load({ ...LIB, refuse: url => stubborn.on && url.includes('/playlists/p2/') });
  const first = await app.syncLibrary(false, () => {});
  assert.equal(first.playlists[1].snapshot_id, null);

  stubborn.on = false;
  const again = await app.syncLibrary(false, () => {});
  assert.equal(again.playlists[1].tracks.length, 1, 'the refusal was not taken as final');
});

/* ---------- what a retry costs ----------
 * Every retry used to re-spend /me and the whole playlist index before it got
 * back to the playlist it actually stopped on. On a rate-limited shared quota
 * that could be the entire budget, so the retry failed in the same place
 * having read nothing new — which is what "it never gets past this" was. */

test('a retry does not re-spend /me and the playlist index', async () => {
  const stop = { on: true };
  const app = load({ ...LIB, limit: url => stop.on && url.includes('/playlists/p3/') ? 3600 : 0 });
  await assert.rejects(() => app.syncLibrary(false, () => {}));
  const me = app.exact('/v1/me'), index = app.hits('/me/playlists');
  assert.equal(me, 1);

  stop.on = false;
  await app.syncLibrary(false, () => {});
  assert.equal(app.exact('/v1/me'), me, '/me is banked with the rest of the read');
  assert.equal(app.hits('/me/playlists'), index, 'and so is the playlist index');
});

test('a finished read clears the banked index along with the parts', async () => {
  const app = load(LIB);
  await app.syncLibrary(false, () => {});
  assert.equal(app.store.get('part:index'), undefined);
});

test('a forced re-read drops the banked pieces first, index included', async () => {
  const stop = { on: true };
  const app = load({ ...LIB, limit: url => stop.on && url.includes('/playlists/p3/') ? 3600 : 0 });
  await assert.rejects(() => app.syncLibrary(false, () => {}));
  stop.on = false;
  const before = app.hits('/playlists/p1/');
  await app.syncLibrary(true, () => {});
  assert.equal(app.hits('/playlists/p1/'), before + 1, 'force means force, banked pieces or not');
});

/* ---------- pacing ----------
 * A Spotify app without extended quota gets a few calls a second, and the
 * hosted page's default client ID spends that budget across everyone who has
 * the page open at once. The old floor was 70ms — fourteen a second — which
 * did not risk a 429 so much as schedule one. */

test('the pace floor stays under what a shared, un-extended quota allows', () => {
  const min = BUNDLE.match(/const MIN_GAP = (\d+), MAX_GAP = (\d+);/);
  assert.ok(min, 'MIN_GAP / MAX_GAP not found — rebuild with npm run build:web');
  assert.ok(+min[1] >= 200, `a ${min[1]}ms floor is ${(1000 / +min[1]).toFixed(0)} calls a second — too many`);
  assert.ok(+min[2] >= 2000, 'the ceiling has to be a real pause, not a slightly slower burst');
});

test('the pace recovers slowly after a 429, rather than diving back into it', async () => {
  const app = load({ ...LIB, limit: (url, nth) => url.includes('/playlists/p1/') && nth === 1 ? 1 : 0 });
  await app.syncLibrary(false, () => {});
  const gap = vm.runInContext('gap', app);
  assert.ok(gap > vm.runInContext('MIN_GAP', app),
    'a handful of successes must not undo the back-off a rate limit just earned');
});

test('the pace Spotify last agreed to is written down', async () => {
  const app = load({ ...LIB, limit: (url, nth) => url.includes('/playlists/p1/') && nth === 1 ? 1 : 0 });
  await app.syncLibrary(false, () => {});
  assert.ok(+app.LS.store.bf_gap > vm.runInContext('MIN_GAP', app),
    'the back-off a 429 earned has to outlive the read that earned it');
});

test('a reopened page does not start at full speed after a pause', async () => {
  // iOS reclaims the page behind you, and the reopen straight after a rate
  // limit used to go back to Spotify at the floor pace and earn the same 429.
  const reopened = load({ ...LIB, saved: { bf_gap: '4000' } });
  const gap = vm.runInContext('gap', reopened), min = vm.runInContext('MIN_GAP', reopened);
  assert.ok(gap > min, 'the remembered pace is read back');
  assert.ok(gap < 4000, 'but only half-remembered, so it can speed up again once the queue clears');
});

test('a token that stops working mid-read is refreshed once, not treated as a sign-out', async () => {
  // A long read outlives tokens: revoked, re-granted, or simply expired early.
  // A 401 used to come back as a plain Error with no `retryable` flag — so it
  // landed on the wall whose only button cleared the sign-in.
  const app = load({ ...LIB, fail: (url, nth) => url.includes('/playlists/p2/') && nth === 1 ? 401 : 0 });
  const lib = await app.syncLibrary(false, () => {});
  assert.deepEqual(own(lib.playlists.map(p => p.tracks.length)), [1, 1, 1]);
  assert.equal(app.hits('accounts.spotify.com'), 1, 'and it went and got a new token to do it');
});

test('a token Spotify keeps refusing is not retried forever', async () => {
  const app = load({ ...LIB, fail: url => url.includes('/playlists/p2/') ? 401 : 0 });
  await assert.rejects(() => app.syncLibrary(false, () => {}), /401/);
});

test('a back-off does not outlive the rolling window that earned it', async () => {
  // Spotify's limit is a rolling window: it drains while nothing is being
  // asked of it. A pace held from a sync half an hour ago is just a slow app.
  const app = load({ ...LIB, saved: { bf_gap: '4000' } });
  assert.ok(vm.runInContext('gap', app) > vm.runInContext('MIN_GAP', app));
  vm.runInContext('nextAt = Date.now() - (GAP_IDLE_RESET + 1000)', app);
  await app.sp('/me');
  assert.equal(vm.runInContext('gap', app), vm.runInContext('MIN_GAP', app),
    'a quiet stretch is the window draining, so the pace goes back to the floor');
});

/* ---------- a quota that is simply gone ----------
 * The per-call hold budget never trips in the case that actually bit: the very
 * first call of a read gets a 429, then the next, then the next, each pause
 * short enough to absorb and each one restarting its countdown. From outside
 * that is a progress bar stuck at 2% and "Spotify asked for a pause" re-arming
 * forever — and waiting does not fix it, because the quota belongs to the app
 * rather than the listener. So the read as a whole has a budget too. */

test('short pauses that never stop are surfaced, not absorbed forever', async () => {
  // Four seconds is well inside AUTO_HOLD_MAX, so every one of these used to be
  // swallowed quietly and the read never got anywhere.
  const app = load({ ...LIB, limit: () => 4 });
  const began = Date.now();
  await assert.rejects(() => app.syncLibrary(false, () => {}), e => {
    assert.equal(e.retryable, true);
    return true;
  });
  const took = Date.now() - began;
  assert.ok(took < 40000, `sat through ${(took / 1000).toFixed(0)}s of short pauses before saying anything`);
});

test('the per-read budget is small enough to reach the actionable screen quickly', () => {
  const m = BUNDLE.match(/const HOLD_BUDGET_RUN = (\d+);/);
  assert.ok(m, 'HOLD_BUDGET_RUN not found — rebuild with npm run build:web');
  assert.ok(+m[1] <= 30000, 'a whole read must not spend longer than this quietly waiting');
});

test('an ordinary one-off pause is still absorbed without bothering anyone', async () => {
  // The budget must not turn every throttle into a wall — one short pause in a
  // read is exactly what the quiet countdown is for.
  const app = load({ ...LIB, limit: (url, nth) => url.includes('/playlists/p2/') && nth === 1 ? 1 : 0 });
  const lib = await app.syncLibrary(false, () => {});
  assert.equal(lib.playlists.length, 3, 'a single short throttle still just waits and carries on');
});

test('the budget resets per read, so each retry gets a fresh allowance', async () => {
  const stop = { on: true };
  const app = load({ ...LIB, limit: () => stop.on ? 4 : 0 });
  await assert.rejects(() => app.syncLibrary(false, () => {}));
  stop.on = false;
  const lib = await app.syncLibrary(false, () => {});
  assert.equal(lib.playlists.length, 3, 'the retry is not still carrying the last attempt’s spent budget');
});

// A QUOTA_EXCEEDED 429 means the app's whole request budget for the period is
// gone, not a busy moment — so, unlike an ordinary 429, it must never be sat
// through quietly nor answered with a countdown promising a retry that was
// never going to succeed.
test('a quota-exceeded 429 is surfaced immediately rather than quietly absorbed', async () => {
  const app = load({ ...LIB, quota: url => url.includes('/playlists/p1/') });
  const began = Date.now();
  await assert.rejects(() => app.syncLibrary(false, () => {}), e => {
    assert.equal(e.retryable, true, 'still worth a manual Try again — the quota may reset');
    assert.equal(e.retryAfterMs, undefined, 'no countdown: waiting will not fix this on its own');
    assert.match(e.message, /quota/i);
    return true;
  });
  assert.ok(Date.now() - began < 5000, 'must not sit through it first, unlike an ordinary short pause');
});

test('a quota-exceeded 429 still leaves the read resumable, like any other retryable failure', async () => {
  const app = load({ ...LIB, quota: (url, nth) => url.includes('/playlists/p1/') && nth === 1 });
  await assert.rejects(() => app.syncLibrary(false, () => {}));
  const lib = await app.syncLibrary(false, () => {});
  assert.equal(lib.playlists.length, 3, 'the retry (nth=2) is past the one quota-exceeded response and succeeds');
});
