import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { maestPatches, createMaestEar, pickMaestOutputs, MAEST_FRAMES, MAEST_MEAN, MAEST_STD } from '../core/audio/maest.mjs';
import { analyseSamples, fillMaest } from '../core/audio/worker.js';
import { createAudioController, createWorkerEar } from '../web/audio/controller.mjs';
import { makeRecord, makeEar, earCurrent, validRecord, unpackEmbedding, MAEST_DIM, MAEST_N_STYLES, MAEST_MODEL, N_STYLES, EMB_DIM, MISS } from '../core/audio/record.mjs';
import { N_BANDS, SAMPLE_RATE, MEL_VERSION } from '../core/audio/mel.mjs';

// WP-C1: MAEST as the optional second ear. Model-free: every session is fake,
// and the one real-model check runs only when BETTERFY_MAEST_DIR is set.

const tone = (seconds, f = 440) => Float32Array.from({ length: Math.round(seconds * SAMPLE_RATE) }, (_, i) => 0.3 * Math.sin(2 * Math.PI * f * i / SAMPLE_RATE));
const SIZE = MAEST_FRAMES * N_BANDS;

/* ------------------------------------------------------------ front end */

test('two 10 s windows make two patches of 626 frames, one per window, never across the join', () => {
  const p = maestPatches([tone(10, 220), tone(10, 1760)]);
  assert.equal(p.patches, 2);
  assert.equal(p.frames, MAEST_FRAMES);
  assert.equal(p.data.length, 2 * SIZE);
  // Each patch's energy sits where its own tone is: the windows are not mixed.
  const bandOfMax = off => { let b = 0; for (let k = 1; k < N_BANDS; k++) if (p.data[off + k] > p.data[off + b]) b = k; return b; };
  assert.ok(bandOfMax(100 * N_BANDS) < bandOfMax(SIZE + 100 * N_BANDS));
});

test('normalised with MAEST’s training statistics; padding is silence; a window under ~5 s is left out', () => {
  const p = maestPatches([tone(10), tone(3), new Float32Array(0)]);
  assert.equal(p.patches, 1, 'the 3 s window is too little for a 10 s model');
  // 10 s gives 625 frames: the last of 626 is padded with log-mel 0 before normalising.
  const pad = p.data[(MAEST_FRAMES - 1) * N_BANDS];
  assert.ok(Math.abs(pad - (0 - MAEST_MEAN) / (2 * MAEST_STD)) < 1e-6);
  const raw = maestPatches([tone(10)], { normalise: false });
  assert.ok(Math.abs(raw.data[(MAEST_FRAMES - 1) * N_BANDS]) < 1e-9);
  assert.ok(Math.abs((raw.data[50] - MAEST_MEAN) / (2 * MAEST_STD) - p.data[50]) < 1e-5);
  assert.equal(maestPatches([tone(4)]).patches, 0);
});

/* ------------------------------------------------------------ the ear */

/** Fake MAEST: activations[p][k] = first input value of patch p + k/1e4; embedding tokens per `tokens`. */
function fakeOrt({ rank = null, tokens = 1, names = ['melspectrogram'] } = {}) {
  const runs = [];
  class Tensor { constructor(type, data, dims) { Object.assign(this, { type, data, dims }); } }
  const session = {
    inputNames: names,
    ...(rank ? { inputMetadata: [{ name: names[0], shape: rank === 4 ? ['batch', 1, MAEST_FRAMES, N_BANDS] : ['batch', MAEST_FRAMES, N_BANDS] }] } : {}),
    async run(feeds) {
      const x = feeds[names[0]]; const n = x.dims[0];
      runs.push(x.dims.slice());
      const act = new Float32Array(n * MAEST_N_STYLES), emb = new Float32Array(n * tokens * MAEST_DIM);
      for (let p = 0; p < n; p++) {
        const v = x.data[p * SIZE];
        for (let k = 0; k < MAEST_N_STYLES; k++) act[p * MAEST_N_STYLES + k] = Math.min(1, Math.max(0, 0.5 + v / 10 + k / 1e4));
        for (let t = 0; t < tokens; t++) for (let d = 0; d < MAEST_DIM; d++) emb[(p * tokens + t) * MAEST_DIM + d] = t + p;
      }
      return { embeddings: { data: emb }, activations: { data: act } };
    },
    async release() { this.released = true; },
  };
  return { Tensor, InferenceSession: { create: async (url, opts) => Object.assign(session, { url, opts }) }, runs, session };
}

