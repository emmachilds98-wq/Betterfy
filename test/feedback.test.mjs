import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Filing teaches the model twice, and only one half was being kept. Accepting
// a suggestion is learned for free — the track joins the playlist and the next
// sync folds it into that playlist's centroid. Rejecting one taught it
// nothing: Skip advanced an in-memory index and no more, so the same wrong
// suggestion came back for the same track every session, forever.
// These cover the negative half: skips and per-track rejections.

const BUNDLE = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');

function slice(from, to, what) {
  const i = BUNDLE.indexOf(from), j = BUNDLE.indexOf(to);
  assert.ok(i > 0 && j > i, `${what} not found — rebuild with npm run build:web`);
  return BUNDLE.slice(i, j);
}

/** The feedback helpers, over an in-memory idb. */
function load(initial = {}) {
  let store = initial ? JSON.parse(JSON.stringify(initial)) : undefined;
  const sandbox = {
    idb: {
      get: async k => (k === 'feedback' && store ? JSON.parse(JSON.stringify(store)) : undefined),
      set: async (k, v) => { if (k === 'feedback') store = JSON.parse(JSON.stringify(v)); },
    },
    console,
    peek: () => store,
  };
  vm.createContext(sandbox);
  // `let`/`const` at the top of a vm script are lexically scoped to that
  // script, not properties of the context — so hand the bindings out
  // explicitly. FB is handed out as a getter because loadFeedback reassigns it.
  vm.runInContext(
    slice('let FB = {};', 'const FIELDS =', 'feedback helpers') + `
    globalThis.loadFeedback = loadFeedback;
    globalThis.recordSkip = recordSkip;
    globalThis.recordReject = recordReject;
    globalThis.clearFeedback = clearFeedback;
    globalThis.getFB = () => FB;`,
    sandbox);
  return sandbox;
}

test('a skip is remembered, so the same track does not reopen the queue next session', async () => {
  const s = load({});
  await s.loadFeedback();
  await s.recordSkip('t1');
  assert.equal(s.peek().t1.skips, 1);
  assert.ok(s.peek().t1.lastSkip, 'a skip records when, so it can age out later');

  await s.recordSkip('t1');
  assert.equal(s.peek().t1.skips, 2, 'skipping twice counts twice');
});

test('rejecting a playlist records it against that track only', async () => {
  const s = load({});
  await s.loadFeedback();
  await s.recordReject('t1', 'pl-lyricism');
  await s.recordReject('t2', 'pl-house');

  assert.deepEqual(s.peek().t1.rejected, ['pl-lyricism']);
  assert.deepEqual(s.peek().t2.rejected, ['pl-house']);
});

test('rejecting the same playlist twice does not duplicate it', async () => {
  const s = load({});
  await s.loadFeedback();
  await s.recordReject('t1', 'pl-a');
  await s.recordReject('t1', 'pl-a');
  assert.deepEqual(s.peek().t1.rejected, ['pl-a']);
});

test('a track can reject several playlists without losing the earlier ones', async () => {
  const s = load({});
  await s.loadFeedback();
  await s.recordReject('t1', 'pl-a');
  await s.recordReject('t1', 'pl-b');
  assert.deepEqual(s.peek().t1.rejected, ['pl-a', 'pl-b']);
});

test('skips and rejections coexist on one track', async () => {
  const s = load({});
  await s.loadFeedback();
  await s.recordSkip('t1');
  await s.recordReject('t1', 'pl-a');
  assert.equal(s.peek().t1.skips, 1);
  assert.deepEqual(s.peek().t1.rejected, ['pl-a']);
});

test('feedback saved in an earlier session is read back at boot', async () => {
  const s = load({ t9: { skips: 3, lastSkip: '2026-01-01T00:00:00Z', rejected: ['pl-z'] } });
  await s.loadFeedback();
  assert.equal(s.getFB().t9.skips, 3);
  assert.deepEqual(s.getFB().t9.rejected, ['pl-z']);
});

test('a first run with nothing stored starts empty rather than throwing', async () => {
  const s = load(null);
  await s.loadFeedback();
  // Objects built inside the vm belong to that realm, so compare shape not identity.
  assert.deepEqual(Object.keys(s.getFB()), []);
});

test('clearFeedback forgets one track and leaves the rest alone', async () => {
  const s = load({});
  await s.loadFeedback();
  await s.recordSkip('t1');
  await s.recordSkip('t2');
  await s.clearFeedback('t1');
  assert.equal(s.peek().t1, undefined);
  assert.equal(s.peek().t2.skips, 1);
});

/* ---- how buildReports and the queue use it ---- */

test('buildReports drops rejected playlists from a track\'s suggestions', () => {
  const body = slice('function buildReports(lib, cfg, tags)', 'function secDupes', 'buildReports');
  assert.match(body, /rank\(t, tags, profiles, idf, \{ top: 8 \}\)[\s\S]*?filter\(b => !fb\?\.rejected\?\.includes\(b\.id\)\)/,
    'suggestions must exclude what was rejected for this track');
  assert.match(body, /\.slice\(0, 3\)/,
    'more than three are ranked so a rejection promotes the next real candidate rather than leaving a gap');
});

test('skipped tracks sink below everything not yet seen', () => {
  const body = slice('function buildReports(lib, cfg, tags)', 'function secDupes', 'buildReports');
  assert.match(body, /\.sort\(\(a,b\) => \(a\.skips - b\.skips\) \|\| \(b\.added\?\?''\)\.localeCompare\(a\.added\?\?''\)\)/,
    'the queue must move on from a skip, while still preferring newest first among unseen tracks');
});

test('Skip persists before moving the card to the back of the queue', () => {
  const body = slice("if (a === 'skip')", "if (a === 'unlike')", 'skip handler');
  assert.match(body, /await recordSkip\(t\.id\)/, 'a skip is only meaningful if it is written down');
  assert.match(body, /R\.backlog\.push\(t\)/, 'the card goes to the back so the rest of the queue advances');
});
