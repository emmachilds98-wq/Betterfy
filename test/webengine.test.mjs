import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/*
 * The Engine screen, run rather than reasoned about.
 *
 * Phase 5's gate in docs/THINKING-ENGINE-PLAN.md is "the queue renders on the
 * phone build", and a passing unit test for `placements()` is not that. The
 * screen is 200 lines of string-building over an engine loaded from a second
 * file, and every way it can break — a renamed export, a field that is called
 * `overlap` and not `share`, a global the lazy loader never defines — breaks it
 * silently, at runtime, on somebody's phone.
 *
 * So these run the real screen code out of the real built page, against the real
 * engine bundle, and read the HTML that comes out. The stubs below are only the
 * app shell: the library, the v1 report the screen compares itself against, and
 * the handful of helpers the page defines elsewhere.
 */

const PAGE = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
const ENGINE = readFileSync(new URL('../docs/engine.js', import.meta.url), 'utf8');

function slice(from, to, what) {
  const i = PAGE.indexOf(from), j = PAGE.indexOf(to);
  assert.ok(i > 0 && j > i, `${what} not found — rebuild with npm run build:web`);
  return PAGE.slice(i, j);
}

const SCREEN = () => slice('/* ======================= the account-native engine',
  "document.addEventListener('click', guard(async e => {", 'the Engine screen');

const track = (id, artist, over = {}) => ({
  id, name: 'Track ' + id, artists: [{ id: 'ar-' + artist, name: artist }],
  album: 'Album ' + id, albumType: 'single', albumTracks: 2, trackNo: 1,
  duration_ms: 400000, released: '2021-05-01', popularity: 40,
  isrc: 'GBXYZ21' + String(10000 + Number(String(id).replace(/\D/g, '') || 0)).slice(0, 5),
  added_at: '2024-03-01T00:00:00Z', ...over });

/**
 * Two clearly different families, each with enough crossover for the artist
 * graph to find something, plus two liked tracks nobody has filed.
 */
function library() {
  const house = [], ambient = [];
  for (let i = 0; i < 9; i++) house.push(track('h' + i, 'House' + (i % 3)));
  for (let i = 0; i < 9; i++) ambient.push(track('m' + i, 'Amb' + (i % 3),
    { albumType: 'album', albumTracks: 11, duration_ms: 190000, released: '1996-02-01', popularity: 8 }));
  // Crossover, so some artists appear in more than one bucket.
  const crossA = track('x0', 'House0', { id: 'x0' });
  const crossB = track('x1', 'Amb0', { id: 'x1', albumType: 'album', albumTracks: 11 });
  return {
    playlists: [
      { id: 'p-house', name: 'Tech House', tracks: [...house, crossB] },
      { id: 'p-amb', name: 'Ambient', tracks: [...ambient, crossA] },
      { id: 'p-late', name: 'Late Night', tracks: [...house.slice(0, 6), ...ambient.slice(0, 2)] },
    ],
    liked: [track('u0', 'House1'), track('u1', 'Nobody')],
  };
}

/** The app shell the screen reads, and nothing it does not. */
function screen({ lib = library(), backlog = null, tags = {}, durable = true,
                  worker = null, isMirror = () => false, cfg = null } = {}) {
  const store = new Map();
  const sandbox = {
    ...(worker ? { Worker: worker } : {}),
    console, performance, setTimeout, clearTimeout,
    requestAnimationFrame: fn => setTimeout(fn, 0),
    LIB: lib,
    TAGS: tags,
    // Which playlists take suggestions: every playlist in the fixture, unless a
    // test says otherwise. Both engines file only into these.
    CFG: cfg ?? Object.fromEntries(lib.playlists.map(p => [p.id, { name: p.name, target: !isMirror(p) }])),
    // What the File screen is currently offering, which is the thing the shadow
    // comparison is a comparison *against*.
    R: { backlog: backlog ?? [
      { id: 'u0', title: 'Track u0', artist: 'House1', suggest: [{ id: 'p-house', name: 'Tech House', score: 0.6 }] },
      { id: 'u1', title: 'Track u1', artist: 'Nobody', suggest: [] },
    ] },
    esc: s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    guard: fn => fn,
    isMirrorPlaylist: isMirror,
    renders: 0,
    toasts: [],
    idb: {
      get durable() { return durable; },
      get: k => store.get(k) ?? null,
      set: (k, v) => { if (durable) store.set(k, v); },
      del: k => { store.delete(k); },
    },
    document: { head: { appendChild() {} }, createElement: () => ({}) },
  };
  sandbox.render = () => { sandbox.renders++; };
  sandbox.toast = m => sandbox.toasts.push(m);
  vm.createContext(sandbox);
  // The engine bundle first, so the screen's lazy loader finds it already present
  // and never needs the DOM. Loaded exactly as a <script> would: bare, global.
  vm.runInContext(ENGINE, sandbox);
  vm.runInContext(SCREEN(), sandbox);
  return sandbox;
}

