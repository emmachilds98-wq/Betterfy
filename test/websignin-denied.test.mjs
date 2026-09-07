import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Spotify's access_denied covers two different situations under one code:
// "you tapped cancel" and "this app has a 25-account cap in development mode
// and you aren't on the approved list". Getting onto that list used to mean
// handing your Spotify account email to whoever runs the page. Since the page
// already lets anyone register their own free Spotify app (no email to
// anyone, no secret, PKCE-only), access_denied should hand people that path
// immediately rather than send them back to ask for approval.

const BUNDLE = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');

function slice(from, to, what) {
  const i = BUNDLE.indexOf(from), j = BUNDLE.indexOf(to);
  assert.ok(i > 0 && j > i, `${what} not found — rebuild with npm run build:web`);
  return BUNDLE.slice(i, j);
}

/** A DOM stub with just enough of $()/createElement for the error branch. */
function fakeDom() {
  const els = new Map();
  const el = id => {
    if (!els.has(id)) els.set(id, { id, hidden: true, open: false, innerHTML: '', children: [],
      after(node) { this._after = node; } });
    return els.get(id);
  };
  el('land'); el('setupPanel'); el('ownAppDetails');
  const cta = { after(node) { cta._after = node; } };
  return {
    els, cta,
    $: sel => sel === '.cta' ? cta : (sel.startsWith('#') ? els.get(sel.slice(1)) ?? null : null),
    document: {
      createElement: () => { const n = { classList: { add(){} } }; return n; },
    },
  };
}

async function boot(search) {
  const dom = fakeDom();
  const toasts = [];
  const sandbox = {
    T: {}, S: {}, REDIRECT: 'https://example.test/Betterfy/',
    location: { search },
    URLSearchParams,
    $: dom.$,
    document: dom.document,
    LS: { store: {}, setItem(k, v) { this.store[k] = v; }, getItem(k) { return this.store[k]; } },
    history: { calls: [], replaceState(...a) { this.calls.push(a); } },
    setTimeout: () => {},
    checkForUpdate: () => {},
    toast: m => toasts.push(m),
    console,
  };
  // Anchored to the start of a line: a bare "(async () => {" also matches a
  // nested arrow somewhere above, and then this slices the wrong region.
  const friendly = slice('const FRIENDLY = {', '\n(async () => {', 'FRIENDLY table');
  // The boot IIFE's own opening/closing are stripped so this can be re-wrapped
  // and awaited directly — the "return" inside the error branch only parses
  // inside a function body.
  const body = slice("if (T.rememberFilters) { if (T.crossMin)", "const code = q.get('code');", 'access_denied handling');
  vm.createContext(sandbox);
  await vm.runInContext(friendly + `(async () => {\n${body}\n})()`, sandbox);
  return { dom, toasts, sandbox };
}

const run = errorCode => boot(errorCode ? `?error=${errorCode}` : '');

test('access_denied reveals the "bring your own app" setup panel, expanded', async () => {
  const { dom } = await run('access_denied');
  assert.equal(dom.els.get('setupPanel').hidden, false);
  assert.equal(dom.els.get('ownAppDetails').open, true);
});

test('access_denied leaves a persistent explanation, not just a toast that vanishes', async () => {
  const { dom } = await run('access_denied');
  assert.ok(dom.cta._after, 'a fineprint hint is inserted after the CTA');
  assert.match(dom.cta._after.innerHTML, /use your own Spotify app/);
  assert.match(dom.cta._after.innerHTML, /#ownAppDetails/, 'and it links straight to it, not just mentions it');
});

test('the setup panel stays revealed across reload — remembered like the ?setup flag', async () => {
  const { sandbox } = await run('access_denied');
  assert.equal(sandbox.LS.store.bf_setup, '1');
});

test('a different error code does not touch the setup panel at all', async () => {
  const { dom } = await run('server_error');
  assert.equal(dom.els.get('setupPanel').hidden, true);
  assert.equal(dom.cta._after, undefined);
});

test('the access_denied toast itself points at the same escape hatch', async () => {
  const { toasts } = await run('access_denied');
  assert.match(toasts[0], /approved/i);
});

// Spotify lets a non-allowlisted account complete sign-in and only refuses the
// API calls that follow, with a 403 — discovered one step later than
// access_denied, but the fix is identical. start()'s catch (untested here —
// it needs the whole app booted) reloads to ?setup&reason=not_allowlisted
// rather than rebuilding the panel in place, since by then stage() has already
// overwritten #land's pristine markup. These pin what that reload lands on.

test('a 403-after-sign-in reload reveals the same setup panel access_denied does', async () => {
  const { dom } = await boot('?setup&reason=not_allowlisted');
  assert.equal(dom.els.get('setupPanel').hidden, false);
  assert.equal(dom.els.get('ownAppDetails').open, true);
});

test('a 403-after-sign-in reload leaves the same persistent explanation', async () => {
  const { dom } = await boot('?setup&reason=not_allowlisted');
  assert.ok(dom.cta._after, 'a fineprint hint is inserted after the CTA');
  assert.match(dom.cta._after.innerHTML, /use your own Spotify app/);
  assert.match(dom.cta._after.innerHTML, /#ownAppDetails/);
});

test('a 403-after-sign-in reload does not loop: the reason is stripped from the URL', async () => {
  const { sandbox } = await boot('?setup&reason=not_allowlisted');
  // The {} first argument crosses a vm realm boundary, so compare the URL
  // alone rather than the whole call with assert.deepEqual.
  assert.equal(sandbox.history.calls[0][2], 'https://example.test/Betterfy/?setup');
});

test('a 403-after-sign-in reload toasts too, distinctly from access_denied', async () => {
  const { toasts } = await boot('?setup&reason=not_allowlisted');
  assert.match(toasts[0], /approved/i);
});
