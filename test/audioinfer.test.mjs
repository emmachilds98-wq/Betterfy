import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEar, pickOutputs, MAX_BATCH } from '../core/audio/infer.mjs';
import { PATCH_FRAMES, N_BANDS, melFrames, melPatches, SAMPLE_RATE } from '../core/audio/mel.mjs';
import { N_STYLES, EMB_DIM } from '../core/audio/record.mjs';

const SIZE = PATCH_FRAMES * N_BANDS;

// A fake onnxruntime: activations[p][k] = first mel value of patch p + k/1000,
// so each row can be traced back to the patch that produced it.
function fakeOrt() {
  const batches = [];
  class Tensor { constructor(type, data, dims) { Object.assign(this, { type, data, dims }); } }
  const session = {
    inputNames: ['melspectrogram'],
    async run(feeds) {
      const x = feeds.melspectrogram; const n = x.dims[0];
      batches.push(x.dims.slice());
      const act = new Float32Array(n * N_STYLES), emb = new Float32Array(n * EMB_DIM);
      for (let p = 0; p < n; p++) {
        const v = x.data[p * SIZE];
        for (let k = 0; k < N_STYLES; k++) act[p * N_STYLES + k] = v + k / 1000;
        for (let k = 0; k < EMB_DIM; k++) emb[p * EMB_DIM + k] = v;
      }
      // Deliberately listed embeddings-first under unhelpful names.
      return { out_b: { data: emb }, out_a: { data: act } };
    },
    released: false, async release() { this.released = true; },
  };
  return { Tensor, InferenceSession: { create: async (url, opts) => Object.assign(session, { url, opts }) }, batches, session };
}

const patchesOf = n => { const d = new Float32Array(n * SIZE); for (let p = 0; p < n; p++) d[p * SIZE] = p; return d; };

test('shapes: n patches in, [n×400] and [n×1280] out, in patch order', async () => {
  const ort = fakeOrt();
  const ear = await createEar({ ort, modelUrl: 'models/effnet.onnx' });
  const { activations, embeddings } = await ear.run(patchesOf(5), 5);
  assert.equal(activations.length, 5 * N_STYLES);
  assert.equal(embeddings.length, 5 * EMB_DIM);
  assert.equal(activations[3 * N_STYLES], 3);
  assert.equal(embeddings[4 * EMB_DIM + 7], 4);
  assert.deepEqual(ort.session.opts, { executionProviders: ['wasm'] }, 'WASM only by default');
});

test('batches at most 16 patches per run, and keeps order across batches', async () => {
  const ort = fakeOrt();
  const ear = await createEar({ ort, modelUrl: 'm' });
  const { activations } = await ear.run(patchesOf(37), 37);
  assert.deepEqual(ort.batches.map(d => d[0]), [MAX_BATCH, MAX_BATCH, 5]);
  assert.ok(ort.batches.every(d => d[1] === PATCH_FRAMES && d[2] === N_BANDS));
  for (const p of [0, 15, 16, 31, 36]) assert.equal(activations[p * N_STYLES], p, `patch ${p}`);
  await ear.release();
  assert.equal(ort.session.released, true);
});

test('rejects wrong-sized input and unrecognisable outputs', async () => {
  const ear = await createEar({ ort: fakeOrt(), modelUrl: 'm' });
  await assert.rejects(ear.run(new Float32Array(10), 1), /expected/);
  await assert.rejects(ear.run(new Float32Array(0), 0), /no patches/);
  assert.throws(() => pickOutputs({ a: { data: new Float32Array(5) } }, 1), /outputs/);
});

// Optional: the real model on a synthetic signal. Skipped unless BETTERFY_MODEL_DIR
// points at a folder with discogs-effnet-bsdynamic-1.onnx and onnxruntime-node installed.
test('real model on a synthetic signal (optional)', { skip: !process.env.BETTERFY_MODEL_DIR && 'set BETTERFY_MODEL_DIR to run' }, async () => {
  const ort = await import('onnxruntime-node');
  const ear = await createEar({ ort, modelUrl: `${process.env.BETTERFY_MODEL_DIR}/discogs-effnet-bsdynamic-1.onnx`, sessionOptions: {} });
  const sig = Float32Array.from({ length: SAMPLE_RATE * 10 }, (_, i) => 0.3 * Math.sin(2 * Math.PI * 220 * i / SAMPLE_RATE) * (i % 8000 < 800 ? 1 : 0.2));
  const p = melPatches(melFrames(sig));
  const { activations, embeddings } = await ear.run(p.data, p.patches);
  assert.ok(activations.every(v => v >= 0 && v <= 1), 'sigmoids');
  assert.ok(embeddings.some(v => v !== 0));
});