test('the ear runs both windows in one batch and answers the mean styles and mean embedding', async () => {
  const ort = fakeOrt();
  const ear = await createMaestEar({ ort, modelUrl: 'models/maest.onnx' });
  const out = await ear.run([tone(10), tone(10, 880)]);
  assert.deepEqual(ort.runs, [[2, MAEST_FRAMES, N_BANDS]], 'rank 3 when the graph does not say');
  assert.equal(out.patches, 2);
  assert.equal(out.activations.length, MAEST_N_STYLES);
  assert.equal(out.embedding.length, MAEST_DIM);
  assert.ok(Math.abs(out.embedding[0] - 0.5) < 1e-6, 'mean of patch 0 and patch 1');
  // The record takes it as is.
  const field = makeEar('maest', { embedding: out.embedding, activations: out.activations });
  assert.equal(field.model, MAEST_MODEL);
  assert.equal(unpackEmbedding(field.emb).length, MAEST_DIM);
  await ear.release();
  assert.ok(ort.session.released);
});

test('a graph that asks for [n, 1, frames, 96] gets it; per-token embeddings are averaged over tokens', async () => {
  const ort = fakeOrt({ rank: 4, tokens: 3, names: ['serving_default_melspectrogram'] });
  const ear = await createMaestEar({ ort, modelUrl: 'm.onnx' });
  const out = await ear.run([tone(10)]);
  assert.deepEqual(ort.runs, [[1, 1, MAEST_FRAMES, N_BANDS]]);
  assert.ok(Math.abs(out.embedding[0] - 1) < 1e-6, 'tokens 0, 1, 2 average to 1');
});

test('no window long enough is no answer, not a zero answer; outputs of the wrong width are an error', async () => {
  const ort = fakeOrt();
  const ear = await createMaestEar({ ort, modelUrl: 'm.onnx' });
  assert.equal(await ear.run([tone(2)]), null);
  assert.equal(ort.runs.length, 0, 'the model is not run on nothing');
  assert.throws(() => pickMaestOutputs({ a: { data: new Float32Array(N_STYLES) }, b: { data: new Float32Array(EMB_DIM) } }, 1), /768/);
  const named = pickMaestOutputs({ a: { data: new Float32Array(MAEST_N_STYLES) }, x: { data: new Float32Array(MAEST_DIM).fill(1) }, y: { data: new Float32Array(MAEST_DIM).fill(2) } }, 1, { embeddingOutput: 'y' });
  assert.equal(named.emb[0], 2, 'a named embedding output wins over the first 768-wide one');
});

/* ------------------------------------------------------------ worker */

function fakeEffnet() {
  return { run: async (data, n) => { const activations = new Float32Array(n * N_STYLES).fill(0.1); activations[3] = 0.9;
    return { activations, embeddings: new Float32Array(n * EMB_DIM).fill(0.5) }; } };
}
const fakeMaest = (calls = []) => ({ run: async windows => { calls.push(windows.map(w => w.length));
  return { activations: new Float32Array(MAEST_N_STYLES).fill(0.2).fill(0.8, 7, 8), embedding: new Float32Array(MAEST_DIM).fill(0.3) }; } });

const source = { kind: 'deezer-isrc', deezerId: 9, windows: [[0, 1], [2, 3]], seconds: 20 };

