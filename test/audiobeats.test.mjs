import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beatMel, beatFrameCount, resampleSinc, BEAT_SR, BEAT_BANDS, BEAT_FPS } from '../core/audio/dsp/beat-mel.mjs';
import { pickBeats, tempoFromBeats, combineBeatTempo, resolveOctave, createBeatTracker, withBeats, needsBeats, BORDER, BEATS_VERSION } from '../core/audio/dsp/beats.mjs';

// --- front end: held to beat_this's own LogMelSpect (torchaudio) ---
test('beatMel matches beat_this LogMelSpect on the fixture', () => {
  const fx = JSON.parse(readFileSync(new URL('./fixtures/beat-mel.json', import.meta.url)));
  const N = BEAT_SR, x = new Float32Array(N);
  for (let i = 0; i < N; i++) { const t = i / N; x[i] = 0.3 * Math.sin(2 * Math.PI * 220 * t) + 0.1 * Math.sin(2 * Math.PI * 3000 * t); }
  for (const i0 of [0, 11025]) for (let k = 0; k < 200; k++) x[i0 + k] += 0.8 * (0.5 - 0.5 * Math.cos(2 * Math.PI * k / 199));
  const m = beatMel(x);
  assert.equal(m.frames, fx.frames);
  assert.equal(m.frames, beatFrameCount(N));
  let worst = 0;
  for (const [f, row] of Object.entries(fx.rows)) for (let b = 0; b < BEAT_BANDS; b++) worst = Math.max(worst, Math.abs(m.data[f * BEAT_BANDS + b] - row[b]));
  assert.ok(worst < 2e-3, `max diff ${worst}`);
});

test('resampleSinc keeps a 1 kHz tone at 16 k → 22.05 k', () => {
  const x = new Float32Array(16000);
  for (let i = 0; i < x.length; i++) x[i] = Math.sin(2 * Math.PI * 1000 * i / 16000);
  const y = resampleSinc(x, 16000, BEAT_SR);
  assert.equal(y.length, BEAT_SR);
  let err = 0;
  for (let i = 200; i < y.length - 200; i++) err = Math.max(err, Math.abs(y[i] - Math.sin(2 * Math.PI * 1000 * i / BEAT_SR)));
  assert.ok(err < 0.01, `err ${err}`);
});

// --- postprocessing, as beat_this "minimal" ---
const logits = (n, at, v = 5) => { const l = new Float32Array(n).fill(-5); for (const f of at) l[f] = v; return l; };

test('pickBeats: local maxima above 0, adjacent frames merged, downbeats snapped', () => {
  const beat = logits(200, [10, 35, 60, 61, 110]);
  beat[85] = -0.1; // below 0.5 probability: not a beat
  const down = logits(200, [11, 112]);
  const { beats, downbeats } = pickBeats(beat, down);
  assert.deepEqual(beats, [10 / 50, 35 / 50, 60.5 / 50, 110 / 50]);
  assert.deepEqual(downbeats, [10 / 50, 110 / 50]);
});

test('pickBeats: a larger neighbour within 3 frames suppresses a peak', () => {
  const beat = logits(50, [10]); beat[12] = 6;
  assert.deepEqual(pickBeats(beat, new Float32Array(50).fill(-5)).beats, [12 / 50]);
});

// --- tempo from beats ---
const grid = (bpm, n, t0 = 0.3, jitter = 0) => Array.from({ length: n }, (_, i) => t0 + i * 60 / bpm + (i % 2 ? jitter : -jitter));

test('tempoFromBeats: an even grid, with jitter, and with a missed beat', () => {
  assert.equal(tempoFromBeats(grid(128, 20)).bpm, 128);
  assert.ok(Math.abs(tempoFromBeats(grid(174, 28, 0.1, 0.01)).bpm - 174) <= 0.5);
  const missed = grid(140, 22); missed.splice(9, 1);
  const r = tempoFromBeats(missed);
  assert.ok(Math.abs(r.bpm - 140) <= 0.5, `${r.bpm}`);
  assert.ok(r.regularity > 0.9);
  assert.equal(tempoFromBeats([0.1, 0.5, 0.9]).bpm, null);
});

test('combineBeatTempo pools agreeing windows and drops irregular ones', () => {
  assert.equal(combineBeatTempo([{ bpm: 128, regularity: 1 }, { bpm: 128.4, regularity: 0.9 }]).bpm, 128.2);
  assert.equal(combineBeatTempo([{ bpm: 87, regularity: 0.95 }, { bpm: 174, regularity: 0.8 }]).bpm, 87);
  assert.equal(combineBeatTempo([{ bpm: 120, regularity: 0.3 }]), null);
  assert.equal(combineBeatTempo([{ bpm: null, regularity: 0 }]), null);
});