test('the engine bundle defines every global the screen reaches for', () => {
  const s = screen();
  // Named individually on purpose: a renamed export in build-web.mjs's namespace
  // map would otherwise surface as a blank screen with a console error nobody
  // sees, and these are the exact names the screen uses.
  for (const g of ['BetterfyIntrinsic', 'BetterfyColdStart', 'BetterfyExplain',
                   'BetterfyReports', 'BetterfyPersist', 'BetterfyValidate', 'BetterfyBaseline']) {
    assert.equal(vm.runInContext(`typeof ${g}`, s), 'object', `${g} is missing from engine.js`);
  }
  assert.equal(vm.runInContext('typeof BetterfyIntrinsic.buildSpace', s), 'function');
  assert.equal(vm.runInContext('typeof BetterfyBaseline.baselineAccuracy', s), 'function');
});

test('before anything is analysed the screen offers to do it, and claims nothing', async () => {
  const s = screen();
  const html = vm.runInContext('vEngine()', s);
  assert.match(html, /Learn my library/);
  assert.match(html, /data-eng="go"/);
  // The promise that makes this screen safe to ship has to be on it.
  assert.match(html, /files nothing/i);
  assert.ok(!/%/.test(html.replace(/[^%]/g, '')) || !/right first time/.test(html),
    'no score before anything was scored');
});

test('analysing renders the rung, the comparison, and an explanation per track', async () => {
  const s = screen();
  await vm.runInContext('engineAnalyse()', s);
  assert.equal(vm.runInContext('ENG.status', s), 'ready', vm.runInContext('ENG.err ?? ""', s));
  const html = vm.runInContext('vEngine()', s);

  assert.match(html, /How much it has to go on/);
  assert.match(html, /Playlists it can file into/);
  assert.match(html, /What it would do differently/);
  // Both tracks in the stub backlog must appear, including the one neither
  // engine has an answer for.
  assert.match(html, /Track u0/);
  assert.match(html, /Track u1/);
  // The two-column comparison, with today's answer and this engine's.
  assert.match(html, /<em>today<\/em>/);
  assert.match(html, /<em>this engine<\/em>/);
  // And the verdict chip must be one of the three real tones, never undefined.
  assert.ok(!/class="tag undefined"/.test(html));
  assert.ok(!/undefined/.test(html), 'nothing on screen should read "undefined"');
  assert.ok(!/\[object Object\]/.test(html), 'and nothing should read "[object Object]"');
});

test('a placement resting on shape alone is marked as one, whatever its percentage', async () => {
  // 'Nobody' appears in no playlist, so the graph has nothing on them — but the
  // track still places, on duration and release type and era, and scored LIKELY
  // the first time this ran. That is honest arithmetic and a misleading thing to
  // show unqualified: generic shape fits a generic bucket comfortably. So the row
  // has to say the evidence is not about this record.
  const s = screen({ backlog: [{ id: 'u1', title: 'Track u1', artist: 'Nobody', suggest: [] }] });
  await vm.runInContext('engineAnalyse()', s);
  const row = JSON.parse(vm.runInContext('JSON.stringify(ENG.shadow.rows[0])', s));
  assert.equal(row.shapeOnly, true, 'no clause should name anything about this artist');
  assert.ok(row.why.length, 'and it should still say what it did go on');

  const html = vm.runInContext('vEngine()', s);
  assert.match(html, /shape only/);
  assert.match(html, /Treat this one as a shrug/);
  assert.match(html, /Placed on shape alone/, 'and the summary should count them');
});