test('a new record gets the maest ear from each window on its own, and the base record is unchanged', async () => {
  const calls = [];
  const parts = [tone(10), tone(10, 880)];
  const samples = Float32Array.from([...parts[0], ...parts[1]]);
  const withM = await analyseSamples({ ear: fakeEffnet(), maest: fakeMaest(calls), now: () => 5 }, { id: 't', isrc: 'I', samples, parts, source });
  const without = await analyseSamples({ ear: fakeEffnet(), now: () => 5 }, { id: 't', isrc: 'I', samples, parts, source });
  assert.deepEqual(calls, [[SAMPLE_RATE * 10, SAMPLE_RATE * 10]], 'windows, not the joined samples');
  assert.ok(earCurrent(withM.record, 'maest'));
  assert.equal(withM.record.maest.styles[0][0], 7);
  assert.ok(validRecord(withM.record));
  assert.deepEqual({ ...withM.record, maest: null }, without.record, 'byte-identical apart from the second ear');
  assert.equal(without.record.maest, null);
});

test('a MAEST failure leaves the ear out and keeps the record', async () => {
  const boom = { run: async () => { throw new Error('oom'); } };
  const r = await analyseSamples({ ear: fakeEffnet(), maest: boom }, { id: 't', isrc: 'I', samples: tone(20), source });
  assert.ok(r.record && validRecord(r.record));
  assert.equal(r.record.maest, null);
});

function heardRecord(id, deezerId = 9) {
  const n = 2;
  const activations = new Float32Array(n * N_STYLES).fill(0.1);
  return makeRecord({ id, isrc: 'I' + id, activations, embeddings: new Float32Array(n * EMB_DIM).fill(0.5), patches: n,
                      source: { ...source, deezerId }, mel: MEL_VERSION, at: 1 });
}
const net = (deezerId = 9) => ({
  lookup: async () => ({ deezerId, previewUrl: 'https://cdn/x.mp3' }),
  fetchPreview: async () => ({ buffers: [new ArrayBuffer(4), new ArrayBuffer(4)], windows: [[0, 4], [4, 8]] }),
  decode: async () => tone(10),
});

test('fillMaest adds the ear to a record heard before, and only to the same recording', async () => {
  const rec = heardRecord('a');
  const r = await fillMaest({ ...net(), maest: fakeMaest() }, rec);
  assert.ok(earCurrent(r.record, 'maest'));
  assert.deepEqual(r.record.emb, rec.emb, 'the base ear is untouched');
  assert.deepEqual(await fillMaest({ ...net(), maest: fakeMaest() }, r.record), { skip: 'current' });
  assert.deepEqual(await fillMaest({ ...net(10), maest: fakeMaest() }, rec), { skip: 'different-recording' });
  assert.deepEqual(await fillMaest(net(), rec), { skip: 'no-maest' });
  const down = await fillMaest({ ...net(), fetchPreview: async () => ({ miss: MISS.FAILED, detail: 'net' }), maest: fakeMaest() }, rec);
  assert.equal(down.failed.stage, 'download');
});

/* ------------------------------------------------------------ controller */

function memStore(seed = []) {
  const m = new Map(seed.map(r => [r.id, r]));
  return { getAll: async () => new Map(m), put: async r => { m.set(r.id, r); }, count: async () => m.size, map: m };
}
const pipeline = () => ({ ...net(), loadEar: async () => ({ ear: fakeEffnet() }) });

test('MAEST stays unloaded while deep listen does not allow it', async () => {
  let loads = 0;
  const store = memStore();
  const ctrl = createAudioController({ store, ...pipeline(), dsp: null, maestAllowed: () => false,
    loadMaest: async () => { loads++; return fakeMaest(); } });
  await ctrl.start([{ id: 'x', isrc: 'Ix' }]);
  assert.equal(loads, 0);
  assert.equal(store.map.get('x').maest, null);
  assert.equal(ctrl.vm().maest, undefined);
});

