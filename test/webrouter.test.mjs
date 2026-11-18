import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// A6 of docs/BUILD-5-PLAN.md (bug B9): back closes a sheet, then returns to the
// previous screen, and the URL says where you are. Runs the real router.js
// against a fake History that behaves like the browser's.

const SRC = readFileSync(new URL('../web/app/router.js', import.meta.url), 'utf8');
const VIEWS = ['inbox', 'tidy', 'discover', 'lists', 'new', 'shuffle'];
const MOVED = { home: { view: 'inbox' }, sources: { section: 'sources' }, engine: { section: 'engine' }, history: { section: 'history' } };
const settle = () => new Promise(res => setImmediate(res));

function rig(hash = '') {
  const stack = [{ state: null, hash }]; let i = 0;
  const app = { view: 'inbox', sheet: null };
  const loc = { get hash() { return stack[i].hash; } };
  let r;
  const hist = {
    get state() { return stack[i].state; },
    pushState(state, _t, h) { stack.length = i + 1; stack.push({ state, hash: h }); i++; },
    replaceState(state, _t, h) { stack[i] = { state, hash: h }; },
    back() { if (i > 0) { i--; queueMicrotask(() => r.onPop()); } },   // popstate is async
  };
  const sb = vm.createContext({});
  vm.runInContext(SRC.slice(0, SRC.indexOf('const ROUTER')), sb);
  r = sb.makeRouter({
    views: VIEWS, hist, loc, moved: MOVED, fallback: 'inbox',
    getView: () => app.view, getSheet: () => app.sheet,
    setView: v => { app.view = v; },
    setSheet: s => { app.sheet = s; },
  });
  // What go() / openSheet() do: change the screen, then tell the router.
  const go = v => { app.view = v; r.note(); };
  const sheet = s => { app.sheet = s; r.note(); };
  const back = async () => { hist.back(); await settle(); };
  return { r, app, stack, go, sheet, back, at: () => i };
}

test('a hash names a screen, with a sheet on top when one is open', () => {
  const { r } = rig();
  assert.deepEqual({ ...r.parse('#/tidy') }, { view: 'tidy', sheet: null });
  assert.deepEqual({ ...r.parse('#/tidy/settings') }, { view: 'tidy', sheet: 'settings' });
  assert.deepEqual({ ...r.parse('#/nope/settings') }, { view: null, sheet: 'settings' });
  assert.equal(r.parse('').view, null);
  assert.equal(r.hashOf('inbox', 'settings'), '#/inbox/settings');
});

test('the first load honours the URL, and an unknown one lands on File', () => {
  assert.equal(rig('#/tidy').r.start(), 'tidy');
  assert.equal(rig('#/bogus').r.start(), 'inbox');
  assert.equal(rig('').r.start(), 'inbox');
  const t = rig('#/lists/settings'); t.r.start();
  assert.equal(t.stack[0].hash, '#/lists', 'a sheet is never reopened from a link');
});

test('each screen change is one history entry; back returns to the last screen', async () => {
  const t = rig(); t.r.start();
  t.go('discover'); t.go('tidy');
  assert.equal(t.at(), 2);
  assert.equal(t.stack[2].hash, '#/tidy');
  await t.back(); assert.equal(t.app.view, 'discover');
  await t.back(); assert.equal(t.app.view, 'inbox');
});

test('back closes an open sheet first, then the screen', async () => {
  const t = rig(); t.r.start();
  t.go('tidy'); t.sheet('settings');
  assert.equal(t.stack[t.at()].hash, '#/tidy/settings');
  await t.back();
  assert.equal(t.app.sheet, null); assert.equal(t.app.view, 'tidy');
  await t.back();
  assert.equal(t.app.view, 'inbox');
});

test('closing a sheet with its own button leaves no stale entry', async () => {
  const t = rig(); t.r.start();
  t.go('tidy'); t.sheet('settings'); t.sheet(null);
  await settle();
  assert.equal(t.at(), 1); assert.equal(t.app.view, 'tidy');
  await t.back(); assert.equal(t.app.view, 'inbox');
});

test('a sheet that closes and a screen that opens in one click both land', async () => {
  const t = rig(); t.r.start();
  t.sheet('settings');
  t.sheet(null); t.go('lists');          // the More sheet's list: close, then go
  await settle();
  assert.equal(t.app.view, 'lists'); assert.equal(t.stack[t.at()].hash, '#/lists');
  await t.back(); assert.equal(t.app.view, 'inbox'); assert.equal(t.app.sheet, null);
});

test('closing the sheet and reopening it in one click leaves Settings on one entry', async () => {
  const t = rig(); t.r.start();
  t.sheet('settings');
  t.sheet(null); t.sheet('settings');
  await settle();
  assert.equal(t.stack[t.at()].hash, '#/inbox/settings'); assert.equal(t.at(), 1);
  await t.back(); assert.equal(t.app.sheet, null);
});

test('old links to screens that moved land somewhere sensible (UI-D)', () => {
  const { r } = rig();
  assert.deepEqual({ ...r.parse('#/home') }, { view: 'inbox', sheet: null });
  assert.deepEqual({ ...r.parse('#/sources') }, { view: null, sheet: 'settings', section: 'sources' });
  assert.equal(r.parse('#/engine').section, 'engine', 'Engine is a section of Settings again (2026-11-18)');
  assert.equal(r.parse('#/history').section, 'history');
  assert.equal(r.parse('#/constructor').view, null, 'inherited names are not screens');
  const t = rig('#/sources');
  assert.equal(t.r.start(), 'inbox', 'the page behind the sheet is File');
  assert.equal(t.r.section, 'sources', 'and the page is told which section to open, once');
  assert.equal(t.r.section, null);
  assert.equal(t.stack[0].hash, '#/inbox');
  assert.equal(rig('#/home').r.start(), 'inbox');
});

test('the router does nothing before the app is showing', () => {
  const t = rig(); t.go('tidy');
  assert.equal(t.stack.length, 1);
});

test('the router is wired into the page in order, and its hooks are in place', () => {
  const read = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
  assert.match(read('web/manifest.mjs'), /'app\/sheet\.js',\s*'app\/router\.js'/);
  assert.match(read('web/app/render.js'), /routeNote\(\);\n\}/);
  assert.match(read('web/app/theme.js'), /function openSettings[\s\S]*routeNote\(\)/);
  assert.match(read('web/app/boot.js'), /view = ROUTER\.start\(\)/);
});

test('a playlist sheet gets its own entry (#/lists/pl:<id>) and back closes it before leaving Library', async () => {
  const t = rig(); t.r.start();
  t.go('lists');
  t.sheet('pl:37i9dQZF1');
  assert.equal(t.stack[t.at()].hash, '#/lists/pl:37i9dQZF1');
  assert.deepEqual({ ...t.r.parse('#/lists/pl:abc') }, { view: 'lists', sheet: 'pl:abc' });
  assert.equal(t.r.parse('#/lists/pl:').sheet, null);
  await t.back();
  assert.equal(t.app.sheet, null);
  assert.equal(t.app.view, 'lists');
  t.sheet('pl:x'); t.sheet(null); await settle();
  assert.equal(t.stack[t.at()].hash, '#/lists', 'closing from its own button takes the entry off');
});
