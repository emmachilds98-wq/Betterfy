// DESIGN-PLAN L0: the second ear looked stuck at "listening 1/1". After its
// songs a run tidies up (DSP, CLAP, Beat This, key v4) and showed no progress
// for it, nothing timed a hung step out, and the second-ear button did nothing
// while listening ran. These pin the fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { withTimeout, TimeoutError, TRACK_TIMEOUT_MS, MODEL_TIMEOUT_MS } from '../core/audio/timeout.mjs';
import { runQueue } from '../core/audio/worker.js';
import { createAudioController } from '../web/audio/controller.mjs';
import { createMaestRunner, maestStatusText } from '../web/audio/maest-run.mjs';
import { listenPill, listenCard, listenTidyText } from '../web/ui/sound.mjs';
import { DSP_VERSION } from '../core/audio/dsp/combine.mjs';
import { KEYNET_VERSION } from '../core/audio/dsp/keynet.mjs';
import { makeRecord, N_STYLES, EMB_DIM } from '../core/audio/record.mjs';

const SR = 16000;
const tone = (hz, s = 10) => Float32Array.from({ length: s * SR }, (_, i) => 0.3 * Math.sin(2 * Math.PI * hz * i / SR));
const never = () => new Promise(() => {});
function memStore(init = []) {
  const m = new Map(init.map(r => [r.id, r]));
  return { m, getAll: async () => new Map(m), get: async id => m.get(id), put: async r => { m.set(r.id, r); return true; }, count: async () => m.size };
}
/** A heard record with no dsp yet: the DSP top-up gives it one, then key v4 gets its turn. */
const bare = id => ({ id, isrc: 'GBXXX000000' + id, source: { deezerId: 7 } });
const deps = () => ({
  lookup: async () => ({ deezerId: 7, previewUrl: 'u' }),
  fetchPreview: async () => ({ buffers: [new ArrayBuffer(8), new ArrayBuffer(8)] }),
  decode: async () => tone(220, 2),
  dsp: () => ({ v: DSP_VERSION, bpm: 124, bpmConf: 0.5, key: 'C major', camelot: '8B', keyConf: 0.2 }),
  loadEar: async () => { throw new Error('no ear needed'); },
  loadKeyNet: async () => ({ logp: async () => Float32Array.from({ length: 24 }, (_, i) => Math.log(i === 21 ? 0.9 : 0.1 / 23)) }),
});

/* ------------------------------------------------------------ withTimeout */

test('withTimeout: passes answers and failures through, and gives up after the limit', async () => {
  assert.equal(await withTimeout(Promise.resolve(3), 50), 3);
  assert.equal(await withTimeout(() => Promise.resolve(4), 50), 4);
  await assert.rejects(withTimeout(Promise.reject(new Error('404')), 50), /404/);
  const e = await withTimeout(never(), 20, 'loading the key model').catch(x => x);
  assert.ok(e instanceof TimeoutError && e.timeout);
  assert.match(e.message, /loading the key model took longer than/);
  assert.equal(await withTimeout(() => 5, 0), 5, '0 means no limit');
  assert.equal(TRACK_TIMEOUT_MS, 60_000);
  assert.equal(MODEL_TIMEOUT_MS, 300_000);
});

test('runQueue: a track that never settles counts as failed and the queue moves on', async () => {
  const got = [];
  const d = { ...deps(), fetchPreview: async url => (url === 'hang' ? never() : deps().fetchPreview()),
              lookup: async isrc => ({ deezerId: 7, previewUrl: isrc === 'H' ? 'hang' : 'u' }) };
  const res = await runQueue(d, [{ id: 'a', isrc: 'H' }, { id: 'b', isrc: null }], { timeoutMs: 20, onResult: r => got.push(r) });
  assert.deepEqual(res, { done: 2, stopped: false });
  assert.equal(got[0].failed.stage, 'unknown');
  assert.match(got[0].failed.detail, /took longer than/);
  assert.ok(got[1].miss, 'the next track was still heard');
});

/* ------------------------------------------------------------ progress while tidying up */

test('controller: each tidy-up step shows its own count, and the run ends done with no tidy left', async () => {
  // Two with no dsp (the DSP step, keyed by v4 as it goes) and two measured before v4 (the keys step).
  const measured = id => ({ ...bare(id), dsp: deps().dsp() });
  const store = memStore([bare('1'), bare('2'), measured('3'), measured('4')]);
  const seen = [];
  const ctrl = createAudioController({ store, ...deps(), onChange: v => seen.push(v) });
  const r = await ctrl.start([]);
  assert.equal(r.stopped, false);
  const tidy = seen.filter(v => v.tidy).map(v => `${v.tidy.step} ${v.tidy.done}/${v.tidy.total}`);
  for (const s of ['dsp 0/2', 'dsp 1/2', 'dsp 2/2', 'keys 0/2', 'keys 1/2', 'keys 2/2']) assert.ok(tidy.includes(s), `${s} in ${tidy}`);
  assert.ok(seen.filter(v => v.tidy).every(v => v.state === 'running'));
  const last = ctrl.vm();
  assert.equal(last.state, 'done');
  assert.equal(last.tidy, undefined);
  assert.ok([...store.m.values()].every(x => x.dsp?.keyNetV === KEYNET_VERSION), 'both steps did their work');
});

