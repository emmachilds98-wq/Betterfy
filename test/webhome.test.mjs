import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as HOME from '../web/screens/home.mjs';
import { ctxOf } from './screenctx.mjs';

// File, the home tab (UI-D): the status line, the "Analyse my library" strip,
// the deck and Up next, and the done state. The sound layer must be invisible
// to anyone who never turns listening on: with no ListenVM, File renders byte
// for byte what it renders when nothing ever called setListen(), and the
// chrome's slot stays empty. These run the real code out of the built page.

const PAGE = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
function slice(from, to, what) {
  const i = PAGE.indexOf(from), j = PAGE.indexOf(to, i);
  assert.ok(i > 0 && j > i, `${what} not found — rebuild with node build-web.mjs`);
  return PAGE.slice(i, j);
}

const track = (i, extra = {}) => ({ id: 't' + i, title: 'Title number ' + i, artist: 'Artist ' + i, ...extra });

function file({ backlog } = {}) {
  const slot = { innerHTML: '', attrs: {}, tabIndex: -1, childElementCount: 0, textContent: '',
    setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; if (k === 'tabindex') this.tabIndex = -1; },
    addEventListener() {} };
  const statN = { textContent: '' };
  const calls = { render: 0 };
  const sandbox = {
    slot, statN, calls,
    esc: s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    isMirrorPlaylist: () => false, analyseHTML: () => '',
    view: 'inbox', go() {}, openUnderHood() {},
    render() { calls.render++; },
    deck: () => '<div class="deck-stub"></div>',
    store: { get() {}, on() {}, set() { calls.render++; }, touch() { calls.render++; } },
    listenPill: vm => vm ? `<span class="pill">${vm.state}</span>` : '',
    listenTidyText: () => '',
    document: { getElementById: id => id === 'listenSlot' ? slot : null },
    $: sel => sel === '#listenSlot' ? slot : sel === '#main' ? {} : sel === '#main [data-listenstat]' ? statN : null,
    S: { inboxAt: 0 },
    LIB: { user: { name: 'Sam' }, captured_at: '2026-11-14T10:00:00Z',
      liked: [track(1), track(2), track(3)],
      playlists: [{ id: 'p', name: 'P', tracks: [track(1), track(9)] }] },
    R: { within: [{ verdict: 'same-recording' }], misfiled: [], across: [],
      backlog: backlog ?? [track(2, { suggest: [{ name: 'Deep house', score: 0.82 }] }), track(3), track(4)] },
  };
  vm.createContext(sandbox);
  vm.runInContext(slice('/* ---------- the listening indicator', '/** A row-sized cover.', 'the listening slot'), sandbox);
  vm.runInContext(slice('/** One line of status for the File tab', '/** The strip at the top of Library', 'listenStatus'), sandbox);
  return sandbox;
}
const html = s => HOME.view(ctxOf(s));

test('File opens with one status line: what to file, what to tidy', () => {
  const h = html(file());
  assert.match(h, /<div class="status" id="fileStatus"[^>]*><span class="st-file"><b>3<\/b> to file<\/span>/);
  assert.match(h, /<button class="st-tidy" data-go="tidy"><b>1<\/b> to tidy<\/button>/);
  assert.ok(h.indexOf('class="status"') < h.indexOf('deck-stub'), 'the line is above the deck');
  assert.ok(h.indexOf('deck-stub') < h.indexOf('class="upnext strip"'), 'and Up next is below it');
});

test('with no ListenVM, File is byte-identical whatever "nothing" the audio side hands over', () => {
  const base = html(file());
  assert.ok(!/listening|heard|data-listenstat/.test(base), 'nothing is said about listening');
  for (const none of ['null', 'undefined', "({ state: 'off', done: 0, total: 0, missed: {}, heard: 0 })",
    "({ state: 'paused', done: 0, total: 40, reason: 'waiting for Wi-Fi', missed: {}, heard: 0 })"]) {
    const s = file();
    vm.runInContext(`setListen(${none})`, s);
    assert.equal(html(s), base, `setListen(${none}) changed File`);
  }
});

test('with no ListenVM the chrome slot stays empty and carries no button semantics', () => {
  const s = file();
  vm.runInContext('setListen(null)', s);
  assert.equal(s.slot.innerHTML, '');
  assert.deepEqual(s.slot.attrs, {});
  assert.match(PAGE, /<div class="listenslot" id="listenSlot"><\/div>/, 'built page ships the slot empty');
  assert.match(PAGE, /\.listenslot:empty\{display:none\}/, 'and an empty slot takes no room');
});

