import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { installTidy } from './tidyctx.mjs';

// Tidy › By sound, run out of the built page. Without heard tracks Tidy must
// draw exactly the three sections it always had; with them, a fourth lists
// the moves core/audio/misfit.mjs found, through the same Move/undo buttons.

const PAGE = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
function slice(from, to, what) {
  const i = PAGE.indexOf(from), j = PAGE.indexOf(to, i);
  assert.ok(i > 0 && j > i, `${what} not found — rebuild with npm run build:web`);
  return PAGE.slice(i, j);
}

const ROW = { id: 't1', from: 'pl-house', to: 'pl-jungle', fromName: 'House', toName: 'Jungle', curShare: 0, toShare: 0.9,
  band: 'sure', idBacks: true, sound: 'Jungle', bpm: 172, near: { to: 11, from: 0, k: 12 },
  why: ['11 of the 12 tracks it sounds most like are in Jungle, 0 in House', 'it sounds like Jungle, which fits Jungle'] };

function tidy({ audio = false, rows = [], fb = {} } = {}) {
  const sandbox = {
    esc: s => String(s ?? ''), thumbHTML: () => '<i class="th"></i>', cmpTable: () => '', tagChips: () => '',
    R: { within: [], across: [], misfiled: [] }, LISTENING_CACHE: null, LISTENING_PENDING: true, getListening: () => Promise.resolve(),
    render: () => {}, FB: fb, view: 'tidy',
    LIB: { playlists: [{ id: 'pl-house', name: 'House', tracks: [{ id: 't1', name: 'Stray', artists: [{ name: 'Someone' }], duration_ms: 1000 }] }] },
  };
  if (audio) Object.assign(sandbox, {
    AUDIO: { records: new Map([['t1', {}]]) }, soundHeard: () => 1, engineTargets: () => ['pl-house', 'pl-jungle'],
    audioSettings: () => ({ on: true }), fire: () => {},
  });
  vm.createContext(sandbox);
  installTidy(sandbox, slice);
  if (audio) {
    sandbox.__rows = rows;
    vm.runInContext(`Object.assign(TSOUND, { status: 'ready', res: { rows: __rows, accuracy: { scored: 400, caught: 0.82, flagged: 0.9,
      falseAlarm: 0.03, sure: { caught: 0.6, precision: 0.95, falseAlarm: 0.01 } } } }); TSOUND.key = tidySoundKey();`, sandbox);
  }
  return sandbox;
}

