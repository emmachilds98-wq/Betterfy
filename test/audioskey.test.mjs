import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSkey, skeyAnswer, skeyWindows, meanScores, resample, SKEY_LABELS, SKEY_CAMELOT, SKEY_SAMPLE_RATE,
         SKEY_MIN_SECONDS, SKEY_VERSION } from '../core/audio/dsp/skey.mjs';
import { CAMELOT } from '../core/audio/dsp/key.mjs';

// Build 5 §6.1 step 2. The model itself is not run here (no onnxruntime in
// the repo, no network in tests): a fake ort stands in, as for infer.mjs. The
// accuracy number comes from scripts/audio-dsp/skey-eval.mjs on the Beatport
// set (see skey.mjs's header).

/** A fake onnxruntime whose session answers `scoresFor(samples)`; records every call. */
function fakeOrt(scoresFor, { inputNames = ['audio'], outName = 'scores' } = {}) {
  const calls = [];
  class Tensor { constructor(type, data, dims) { Object.assign(this, { type, data, dims }); } }
  const session = {
    inputNames,
    async run(feeds) { const x = Object.values(feeds)[0]; calls.push({ feeds, dims: x.dims }); return { [outName]: { data: scoresFor(x.data) } }; },
    released: false, async release() { this.released = true; },
  };
  return { Tensor, InferenceSession: { create: async (url, opts) => Object.assign(session, { url, opts }) }, calls, session };
}
const onehot = (i, p = 0.9) => Float32Array.from({ length: 24 }, (_, k) => k === i ? p : (1 - p) / 23);
const noise = (n, amp = 0.3, seed = 1) => { let s = seed; return Float32Array.from({ length: n }, () => { s = (s * 16807) % 2147483647; return amp * (s / 2147483647 * 2 - 1); }); };

test('labels map to the right Camelot codes (manifest order: majors from A, minors from B)', () => {
  assert.equal(SKEY_LABELS.length, 24);
  assert.equal(new Set(SKEY_CAMELOT).size, 24);
  assert.equal(SKEY_CAMELOT[0], '11B');            // A major
  assert.equal(SKEY_CAMELOT[3], '8B');             // C major
  assert.equal(SKEY_CAMELOT[10], '9B');            // G major (the manifest's parity example)
  assert.equal(SKEY_CAMELOT[12], '10A');           // B minor
  assert.equal(SKEY_CAMELOT[22], '8A');            // A minor (the manifest's parity example)
  assert.equal(SKEY_CAMELOT[23], '3A');            // Bb minor
  for (let i = 0; i < 24; i++) assert.equal(CAMELOT[SKEY_CAMELOT[i]].mode, i < 12 ? 'major' : 'minor');
});

test('skeyAnswer: key.mjs shape, top probability as confidence, alternates with relations', () => {
  const p = onehot(22, 0.7); p[3] = 0.2;            // A minor, then C major (its relative)
  const a = skeyAnswer(p);
  assert.equal(a.key, 'A minor');
  assert.equal(a.camelot, '8A');
  assert.equal(a.openKey, '1m');
  assert.equal(a.mode, 'minor');
  assert.equal(a.confidence, 0.7);
  assert.equal(a.alternates[0].camelot, '8B');
  assert.equal(a.alternates[0].relation, 'relative');
  assert.equal(a.alternates[0].compatible, true);
  assert.equal(a.alternates.length, 3);
  assert.equal(a.version, SKEY_VERSION);
  assert.equal(skeyAnswer(null).key, null);
  assert.equal(skeyAnswer(new Float32Array(5)).confidence, 0);
});

test('meanScores averages windows and skips the ones with no answer', () => {
  const m = meanScores([onehot(0, 1), null, onehot(1, 1)]);
  assert.ok(Math.abs(m[0] - 0.5) < 1e-6 && Math.abs(m[1] - 0.5) < 1e-6);
  assert.equal(meanScores([null, null]), null);
  assert.equal(meanScores([]), null);
});

test('createSkey feeds [1, samples] float32 under the model input name and reads 24 scores', async () => {
  const ort = fakeOrt(() => onehot(10));
  const sk = await createSkey({ ort, modelUrl: 'skey.onnx' });
  const x = noise(SKEY_SAMPLE_RATE * 4);
  const s = await sk.run(x);
  assert.equal(s.length, 24);
  assert.equal(skeyAnswer(s).key, 'G major');
  assert.deepEqual(ort.calls[0].dims, [1, x.length]);
  assert.ok('audio' in ort.calls[0].feeds);
  assert.deepEqual(ort.session.opts, { executionProviders: ['wasm'] });
  await sk.release();
  assert.equal(ort.session.released, true);
});

