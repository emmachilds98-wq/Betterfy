import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loudness, energyFrom, LOUDNESS_VERSION } from '../core/audio/dsp/loudness.mjs';
import { SAMPLE_RATE } from '../core/audio/mel.mjs';

// Synthetic signals only: the claims here are about the heuristic's shape
// (monotone, scale-correct, finite), not about matching a reference meter.

const SR = SAMPLE_RATE, SECONDS = 30, N = SR * SECONDS;

/** Seeded LCG in [-0.5, 0.5), so every signal is reproducible. */
function rng(seed = 1) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 - 0.5; };
}
const sine = (hz, amp, n = N, sr = SR) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin(2 * Math.PI * hz * i / sr));
const noise = (amp, seed = 7) => { const r = rng(seed); return Float32Array.from({ length: N }, () => amp * 2 * r()); };
/** Decaying noise bursts (~10 ms) at `rate` per second, over optional background noise. */
function clickTrack(rate, amp, bg = 0, seed = 3) {
  const x = noise(bg, seed + 1), r = rng(seed), period = Math.round(SR / rate);
  for (let s = 0; s < N; s += period) for (let j = 0; j < 800 && s + j < N; j++) x[s + j] += amp * 2 * r() * Math.exp(-j / 150);
  return x;
}
/** Short quiet 220 Hz tone bursts, one every 2 s. */
function sparseSine(amp) {
  const x = new Float32Array(N);
  for (let s = 0; s < N; s += 2 * SR) for (let j = 0; j < SR / 4 && s + j < N; j++) x[s + j] = amp * Math.sin(2 * Math.PI * 220 * j / SR);
  return x;
}

const NUMERIC = ['rmsDb', 'loudness', 'shortTermMax', 'centroidHz', 'onsetDensity', 'energy'];
const allFinite = r => NUMERIC.every(k => typeof r[k] === 'number' && Number.isFinite(r[k]));

test('silence: minimal energy, floors instead of -Infinity, no NaN', () => {
  const r = loudness(new Float32Array(N));
  assert.ok(allFinite(r), JSON.stringify(r));
  assert.equal(r.energy, 0);
  assert.equal(r.onsetDensity, 0);
  assert.equal(r.centroidHz, 0);
  assert.equal(r.loudness, -70);
  assert.equal(r.version, LOUDNESS_VERSION);
  assert.ok(JSON.parse(JSON.stringify(r)).loudness === -70, 'JSON-safe');
});

test('empty and very short inputs stay finite', () => {
  for (const x of [new Float32Array(0), sine(440, 0.3, 100), sine(440, 0.3, 3000)]) {
    const r = loudness(x);
    assert.ok(allFinite(r), JSON.stringify(r));
    assert.ok(r.energy >= 0 && r.energy <= 1);
  }
});

test('doubling amplitude adds ~6 dB of loudness and RMS', () => {
  const a = loudness(sine(440, 0.1)), b = loudness(sine(440, 0.2)), c = loudness(sine(440, 0.4));
  for (const [lo, hi] of [[a, b], [b, c]]) {
    assert.ok(Math.abs(hi.loudness - lo.loudness - 6.02) < 0.1, `${lo.loudness} -> ${hi.loudness}`);
    assert.ok(Math.abs(hi.rmsDb - lo.rmsDb - 6.02) < 0.05, `${lo.rmsDb} -> ${hi.rmsDb}`);
  }
  // A full-scale sine is -3 dBFS RMS; K-weighting barely touches 440 Hz.
  assert.ok(Math.abs(loudness(sine(440, 1)).rmsDb + 3.01) < 0.05);
  assert.ok(b.energy > a.energy);
});

test('K-weighting is re-derived per sample rate: same tone, similar loudness at 44.1 kHz', () => {
  const at16 = loudness(sine(1000, 0.25, SR * 5)).loudness;
  const at44 = loudness(sine(1000, 0.25, 44100 * 5, 44100), { sampleRate: 44100 }).loudness;
  assert.ok(Math.abs(at16 - at44) < 0.5, `${at16} vs ${at44}`);
});

