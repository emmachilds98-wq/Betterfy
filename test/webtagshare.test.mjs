import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/* Giving a freshly-fetched tag back to the shared table.
 *
 * CLAUDE.md is explicit about anything outside Spotify: a bonus must be
 * silently absent and zero-cost for anyone who hasn't got it, and the core
 * model must never lean on it. So most of what matters here is what this does
 * *not* do — with no project configured it makes no request at all, and however
 * it fails it is never the reason a listener's own tag fetch went wrong. */

const BUNDLE = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');

/**
 * The contributor, with config injected rather than read from the build, so
 * both the on and off states can be driven whatever the shipped build carries.
 */
function load({ project = 'betterfy-tags', key = 'AIza' + 'x'.repeat(30), raw = {},
                appCheckSiteKey = '', appCheckAppId = '', fetchImpl = null } = {}) {
  const from = BUNDLE.indexOf('const TAGS_PROJECT =');
  const to = BUNDLE.indexOf('async function discogsTags');
  assert.ok(from > 0 && to > from, 'contributeTags not found — rebuild with npm run build:web');
  // Whatever the build baked in, swap it for what this test wants. Matching the
  // line rather than one particular value, so these keep working whether the
  // shipped build has sharing (or App Check) on or off.
  const src = BUNDLE.slice(from, to)
    .replace(/const TAGS_PROJECT = '[^']*', TAGS_KEY = '[^']*';/,
      `const TAGS_PROJECT = ${JSON.stringify(project)}, TAGS_KEY = ${JSON.stringify(key)};`)
    .replace(/const APPCHECK_SITE_KEY = '[^']*', APPCHECK_APP_ID = '[^']*';/,
      `const APPCHECK_SITE_KEY = ${JSON.stringify(appCheckSiteKey)}, APPCHECK_APP_ID = ${JSON.stringify(appCheckAppId)};`);
  assert.ok(src.includes(`TAGS_PROJECT = ${JSON.stringify(project)}`), 'config injection missed');

  const calls = [];
  const defaultFetch = async (url, opts, ms) => {
    calls.push({ url, opts, ms });
    if (String(url).includes('firebaseappcheck.googleapis.com'))
      return { ok: true, json: async () => ({ token: 'app-check-token-abc', ttl: '3600s' }) };
    return { ok: true, json: async () => ({}) };
  };
  const sandbox = {
    RAW_TAGS: raw,
    fetchDeadline: fetchImpl ? (url, opts, ms) => fetchImpl(url, opts, ms, calls) : defaultFetch,
    // Only ever touched when App Check is configured — harmless stubs otherwise.
    document: { head: { appendChild: s => s.onload?.() }, createElement: () => ({}) },
    grecaptcha: { ready: cb => cb(), execute: () => Promise.resolve('recaptcha-token') },
    Date, JSON, encodeURIComponent, console, setTimeout,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return Object.assign(sandbox, { calls });
}

/** contributeTags kicks off async work (the App Check exchange) without the
 *  caller awaiting anything, by design — this lets a test wait for it to settle. */
const settle = () => new Promise(r => setTimeout(r, 0));

const TAGS = [['jungle', 100], ['breakbeat', 60]];
const ARTIST = '4Z8W4fKeB5YxbusRsdQVPb';

test('the build carries a real project or nothing — never an unreplaced placeholder', () => {
  // A placeholder that survived the build would read as configured to a human
  // and as nonsense to Firestore. sharingTags() refuses it either way, but the
  // build should not be producing one in the first place.
  assert.match(BUNDLE, /const TAGS_PROJECT = '(|[a-z][a-z0-9-]{3,39})', TAGS_KEY = '[^']*';/,
    'unreplaced __TAGS_PROJECT__ / __TAGS_KEY__ in the shipped build');
});

test('with no project configured, not a single request goes out', () => {
  const app = load({ project: '', key: '' });
  app.contributeTags(ARTIST, TAGS);
  assert.deepEqual(app.calls, [], 'zero-cost for anyone who has not got it');
});

