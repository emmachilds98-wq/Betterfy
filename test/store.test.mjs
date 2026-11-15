// The store (web/app/store.js, docs/BUILD-5-PLAN.md A3): background jobs say
// which slice they changed, and only a screen that reads it repaints, once per
// frame. Three kinds of test: a grep gate on the source, the store's own API
// run from the built page, and real background jobs from the built page
// against the real render(), on a screen that does and one that doesn't read
// what they changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';

import { APP_FILES } from '../web/manifest.mjs';
import { STORE_CODE, addStore } from './fixtures/page-store.mjs';

const WEB = new URL('../web/', import.meta.url);
const src = f => readFileSync(new URL(f, WEB), 'utf8');
/** Code without its comments, so prose that says "render()" doesn't count. */
const code = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
const PAGE = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
function slice(from, to, what) {
  const i = PAGE.indexOf(from), j = PAGE.indexOf(to, i + 1);
  assert.ok(i > 0 && j > i, `${what} not found — rebuild with node build-web.mjs`);
  return PAGE.slice(i, j);
}

/* ---------- the gate: no blind render() from a background job ---------- */

// Files that are background work through and through: listening, the engine,
// sync, tag fills, sound-first, CLAP, the player's poll. None of them may call
// render() at all; they write a slice. blend.js is #111's blend refresh, held
// to the same rule when it lands.
const BACKGROUND = ['app/audio.js', 'app/audio-panel.js', 'app/listening.js', 'app/soundfirst.js', 'app/clap.js',
  'app/keyless.js', 'app/engine.js', 'app/sync.js', 'app/sync-tags.js', 'app/tagfix.js', 'app/tagshare.js',
  'app/player.js', 'app/version.js', 'app/cache.js', 'app/feedback.js', 'app/blend.js'];

test('no background-job file calls render() itself', () => {
  for (const f of BACKGROUND) {
    if (!existsSync(new URL(f, WEB))) continue;
    const lines = code(src(f)).split('\n');
    const bad = lines.map((l, i) => [i + 1, l]).filter(([, l]) => /(^|[^\w.])render\(\)/.test(l));
    assert.deepEqual(bad.map(([n, l]) => `${f}:${n}: ${l.trim()}`), [],
      `${f} is a background job: write a slice with store.set() or repaint([...]) instead (web/app/store.js)`);
  }
});