test('gating ignores silence: a tone with long silent gaps reads as the tone', () => {
  const tone = sine(440, 0.2), gappy = Float32Array.from(tone, (v, i) => (Math.floor(i / SR) % 3 === 0 ? v : 0));
  const full = loudness(tone).loudness, gated = loudness(gappy).loudness;
  // Blocks straddling a tone edge are part-silent but pass the -10 LU gate, as in BS.1770.
  assert.ok(Math.abs(full - gated) < 1.5, `${full} vs ${gated}`);
  assert.ok(loudness(gappy).rmsDb < loudness(tone).rmsDb - 4, 'plain RMS does drop');
});

test('noise is brighter than a low sine', () => {
  const low = loudness(sine(110, 0.3)), wide = loudness(noise(0.3));
  assert.ok(Math.abs(low.centroidHz - 110) < 15, `low sine centroid ${low.centroidHz}`);
  assert.ok(wide.centroidHz > 3000, `noise centroid ${wide.centroidHz}`); // white noise to 8 kHz: ~4 kHz
  assert.ok(wide.centroidHz > low.centroidHz * 10);
});

test('steady signals have no onsets', () => {
  assert.equal(loudness(sine(440, 0.3)).onsetDensity, 0);
  assert.equal(loudness(sine(100, 0.5)).onsetDensity, 0);
  assert.ok(loudness(noise(0.3)).onsetDensity < 0.5);
});

test('click tracks: onsetDensity ≈ clicks per second', () => {
  for (const [rate, bg] of [[2, 0], [8, 0], [2, 0.05], [8, 0.05], [4, 0.1]]) {
    const r = loudness(clickTrack(rate, 0.8, bg));
    assert.ok(Math.abs(r.onsetDensity - rate) < Math.max(0.2, rate * 0.06), `${rate}/s over noise ${bg}: ${r.onsetDensity}`);
  }
});

test('a dense, loud, noisy click track has more energy than a quiet sparse sine', () => {
  const busy = loudness(clickTrack(8, 0.9, 0.2)), calm = loudness(sparseSine(0.05));
  assert.ok(busy.energy > calm.energy + 0.4, `${busy.energy} vs ${calm.energy}`);
  assert.ok(busy.energy <= 1 && calm.energy >= 0);
  // Each component pulls the same way.
  assert.ok(busy.loudness > calm.loudness && busy.centroidHz > calm.centroidHz && busy.onsetDensity > calm.onsetDensity);
});

test('energyFrom: documented blend, clamped, 0 at the silence floor', () => {
  assert.equal(energyFrom({ loudness: -70, centroidHz: 4000, onsetDensity: 8 }), 0);
  assert.equal(energyFrom({ loudness: 0, centroidHz: 16000, onsetDensity: 20 }), 1);
  // -25 LUFS-like → L = 0.5; 1 kHz → C = 0.5; 4/s → O = 0.5.
  assert.ok(Math.abs(energyFrom({ loudness: -25, centroidHz: 1000, onsetDensity: 4 }) - 0.5) < 1e-12);
});

test('deterministic: same input, same output; input not mutated', () => {
  const x = clickTrack(4, 0.7, 0.1), copy = Float32Array.from(x);
  const a = loudness(x), b = loudness(x);
  assert.deepEqual(a, b);
  assert.deepEqual(x, copy);
  assert.deepEqual(loudness(Array.from(x)), a, 'plain arrays work the same');
});

test('speed on a 30 s clip (logged, not asserted tightly)', () => {
  const x = clickTrack(4, 0.7, 0.1);
  loudness(x); // warm up
  const runs = 5, t0 = performance.now();
  for (let i = 0; i < runs; i++) loudness(x);
  const ms = (performance.now() - t0) / runs;
  console.log(`loudness(): ${ms.toFixed(1)} ms per 30 s clip (target < 50 ms)`);
  assert.ok(ms < 2000);
});