// --- the half/double-time decision ---
test('resolveOctave moves to the level Beat This heard, keeping D1 precision', () => {
  const d1 = { v: 'x', bpm: 87.1, bpmConf: 0.4, octaveAmbiguous: true, bpmAlt: 174.3 };
  const up = resolveOctave(d1, { bpm: 175 });
  assert.equal(up.bpm, 174.3);
  assert.equal(up.bpmAlt, 87.1);
  assert.equal(up.octaveAmbiguous, false);
  assert.equal(up.octaveBy, 'beats');
  assert.equal(up.beatBpm, 175);
  const down = resolveOctave({ bpm: 140, octaveAmbiguous: false }, { bpm: 70.2 });
  assert.equal(down.bpm, 70);
  assert.equal(down.bpmAlt, 140);
});

test('resolveOctave confirms agreement, ignores other ratios, honours onlyAmbiguous', () => {
  const d1 = { bpm: 128, octaveAmbiguous: true, bpmAlt: 64 };
  const same = resolveOctave(d1, { bpm: 127.5 });
  assert.equal(same.bpm, 128);
  assert.equal(same.octaveAmbiguous, false);
  assert.equal(same.bpmAlt, 64);
  assert.equal(resolveOctave(d1, { bpm: 96 }), d1); // 3:4, not an octave: unchanged
  assert.equal(resolveOctave(d1, null), d1);
  const sure = { bpm: 128, octaveAmbiguous: false };
  assert.equal(resolveOctave(sure, { bpm: 64 }, { onlyAmbiguous: true }), sure);
});

// --- the tracker on a fake ONNX session ---
function fakeOrt(bpm) {
  const seen = [];
  class Tensor { constructor(type, data, dims) { Object.assign(this, { type, data, dims }); } }
  const InferenceSession = {
    async create(url) {
      return {
        inputNames: ['input_spectrogram'],
        async run(feeds) {
          const x = feeds.input_spectrogram; seen.push({ url, dims: x.dims });
          const T = x.dims[1], beat = new Float32Array(T).fill(-5), down = new Float32Array(T).fill(-5);
          for (let i = 0; ; i++) {
            const f = BORDER + Math.round(5 + i * 60 / bpm * BEAT_FPS);
            if (f >= T - BORDER) break;
            beat[f] = 4; if (i % 4 === 0) down[f] = 4;
          }
          return { beat: new Tensor('float32', beat, [1, T]), downbeat: new Tensor('float32', down, [1, T]) };
        },
      };
    },
  };
  return { ort: { InferenceSession, Tensor }, seen };
}

test('createBeatTracker pads by BORDER, picks beats and downbeats, and measures windows', async () => {
  const { ort, seen } = fakeOrt(174);
  const tr = await createBeatTracker({ ort, modelUrl: 'models/x.onnx' });
  const w = new Float32Array(16000 * 10);
  const r = await tr.run(w);
  const frames = beatFrameCount(Math.floor(w.length * BEAT_SR / 16000));
  assert.deepEqual(seen[0].dims, [1, frames + 2 * BORDER, BEAT_BANDS]);
  assert.equal(seen[0].url, 'models/x.onnx');
  assert.ok(Math.abs(r.tempo.bpm - 174) < 1, `${r.tempo.bpm}`);
  assert.ok(r.downbeats.length >= 6 && r.downbeats.length <= 8);
  const m = await tr.measure([w, w]);
  assert.equal(m.windows, 2);
  assert.ok(Math.abs(m.bpm - 174) < 1);
});

test('withBeats: Beat This settles the level; a failing tracker leaves dsp as it was', async () => {
  const dsp = () => ({ v: 'D', bpm: 87, bpmConf: 0.5, octaveAmbiguous: true, bpmAlt: 174 });
  const { ort } = fakeOrt(174);
  const tr = await createBeatTracker({ ort });
  const out = await withBeats(dsp, tr)([new Float32Array(160000)]);
  assert.equal(out.bpm, 174);
  assert.equal(out.v, 'D');
  assert.equal(out.beatsV, BEATS_VERSION);
  const broken = { measure: async () => { throw new Error('no model'); } };
  const kept = await withBeats(dsp, broken)([new Float32Array(10)]);
  assert.deepEqual(kept, dsp());
  assert.equal(needsBeats({ dsp: kept }), true);
  assert.equal(needsBeats({ dsp: out }), false);
  assert.equal(needsBeats({ dsp: { bpm: null } }), false);
  assert.equal(await withBeats(() => null, tr)([]), null);
});