test('a placement backed by the artist graph is not marked shape-only', async () => {
  // House1 is filed in two of the three buckets, so there is real evidence here
  // and the caveat above must not fire — a warning on every row is no warning.
  const s = screen({ backlog: [{ id: 'u0', title: 'Track u0', artist: 'House1',
                                 suggest: [{ id: 'p-house', name: 'Tech House', score: 0.6 }] }] });
  await vm.runInContext('engineAnalyse()', s);
  const row = JSON.parse(vm.runInContext('JSON.stringify(ENG.shadow.rows[0])', s));
  assert.equal(row.shapeOnly, false, 'an artist the account files should produce named evidence');
  assert.ok(row.why.some(w => w.mark === '\u2713'), 'with at least one strong clause');
  assert.ok(!/Treat this one as a shrug/.test(vm.runInContext('vEngine()', s)));
});

test('the shadow comparison never calls agreement accuracy', async () => {
  const s = screen();
  await vm.runInContext('engineAnalyse()', s);
  const html = vm.runInContext('vEngine()', s);
  // These tracks are unfiled: there is no ground truth, so claiming accuracy
  // here would be the exact dishonesty the whole screen is built to avoid.
  const shadow = html.slice(html.indexOf('What it would do differently'),
                            html.indexOf('Is it actually any better?'));
  assert.ok(shadow.length > 100, 'both sections should be present');
  assert.ok(!/\baccurac/i.test(shadow), 'the disagreement section must not claim accuracy');
  assert.match(shadow, /neither column is <i>known<\/i> to be right/);
});

test('the space is cached, so a second analysis revives instead of rebuilding', async () => {
  const s = screen();
  await vm.runInContext('engineAnalyse()', s);
  assert.equal(vm.runInContext('ENG.from', s), 'built');
  // A fresh screen over the same store would be a different sandbox, so reset
  // the in-memory state and re-analyse against the cache this run just wrote.
  vm.runInContext('ENG.status = "idle"; ENG.space = null;', s);
  await vm.runInContext('engineAnalyse()', s);
  assert.equal(vm.runInContext('ENG.from', s), 'cache', 'the second run must use the cache');
  assert.equal(vm.runInContext('ENG.status', s), 'ready');
});

test('a browser that stores nothing still works, and says the result is not remembered', async () => {
  const s = screen({ durable: false });
  await vm.runInContext('engineAnalyse()', s);
  assert.equal(vm.runInContext('ENG.status', s), 'ready');
  assert.equal(vm.runInContext('ENG.from', s), 'built');
  assert.match(vm.runInContext('vEngine()', s), /not remembered/);
});

test('scoring both engines reports the same denominator for each', async () => {
  const s = screen({ tags: { 'ar-House0': { tags: [['tech house', 100]] },
                             'ar-House1': { tags: [['tech house', 90]] },
                             'ar-House2': { tags: [['house', 80]] },
                             'ar-Amb0': { tags: [['ambient', 100]] },
                             'ar-Amb1': { tags: [['ambient', 95]] },
                             'ar-Amb2': { tags: [['drone', 70]] } } });
  await vm.runInContext('engineAnalyse()', s);
  await vm.runInContext('engineValidate()', s);
  const v = vm.runInContext('JSON.stringify(ENG.val ?? null)', s);
  const val = JSON.parse(v);
  assert.ok(val && !val.error, `validation failed: ${val?.error}`);
  assert.ok(val.base, 'with tags present the tag engine must be scored too');
  assert.equal(val.mine.scored, val.base.scored,
    'a comparison is only a comparison if both engines scored the same tracks');

  const html = vm.runInContext('vEngine()', s);
  assert.match(html, /right first time/);
  // One of the three verdicts, and never a claim of musical truth.
  assert.match(html, /Ahead\.|Behind\.|Level\./);
  assert.match(html, /not musical truth/);
});