test('once listening has run, the line says so: progress while it runs, the heard count after', () => {
  const s = file();
  vm.runInContext("setListen({ state: 'running', done: 37, total: 412, missed: {}, heard: 120 })", s);
  assert.match(html(s), /<button class="st-listen" data-act="openlisten" data-listenstat>listening 37\/412<\/button>/);
  vm.runInContext("setListen({ state: 'done', done: 412, total: 412, missed: {}, heard: 120 })", s);
  assert.match(html(s), /data-listenstat>120 heard<\/button>/, 'heard (all runs), not done (this run)');
  assert.equal(s.slot.innerHTML, '<span class="pill">done</span>');
  assert.equal(s.slot.attrs.role, 'button');
});

test('the status line and the pill open Listening, in the Settings sheet', async () => {
  const opened = [];
  await HOME.actions.openlisten({ openUnderHood: s => opened.push(s) });
  assert.deepEqual(opened, ['sources']);
  assert.match(slice('/* ---------- the listening indicator', '/** A row-sized cover.', 'slot'), /openUnderHood\('sources'\)/);
});

test('a ticking count updates in place; only the status part appearing or going re-draws File', () => {
  const s = file();
  vm.runInContext("setListen({ state: 'running', done: 1, total: 40, missed: {}, heard: 1 })", s);
  assert.equal(s.calls.render, 1, 'the part appeared');
  vm.runInContext("setListen({ state: 'running', done: 2, total: 40, missed: {}, heard: 2 })", s);
  assert.equal(s.calls.render, 1, 'no re-draw for a tick');
  assert.equal(s.statN.textContent, 'listening 2/40');
  vm.runInContext('setListen(null)', s);
  assert.equal(s.calls.render, 2, 'the part went');
});

test('Up next is a strip of the tracks after the one on the deck, each with its full title for when the line is clipped', () => {
  const s = file(); s.S.inboxAt = 0;
  const h = html(s);
  assert.match(h, /data-goinbox="1" title="Title number 3 — Artist 3"/);
  assert.match(h, /data-goinbox="2" title="Title number 4 — Artist 4"/);
  assert.ok(!/data-goinbox="0"/.test(h), 'the one on the deck is not in the strip');
  s.S.inboxAt = 2;
  assert.ok(!/class="upnext/.test(html(s)), 'nothing after the last track, so no strip');
});

test('nothing to file: the done state and the library bar, with no Up next', () => {
  const h = html(file({ backlog: [] }));
  assert.match(h, /<b>0<\/b> to file/);
  assert.match(h, /deck-stub/);
  assert.match(h, /Where your library sits/);
  assert.ok(!/upnext/.test(h));
});

test('the "Analyse my library" strip stays on File', () => {
  const s = file(); s.analyseHTML = () => '<div class="analyse"><button id="analyseGo" data-act="analyseGo">Analyse my library</button></div>';
  assert.match(html(s), /id="analyseGo"/);
  const done = []; HOME.actions.analyseGo({ analyseGo: () => done.push(1) });
  assert.equal(done.length, 1);
});

test('the audio side feeds the indicator: every redraw and switching off hand the ListenVM over', () => {
  assert.match(slice('function audioRedraw()', '/** What the queue', 'audioRedraw'), /^function audioRedraw\(\) \{\s*setListen\(AUDIO\.vm\);/);
  assert.match(PAGE, /AUDIO\.vm = null; setListen\(null\); render\(\);/);
});

test('the landing listening line is live now listening has shipped, and credits point at Settings', () => {
  assert.match(PAGE, /<div class="wide" data-flag="listening">/);
  assert.ok(!/data-flag="listening" hidden/.test(PAGE));
  assert.ok(!/top yours up from the Playlists screen/.test(PAGE));
});

test('the shell: four tabs, no pager dots, no More, no download icon in the corner', () => {
  const tabs = [...PAGE.matchAll(/<button class="nav" data-v="(\w+)"/g)].map(m => m[1]);
  assert.deepEqual(tabs, ['inbox', 'tidy', 'discover', 'lists']);
  assert.ok(!/id="dots"|id="tabMore"|id="moreSheet"/.test(PAGE));
  assert.match(PAGE, /<div class="fabBar">\s*<button class="fab" id="btnSettings"/, 'only the gear is left in the corner');
  assert.match(PAGE, /<section id="underHood">/);
  assert.match(PAGE, /<button class="b" id="btnUpdate"/, 'the update check lives in Settings now');
  assert.match(PAGE, /id="disconnect"/);
});