test('without heard tracks Tidy has its three sections, Hard to find, and nothing about sound', () => {
  const html = vm.runInContext('vTidy()', tidy());
  assert.equal((html.match(/data-tidy="/g) ?? []).length, 4);
  assert.match(html, /data-tidy="hidden"><span class="lg">Hard to find<\/span><span class="sh">Hidden<\/span>/);
  assert.ok(!/By sound|by sound|data-tsb|tsrow/.test(html));
});

// DESIGN-PLAN §7.7 M3 (provisional): By sound is not a section any more. Its rows are
// Wrong place rows with a "by sound" badge, Sure with Sure and Likely with Likely.
test('with heard tracks there is no fifth section: Wrong place counts the moves by sound', () => {
  const s = tidy({ audio: true, rows: [ROW, { ...ROW, id: 't2', band: 'likely' }] });
  const html = vm.runInContext('vTidy()', s);
  assert.ok(!/data-tidy="sound"/.test(html));
  assert.match(html, /data-tidy="misfile"><span class="lg">Wrong place<\/span><span class="sh">Misfiled<\/span> <span class="n">2<\/span>/);
  assert.match(html, /data-mfb="high">[^]*?<span class="n">1<\/span>/);
  assert.match(html, /data-mfb="medium">[^]*?<span class="n">1<\/span>/);
});

test('a by-sound row says what it sounds like, where it sits, and moves with the usual Move button', () => {
  const s = tidy({ audio: true, rows: [ROW] });
  const html = vm.runInContext('vTidy()', s);
  assert.match(html, /<span class="bysound">by sound<\/span> Sounds like <b>Jungle<\/b> <span class="mono">172 BPM<\/span>, sits in <b>House<\/b>/);
  assert.match(html, /data-mvtr="t1" data-mvfrom="pl-house" data-mvto="pl-jungle">Move</);
  assert.match(html, /data-tskeep="t1" data-tsto="pl-jungle">Keep here/);
  assert.match(html, /Stray/);
  assert.match(html, /By sound, checked on 400 tracks you filed yourself: .*82% were caught and sent home \(95% of the sure ones right\); 3% /);
});

test('a Likely by-sound row shows under Likely, not Sure', () => {
  const s = tidy({ audio: true, rows: [{ ...ROW, band: 'likely' }] });
  assert.ok(!/data-mvtr="t1"/.test(vm.runInContext('vTidy()', s)));
  vm.runInContext("S.mfBand = 'medium'", s);
  assert.match(vm.runInContext('vTidy()', s), /data-mvtier="likely" data-act="move" data-mvtr="t1"/);
});

test('where both tiers flag the same track in the same playlist, one row shows: the sound one', () => {
  const s = tidy({ audio: true, rows: [ROW] });
  s.R.misfiled = [{ id: 't1', currentPlaylistId: 'pl-house', current: 'House', confidence: 'high', currentScore: 0.05,
    suggest: [{ id: 'pl-jungle', name: 'Jungle', score: 0.6 }], title: 'Stray' }];
  const html = vm.runInContext('vTidy()', s);
  assert.equal((html.match(/data-act="move" data-mvtr="t1"|data-mvtr="t1" data-mvfrom/g) ?? []).length, 1);
  assert.match(html, /data-tidy="misfile">[^]*?<span class="n">1<\/span>/);
});

test('"Keep here" (a rejection of that playlist) hides the row', () => {
  const s = tidy({ audio: true, rows: [ROW], fb: { t1: { rejected: ['pl-jungle'] } } });
  const html = vm.runInContext('vTidy()', s);
  assert.ok(!/data-mvtr="t1"/.test(html));
  assert.match(html, /Everything fits where it is/);
});

test('a remembered By sound section opens Wrong place on sound\'s band', () => {
  const s = tidy({ audio: true, rows: [{ ...ROW, band: 'likely' }] });
  vm.runInContext("S.tidySec = 'sound'; S.tsBand = 'likely'", s);
  const html = vm.runInContext('vTidy()', s);
  assert.equal(vm.runInContext('S.tidySec', s), 'misfile');
  assert.equal(vm.runInContext('S.mfBand', s), 'medium');
  assert.match(html, /data-mvtr="t1"/);
});

test('a remembered By sound section falls back to Wrong place once there is no sound', () => {
  const s = tidy();
  vm.runInContext("S.tidySec = 'sound'", s);
  vm.runInContext('vTidy()', s);
  assert.equal(vm.runInContext('S.tidySec', s), 'misfile');
});

// L4: short labels on a phone, and a section with nothing in it is dimmed but tappable.
test('every part has its full and short label, and empty ones are marked zero', () => {
  const s = tidy();
  s.R.within = [REPEAT];
  const html = vm.runInContext('vTidy()', s);
  assert.match(html, /<button class="zero" type="button" aria-pressed="false" data-act="section" data-tidy="misfile">/);
  assert.match(html, /<button type="button" aria-pressed="true" data-act="section" data-tidy="dupes">Repeats <span class="n">1<\/span>/);
  assert.match(html, /data-tidy="cross"><span class="lg">Cross-filed<\/span><span class="sh">In two<\/span>/);
});

// BUILD-5-PLAN §4.1 / UI-A: Tidy opens on the first section with work in it,
// not on "Wrong place 0" while another section has rows.
const pressed = html => html.match(/aria-pressed="true" data-act="section" data-tidy="(\w+)"/)?.[1];
const REPEAT = { verdict: 'same-recording', title: 'Twice', artist: 'Someone', playlist: 'House', playlistId: 'pl-house', why: 'same ISRC',
  options: [{ id: 'a', dur: '3:00' }, { id: 'b', dur: '3:00' }] };

test('with nothing in Wrong place, Tidy opens on the first section that has work', () => {
  const s = tidy();
  s.R.within = [REPEAT];
  const html = vm.runInContext('vTidy()', s);
  assert.equal(pressed(html), 'dupes');
  assert.match(html, /The same recording, twice/);
  assert.equal(vm.runInContext('S.tidySec', s), undefined, 'the automatic pick is not stored as a choice');
});

test('the first non-empty section can be Cross-filed, and sound rows open Wrong place', () => {
  const s = tidy();
  s.R.across = [{ title: 'x', placements: [] }];
  assert.equal(pressed(vm.runInContext('vTidy()', s)), 'cross');
  const t = tidy({ audio: true, rows: [ROW] });
  t.R.within = [REPEAT];
  assert.equal(pressed(vm.runInContext('vTidy()', t)), 'misfile');
});

test('Wrong place still comes first when it has rows', () => {
  const s = tidy();
  s.R.within = [REPEAT];
  s.R.misfiled = [{ id: 't9', confidence: 'medium', suggest: [], current: 'House', currentScore: 0.1, title: 'Stray' }];
  assert.equal(pressed(vm.runInContext('vTidy()', s)), 'misfile');
});

test('with every section empty Tidy opens on Wrong place', () => {
  assert.equal(pressed(vm.runInContext('vTidy()', tidy())), 'misfile');
});

test('a section the listener picked is kept, even when it is empty', () => {
  const s = tidy();
  s.R.within = [REPEAT];
  vm.runInContext("S.tidySec = 'misfile'", s);
  assert.equal(pressed(vm.runInContext('vTidy()', s)), 'misfile');
  vm.runInContext("S.tidySec = 'cross'", s);
  assert.equal(pressed(vm.runInContext('vTidy()', s)), 'cross');
});

test('a remembered section that has gone away falls back to the first one with work', () => {
  const s = tidy();
  s.R.within = [REPEAT];
  vm.runInContext("S.tidySec = 'sound'", s);
  assert.equal(pressed(vm.runInContext('vTidy()', s)), 'dupes');
  assert.equal(vm.runInContext('S.tidySec', s), 'dupes');
});