test('no file redraws from a callback or a view check: that shape is a background job', () => {
  // A promise landing, a timer, or "only if this screen is up" is never the
  // user acting; it is exactly what the store's slices are for.
  const shapes = [/\.then\([^;]*(^|[^\w.])render\(\)/, /setTimeout\([^;]*(^|[^\w.])render\(\)/,
                  /requestAnimationFrame\([^;]*(^|[^\w.])render\(\)/, /view\s*!?==?=\s*'[a-z]+'[^;]*(^|[^\w.])render\(\)/];
  for (const f of APP_FILES) {
    if (f === 'app/store.js' || f === 'app/render.js') continue;
    code(src(f)).split('\n').forEach((l, i) => {
      for (const re of shapes) assert.ok(!re.test(l), `${f}:${i + 1} redraws from a background shape: ${l.trim()}`);
    });
  }
});

test('render() is called only by the store, the first paint, navigation and user actions', () => {
  // The store is the one place a background repaint reaches render().
  assert.match(code(src('app/store.js')), /\n\s*render\(\);/);
  assert.ok(APP_FILES.indexOf('app/store.js') < APP_FILES.indexOf('app/listening.js'),
    'the store comes before every file whose jobs write to it');
  assert.ok(APP_FILES.indexOf('app/ui.js') < APP_FILES.indexOf('app/store.js'), 'after the page state it wraps');
});

test('every slice a job writes is one the store knows, and every screen says what it reads', () => {
  const s = addStore(vm.createContext({}));
  const known = new Set(vm.runInContext('Object.keys(STORE_BOUND)', s));
  const screens = vm.runInContext('Object.keys(SCREEN_SLICES)', s);
  const views = [...src('app/ui.js').match(/const VORDER = \[([^\]]+)\]/)[1].matchAll(/'([a-z]+)'/g)].map(m => m[1]);
  assert.deepEqual([...screens].sort(), [...views].sort(), 'SCREEN_SLICES names every screen, and only screens');
  for (const v of screens) for (const sl of vm.runInContext(`SCREEN_SLICES.${v}`, s))
    assert.ok(known.has(sl) || sl === `ui.${v}`, `${v} reads ${sl}, which is no slice`);
  const written = new Set();
  for (const f of APP_FILES) {
    const c = code(src(f));
    for (const m of c.matchAll(/store\.set\('([^']+)'/g)) written.add(m[1]);
    for (const m of c.matchAll(/repaint\(\[([^\]]*)\]\)/g)) for (const n of m[1].matchAll(/'([^']+)'/g)) written.add(n[1]);
  }
  assert.ok(written.size >= 6, [...written].join());
  for (const sl of written)
    assert.ok(known.has(sl) || (sl.startsWith('ui.') && views.includes(sl.slice(3))), `a job writes ${sl}, which no screen could read`);
});

/* ---------- the store's API, run from the built page ---------- */

function storeBox({ view = 'home' } = {}) {
  const frames = [];
  const s = vm.createContext({ view, LIB: { playlists: [] }, R: { backlog: [] },
    ENG: { status: 'idle', err: null }, SOUND: { status: 'idle' }, AUDIO: {}, GAPS: {}, PLAYER: {}, renders: 0 });
  s.render = () => { s.renders++; };
  addStore(s, { frames });
  const frame = () => { const due = frames.splice(0); for (const fn of due) fn(); return due.length; };
  return { s, frames, frame, run: c => vm.runInContext(c, s) };
}

test('get reads the page\'s own state; set replaces lib, reports and ui.*, and patches the objects', () => {
  const { s, run } = storeBox();
  assert.equal(run("store.get('reports')"), s.R);
  assert.equal(run("store.get('eng')"), s.ENG);
  const R2 = run("store.set('reports', { backlog: [1, 2] })");
  assert.deepEqual(JSON.parse(JSON.stringify(R2)), { backlog: [1, 2] });
  assert.equal(s.R, R2, 'R itself is the slice: what every screen already reads');
  const eng = s.ENG;
  run("store.set('eng', { status: 'working' })");
  assert.equal(s.ENG, eng, 'the object stays the same object');
  assert.equal(s.ENG.status, 'working');
  assert.equal(s.ENG.err, null, 'and keeps what the patch left out');
  run("store.set('eng', e => { e.err = 'x'; })");
  assert.equal(s.ENG.err, 'x', 'an updater may change it in place');
  run("store.set('ui.lists', 3)");
  run("store.set('ui.lists', n => n + 1)");
  assert.equal(run("store.get('ui.lists')"), 4);
  run("store.set('ui.lists', n => { })");
  assert.equal(run("store.get('ui.lists')"), 4, 'an updater returning nothing keeps the value');
  assert.equal(run("store.get('ui.nothing')"), undefined);
});

test('on() hears every change to its slice, from set() and repaint(); off() stops it', () => {
  const { s, run } = storeBox();
  s.heard = [];
  run("globalThis.off = store.on('eng', (v, sl) => heard.push([sl, v.status]))");
  run("store.on('sound', (v, sl) => heard.push([sl, v.status]))");
  run("store.set('eng', { status: 'working' })");
  run("repaint(['eng', 'gaps'])");
  run("store.set('sound', { status: 'ready' })");
  run('off()');
  run("store.set('eng', { status: 'ready' })");
  assert.deepEqual(JSON.parse(JSON.stringify(s.heard)), [['eng', 'working'], ['eng', 'working'], ['sound', 'ready']]);
  run("store.on('gaps', () => { throw new Error('a listener failing') })");
  s.console = { error: () => { s.logged = true; } };
  run("store.set('gaps', { status: 'ready' })");
  assert.ok(s.logged, 'a failing listener is reported, and the others still run');
});

test('any number of changes in one frame make one repaint', () => {
  const { s, frames, frame, run } = storeBox({ view: 'engine' });
  run("store.set('eng', { status: 'working' }); store.set('eng', { valStage: 'bridge' }); repaint(['eng', 'reports'])");
  assert.equal(frames.length, 1, 'one frame asked for');
  assert.equal(s.renders, 0, 'nothing drawn before it');
  frame();
  assert.equal(s.renders, 1, 'one repaint for all three');
  assert.equal(frame(), 0, 'and no frame left over');
  run("repaint(['eng'])");
  frame();
  assert.equal(s.renders, 2, 'the next frame repaints again');
  run('repaint([])');
  assert.equal(frames.length, 0, 'nothing changed: no frame');
});

test('only a screen that reads a slice repaints for it; lib and reports reach every screen', () => {
  const cases = [
    ['engine', 'eng', 1], ['inbox', 'eng', 0], ['home', 'eng', 0],
    ['inbox', 'sound', 1], ['tidy', 'sound', 1], ['home', 'sound', 0], ['lists', 'sound', 0], ['discover', 'sound', 0],
    ['home', 'audio', 1], ['inbox', 'audio', 0], ['sources', 'audio', 0],
    ['new', 'gaps', 1], ['inbox', 'gaps', 0],
    ['discover', 'player', 0], ['inbox', 'player', 0],
    ['tidy', 'ui.tidy', 1], ['inbox', 'ui.tidy', 0], ['lists', 'ui.lists', 1], ['shuffle', 'ui.lists', 0],
    ...['home', 'inbox', 'tidy', 'discover', 'engine', 'history', 'sources'].flatMap(v => [[v, 'reports', 1], [v, 'lib', 1]]),
  ];
  for (const [view, slice, n] of cases) {
    const { s, frame, run } = storeBox({ view });
    run(`repaint(['${slice}'])`);
    frame();
    assert.equal(s.renders, n, `${slice} changing while on ${view}`);
  }
});

test('the screen is the one on view when the frame comes, and nothing draws before sign-in', () => {
  const { s, frame, run } = storeBox({ view: 'engine' });
  run("store.set('eng', { status: 'ready' })");
  s.view = 'inbox';                       // moved on before the frame: go() already drew it
  frame();
  assert.equal(s.renders, 0);
  const b = storeBox({ view: 'engine' });
  b.s.LIB = null;
  b.run("repaint(['eng', 'reports'])");
  b.frame();
  assert.equal(b.s.renders, 0, 'no library yet: no screen to draw');
});

/* ---------- real background jobs, the real render(), a fake #main ---------- */

const UI = slice("const VORDER = ['home'", 'let toastT;', 'the screen order (ui.js)');
const RENDER = slice('const VIEWS = { home:vHome', '/** Move to another screen', 'render() (render.js)');
const MIDRUN = slice('const AUDIO_MIDRUN = {', '/* ---------- mood, voice and energy', 'the mid-run refresh (audio.js)');
const TIDYSOUND = slice("const TSOUND = { status: 'idle'", 'function tidySoundTrack(', 'Tidy by sound (tidy.js)');
const VNAMES = { home: 'vHome', inbox: 'vInbox', tidy: 'vTidy', new: 'vNew', discover: 'vDiscover', shuffle: 'vShuffle',
                 lists: 'vLists', engine: 'vEngine', history: 'vHistory', sources: 'vSources' };

function pageBox(view) {
  const el = id => ({ id, dataset: {}, attrs: {}, offsetWidth: 0, textContent: '', children: [], childElementCount: 0,
    classList: { add() {}, remove() {} }, setAttribute(k, v) { this.attrs[k] = v; },
    html: '', writes: 0, get innerHTML() { return this.html; }, set innerHTML(v) { this.html = v; this.writes++; } });
  const byId = { main: el('main'), mtitle: el('mtitle'), tabMore: el('tabMore'), dots: el('dots') };
  const frames = [], pending = [];
  const s = vm.createContext({
    console, view, byId, drawn: {}, pending,
    document: { documentElement: { style: { setProperty() {} } }, querySelectorAll: () => [], getElementById: id => byId[id] ?? null },
    $: sel => byId[sel.replace(/^#/, '')] ?? null,
    bindSwipeCard() {}, playerStop() {}, playerRun() {}, guard: f => f,
    LIB: { playlists: [{ id: 'p1', tracks: [] }], liked: [] },
    R: { backlog: [{ id: 't1' }], within: [], misfiled: [], clusters: [] },
    FB: {}, LABELCHECKS: {}, idb: { get: async () => ({}) }, BetterfyAudio: { CHECKS_KEY: 'checks' },
    fire: p => { pending.push(Promise.resolve(p)); },
    soundWarm() { s.warmed = (s.warmed ?? 0) + 1; },
    soundHeard: () => [...(s.AUDIO.records?.values() ?? [])].length,
    engineTargets: () => ['p1'], engineAudio: async () => s.AUDIO.records,
    AUDIO: { records: null, ctrl: { refresh: async () => new Map([['t1', { id: 't1' }], ['t2', { id: 't2' }]]) } },
    ENG: {}, SOUND: {}, GAPS: {}, PLAYER: {},
  });
  // Every screen draws its name and how often it was drawn: the swipe deck
  // being thrown away and drawn again shows as a new count.
  for (const [v, fn] of Object.entries(VNAMES)) s[fn] = () => `<section>${v} #${(s.drawn[v] = (s.drawn[v] ?? 0) + 1)}</section>`;
  addStore(s, { frames });
  vm.runInContext(UI + RENDER + MIDRUN + TIDYSOUND, s);
  vm.runInContext('render()', s);          // the first paint, as start() does
  const main = byId.main;
  return {
    s, main,
    settle: async () => { while (pending.length) await pending.shift(); for (const fn of frames.splice(0)) fn(); },
  };
}
const running = "({ state: 'running', heard: 40 })";

test('built page: listening hears more while on Lists, and Lists is left exactly as it was', async () => {
  const { s, main, settle } = pageBox('lists');
  const before = main.innerHTML;
  assert.equal(before, '<section>lists #1</section>');
  vm.runInContext(`audioMidRun(${running})`, s);
  await settle();
  assert.equal(s.AUDIO.records.size, 2, 'the job ran: the heard records were re-read');
  assert.equal(main.writes, 1, '#main was not written again');
  assert.equal(main.innerHTML, before);
  assert.equal(s.drawn.lists, 1);
});

test('built page: the same refresh while on File redraws File, once', async () => {
  const { s, main, settle } = pageBox('inbox');
  vm.runInContext(`audioMidRun(${running})`, s);
  await settle();
  assert.equal(s.warmed, 1, 'File\'s sound space is warmed, as before');
  assert.equal(main.innerHTML, '<section>inbox #2</section>', 'File reads what was heard, so it repaints');
  assert.equal(main.writes, 2);
});

test('built page: on Home the heard count ticks in place; the cards are not replayed for it', async () => {
  const { s, main, settle } = pageBox('home');
  vm.runInContext(`audioMidRun(${running})`, s);
  await settle();
  assert.equal(s.warmed, 1);
  assert.equal(main.writes, 1, 'Home shows no sound picks: before A3 this re-drew the whole screen');
});

test('built page: Tidy by sound finishing while on File leaves File; on Tidy it redraws Tidy', async () => {
  for (const [view, writes] of [['inbox', 1], ['discover', 1], ['tidy', 2]]) {
    const { s, main, settle } = pageBox(view);
    s.AUDIO.records = new Map([['t1', { id: 't1' }]]);
    s.audioSettings = () => ({ on: true });
    vm.runInContext("TSOUND.status = 'working'; fire(tidySoundLoad())", s);
    await settle();
    assert.equal(vm.runInContext('TSOUND.status', s), 'idle', 'the job ran');
    assert.equal(main.writes, writes, `on ${view}`);
  }
});

test('built page: a sync landing repaints any screen, since the tab counts read it', async () => {
  const { s, main, settle } = pageBox('engine');
  vm.runInContext("store.set('reports', { ...R, backlog: [] })", s);
  vm.runInContext("store.set('reports', { ...R })", s);
  await settle();
  assert.equal(main.writes, 2, 'one repaint for two landings in the same frame');
  assert.equal(main.innerHTML, '<section>engine #2</section>');
});

test('the store slice is cut whole from the built page', () => {
  assert.match(STORE_CODE, /^\/\* ---------- the store: docs\/BUILD-5-PLAN\.md A3/);
  assert.match(STORE_CODE, /end of the store ---------- \*\/$/);
  assert.equal(PAGE.split(STORE_CODE).length, 2, 'once, verbatim');
});
