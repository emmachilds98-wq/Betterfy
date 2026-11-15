// WP-C1 in the real built page: which ear the engine is handed, what the
// Score run is handed, and the Deep listen block's second-ear line. The
// helpers run in a vm sandbox with the real audio bundle (docs/audio.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { makeRecord, makeEar, withEar, N_STYLES, EMB_DIM, MAEST_DIM, MAEST_N_STYLES } from '../core/audio/record.mjs';

const PAGE = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
const AUDIO_JS = readFileSync(new URL('../docs/audio.js', import.meta.url), 'utf8');
function slice(from, to, what) {
  const i = PAGE.indexOf(from), j = PAGE.indexOf(to, i);
  assert.ok(i > 0 && j > i, `${what} was not found — rebuild with npm run build:web`);
  return PAGE.slice(i, j);
}
const ENGINE_IN = slice('const engineAudioBase = audio =>', '/* ====', 'engineAudioIn');
const DEEP = slice('function deepPanelHTML()', 'function bridgeProgressText()', 'the Deep listen block');

const rec = (id, maest) => {
  const r = makeRecord({ id, isrc: 'X', activations: new Float32Array(N_STYLES).fill(0.1), embeddings: new Float32Array(EMB_DIM).fill(0.2), patches: 1,
                         source: { kind: 'deezer-isrc', deezerId: 1, windows: [[0, 1]], seconds: 10 }, mel: '1.0.0', at: 1 });
  return maest ? withEar(r, 'maest', makeEar('maest', { embedding: new Float32Array(MAEST_DIM).fill(0.3), activations: new Float32Array(MAEST_N_STYLES).fill(0.2) })) : r;
};

function sandbox({ choice = null, fb = {}, deep = { maest: true, clap: false, memoryOverride: false }, vm: maestVm = null, mem = 8 } = {}) {
  const ls = new Map([['bf_audio_deep', JSON.stringify(deep)], ['bf_audio', JSON.stringify({ on: true })]]);
  const ctx = vm.createContext({ atob, btoa, console, Float32Array, Uint8Array, Map, Set, JSON, Math, Object, Array, Number, String,
    LS: { getItem: k => ls.get(k) ?? null, setItem: (k, v) => ls.set(k, v) },
    navigator: { connection: { type: 'wifi' }, deviceMemory: mem },
    esc: s => String(s), FB: fb, ENGINE_LEARN_MODEL: 'prototype', ENG: { calib: choice ? { soundChoice: choice } : null },
    AUDIO: { wifiOk: false, maestVm },
    audioSettings: () => ({ on: true, wifiOnly: true, scope: 'playing+unfiled' }) });
  ctx.globalThis = ctx;
  vm.runInContext(AUDIO_JS, ctx);
  const deepSettingsFn = slice('function deepSettings()', '/** Load the bundle, open the store', 'deepSettings');
  vm.runInContext(deepSettingsFn + DEEP + ENGINE_IN.replace(/const ENGINE_LEARN_MODEL = [^;]+;/, '') + ';globalThis.T = { engineAudioIn, engineAudioScore, engineEar, deepPanelHTML };', ctx);
  return ctx.T;
}

test('page: no Score verdict, the engine hears with the first ear exactly as before', () => {
  const recs = [rec('a', true), rec('b', false)];
  const T = sandbox();
  const a = T.engineAudioIn(recs);
  assert.deepEqual(Object.keys(a), ['records', 'model'], 'no ear key: exactly what main passed');
  assert.equal(a.records, recs);
  assert.equal(T.engineEar(recs), 'effnet');
  const withFb = sandbox({ fb: { a: { rejected: ['p'] } } }).engineAudioIn(recs);
  assert.deepEqual(Object.keys(withFb), ['records', 'model', 'feedback']);
  assert.equal(T.engineAudioIn(null), null);
});

test('page: a passed Score choice for the second ear hands the engine that ear', () => {
  const recs = [rec('a', true)];
  const T = sandbox({ choice: { ear: 'maest', reason: 'SECOND_EAR', gate: { pass: true } } });
  const a = T.engineAudioIn(recs);
  assert.equal(a.ear, 'maest');
  assert.equal(a.records, recs);
  assert.equal(sandbox({ choice: { ear: 'maest', gate: { pass: false } } }).engineAudioIn(recs).ear, undefined);
  assert.equal(T.engineAudioIn([rec('b', false)]).ear, undefined, 'no second-ear records: the first ear');
});

test('page: the Score run gets the arms only when some records have a second ear, and never an ear', () => {
  const T = sandbox({ choice: { ear: 'maest', gate: { pass: true } } });
  const plain = [rec('b', false)];
  assert.equal(T.engineAudioScore(plain).arms, undefined);
  assert.deepEqual(T.engineAudioScore(plain), T.engineAudioIn(plain));
  const s = T.engineAudioScore([rec('a', true), rec('b', false)]);
  assert.deepEqual([...s.arms], ['maest', 'both']);
  assert.equal(s.ear, undefined, 'the Score run always scores the first ear as its first arm');
});

test('page: the Deep listen block says the second ear changes nothing until a Score run', () => {
  const html = sandbox({ vm: { state: 'done', heard: 3, waiting: 2 } }).deepPanelHTML();
  assert.match(html, /3 tracks heard by the second ear, 2 still to go/);
  assert.match(html, /changes no suggestion until a Score run/);
  assert.match(html, /id="maestGo"/);
  const low = sandbox({ mem: 4 }).deepPanelHTML();
  assert.match(low, /less than 8 GB/);
  assert.doesNotMatch(low, /id="maestGo"/);
  const off = sandbox({ deep: { maest: false, clap: false, memoryOverride: false } }).deepPanelHTML();
  assert.doesNotMatch(off, /maestStatus/);
});
