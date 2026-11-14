import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

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
  vm.runInContext(slice('const S = {', '// Bar order', 'Tidy state')
    + slice('const TIDY_SECTIONS', '/* ======================= gaps', 'Tidy sections'), sandbox);
  if (audio) {
    sandbox.__rows = rows;
    vm.runInContext(`Object.assign(TSOUND, { status: 'ready', res: { rows: __rows, accuracy: { scored: 400, caught: 0.82, flagged: 0.9,
      falseAlarm: 0.03, sure: { caught: 0.6, precision: 0.95, falseAlarm: 0.01 } } } }); TSOUND.key = tidySoundKey();`, sandbox);
  }
  return sandbox;
}

test('without heard tracks Tidy has its three sections and nothing about sound', () => {
  const html = vm.runInContext('vTidy()', tidy());
  assert.equal((html.match(/data-tidy="/g) ?? []).length, 3);
  assert.ok(!/By sound|data-tsb|tsrow/.test(html));
});

test('with heard tracks a fourth section counts the moves by sound', () => {
  const s = tidy({ audio: true, rows: [ROW, { ...ROW, id: 't2', band: 'likely' }] });
  const html = vm.runInContext('vTidy()', s);
  assert.match(html, /data-tidy="sound">By sound <span class="n">2<\/span>/);
});

test('a row says what it sounds like, where it sits, and moves with the usual Move button', () => {
  const s = tidy({ audio: true, rows: [ROW] });
  vm.runInContext("S.tidySec = 'sound'", s);
  const html = vm.runInContext('vTidy()', s);
  assert.match(html, /Sounds like <b>Jungle<\/b> <span class="mono">172 BPM<\/span>, sits in <b>House<\/b>/);
  assert.match(html, /data-mvtr="t1" data-mvfrom="pl-house" data-mvto="pl-jungle">Move</);
  assert.match(html, /data-tskeep="t1" data-tsto="pl-jungle">Keep here/);
  assert.match(html, /Stray/);
  assert.match(html, /Checked on 400 tracks you filed yourself: .*82% were caught and sent home \(95% of the sure ones right\); 3% /);
});

test('"Keep here" (a rejection of that playlist) hides the row', () => {
  const s = tidy({ audio: true, rows: [ROW], fb: { t1: { rejected: ['pl-jungle'] } } });
  vm.runInContext("S.tidySec = 'sound'", s);
  const html = vm.runInContext('vTidy()', s);
  assert.ok(!/data-mvtr="t1"/.test(html));
  assert.match(html, /Everything sounds where it is/);
});

test('a remembered By sound section falls back to Wrong place once there is no sound', () => {
  const s = tidy();
  vm.runInContext("S.tidySec = 'sound'", s);
  vm.runInContext('vTidy()', s);
  assert.equal(vm.runInContext('S.tidySec', s), 'misfile');
});
