import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/* Safari with "Block All Cookies", a locked-down private window, an in-app web
 * view: in all of them reading localStorage throws a SecurityError rather than
 * returning null. Every unguarded localStorage call in the page was therefore a
 * line that could kill the boot script — and because the landing screen is
 * static HTML, the page still came up looking perfectly normal, with Connect
 * Spotify wired to nothing. These pin the shim that stands in the way of that. */

const BUNDLE = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');

function slice(from, to, what) {
  const i = BUNDLE.indexOf(from), j = BUNDLE.indexOf(to);
  assert.ok(i > 0 && j > i, `${what} not found — rebuild with npm run build:web`);
  return BUNDLE.slice(i, j);
}

/** The LS shim, loaded against whatever `window.localStorage` is handed in. */
function loadLS(localStorage) {
  const sandbox = { window: { localStorage }, console };
  vm.createContext(sandbox);
  vm.runInContext(slice('const LS = (() => {', 'const mmss =', 'the LS shim') + '\nthis.LS = LS;', sandbox);
  return sandbox.LS;
}

/** A store that throws on every access, the way a blocked one does. */
const hostile = new Proxy({}, { get() { throw new DOMException('The operation is insecure.', 'SecurityError'); } });

const working = () => {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
};

test('a browser that blocks storage outright does not take the page down with it', () => {
  const LS = loadLS(hostile);
  assert.equal(LS.durable, false, 'and it knows nothing it writes will survive');
  assert.doesNotThrow(() => LS.setItem('bf_tok', 'x'));
  assert.doesNotThrow(() => LS.removeItem('bf_tok'));
  assert.doesNotThrow(() => LS.getItem('bf_tok'));
});

test('with storage blocked, values still round-trip for the life of the page', () => {
  // A sign-in has to hold a PKCE verifier across one redirect. Memory is enough
  // for that; throwing is not.
  const LS = loadLS(hostile);
  LS.setItem('bf_verifier', 'abc');
  assert.equal(LS.getItem('bf_verifier'), 'abc');
  LS.removeItem('bf_verifier');
  assert.equal(LS.getItem('bf_verifier'), null);
});

test('a missing key reads as null, not undefined', () => {
  assert.equal(loadLS(hostile).getItem('nope'), null);
  assert.equal(loadLS(working()).getItem('nope'), null);
});

test('real storage is used, and reported as durable, when there is any', () => {
  const real = working();
  const LS = loadLS(real);
  assert.equal(LS.durable, true);
  LS.setItem('bf_tok', 'kept');
  assert.equal(real.getItem('bf_tok'), 'kept', 'it actually reached the real store');
  LS.removeItem('bf_tok');
  assert.equal(real.getItem('bf_tok'), null);
});

test('a store that starts working and then refuses does not lose what it took', () => {
  // A private window's small allowance runs out mid-session: setItem starts
  // throwing QuotaExceededError. Reads must not start coming back empty.
  const m = new Map();
  let full = false;
  const flaky = {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { if (full) throw new DOMException('quota', 'QuotaExceededError'); m.set(k, String(v)); },
    removeItem: k => m.delete(k),
  };
  const LS = loadLS(flaky);
  LS.setItem('bf_tok', 'first');
  full = true;
  assert.doesNotThrow(() => LS.setItem('bf_gap', '900'));
  assert.equal(LS.getItem('bf_gap'), '900', 'the write it refused is still readable this session');
  assert.equal(LS.getItem('bf_tok'), 'first');
});

test('a getItem that throws mid-session falls back rather than propagating', () => {
  let armed = false;
  const m = new Map();
  const LS = loadLS({
    getItem: k => { if (armed) throw new DOMException('nope', 'SecurityError'); return m.has(k) ? m.get(k) : null; },
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k),
  });
  LS.setItem('bf_gap', '750');
  armed = true;
  assert.equal(LS.getItem('bf_gap'), '750');
});

/* ---------- the sign-in can say why it will not start ---------- */

test('sign-in needs crypto.subtle, and says so rather than throwing into nothing', async () => {
  // Over plain http, or inside an in-app web view, crypto.subtle is absent.
  // This used to be a bare TypeError out of an unhandled click handler: a
  // Connect button that did nothing and explained nothing.
  const sandbox = {
    LS: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    globalThis: { crypto: undefined },
    crypto: undefined, location: {}, console,
    clientId: () => 'c', SCOPES: 's', REDIRECT: 'https://example.test/Betterfy/',
    URLSearchParams, TextEncoder, btoa,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(slice('const b64url =', '/* Spotify rate-limits', 'beginAuth'), sandbox);
  await assert.rejects(() => sandbox.beginAuth(), /will not let Betterfy sign in securely/);
  assert.equal(sandbox.location.href, undefined, 'and it never left the page');
});

test('a verifier that could not be stored stops the sign-in here, not after the round trip', async () => {
  // Finding out on the way back means an error about a "lost security code",
  // one redirect too late to be about this browser.
  const sandbox = {
    LS: { getItem: () => null, setItem: () => {}, removeItem: () => {} },  // accepts writes, keeps nothing
    crypto: { getRandomValues: a => a, subtle: { digest: async () => new Uint8Array(32) } },
    location: {}, console, clientId: () => 'c', SCOPES: 's',
    REDIRECT: 'https://example.test/Betterfy/', URLSearchParams, TextEncoder, btoa,
    readVerifier: () => null,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(slice('const b64url =', '/* Spotify rate-limits', 'beginAuth'), sandbox);
  await assert.rejects(() => sandbox.beginAuth(), /not letting Betterfy store anything/);
  assert.equal(sandbox.location.href, undefined, 'and it never left the page');
});

test('a sign-in that can be stored does leave for Spotify, with S256 and the client id', async () => {
  const held = new Map();
  const sandbox = {
    LS: { getItem: k => held.get(k) ?? null, setItem: (k, v) => held.set(k, String(v)), removeItem: k => held.delete(k) },
    crypto: { getRandomValues: a => a, subtle: { digest: async () => new Uint8Array(32) } },
    location: {}, console, clientId: () => 'real-client-id', SCOPES: 'scope-a scope-b',
    REDIRECT: 'https://example.test/Betterfy/', URLSearchParams, TextEncoder, btoa,
    readVerifier: () => held.get('bf_verifier') ?? null,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(slice('const b64url =', '/* Spotify rate-limits', 'beginAuth'), sandbox);
  await sandbox.beginAuth();
  const u = new URL(sandbox.location.href);
  assert.equal(u.origin + u.pathname, 'https://accounts.spotify.com/authorize');
  assert.equal(u.searchParams.get('client_id'), 'real-client-id');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://example.test/Betterfy/');
  assert.ok(u.searchParams.get('code_challenge'), 'and it carries a challenge');
});

test('the verifier is read back from sessionStorage when localStorage kept nothing', () => {
  const sandbox = {
    LS: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    sessionStorage: { getItem: k => (k === 'bf_verifier' ? 'from-session' : null) },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(slice('function readVerifier()', 'const retryable =', 'readVerifier'), sandbox);
  assert.equal(sandbox.readVerifier(), 'from-session');
});

test('readVerifier survives a browser with no sessionStorage at all', () => {
  const sandbox = {
    LS: { getItem: k => (k === 'bf_verifier' ? 'from-local' : null), setItem: () => {}, removeItem: () => {} },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(slice('function readVerifier()', 'const retryable =', 'readVerifier'), sandbox);
  assert.equal(sandbox.readVerifier(), 'from-local');
});