test('an unreplaced build placeholder counts as off, not as a project name', () => {
  const app = load({ project: '__TAGS_PROJECT__', key: '__TAGS_KEY__' });
  app.contributeTags(ARTIST, TAGS);
  assert.deepEqual(app.calls, []);
});

test('a configured build posts the artist to its own document', () => {
  const app = load();
  app.contributeTags(ARTIST, TAGS);
  assert.equal(app.calls.length, 1);
  const { url, opts } = app.calls[0];
  assert.ok(url.startsWith('https://firestore.googleapis.com/v1/projects/betterfy-tags/'), url);
  assert.match(url, /\/documents\/tagContributions\?documentId=4Z8W4fKeB5YxbusRsdQVPb/,
    'documentId on a create is what makes the first contribution win and later ones bounce');
  assert.match(url, /[?&]key=AIza/);
  assert.equal(opts.method, 'POST');
});

test('what it sends is what merge-tags.mjs expects to read back', () => {
  const app = load();
  app.contributeTags(ARTIST, TAGS);
  const body = JSON.parse(app.calls[0].opts.body);
  assert.deepEqual(JSON.parse(body.fields.tags.stringValue), TAGS,
    'Last.fm’s own 0-100 scale, which the merge converts — not pre-converted here');
  assert.equal(body.fields.source.stringValue, 'lastfm');
  assert.ok(Number(body.fields.at.integerValue) > 0);
});

test('at most ten tags are offered, matching the shipped table', () => {
  const app = load();
  app.contributeTags(ARTIST, Array.from({ length: 18 }, (_, i) => [`t${i}`, 50]));
  assert.equal(JSON.parse(JSON.parse(app.calls[0].opts.body).fields.tags.stringValue).length, 10);
});

test('an artist already in the shipped table is not offered again', () => {
  // Nothing to give, and the create would only bounce.
  const app = load({ raw: { [ARTIST]: { tags: [['electronic', 100]] } } });
  app.contributeTags(ARTIST, TAGS);
  assert.deepEqual(app.calls, []);
});

test('nothing is sent for an artist Last.fm had no tags for', () => {
  const app = load();
  app.contributeTags(ARTIST, []);
  app.contributeTags(ARTIST, null);
  app.contributeTags('', TAGS);
  assert.deepEqual(app.calls, []);
});

test('a request that fails is never the reason a tag fetch failed', () => {
  const app = load();
  app.fetchDeadline = async () => { throw new TypeError('Load failed'); };
  assert.doesNotThrow(() => app.contributeTags(ARTIST, TAGS));
});

test('a contributor that throws outright is still not the caller’s problem', () => {
  // It sits between fetching a listener's own tags and saving them. Nothing
  // optional gets to interrupt that.
  const app = load();
  app.fetchDeadline = () => { throw new Error('boom'); };
  assert.doesNotThrow(() => app.contributeTags(ARTIST, TAGS));
});

test('it never blocks: the caller gets nothing to await', () => {
  const app = load();
  let settled = false;
  app.fetchDeadline = () => new Promise(() => { settled = true; });   // never resolves
  assert.equal(app.contributeTags(ARTIST, TAGS), undefined);
  assert.ok(settled, 'the request did start — it is just not awaited');
});

test('the request carries a deadline, like every other one in the page', () => {
  const app = load();
  app.contributeTags(ARTIST, TAGS);
  const { ms } = app.calls[0];
  assert.ok(ms > 0 && ms <= 20000, `${ms}ms is not a sane deadline for a background gift`);
});

/* ---------- App Check: closing the one open door on an unauthenticated write ----------
 * The write itself is unauthenticated by design (Firestore's rules are a shape
 * check, not a trust boundary), so it is the one place in the whole app open
 * to being scripted at volume. App Check closes that without a sign-in: a
 * reCAPTCHA v3 solve is exchanged for a token Firestore can be told to
 * require. Same optional pattern as sharing itself — off unless configured,
 * and never the reason a contribution fails to go out. */

