import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// The web app's token handling lives inline in docs/index.html, so these tests
// lift that exact slice of the shipped bundle out and run it against a stub
// Spotify. What is being pinned down is the behaviour behind the 429 people hit
// on the home-screen app: accounts.spotify.com rate-limits per app, so a refresh
// can fail for reasons that have nothing to do with whether you are signed in,
// and the app must not answer that by signing you out and asking again.

const BUNDLE = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');

function authSlice() {
  const from = BUNDLE.indexOf('const RATE_LIMITED');
  const to = BUNDLE.indexOf('/* ---------- Spotify ---------- */');
  assert.ok(from > 0 && to > from, 'auth block not found in docs/index.html — rebuild with npm run build:web');
  return BUNDLE.slice(from, to);
}

/** The auth block, loaded with a fake browser and a scripted Spotify. */
function load(responses) {
  const store = new Map();
  const calls = [];
  const sandbox = {
    clientId: () => 'test-client',
    REDIRECT: 'https://example.test/Betterfy/',
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k),
    },
    fetch: async (url, opts) => {
      calls.push(Object.fromEntries(new URLSearchParams(opts.body)));
      const r = responses[calls.length - 1] ?? responses[responses.length - 1];
      if (r.throws) throw new Error('network down');
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        headers: { get: h => (h === 'retry-after' ? (r.retryAfter ?? null) : null) },
        json: async () => { if (r.text) throw new SyntaxError('Unexpected token T'); return r.body; },
      };
    },
    URLSearchParams, setTimeout, clearTimeout, console,
  };
  vm.createContext(sandbox);
  vm.runInContext(authSlice(), sandbox);
  return { ...sandbox, store, calls };
}

const SAVED = grant => JSON.stringify({
  access_token: 'old', refresh_token: 'r1', expires_at: Date.now() - 1000, ...grant,
});

test('a rate-limited refresh keeps you signed in instead of throwing the token away', async () => {
  // Spotify answers a 429 in plain text, not the documented JSON error object.
  const app = load([{ status: 429, text: true, retryAfter: '60' }]);
  app.store.set('bf_tok', SAVED());

  await assert.rejects(() => app.token(), e => {
    assert.equal(e.retryable, true);
    assert.match(e.message, /too many requests/i);
    return true;
  });
  assert.ok(app.store.get('bf_tok'), 'the refresh token must survive a rate limit');
});

test('a long Retry-After is reported rather than slept through', async () => {
  const app = load([{ status: 429, text: true, retryAfter: '3600' }]);
  app.store.set('bf_tok', SAVED());
  await assert.rejects(() => app.token());
  assert.equal(app.calls.length, 1, 'no point retrying inside an hour-long rate limit');
});

test('a refresh token Spotify has actually rejected is cleared, and you sign in again', async () => {
  const app = load([{ status: 400, body: { error: 'invalid_grant', error_description: 'Refresh token revoked' } }]);
  app.store.set('bf_tok', SAVED());

  assert.equal(await app.token(), null);
  assert.equal(app.store.get('bf_tok'), undefined, 'a revoked token is worth nothing');
});

test('a network failure is retryable and does not sign you out', async () => {
  const app = load([{ throws: true }]);
  app.store.set('bf_tok', SAVED());
  await assert.rejects(() => app.token(), e => e.retryable === true);
  assert.ok(app.store.get('bf_tok'));
});

test('parallel callers finding a stale token share one refresh', async () => {
  const app = load([{ status: 200, body: { access_token: 'new', expires_in: 3600 } }]);
  app.store.set('bf_tok', SAVED());

  const out = await Promise.all([app.token(), app.token(), app.token()]);
  assert.deepEqual(out, ['new', 'new', 'new']);
  assert.equal(app.calls.length, 1, 'three stale-token callers must not post three refreshes');
});

test('a refresh keeps the old refresh token when Spotify does not issue a new one', async () => {
  const app = load([{ status: 200, body: { access_token: 'new', expires_in: 3600 } }]);
  app.store.set('bf_tok', SAVED());

  await app.token();
  assert.equal(JSON.parse(app.store.get('bf_tok')).refresh_token, 'r1');
});

test('a fresh access token is used without asking Spotify at all', async () => {
  const app = load([{ status: 500, body: {} }]);
  app.store.set('bf_tok', JSON.stringify({ access_token: 'good', refresh_token: 'r1', expires_at: Date.now() + 3600e3 }));

  assert.equal(await app.token(), 'good');
  assert.equal(app.calls.length, 0);
});

test('the exchange sends the stored verifier and saves an expiry', async () => {
  const app = load([{ status: 200, body: { access_token: 'a', refresh_token: 'r', expires_in: 3600 } }]);
  app.store.set('bf_verifier', 'v1');

  await app.exchange('the-code');
  assert.equal(app.calls[0].code_verifier, 'v1');
  assert.equal(app.calls[0].grant_type, 'authorization_code');
  assert.ok(JSON.parse(app.store.get('bf_tok')).expires_at > Date.now());
  assert.equal(app.store.get('bf_verifier'), undefined, 'a spent code takes its verifier with it');
});

test('a rate-limited exchange says so in words a listener can act on', async () => {
  const app = load([{ status: 429, text: true, retryAfter: '120' }]);
  app.store.set('bf_verifier', 'v1');

  await assert.rejects(() => app.exchange('the-code'), e => {
    assert.equal(e.retryable, true);
    assert.match(e.message, /Wait a minute/);
    return true;
  });
});

// The home-screen case itself: iOS reopens the app at the URL it was last on,
// so the boot path must strip ?code= and remember the code before posting it.
test('boot removes the authorization code from the URL before exchanging it', () => {
  const boot = BUNDLE.slice(BUNDLE.indexOf('const code = q.get(\'code\')'));
  const replace = boot.indexOf('history.replaceState');
  const post = boot.indexOf('await exchange(code)');
  const remember = boot.indexOf('bf_code_used\', code');
  assert.ok(replace > -1 && post > replace, 'the URL must be cleaned before the code is posted');
  assert.ok(remember > -1 && remember < post, 'a code must be marked used before it is posted, not after');
});
