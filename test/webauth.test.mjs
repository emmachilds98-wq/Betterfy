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
  const to = BUNDLE.indexOf('/* ---------- Spotify ----------');
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

/* ---------- signing in without being asked ---------- */

// iOS gives a home-screen app its own storage, so it opens with no sign-in even
// when Safari has one, and nothing can hand it across. What it can do is not
// make a person do it — but an automatic redirect that can fire twice is a
// loop, so exactly when it fires is worth pinning down.

function autoConnect({ home = true, token = null, tried = null } = {}) {
  const from = BUNDLE.indexOf('/** Running from the Home Screen');
  const to = BUNDLE.indexOf('/* ---------------- staying on the current version');
  assert.ok(from > 0 && to > from, 'auto-connect block not found — rebuild with npm run build:web');
  const store = new Map();
  if (token) store.set('bf_tok', token);
  if (tried) store.set('bf_autoconnect', tried);
  const sandbox = {
    window: { navigator: { standalone: home } },
    matchMedia: () => ({ matches: false }),
    localStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
  };
  vm.createContext(sandbox);
  vm.runInContext(BUNDLE.slice(from, to), sandbox);
  // Both are consts in the script's own scope, so they are read back out of
  // the context rather than off the sandbox.
  return { due: () => vm.runInContext('autoConnectDue()', sandbox),
           isHome: () => vm.runInContext('standalone()', sandbox) };
}

test('a home-screen app with no sign-in goes and gets one', () => {
  assert.equal(autoConnect().due(), true);
});

test('a browser tab never redirects itself to Spotify', () => {
  // The landing page is where someone decides whether to connect at all.
  assert.equal(autoConnect({ home: false }).due(), false);
});

test('an app that is already signed in is left alone', () => {
  assert.equal(autoConnect({ token: '{"access_token":"a"}' }).due(), false);
});

test('it tries once and never again, so a refusal cannot loop', () => {
  assert.equal(autoConnect({ tried: '1' }).due(), false);
});

test('display-mode standalone counts, not just the iOS flag', () => {
  const from = BUNDLE.indexOf('/** Running from the Home Screen');
  const to = BUNDLE.indexOf('/* ---------------- staying on the current version');
  const sandbox = { window: { navigator: {} }, matchMedia: q => ({ matches: q.includes('standalone') }),
                    localStorage: { getItem: () => null, setItem: () => {} } };
  vm.createContext(sandbox);
  vm.runInContext(BUNDLE.slice(from, to), sandbox);
  assert.equal(vm.runInContext('standalone()', sandbox), true);
  assert.equal(vm.runInContext('autoConnectDue()', sandbox), true);
});

test('the one attempt is claimed before leaving for Spotify, not after', () => {
  // Set it afterwards and a page that never comes back would try again on the
  // next open, and the one after that.
  const boot = BUNDLE.slice(BUNDLE.indexOf('if (autoConnectDue())'));
  const claim = boot.indexOf("setItem('bf_autoconnect'");
  const leave = boot.indexOf('return beginAuth()');
  assert.ok(claim > -1 && leave > claim, 'the attempt must be recorded before the redirect');
});

test('the shipped bundle carries a client ID', () => {
  // Without one the page looks perfectly healthy and cannot sign anyone in:
  // beginAuth() sends client_id= empty and Spotify refuses. .env is gitignored,
  // so a rebuild on a machine that has never held it used to blank this and the
  // only symptom was at the sign-in screen, after publishing.
  const m = BUNDLE.match(/const DEFAULT_CLIENT_ID = '([^']*)'/);
  assert.ok(m, 'DEFAULT_CLIENT_ID not found in docs/index.html — rebuild with npm run build:web');
  assert.match(m[1], /^[0-9a-f]{32}$/,
    'docs/index.html was built without a Spotify client ID — rebuild with `node build-web.mjs <client id>`');
});