test('with no tags at all the tag engine is not scored, rather than scored as zero', async () => {
  const s = screen({ tags: {} });
  await vm.runInContext('engineAnalyse()', s);
  await vm.runInContext('engineValidate()', s);
  const val = JSON.parse(vm.runInContext('JSON.stringify(ENG.val)', s));
  assert.equal(val.base, null, 'handing it an empty table and declaring it beaten would be rigging');
  const html = vm.runInContext('vEngine()', s);
  assert.match(html, /nothing to compare against/i);
  assert.ok(!/Ahead\.|Behind\.|Level\./.test(html), 'and no verdict should be announced');
});

test('forgetting clears the cache and returns the screen to its opening state', async () => {
  const s = screen();
  await vm.runInContext('engineAnalyse()', s);
  await vm.runInContext('engineReset()', s);
  assert.equal(vm.runInContext('ENG.status', s), 'idle');
  assert.equal(vm.runInContext('ENG.space', s), null);
  assert.match(vm.runInContext('vEngine()', s), /Learn my library/);
  // And the next analysis genuinely rebuilds rather than reviving what it just
  // promised to forget.
  await vm.runInContext('engineAnalyse()', s);
  assert.equal(vm.runInContext('ENG.from', s), 'built');
});

test('an engine that cannot be fetched leaves a retry, not a dead screen', async () => {
  const s = screen();
  // Simulate the lazy load failing the way a bad deploy or an offline phone does.
  vm.runInContext('ENGINE_JS = Promise.reject(new Error("could not fetch engine.js"));', s);
  await vm.runInContext('engineAnalyse()', s);
  assert.equal(vm.runInContext('ENG.status', s), 'error');
  const html = vm.runInContext('vEngine()', s);
  assert.match(html, /didn't work/);
  assert.match(html, /data-eng="go"/, 'and the retry must still be reachable');
});

test('the screen is reachable: it is in the view table, the order and the bar', () => {
  // A screen nothing routes to is a screen nobody can open, and that failure is
  // invisible to every test that calls vEngine() directly.
  assert.match(PAGE, /engine:vEngine/, 'VIEWS must map the view');
  assert.match(PAGE, /'lists','engine','history'/, 'VORDER must include it, for swipe and keys');
  assert.match(PAGE, /engine:'Engine'/, 'VTITLE must name it');
  assert.match(PAGE, /SECONDARY = new Set\(\[[^\]]*'engine'/, 'it belongs behind More, not on the bar');
  assert.match(PAGE, /data-v="engine"/, 'and a nav button must exist');
  assert.match(PAGE, /\[data-v="engine"\]\{--vc:/, 'with a screen colour, like every other view');
});


/* ---------- the worker ----------
 *
 * Learning and scoring run in docs/engine-worker.js when the browser has workers,
 * because on a big library they froze the page for seconds (6.2s measured for
 * scoring a 250-playlist library on the live build). These run the real generated
 * worker in its own sandbox, joined to the page's by structuredClone'd messages
 * the way a browser joins them, and hold it to one rule: the worker path must
 * give exactly the answer the main-thread path gives.
 */

const WORKER_SRC = readFileSync(new URL('../docs/engine-worker.js', import.meta.url), 'utf8');

/** A Worker built from the real worker file. `log` records every op it ran. */
function fakeWorker({ log = [], failToStart = false } = {}) {
  return class {
    constructor(url) {
      if (failToStart) throw new Error('workers are blocked here');
      this.url = url;
      const self = {};
      const ctx = { self, performance, Set, Map, Object, Math, JSON, Date, Error, String, Number, Array,
        importScripts: () => vm.runInContext(ENGINE, ctx) };
      self.postMessage = msg => setTimeout(() => this.onmessage?.({ data: structuredClone(msg) }), 0);
      vm.createContext(ctx);
      vm.runInContext(WORKER_SRC, ctx);
      this.self = self;
    }
    postMessage(msg) {
      log.push(msg.op);
      const data = structuredClone(msg);
      setTimeout(() => this.self.onmessage({ data }), 0);
    }
    terminate() {}
  };
}

const strip = v => { const { ms, where, ...rest } = v; return JSON.parse(JSON.stringify(rest)); };

test('the generated worker loads the engine from the same build as the page', () => {
  const page = PAGE.match(/engine-worker\.js\?v=([\w-]+)/)?.[1];
  const engine = WORKER_SRC.match(/importScripts\('engine\.js\?v=([\w-]+)'\)/)?.[1];
  assert.ok(page && engine, 'both stamps should be present — rebuild with npm run build:web');
  assert.equal(engine, page, 'a worker importing a different engine build would answer for another version');
});

test('learning in the worker gives exactly what learning on the page gives', async () => {
  const log = [];
  const viaWorker = screen({ worker: fakeWorker({ log }) });
  await vm.runInContext('engineAnalyse()', viaWorker);
  assert.equal(vm.runInContext('ENG.status', viaWorker), 'ready', vm.runInContext('ENG.err ?? ""', viaWorker));
  assert.equal(vm.runInContext('ENG.where', viaWorker), 'worker');
  assert.deepEqual(log, ['build']);

  const onPage = screen();
  await vm.runInContext('engineAnalyse()', onPage);
  assert.equal(vm.runInContext('ENG.where', onPage), 'page');

  for (const k of ['rung', 'shadow', 'pairs'])
    assert.deepEqual(JSON.parse(vm.runInContext(`JSON.stringify(ENG.${k})`, viaWorker)),
                     JSON.parse(vm.runInContext(`JSON.stringify(ENG.${k})`, onPage)), `${k} differs`);
});

test('scoring in the worker gives exactly what scoring on the page gives', async () => {
  const tags = { 'ar-House0': { tags: [['house', 100]] }, 'ar-Amb0': { tags: [['ambient', 100]] } };
  const viaWorker = screen({ tags, worker: fakeWorker() });
  await vm.runInContext('engineValidate()', viaWorker);
  const w = JSON.parse(vm.runInContext('JSON.stringify(ENG.val)', viaWorker));
  assert.ok(!w.error, w.error);
  assert.equal(w.where, 'worker');

  const onPage = screen({ tags });
  await vm.runInContext('engineValidate()', onPage);
  const p = JSON.parse(vm.runInContext('JSON.stringify(ENG.val)', onPage));
  assert.equal(p.where, 'page');
  assert.ok(w.mine.scored > 0 && w.base, 'both engines should actually have been scored');
  assert.deepEqual(strip(w), strip(p));
});

test('a mirror playlist is excluded in the worker exactly as on the page', async () => {
  // The worker cannot call isMirrorPlaylist — it reads the page's settings — so
  // the page sends the ids. Get that wrong and a record-of-everything playlist
  // floods the worker's graph while the page's stays clean.
  const lib = library();
  lib.playlists.push({ id: 'p-all', name: 'All Songs',
    tracks: lib.playlists.flatMap(p => p.tracks).concat(lib.liked) });
  const isMirror = p => p?.id === 'p-all';
  const viaWorker = screen({ lib, isMirror, worker: fakeWorker() });
  const onPage = screen({ lib, isMirror });
  await vm.runInContext('engineValidate()', viaWorker);
  await vm.runInContext('engineValidate()', onPage);
  const w = JSON.parse(vm.runInContext('JSON.stringify(ENG.val)', viaWorker));
  const p = JSON.parse(vm.runInContext('JSON.stringify(ENG.val)', onPage));
  assert.equal(w.where, 'worker');
  assert.deepEqual(strip(w), strip(p));
  assert.ok(!w.mine.playlists.some(b => b.id === 'p-all'), 'the mirror must never be a destination');
});

test('a worker that cannot start falls back to the page, with the same answer', async () => {
  const s = screen({ worker: fakeWorker({ failToStart: true }) });
  await vm.runInContext('engineAnalyse()', s);
  assert.equal(vm.runInContext('ENG.status', s), 'ready');
  assert.equal(vm.runInContext('ENG.where', s), 'page');
  await vm.runInContext('engineValidate()', s);
  assert.equal(vm.runInContext('ENG.val.where', s), 'page');
  assert.ok(!vm.runInContext('ENG.val.error', s));
  // And the screen must stop promising it runs in the background.
  vm.runInContext('ENG.valRunning = true', s);
  assert.match(vm.runInContext('vEngine()', s), /page will freeze/);
});

test('the score can be copied as plain text that names no track or artist', async () => {
  const tags = { 'ar-House0': { tags: [['house', 100]] } };
  const s = screen({ tags, worker: fakeWorker() });
  await vm.runInContext('engineAnalyse()', s);
  await vm.runInContext('engineValidate()', s);
  const html = vm.runInContext('vEngine()', s);
  assert.match(html, /data-eng="copy"/);

  const text = vm.runInContext('engineSummary()', s);
  assert.match(text, /This engine: top-1 \d+%, top-3 \d+%/);
  assert.match(text, /Today's engine: top-1 \d+%/);
  assert.match(text, /Rung: /);
  assert.match(text, /in the background/);
  assert.ok(!/undefined|NaN|\[object Object\]/.test(text), text);
  // Counts and the listener's own playlist names, never what is in them.
  assert.ok(!/Track \w+|House0|Amb0/.test(text), 'the summary must not leak track or artist names');
});

test('the weakest playlists are named, weakest first, and only with enough tracks to judge', async () => {
  const s = screen({ worker: fakeWorker() });
  await vm.runInContext('engineAnalyse()', s);
  await vm.runInContext('engineValidate()', s);
  const weak = JSON.parse(vm.runInContext('JSON.stringify(weakBuckets(ENG.val))', s));
  assert.ok(weak.length > 0, 'the fixture has three playlists with enough tracks');
  for (const b of weak) {
    assert.ok(b.n >= 5);
    assert.ok(['Tech House', 'Ambient', 'Late Night'].includes(b.name), `named by the listener's own name: ${b.name}`);
  }
  for (let i = 1; i < weak.length; i++) assert.ok(weak[i - 1].inTop3 <= weak[i].inTop3);
  assert.match(vm.runInContext('vEngine()', s), /Playlists it understands least/);
});


/* ---------- genre playlists only ---------- */

test('the engine files only into playlists that take suggestions', async () => {
  // "Late Night" is not a genre playlist: it must never be offered, by either
  // path, and the score must not count it as a right answer.
  const lib = library();
  const cfg = { 'p-house': { target: true }, 'p-amb': { target: true }, 'p-late': { target: false } };
  for (const worker of [null, fakeWorker()]) {
    const s = screen({ lib, cfg, ...(worker ? { worker } : {}) });
    await vm.runInContext('engineAnalyse()', s);
    const dest = JSON.parse(vm.runInContext('JSON.stringify([...ENG.space.destinations.keys()].sort())', s));
    assert.deepEqual(dest, ['p-amb', 'p-house'], worker ? 'worker' : 'page');
    await vm.runInContext('engineValidate()', s);
    const v = JSON.parse(vm.runInContext('JSON.stringify(ENG.val)', s));
    assert.ok(!v.mine.playlists.some(b => b.id === 'p-late'), 'never scored as a destination');
  }
});

test('changing which playlists take suggestions rebuilds rather than reusing the cache', async () => {
  const lib = library();
  const s = screen({ lib });
  await vm.runInContext('engineAnalyse()', s);
  vm.runInContext('CFG["p-late"].target = false; ENG.status = "idle"; ENG.space = null;', s);
  await vm.runInContext('engineAnalyse()', s);
  assert.equal(vm.runInContext('ENG.from', s), 'built', 'a space built for other playlists answers another question');
  assert.ok(!vm.runInContext('ENG.space.destinations.has("p-late")', s));
});

test('with no genre playlists the screen says where to mark some, instead of an empty result', () => {
  const lib = library();
  const s = screen({ lib, cfg: Object.fromEntries(lib.playlists.map(p => [p.id, { target: false }])) });
  const html = vm.runInContext('vEngine()', s);
  assert.match(html, /No genre playlists yet/);
  assert.match(html, /data-eng="lists"/);
});