test('createSkey: too short or silent input gets no answer and never reaches the model', async () => {
  const ort = fakeOrt(() => onehot(0));
  const sk = await createSkey({ ort, modelUrl: 'm' });
  assert.equal(await sk.run(noise(SKEY_SAMPLE_RATE * SKEY_MIN_SECONDS - 1)), null);
  assert.equal(await sk.run(new Float32Array(SKEY_SAMPLE_RATE * 5)), null);
  assert.equal(await sk.run(null), null);
  assert.equal(ort.calls.length, 0);
});

test('createSkey: an output that is not 24 wide is an error, not a guess; renamed input/output still work', async () => {
  const bad = await createSkey({ ort: fakeOrt(() => new Float32Array(12)), modelUrl: 'm' });
  await assert.rejects(bad.run(noise(SKEY_SAMPLE_RATE * 4)), /24 scores/);
  const ort = fakeOrt(() => onehot(5), { inputNames: ['wave'], outName: 'probs' });
  const sk = await createSkey({ ort, modelUrl: 'm' });
  assert.equal(skeyAnswer(await sk.run(noise(SKEY_SAMPLE_RATE * 4))).key, 'D major');
  assert.ok('wave' in ort.calls[0].feeds);
});

test('skeyWindows runs each window on its own, averages, and says whether the windows agree', async () => {
  // Window 1 (amplitude 0.3) says A minor; window 2 (0.2) says C major more weakly.
  const ort = fakeOrt(d => d.some(v => Math.abs(v) > 0.25) ? onehot(22, 0.8) : onehot(3, 0.6));
  const sk = await createSkey({ ort, modelUrl: 'm' });
  const r = await skeyWindows(sk, [noise(SKEY_SAMPLE_RATE * 10, 0.3), noise(SKEY_SAMPLE_RATE * 10, 0.2, 7)]);
  assert.equal(ort.calls.length, 2);
  assert.equal(r.camelot, '8A');
  assert.equal(r.keyAgree, false);
  assert.ok(Math.abs(r.keyConf - (0.8 + 0.4 / 23) / 2) < 1e-3, `keyConf ${r.keyConf}`);
  const same = await skeyWindows(sk, [noise(SKEY_SAMPLE_RATE * 10, 0.3), noise(SKEY_SAMPLE_RATE * 10, 0.3, 9)]);
  assert.equal(same.keyAgree, true);
  const one = await skeyWindows(sk, [noise(SKEY_SAMPLE_RATE * 10, 0.3), new Float32Array(100)]);
  assert.equal(one.keyAgree, null);
  assert.equal(await skeyWindows(sk, [new Float32Array(10)]), null);
  assert.equal(await skeyWindows(sk, []), null);
});

test('skeyWindows: a window whose run throws is skipped, never fails the track', async () => {
  let n = 0;
  const ort = fakeOrt(() => { if (n++ === 0) throw new Error('boom'); return onehot(7); });
  const sk = await createSkey({ ort, modelUrl: 'm' });
  const r = await skeyWindows(sk, [noise(SKEY_SAMPLE_RATE * 4), noise(SKEY_SAMPLE_RATE * 4, 0.3, 3)]);
  assert.equal(r.key, 'E major');
});

test('resample: 16 → 22.05 kHz keeps length, DC and a tone where it was', () => {
  const n = 16000, f = 440;
  const x = Float32Array.from({ length: n }, (_, i) => Math.sin(2 * Math.PI * f * i / 16000));
  const y = resample(x, 16000, 22050);
  assert.equal(y.length, Math.floor(n * 22050 / 16000));
  // Away from the edges, y matches the same sine sampled at 22.05 kHz.
  let err = 0, m = 0;
  for (let j = 200; j < y.length - 200; j++) { err = Math.max(err, Math.abs(y[j] - Math.sin(2 * Math.PI * f * j / 22050))); m++; }
  assert.ok(err < 2e-3, `max error ${err}`);
  const dc = resample(new Float32Array(4000).fill(0.5), 16000, 22050);
  assert.ok(Math.abs(dc[2000] - 0.5) < 1e-5);
  // Downsampling filters what the new rate can't hold: a 10 kHz tone at 44.1 → 16 kHz is mostly gone.
  const hi = Float32Array.from({ length: 44100 }, (_, i) => Math.sin(2 * Math.PI * 10000 * i / 44100));
  const z = resample(hi, 44100, 16000);
  let rms = 0; for (let j = 500; j < z.length - 500; j++) rms += z[j] * z[j];
  assert.ok(Math.sqrt(rms / (z.length - 1000)) < 0.05);
  assert.deepEqual(Array.from(resample(Float32Array.from([1, 2, 3]), 8000, 8000)), [1, 2, 3]);
  assert.throws(() => resample(x, 0, 22050), /bad rates/);
});