test('controller: nothing to tidy shows no tidy step at all', async () => {
  const store = memStore([]);
  const seen = [];
  await createAudioController({ store, ...deps(), onChange: v => seen.push(v) }).start([]);
  assert.ok(seen.every(v => !v.tidy));
});

/* ------------------------------------------------------------ hung steps give up */

test('controller: a tidy-up download that never resolves times out, and the run still ends', async () => {
  const store = memStore(['1', '2'].map(bare));
  const d = deps();
  const ctrl = createAudioController({ store, ...d, fetchPreview: never, trackTimeoutMs: 20 });
  const r = await ctrl.start([]);
  assert.equal(r.stopped, false);
  assert.equal(ctrl.vm().state, 'done');
  assert.ok([...store.m.values()].every(x => !x.dsp), 'nothing stored from a hung step');
  // Not marked as unfillable: a later run (with a working network) tries again.
  const again = createAudioController({ store, ...d });
  await again.start([]);
  assert.ok([...store.m.values()].every(x => x.dsp?.v === DSP_VERSION));
});

test('controller: a queue track that never resolves is counted as failed, and the run ends done', async () => {
  const store = memStore([]);
  const ear = { run: async (data, n) => ({ activations: new Float32Array(n * N_STYLES).fill(0.1), embeddings: new Float32Array(n * EMB_DIM).fill(0.5) }) };
  const ctrl = createAudioController({ store, ...deps(), dsp: null, loadKeyNet: undefined, loadEar: async () => ({ ear }),
    decode: async () => new Float32Array(SR * 3), fetchPreview: never, trackTimeoutMs: 20 });
  const r = await ctrl.start([{ id: 'x', isrc: 'Ix', durationMs: 1000 }]);
  assert.deepEqual(r, { done: 1, stopped: false });
  assert.equal(ctrl.vm().state, 'done');
  assert.deepEqual(ctrl.vm().missed, { FAILED: 1 });
});

test('controller: a model load that never settles gives up; listening pauses with a reason, a top-up model is skipped', async () => {
  const s1 = memStore([]);
  const c1 = createAudioController({ store: s1, ...deps(), loadEar: never, modelTimeoutMs: 20 });
  assert.deepEqual(await c1.start([{ id: 'x', isrc: 'Ix' }]), { done: 0, stopped: true });
  assert.equal(c1.vm().state, 'paused');
  assert.match(c1.vm().reason, /couldn’t load the model: loading the listening model took longer than/);

  const s2 = memStore(['1'].map(bare));
  const c2 = createAudioController({ store: s2, ...deps(), loadKeyNet: never, modelTimeoutMs: 20 });
  const r = await c2.start([]);
  assert.equal(r.stopped, false);
  assert.equal(c2.vm().state, 'done');
  assert.equal(s2.m.get('1').dsp.v, DSP_VERSION, 'the DSP step still ran');
  assert.equal(s2.m.get('1').dsp.keyNetV, undefined);
});

test('controller: whenIdle resolves when the run in flight ends, and at once when none is', async () => {
  let release;
  const store = memStore(['1'].map(bare));
  const ctrl = createAudioController({ store, ...deps(), loadKeyNet: undefined,
    fetchPreview: () => new Promise(ok => { release = () => ok(deps().fetchPreview()); }) });
  await ctrl.whenIdle();
  const run = ctrl.start([]);
  let idle = false;
  const w = ctrl.whenIdle().then(() => { idle = true; });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(idle, false);
  assert.equal(ctrl.running, true);
  release();
  await run; await w;
  assert.equal(idle, true);
});

/* ------------------------------------------------------------ the second ear */

const maestRec = id => makeRecord({ id, isrc: 'X' + id, activations: new Float32Array(N_STYLES).fill(0.1), embeddings: new Float32Array(EMB_DIM).fill(0.2),
  patches: 1, source: { kind: 'deezer-isrc', deezerId: 1, windows: [[0, 1]], seconds: 10 }, mel: '1.0.0', at: 1 });

test('second ear: a track that never resolves times out, and the run still ends', async () => {
  const store = memStore([maestRec('a'), maestRec('b')]);
  let released = 0;
  const runner = createMaestRunner({ store, lookup: async () => ({ deezerId: 1, previewUrl: 'u' }), fetchPreview: never,
    decode: async () => tone(220, 2), loadMaest: async () => ({ run: async () => ({}), release: () => { released++; } }), trackTimeoutMs: 20 });
  const r = await runner.start();
  assert.deepEqual(r, { done: 2, stopped: false });
  assert.equal(runner.vm().state, 'done');
  assert.equal(runner.vm().failed, 2);
  assert.equal(released, 1, 'the model is still freed');
});