const APP_ID = '1:940770314231:web:f3579103449980316b90f2';

test('with no App Check configured, contributing makes exactly the one Firestore call', () => {
  const app = load();
  app.contributeTags(ARTIST, TAGS);
  assert.equal(app.calls.length, 1);
  assert.ok(app.calls[0].url.startsWith('https://firestore.googleapis.com/'));
  assert.equal(app.calls[0].opts.headers['X-Firebase-AppCheck'], undefined);
});

test('an unreplaced App Check placeholder counts as off, like the tag-sharing ones do', () => {
  const app = load({ appCheckSiteKey: '__APPCHECK_SITE_KEY__', appCheckAppId: '__APPCHECK_APP_ID__' });
  app.contributeTags(ARTIST, TAGS);
  assert.equal(app.calls.length, 1);
  assert.equal(app.calls[0].opts.headers['X-Firebase-AppCheck'], undefined);
});

test('a bare site key with no app id also counts as off — both are required', () => {
  const app = load({ appCheckSiteKey: 'a-real-looking-site-key', appCheckAppId: '' });
  app.contributeTags(ARTIST, TAGS);
  assert.equal(app.calls.length, 1);
  assert.equal(app.calls[0].opts.headers['X-Firebase-AppCheck'], undefined);
});

test('with App Check configured, a token is exchanged and attached before the write goes out', async () => {
  const app = load({ appCheckSiteKey: 'site-key-123456', appCheckAppId: APP_ID });
  app.contributeTags(ARTIST, TAGS);
  await settle();
  assert.equal(app.calls.length, 2, 'the token exchange, then the actual write');
  const exchange = app.calls.find(c => c.url.includes('firebaseappcheck.googleapis.com'));
  assert.ok(exchange, 'no exchange call was made');
  assert.ok(exchange.url.includes(`/projects/940770314231/apps/${APP_ID}:exchangeRecaptchaV3Token`),
    'the project number comes from the app id, not TAGS_PROJECT');
  assert.equal(JSON.parse(exchange.opts.body).recaptchaV3Token, 'recaptcha-token');
  const write = app.calls.find(c => c.url.includes('firestore.googleapis.com'));
  assert.equal(write.opts.headers['X-Firebase-AppCheck'], 'app-check-token-abc');
});

test('a failed token exchange still lets the write go out, just without the header', async () => {
  const app = load({
    appCheckSiteKey: 'site-key-123456', appCheckAppId: APP_ID,
    fetchImpl: async (url, opts, ms, calls) => {
      if (String(url).includes('firebaseappcheck')) return { ok: false, status: 403, json: async () => ({}) };
      calls.push({ url, opts, ms });
      return { ok: true, json: async () => ({}) };
    },
  });
  app.contributeTags(ARTIST, TAGS);
  await settle();
  assert.equal(app.calls.length, 1, 'the write itself still happened');
  assert.ok(app.calls[0].url.startsWith('https://firestore.googleapis.com/'));
  assert.equal(app.calls[0].opts.headers['X-Firebase-AppCheck'], undefined);
});

test('a cached token is reused rather than re-exchanged on every contribution', async () => {
  let exchanges = 0;
  const app = load({
    appCheckSiteKey: 'site-key-123456', appCheckAppId: APP_ID,
    fetchImpl: async (url, opts, ms, calls) => {
      if (String(url).includes('firebaseappcheck')) {
        exchanges++;
        return { ok: true, json: async () => ({ token: 'app-check-token-abc', ttl: '3600s' }) };
      }
      calls.push({ url, opts, ms });
      return { ok: true, json: async () => ({}) };
    },
  });
  app.contributeTags(ARTIST, TAGS);
  await settle();
  app.contributeTags('anotherArtistId12345678', TAGS);
  await settle();
  assert.equal(exchanges, 1, 'the second contribution reused the cached token');
  assert.equal(app.calls.length, 2, 'but both writes still went out');
});
