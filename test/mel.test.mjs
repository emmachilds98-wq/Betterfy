import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { melFrames, melPatches, frameCount, N_BANDS, PATCH_FRAMES, SAMPLE_RATE } from '../core/audio/mel.mjs';

// Essentia's own answer for synth(n), generated once by
// scripts/audio-phase0/make-mel-fixture.py. If this drifts, the model is fed
// features it was not trained on and every audio answer quietly degrades.
const REF = JSON.parse(readFileSync(new URL('./fixtures/mel-essentia.json', import.meta.url), 'utf8'));

/** Mirror of make-mel-fixture.py's synth(): sweep + LCG noise, float64 then float32. */
function synth(n) {
  const out = new Float32Array(n);
  let state = 12345n;
  for (let i = 0; i < n; i++) {
    state = (state * 1664525n + 1013904223n) % 4294967296n;
    const u = Number(state) / 4294967296 - 0.5;
    const t = i / SAMPLE_RATE;
    out[i] = 0.5 * Math.sin(2 * Math.PI * (100 + 1500 * t) * t) + 0.2 * u;
  }
  return out;
}

// Float32 input and float64 maths on both sides; the residual is rounding.
// Phase 0 showed errors of this size leave model outputs unchanged (1e-6).
const TOLERANCE = 1e-3;

for (const c of REF.cases) {
  test(`mel matches Essentia's TensorflowInputMusiCNN (${c.samples} samples)`, () => {
    const { frames, data } = melFrames(synth(c.samples));
    assert.equal(frames, c.frames, 'frame count');
    let worst = 0;
    for (let f = 0; f < frames; f++)
      for (let b = 0; b < N_BANDS; b++)
        worst = Math.max(worst, Math.abs(data[f * N_BANDS + b] - c.mel[f][b]));
    assert.ok(worst < TOLERANCE, `max abs error ${worst}`);
  });
}

test('frame count follows FrameGenerator(startFromZero), edge cases included', () => {
  // Measured against Essentia: plain floor(n / 256) is wrong at 100, 255, 512, 768, 8192.
  const essentia = { 0: 0, 100: 1, 255: 1, 256: 1, 257: 1, 300: 1, 511: 1, 512: 1, 513: 2,
                     767: 2, 768: 2, 769: 3, 8192: 31, 48000: 187 };
  for (const [n, k] of Object.entries(essentia)) assert.equal(frameCount(Number(n)), k, `n=${n}`);
});

test('silence gives the floor value, not NaN', () => {
  const { data } = melFrames(new Float32Array(2048));
  assert.ok(data.every(v => v === 0));
});

test('patches are 128-frame windows at hop 62, and too-short clips yield none', () => {
  const frames = 300, data = Float32Array.from({ length: frames * N_BANDS }, (_, i) => i);
  const p = melPatches({ frames, data });
  assert.equal(p.patches, Math.floor((frames - PATCH_FRAMES) / 62) + 1);
  // Patch 1 starts at frame 62.
  assert.equal(p.data[PATCH_FRAMES * N_BANDS], 62 * N_BANDS);
  assert.equal(melPatches({ frames: 127, data: new Float32Array(127 * N_BANDS) }).patches, 0);
});

test('a 30 s preview cuts into the patch count phase 0 measured (29)', () => {
  const frames = frameCount(30 * SAMPLE_RATE);
  assert.equal(melPatches({ frames, data: new Float32Array(frames * N_BANDS) }).patches, 29);
});
