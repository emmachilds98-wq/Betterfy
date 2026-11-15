import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// UI-5: Home, the chrome's listening slot and the landing line. The sound layer
// must be invisible to anyone who never turns listening on: with no ListenVM,
// Home renders byte for byte what it renders when nothing ever called
// setListen(), and the slot in the chrome stays empty. These run the real
// Home and slot code out of the built page.

const PAGE = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
function slice(from, to, what) {
  const i = PAGE.indexOf(from), j = PAGE.indexOf(to, i);
  assert.ok(i > 0 && j > i, `${what} not found — rebuild with node build-web.mjs`);
  return PAGE.slice(i, j);
}

const track = (i, extra = {}) => ({ id: 't' + i, title: 'Title number ' + i, artist: 'Artist ' + i, ...extra });

function home({ views = {} } = {}) {
  const slot = { innerHTML: '', attrs: {}, tabIndex: -1, childElementCount: 0, textContent: '',
    setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; if (k === 'tabindex') this.tabIndex = -1; },
    addEventListener() {} };
  const heardN = { textContent: '' };
  const calls = { render: 0 };
  const sandbox = {
    slot, heardN, calls,
    esc: s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    partOfDay: () => 'Evening', tagCoverage: () => ({ pct: 62 }), isMirrorPlaylist: () => false, analyseHTML: () => '',
    VHUE: { home: 'accent', inbox: 'm0', tidy: 'm1', discover: 'm3', shuffle: 'm4' },
    VIEWS: views, view: 'home', go() {},
    render() { calls.render++; },
    store: { get() {}, on() {}, set() { calls.render++; }, touch() { calls.render++; } },
    listenPill: vm => vm ? `<span class="pill">${vm.state}</span>` : '',
    document: { getElementById: id => id === 'listenSlot' ? slot : null },
    $: sel => sel === '#listenSlot' ? slot : sel === '#main' ? {} : sel === '#main .act[data-heard] .n' ? heardN : null,
    S: { discover: [] },
    LIB: { user: { name: 'Sam' }, captured_at: '2026-11-14T10:00:00Z',
      liked: [track(1), track(2), track(3)],
      playlists: [{ id: 'p', name: 'P', tracks: [track(1), track(9)] }] },
    R: { within: [], misfiled: [], across: [],
      backlog: [track(2, { suggest: [{ name: 'Deep house', score: 0.82 }] }), track(3)] },
  };
  vm.createContext(sandbox);
  vm.runInContext(slice('const ACT_IC = {', '/** A row-sized cover.', 'Home and the listening slot'), sandbox);
  return sandbox;
}
const html = (s, code = 'vHome()') => vm.runInContext(code, s);

test('with no ListenVM, Home is byte-identical whatever "nothing" the audio side hands over', () => {
  const base = html(home());
  assert.ok(!/data-heard|acts4 five/.test(base), 'four cards, no fifth');
  assert.equal(base.split('class="act"').length - 1, 4);
  for (const none of ['null', 'undefined', "({ state: 'off', done: 0, total: 0, missed: {}, heard: 0 })",
    "({ state: 'paused', done: 0, total: 40, reason: 'waiting for Wi-Fi', missed: {}, heard: 0 })"]) {
    const s = home();
    vm.runInContext(`setListen(${none})`, s);
    assert.equal(html(s), base, `setListen(${none}) changed Home`);
  }
});

test('with no ListenVM the chrome slot stays empty and carries no button semantics', () => {
  const s = home();
  vm.runInContext('setListen(null)', s);
  assert.equal(s.slot.innerHTML, '');
  assert.deepEqual(s.slot.attrs, {});
  assert.match(PAGE, /<div class="listenslot" id="listenSlot"><\/div>/, 'built page ships the slot empty');
  assert.match(PAGE, /\.listenslot:empty\{display:none\}/, 'and an empty slot takes no room');
});

test('once listening has run, Home gets a fifth "Heard" card counting every heard track', () => {
  const s = home();
  vm.runInContext("setListen({ state: 'running', done: 3, total: 40, missed: {}, heard: 120 })", s);
  const h = html(s);
  assert.match(h, /class="acts4 five"/);
  assert.match(h, /data-heard/);
  assert.match(h, /<span class="n">120<\/span>\s*<span class="l">tracks heard<\/span>/, 'heard (all runs), not done (this run)');
  assert.match(h, /data-go="lists" data-heard/, 'Playlists until Sources exists');
  assert.equal(s.slot.innerHTML, '<span class="pill">running</span>');
  assert.equal(s.slot.attrs.role, 'button');
});

test('the Heard card and the pill open Sources once that screen exists', () => {
  const s = home({ views: { sources: () => '' } });
  vm.runInContext("setListen({ state: 'done', done: 1, total: 1, missed: {}, heard: 1 })", s);
  assert.match(html(s), /data-go="sources" data-heard[^>]*>[\s\S]*?<span class="l">track heard<\/span>/);
});

test('a ticking count updates in place; only the card appearing or going re-draws Home', () => {
  const s = home();
  vm.runInContext("setListen({ state: 'running', done: 1, total: 40, missed: {}, heard: 1 })", s);
  assert.equal(s.calls.render, 1, 'card appeared');
  vm.runInContext("setListen({ state: 'running', done: 2, total: 40, missed: {}, heard: 2 })", s);
  assert.equal(s.calls.render, 1, 'no re-draw for a tick');
  assert.equal(s.heardN.textContent, '2');
  vm.runInContext('setListen(null)', s);
  assert.equal(s.calls.render, 2, 'card went');
});

test('up-next cards carry the full title and artist, for when the line is clipped', () => {
  assert.match(html(home()), /data-goinbox="0" title="Title number 2 — Artist 2"/);
});

test('the audio side feeds the indicator: every redraw and switching off hand the ListenVM over', () => {
  assert.match(slice('function audioRedraw()', '/** What the queue', 'audioRedraw'), /^function audioRedraw\(\) \{\s*setListen\(AUDIO\.vm\);/);
  assert.match(PAGE, /AUDIO\.vm = null; setListen\(null\); render\(\);/);
});

test('the landing listening line is live now listening has shipped, and credits point at Sources', () => {
  assert.match(PAGE, /<div class="wide" data-flag="listening">/);
  assert.ok(!/data-flag="listening" hidden/.test(PAGE));
  assert.ok(!/top yours up from the Playlists screen/.test(PAGE));
});