test('allowed: new tracks are heard by both ears, and records heard before are topped up after the queue', async () => {
  const store = memStore([heardRecord('old')]);
  let loads = 0;
  const ctrl = createAudioController({ store, ...pipeline(), dsp: null, maestAllowed: () => true,
    loadMaest: async () => { loads++; return fakeMaest(); } });
  await ctrl.start([{ id: 'new', isrc: 'Inew' }]);
  assert.equal(loads, 1, 'loaded once');
  assert.ok(earCurrent(store.map.get('new'), 'maest'));
  assert.ok(earCurrent(store.map.get('old'), 'maest'));
  assert.deepEqual(ctrl.vm().maest, { loaded: true, filled: 1 });
});

test('a MAEST model that will not load is said once; listening carries on without it', async () => {
  const store = memStore();
  let loads = 0;
  const ctrl = createAudioController({ store, ...pipeline(), dsp: null, maestAllowed: () => true,
    loadMaest: async () => { loads++; throw new Error('404'); } });
  await ctrl.start([{ id: 'a', isrc: 'Ia' }]);
  await ctrl.start([{ id: 'b', isrc: 'Ib' }]);
  assert.equal(loads, 1, 'not retried every run in the same session');
  assert.equal(await store.count(), 2);
  assert.deepEqual(ctrl.vm().maest, { loaded: false, filled: 0, error: '404' });
});

test('the worker proxy loads MAEST only on load(), once, and copies the windows across', async () => {
  const posted = [], listeners = {};
  const worker = {
    addEventListener: (k, f) => { listeners[k] = f; },
    postMessage: (m) => { posted.push(m); setTimeout(() => {
      const ok = result => listeners.message({ data: { id: m.id, ok: true, result } });
      if (m.op === 'init') ok({ heads: [] });
      if (m.op === 'maest-init') ok({ ok: true });
      if (m.op === 'maest') ok({ activations: new Float32Array(MAEST_N_STYLES), embedding: new Float32Array(MAEST_DIM), patches: m.windows.length });
    }, 0); },
  };
  const w = createWorkerEar(worker, { modelUrl: 'e.onnx', maestUrl: 'm.onnx' });
  await w.ready;
  assert.ok(!posted.some(m => m.op === 'maest-init'), 'nothing downloaded before load()');
  await assert.rejects(w.maest.run([tone(10)]), /not loaded/);
  await Promise.all([w.maest.load(), w.maest.load()]);
  assert.equal(posted.filter(m => m.op === 'maest-init').length, 1);
  const win = tone(10);
  const out = await w.maest.run([win]);
  assert.equal(out.patches, 1);
  assert.equal(win.length, SAMPLE_RATE * 10, 'the caller keeps its windows');
  assert.equal(createWorkerEar(worker, { modelUrl: 'e.onnx' }).maest, undefined, 'no MAEST without a url');
});

/* ------------------------------------------------------------ real model (optional) */

const DIR = process.env.BETTERFY_MAEST_DIR;
test('real MAEST: a 400×768 answer from the shipped int8 model, held to the reference when given', { skip: !DIR && 'set BETTERFY_MAEST_DIR to run' }, async () => {
  const ort = await import('onnxruntime-node');
  const model = join(DIR, 'discogs-maest-10s-pw-2-int8.onnx');
  const ear = await createMaestEar({ ort, modelUrl: model, sessionOptions: {} });
  const out = await ear.run([tone(10), tone(10, 660)]);
  assert.equal(out.activations.length, MAEST_N_STYLES);
  assert.equal(out.embedding.length, MAEST_DIM);
  // scripts/audio-maest/reference.py writes Essentia's own answer for the same windows.
  const ref = join(DIR, 'maest-reference.json');
  if (existsSync(ref)) {
    const want = JSON.parse(readFileSync(ref, 'utf8'));
    const a = out.activations, b = want.activations;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2; }
    assert.ok(dot / Math.sqrt(na * nb) > 0.98, 'style profile matches Essentia within int8 error');
  }
  await ear.release();
});
