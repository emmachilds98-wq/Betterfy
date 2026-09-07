import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Spotify removed the write endpoints PUT/DELETE /me/tracks?ids= on a client
// ID created after February 2026, in favour of PUT/DELETE /me/library?uris=.
// This page's own grandfathered client ID still serves the old form, so
// every like/unlike call tries the new path first and falls back to the old
// one only on the 403/404 that means "this endpoint doesn't exist for this
// app" — never on an unrelated failure, and never a second call once the
// first one succeeds.

const BUNDLE = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');

function slice() {
  // sp() is libraryCall's only dependency worth pulling in; everything this
  // range needs (pace, token, the gap/hold bookkeeping, authError) lives
  // between the two markers along with it.
  const from = BUNDLE.indexOf('const RATE_LIMITED');
  const to = BUNDLE.indexOf('/* ---------- player: Spotify Connect');
  assert.ok(from > 0 && to > from, 'sp()/libraryCall block not found — rebuild with npm run build:web');
  return BUNDLE.slice(from, to);
}

function load({ fail = () => 0 } = {}) {
  const calls = [];
  const sandbox = {
    clientId: () => 'test-client',
    REDIRECT: 'https://example.test/Betterfy/',
    LS: {
      store: { bf_tok: JSON.stringify({ access_token: 'tok', refresh_token: 'r', expires_at: Date.now() + 3600e3 }) },
      getItem(k) { return this.store[k] ?? null; },
      setItem(k, v) { this.store[k] = String(v); },
      removeItem(k) { delete this.store[k]; },
    },
    fetch: async url => {
      calls.push(url);
      const broke = fail(url);
      if (broke) return { ok: false, status: broke, headers: { get: () => null },
        json: async () => ({ error: { message: 'refused' } }) };
      return { ok: true, status: 204, headers: { get: () => null }, json: async () => null };
    },
    URLSearchParams, setTimeout, clearTimeout, console, AbortController,
  };
  vm.createContext(sandbox);
  vm.runInContext(slice(), sandbox);
  return Object.assign(sandbox, { calls, hits: u => calls.filter(c => c.includes(u)).length });
}

test('a like/unlike call tries /me/library first and never falls back on success', async () => {
  const app = load();
  await app.libraryCall('PUT', ['t1']);
  assert.equal(app.hits('/me/library?uris=spotify:track:t1'), 1);
  assert.equal(app.hits('/me/tracks?ids=t1'), 0, 'no fallback needed, so it must not also spend a call on the old path');
});

test('a like/unlike call falls back to /me/tracks when /me/library is refused', async () => {
  const app = load({ fail: url => url.includes('/me/library') ? 404 : 0 });
  await app.libraryCall('DELETE', ['t1']);
  assert.equal(app.hits('/me/library?uris=spotify:track:t1'), 1, 'the new path is still tried first');
  assert.equal(app.hits('/me/tracks?ids=t1'), 1, 'and falls back once refused, so it still works on a grandfathered app');
});

test('a like/unlike call does not fall back on a failure unrelated to the endpoint existing', async () => {
  const app = load({ fail: url => url.includes('/me/library') ? 400 : 0 });
  await assert.rejects(() => app.libraryCall('PUT', ['t1']), /400/);
  assert.equal(app.hits('/me/tracks?ids=t1'), 0, 'a 400 is not "this endpoint does not exist" and must propagate as-is');
});

test('several ids are joined into one call on each path', async () => {
  const app = load({ fail: url => url.includes('/me/library') ? 404 : 0 });
  await app.libraryCall('PUT', ['t1', 't2']);
  assert.equal(app.hits('/me/library?uris=spotify:track:t1,spotify:track:t2'), 1);
  assert.equal(app.hits('/me/tracks?ids=t1,t2'), 1);
});