test('second ear: a model load that never settles pauses with a reason', async () => {
  const runner = createMaestRunner({ store: memStore([maestRec('a')]), lookup: async () => ({}), fetchPreview: async () => ({}),
    decode: async () => null, loadMaest: never, modelTimeoutMs: 20 });
  assert.deepEqual(await runner.start(), { done: 0, stopped: true });
  assert.equal(runner.vm().state, 'paused');
  assert.match(maestStatusText(runner.vm()), /Second ear stopped: couldn’t load the second ear: loading the second ear took longer than/);
});

test('second ear: waiting has its own line', () => {
  assert.equal(maestStatusText({ state: 'waiting' }), 'Second ear: waits for listening to finish, then starts by itself.');
});

/* ------------------------------------------------------------ the words on screen */

test('pill, card and status line say "tidying up", not "1/1"', () => {
  const v = { state: 'running', done: 1, total: 1, heard: 40, missed: {}, tidy: { step: 'keys', done: 5, total: 40 } };
  assert.equal(listenTidyText(v), 'keys 5 of 40');
  assert.equal(listenTidyText(v, '/'), 'keys 5 / 40');
  assert.match(listenPill(v), /Tidying up · keys 5 \/ 40/);
  assert.doesNotMatch(listenPill(v), /1 \/ 1/);
  assert.match(listenCard(v), /Tidying up: keys 5 of 40/);
  assert.match(listenCard(v), /aria-valuenow="5"/);
  for (const [step, word] of [['dsp', 'tempo and key'], ['clap', 'describing'], ['beats', 'tempo']])
    assert.equal(listenTidyText({ ...v, tidy: { step, done: 2, total: 20 } }), `${word} 2 of 20`);
  assert.equal(listenTidyText({ ...v, state: 'done' }), '', 'only while running');
  assert.equal(listenTidyText({ ...v, tidy: undefined }), '');
  assert.match(listenPill({ ...v, tidy: undefined }), /Listening · 1 \/ 1/, 'unchanged without tidy');
});

/* ------------------------------------------------------------ the page: the second ear queues behind listening */

const PAGE = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
function slice(from, to, what) {
  const i = PAGE.indexOf(from), j = PAGE.indexOf(to, i);
  assert.ok(i > 0 && j > i, `${what} was not found — rebuild with npm run build:web`);
  return PAGE.slice(i, j);
}

test('page: listenStatus says tidying up while the run tidies up', () => {
  const ctx = vm.createContext({ listenTidyText, LISTEN: null });
  ctx.globalThis = ctx;
  vm.runInContext(slice('const listenHeard = ', 'function setListen', 'listenHeard') + slice('function listenStatus()', '/** The strip at the top', 'listenStatus')
    + ';globalThis.T = { listenStatus, set: v => { LISTEN = v; } };', ctx);
  ctx.T.set({ state: 'running', done: 1, total: 1, heard: 3, tidy: { step: 'dsp', done: 3, total: 12 } });
  assert.equal(ctx.T.listenStatus(), 'tidying up: tempo and key 3 / 12');
  ctx.T.set({ state: 'running', done: 1, total: 4, heard: 3 });
  assert.equal(ctx.T.listenStatus(), 'listening 1/4');
});

test('page: "Listen with the second ear now" during a run is queued, says so, and then runs', async () => {
  let finish;
  const idle = new Promise(ok => { finish = ok; });
  const toasts = [], starts = [];
  const ctx = vm.createContext({ console,
    LIB: {}, toast: m => toasts.push(m), audioRedraw: () => {}, audioRefresh: async () => {}, audioInit: async () => {},
    deepSettings: () => ({ maest: true }), deepAllowed: () => 'ok', audioModelUrl: f => f, ORT_BASE: '', deezerJsonp: null,
    AUDIO: { ctrl: { running: true, whenIdle: () => idle }, maest: null, maestVm: null },
    BetterfyAudio: { createMaestRunner: () => { const r = { running: false, vm: () => ({ state: 'done' }), start: async () => { starts.push(1); } }; return r; } } });
  ctx.globalThis = ctx;
  vm.runInContext(slice('async function maestStart(', '// A phone that leaves Wi-Fi', 'maestStart') + ';globalThis.maestStart = maestStart;', ctx);
  const tap = ctx.maestStart();
  await new Promise(r => setTimeout(r, 5));
  assert.equal(ctx.AUDIO.maestWaiting, true);
  assert.equal(ctx.AUDIO.maestVm.state, 'waiting');
  assert.equal(maestStatusText(ctx.AUDIO.maestVm), 'Second ear: waits for listening to finish, then starts by itself.');
  assert.match(toasts[0], /waits for listening to finish/);
  assert.equal(starts.length, 0, 'nothing started while listening has the store');
  const second = ctx.maestStart();      // a second tap while waiting adds nothing
  await new Promise(r => setTimeout(r, 5));
  assert.equal(toasts.length, 1);
  ctx.AUDIO.ctrl.running = false;
  finish();
  await tap; await second;
  assert.equal(starts.length, 1, 'it ran once listening finished');
  assert.equal(ctx.AUDIO.maestWaiting, false);
});
