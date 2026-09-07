import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Cross-device sync: Firebase Anonymous Auth plus an explicit device-link
// code, so skip/reject feedback made on one signed-in device shows up on
// another without a second real sign-in, a server, or Firebase Auth ever
// needing to know which Spotify account is involved. Full design in
// FIREBASE.md. These tests run the shipped code against a scripted
// Identity Toolkit / Firestore, since nothing here can be exercised against
// the real services without a live domain.

const BUNDLE = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');

function load({ project = 'betterfy-tags', key = 'AIza' + 'x'.repeat(30), fb = {}, fetchImpl = null,
                lsStore = {} } = {}) {
  const from = BUNDLE.indexOf('const TAGS_PROJECT =');
  const to = BUNDLE.indexOf('async function discogsTags');
  assert.ok(from > 0 && to > from, 'sync block not found — rebuild with npm run build:web');
  const src = BUNDLE.slice(from, to)
    .replace(/const TAGS_PROJECT = '[^']*', TAGS_KEY = '[^']*';/,
      `const TAGS_PROJECT = ${JSON.stringify(project)}, TAGS_KEY = ${JSON.stringify(key)};`);
  assert.ok(src.includes(`TAGS_PROJECT = ${JSON.stringify(project)}`), 'config injection missed');

  const calls = [];
  const defaultFetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    if (String(url).includes('identitytoolkit.googleapis.com'))
      return { ok: true, json: async () => ({ localId: 'anon-uid', idToken: 'id-tok-1', refreshToken: 'refresh-1', expiresIn: '3600' }) };
    if (String(url).includes('securetoken.googleapis.com'))
      return { ok: true, json: async () => ({ user_id: 'anon-uid', id_token: 'id-tok-2', refresh_token: 'refresh-2', expires_in: '3600' }) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  let savedFB = null;
  const sandbox = {
    FB: fb,
    saveFeedback: async () => { savedFB = JSON.parse(JSON.stringify(sandbox.FB)); },
    LS: {
      store: lsStore,
      getItem(k) { return Object.prototype.hasOwnProperty.call(this.store, k) ? this.store[k] : null; },
      setItem(k, v) { this.store[k] = String(v); },
      removeItem(k) { delete this.store[k]; },
    },
    fetchDeadline: fetchImpl ? (url, opts, ms) => fetchImpl(url, opts, ms, calls) : (url, opts) => defaultFetch(url, opts),
    crypto: { randomUUID: () => 'generated-uuid-0000' },
    Date, JSON, Math, Object, Set, String, URLSearchParams, console,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return Object.assign(sandbox, { calls, getSavedFB: () => savedFB });
}

/* ---------- mergeFeedback: pure, so this is the cheap part to get right ---------- */

// Arrays and objects built inside the vm carry that realm's prototype; bring
// the result home before comparing it.
const own = x => JSON.parse(JSON.stringify(x));

test('rejections union — a fact recorded on either device stays true on both', () => {
  const app = load();
  const merged = vm.runInContext(
    "mergeFeedback({t1:{skips:0,lastSkip:null,rejected:['p1']}}, {t1:{skips:0,lastSkip:null,rejected:['p2']}})", app);
  assert.deepEqual(own(merged.t1.rejected).sort(), ['p1', 'p2']);
});

test('skip counts take the higher of the two, never the lower', () => {
  const app = load();
  const merged = vm.runInContext(
    "mergeFeedback({t1:{skips:5,lastSkip:null,rejected:[]}}, {t1:{skips:2,lastSkip:null,rejected:[]}})", app);
  assert.equal(merged.t1.skips, 5);
});

test('lastSkip takes the later of the two timestamps', () => {
  const app = load();
  const merged = vm.runInContext(
    `mergeFeedback({t1:{skips:1,lastSkip:'2026-01-01T00:00:00.000Z',rejected:[]}},
                    {t1:{skips:1,lastSkip:'2026-06-01T00:00:00.000Z',rejected:[]}})`, app);
  assert.equal(merged.t1.lastSkip, '2026-06-01T00:00:00.000Z');
});

test('an entry only one side has is kept whole', () => {
  const app = load();
  const merged = vm.runInContext("mergeFeedback({}, {t9:{skips:3,lastSkip:null,rejected:['p1']}})", app);
  assert.deepEqual(own(merged.t9), { skips: 3, lastSkip: null, rejected: ['p1'] });
});

test('merging is order-independent, so two devices converge either way round', () => {
  const app = load();
  const a = { t1: { skips: 2, lastSkip: null, rejected: ['p1'] } };
  const b = { t1: { skips: 5, lastSkip: null, rejected: ['p2'] } };
  const ab = vm.runInContext('mergeFeedback', app)(a, b);
  const ba = vm.runInContext('mergeFeedback', app)(b, a);
  assert.deepEqual([...ab.t1.rejected].sort(), [...ba.t1.rejected].sort());
  assert.equal(ab.t1.skips, ba.t1.skips);
});

/* ---------- syncSignIn: anonymous identity, cached, refreshed ---------- */

test('a fresh device gets a brand new anonymous identity', async () => {
  const app = load();
  const auth = await vm.runInContext('syncSignIn()', app);
  assert.equal(auth.uid, 'anon-uid');
  assert.equal(auth.idToken, 'id-tok-1');
  assert.ok(app.calls[0].url.includes('accounts:signUp'));
});

test('a second call in the same session reuses the cached identity, no new request', async () => {
  const app = load();
  await vm.runInContext('syncSignIn()', app);
  const before = app.calls.length;
  await vm.runInContext('syncSignIn()', app);
  assert.equal(app.calls.length, before, 'no second sign-up call');
});

test('a saved-but-expired identity is refreshed rather than replaced', async () => {
  const app = load({ lsStore: { bf_sync_auth: JSON.stringify({
    uid: 'old-uid', idToken: 'old-tok', refreshToken: 'old-refresh', exp: Date.now() - 1000 }) } });
  const auth = await vm.runInContext('syncSignIn()', app);
  assert.equal(auth.idToken, 'id-tok-2', 'came from the refresh endpoint, not a fresh sign-up');
  assert.ok(app.calls[0].url.includes('securetoken.googleapis.com'));
});

test('a refresh that fails falls back to a fresh anonymous identity rather than giving up', async () => {
  const app = load({
    lsStore: { bf_sync_auth: JSON.stringify({ uid: 'old', idToken: 'x', refreshToken: 'dead', exp: Date.now() - 1000 }) },
    fetchImpl: async (url, opts, ms, calls) => {
      calls.push({ url: String(url), opts });
      if (String(url).includes('securetoken')) return { ok: false, status: 400, json: async () => ({}) };
      return { ok: true, json: async () => ({ localId: 'new-uid', idToken: 'new-tok', refreshToken: 'new-refresh', expiresIn: '3600' }) };
    },
  });
  const auth = await vm.runInContext('syncSignIn()', app);
  assert.equal(auth.uid, 'new-uid');
});

/* ---------- ensureSyncMembership: create-only, so it must check before writing ---------- */

test('joining a group for the first time creates the member doc', async () => {
  const app = load({
    fetchImpl: async (url, opts, ms, calls) => {
      calls.push({ url: String(url), opts });
      if (String(url).includes('identitytoolkit')) return { ok: true, json: async () => ({ localId: 'u1', idToken: 't', refreshToken: 'r', expiresIn: '3600' }) };
      if (opts.method === 'GET') return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  await vm.runInContext('ensureSyncMembership()', app);
  const creates = app.calls.filter(c => c.opts.method === 'POST' && c.url.includes('/members'));
  assert.equal(creates.length, 1);
  assert.ok(creates[0].url.includes('documentId=u1'));
});

test('a second join attempt does not try to create the member doc again', async () => {
  const app = load({
    fetchImpl: async (url, opts, ms, calls) => {
      calls.push({ url: String(url), opts });
      if (String(url).includes('identitytoolkit')) return { ok: true, json: async () => ({ localId: 'u1', idToken: 't', refreshToken: 'r', expiresIn: '3600' }) };
      // Already a member this time.
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  await vm.runInContext('ensureSyncMembership()', app);
  const creates = app.calls.filter(c => c.opts.method === 'POST' && c.url.includes('/members'));
  assert.equal(creates.length, 0, 'the GET already succeeded, so no create was attempted');
});

test('a 409 on the fallback create is a harmless no-op — the doc already existed', async () => {
  const app = load({
    fetchImpl: async (url, opts, ms, calls) => {
      calls.push({ url: String(url), opts });
      if (String(url).includes('identitytoolkit')) return { ok: true, json: async () => ({ localId: 'u7', idToken: 't', refreshToken: 'r', expiresIn: '3600' }) };
      if (opts.method === 'GET') return { ok: false, status: 500, json: async () => ({}) }; // transient, not "missing"
      return { ok: false, status: 409, json: async () => ({}) }; // already exists
    },
  });
  await assert.doesNotReject(() => vm.runInContext('ensureSyncMembership()', app));
});

test('a create failure that is not 409 still surfaces', async () => {
  const app = load({
    fetchImpl: async (url, opts, ms, calls) => {
      calls.push({ url: String(url), opts });
      if (String(url).includes('identitytoolkit')) return { ok: true, json: async () => ({ localId: 'u8', idToken: 't', refreshToken: 'r', expiresIn: '3600' }) };
      return { ok: false, status: 403, json: async () => ({}) };
    },
  });
  await assert.rejects(() => vm.runInContext('ensureSyncMembership()', app), /403/);
});

/* ---------- link codes: how a second device learns a group id ---------- */

test('a link code is created against this device\'s own group', async () => {
  const app = load();
  const { code, expiresAt } = await vm.runInContext('createLinkCode()', app);
  assert.match(code, /^\d{6}$/);
  assert.ok(expiresAt > Date.now());
  const created = app.calls.find(c => c.url.includes('linkCodes'));
  assert.ok(created.url.includes(`documentId=${code}`));
  const body = JSON.parse(created.opts.body);
  assert.equal(body.fields.groupId.stringValue, 'generated-uuid-0000');
});

test('redeeming a valid code adopts its group and deletes the code', async () => {
  const app = load({
    fetchImpl: async (url, opts, ms, calls) => {
      calls.push({ url: String(url), opts });
      if (String(url).includes('identitytoolkit')) return { ok: true, json: async () => ({ localId: 'u2', idToken: 't', refreshToken: 'r', expiresIn: '3600' }) };
      if (String(url).endsWith('/linkCodes/123456') && opts.method === 'GET')
        return { ok: true, json: async () => ({ fields: { groupId: { stringValue: 'their-group' }, createdAt: { integerValue: String(Date.now()) } } }) };
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  const groupId = await vm.runInContext('redeemLinkCode', app)('123456');
  assert.equal(groupId, 'their-group');
  assert.equal(app.LS.store.bf_sync_group, 'their-group');
  assert.ok(app.calls.some(c => c.opts.method === 'DELETE' && c.url.includes('linkCodes/123456')));
});

test('an unknown code is refused before anything is adopted', async () => {
  const app = load({
    fetchImpl: async (url, opts, ms, calls) => {
      calls.push({ url: String(url), opts });
      if (String(url).includes('identitytoolkit')) return { ok: true, json: async () => ({ localId: 'u3', idToken: 't', refreshToken: 'r', expiresIn: '3600' }) };
      return { ok: false, status: 404, json: async () => ({}) };
    },
  });
  await assert.rejects(() => vm.runInContext('redeemLinkCode', app)('000000'), /not found/);
  assert.equal(app.LS.store.bf_sync_group, undefined);
});

test('an expired code is refused even though it still exists', async () => {
  const app = load({
    fetchImpl: async (url, opts, ms, calls) => {
      calls.push({ url: String(url), opts });
      if (String(url).includes('identitytoolkit')) return { ok: true, json: async () => ({ localId: 'u4', idToken: 't', refreshToken: 'r', expiresIn: '3600' }) };
      if (opts.method === 'GET') return { ok: true, json: async () => ({ fields: {
        groupId: { stringValue: 'stale-group' }, createdAt: { integerValue: String(Date.now() - 11 * 60 * 1000) } } }) };
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  await assert.rejects(() => vm.runInContext('redeemLinkCode', app)('111111'), /expired/);
  assert.equal(app.LS.store.bf_sync_group, undefined, 'a stale code must not adopt its group');
});

/* ---------- syncFeedback: the opt-in gate, and the actual background merge ---------- */

test('a device that has never linked makes no request at all', async () => {
  const app = load({ fb: { t1: { skips: 1, lastSkip: null, rejected: [] } } });
  const changed = await vm.runInContext('syncFeedback()', app);
  assert.equal(changed, false);
  assert.deepEqual(app.calls, [], 'opening the page must never create an identity or a write on its own');
});

test('a linked device pulls remote feedback, merges it in, and saves locally', async () => {
  const app = load({
    lsStore: { bf_sync_group: 'g1' },
    fb: { t1: { skips: 1, lastSkip: null, rejected: ['pA'] } },
    fetchImpl: async (url, opts, ms, calls) => {
      calls.push({ url: String(url), opts });
      if (String(url).includes('identitytoolkit')) return { ok: true, json: async () => ({ localId: 'u5', idToken: 't', refreshToken: 'r', expiresIn: '3600' }) };
      if (String(url).endsWith('/state/feedback') && opts.method === 'GET')
        return { ok: true, json: async () => ({ fields: { data: { stringValue: JSON.stringify({ t2: { skips: 4, lastSkip: null, rejected: ['pB'] } }) } } }) };
      if (String(url).includes('/members/') && opts.method === 'GET') return { ok: true, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  const changed = await vm.runInContext('syncFeedback()', app);
  assert.equal(changed, true);
  assert.ok(app.getSavedFB().t1, 'the local entry survives the merge');
  assert.ok(app.getSavedFB().t2, 'the remote-only entry was pulled in');
  const push = app.calls.find(c => c.url.endsWith('/state/feedback') && c.opts.method === 'PATCH');
  assert.ok(push, 'the merged result is pushed back so the remote side gains t1 too');
});

test('nothing is pushed back when the merge matches what the remote already has', async () => {
  const shared = { t1: { skips: 1, lastSkip: null, rejected: [] } };
  const app = load({
    lsStore: { bf_sync_group: 'g1' },
    fb: shared,
    fetchImpl: async (url, opts, ms, calls) => {
      calls.push({ url: String(url), opts });
      if (String(url).includes('identitytoolkit')) return { ok: true, json: async () => ({ localId: 'u6', idToken: 't', refreshToken: 'r', expiresIn: '3600' }) };
      if (String(url).endsWith('/state/feedback') && opts.method === 'GET')
        return { ok: true, json: async () => ({ fields: { data: { stringValue: JSON.stringify(shared) } } }) };
      if (String(url).includes('/members/') && opts.method === 'GET') return { ok: true, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  const changed = await vm.runInContext('syncFeedback()', app);
  assert.equal(changed, false, 'identical on both sides, nothing to do');
  assert.ok(!app.calls.some(c => c.opts.method === 'PATCH'), 'no pointless write');
});

test('a failed sync is invisible, never thrown at the caller', async () => {
  const app = load({
    lsStore: { bf_sync_group: 'g1' },
    fetchImpl: async () => { throw new TypeError('offline'); },
  });
  const changed = await vm.runInContext('syncFeedback()', app);
  assert.equal(changed, false);
});
