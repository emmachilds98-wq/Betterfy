// The mel front end for Discogs-EffNet, in plain JS.
//
// The model only understands the exact features Essentia's
// TensorflowInputMusiCNN produces. A front end that is "roughly right" still
// returns plausible-looking styles, just worse ones, and nothing downstream
// would notice. So this file is held to Essentia's own output by
// test/mel.test.mjs (fixture: scripts/audio-phase0/make-mel-fixture.py), and
// any change here has to keep that test green.
//
// Written from scratch rather than shipping essentia.js: that is AGPL-3.0 and
// unmaintained since 2022 (docs/AUDIO-ANALYSIS-PLAN.md §2). Isomorphic — no
// DOM, no Node APIs — so the browser worker and Node scripts share it.
//
// Settings, each confirmed against Essentia (phase 0, §0 of the plan):
//   16 kHz mono · frame 512 · hop 256 · Hann (symmetric, not normalised)
//   · |rfft| · power · 96 Slaney-mel bands, unit-area triangles, 0–8 kHz
//   · log10(1 + 10000·x) · patches of 128 frames, hop 62.

export const MEL_VERSION = '1.0.0';
export const SAMPLE_RATE = 16000;
export const FRAME_SIZE = 512;
export const HOP_SIZE = 256;
export const N_BANDS = 96;
export const PATCH_FRAMES = 128;
export const PATCH_HOP = 62;

const N_BINS = FRAME_SIZE / 2 + 1;

// --- Slaney mel scale (Auditory Toolbox): linear below 1 kHz, log above. ---
const LOG_STEP = Math.log(6.4) / 27;
const hzToMel = f => (f < 1000 ? f / (200 / 3) : 15 + Math.log(f / 1000) / LOG_STEP);
const melToHz = m => (m < 15 ? m * (200 / 3) : 1000 * Math.exp((m - 15) * LOG_STEP));

/** Sparse triangular filterbank: one { start, w } per band. */
function buildFilterbank() {
  const lo = hzToMel(0), hi = hzToMel(SAMPLE_RATE / 2);
  const edges = Array.from({ length: N_BANDS + 2 }, (_, i) => melToHz(lo + (hi - lo) * i / (N_BANDS + 1)));
  const bands = [];
  for (let b = 0; b < N_BANDS; b++) {
    const [l, c, r] = [edges[b], edges[b + 1], edges[b + 2]];
    const area = 2 / (r - l); // unit_tri: every triangle has unit area
    let start = -1; const w = [];
    for (let k = 0; k < N_BINS; k++) {
      const f = k * SAMPLE_RATE / FRAME_SIZE;
      const v = Math.max(0, Math.min((f - l) / (c - l), (r - f) / (r - c)));
      if (v > 0) { if (start < 0) start = k; w[k - start] = v * area; }
      else if (start >= 0) break;
    }
    bands.push({ start: Math.max(start, 0), w: Float64Array.from(w) });
  }
  return bands;
}

const HANN = Float64Array.from({ length: FRAME_SIZE }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (FRAME_SIZE - 1)));
const FILTERS = buildFilterbank();

// --- radix-2 FFT, sized for one 512-sample frame ---
const LOG2 = Math.log2(FRAME_SIZE);
const BITREV = Uint16Array.from({ length: FRAME_SIZE }, (_, i) => {
  let r = 0; for (let b = 0; b < LOG2; b++) r |= ((i >> b) & 1) << (LOG2 - 1 - b); return r;
});
const COS = Float64Array.from({ length: FRAME_SIZE / 2 }, (_, i) => Math.cos(2 * Math.PI * i / FRAME_SIZE));
const SIN = Float64Array.from({ length: FRAME_SIZE / 2 }, (_, i) => -Math.sin(2 * Math.PI * i / FRAME_SIZE));

/** Power spectrum |X[k]|² for k = 0..N/2 of one windowed frame, in place of re/im scratch. */
function powerSpectrum(re, im, out) {
  for (let i = 0; i < FRAME_SIZE; i++) {
    const j = BITREV[i];
    if (j > i) { const t = re[i]; re[i] = re[j]; re[j] = t; }
    im[i] = 0;
  }
  for (let size = 2; size <= FRAME_SIZE; size <<= 1) {
    const half = size >> 1, step = FRAME_SIZE / size;
    for (let s = 0; s < FRAME_SIZE; s += size) {
      for (let k = 0; k < half; k++) {
        const c = COS[k * step], sn = SIN[k * step];
        const a = s + k, b = a + half;
        const tr = re[b] * c - im[b] * sn, ti = re[b] * sn + im[b] * c;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
  for (let k = 0; k < N_BINS; k++) out[k] = re[k] * re[k] + im[k] * im[k];
}

/**
 * Number of frames Essentia's FrameGenerator (startFromZero) yields for
 * `n` samples: a frame at start s while s === 0 or s + hop < n. Pinned
 * against Essentia for 13 lengths, including the edge cases plain
 * floor(n / hop) gets wrong (512, 768, 8192).
 */
export function frameCount(n) {
  if (n <= 0) return 0;
  return Math.max(1, Math.ceil((n - HOP_SIZE) / HOP_SIZE));
}

/**
 * 16 kHz mono samples -> log-mel frames.
 * @param {Float32Array|number[]} samples
 * @returns {{ frames: number, data: Float32Array }} row-major [frames × 96]
 */
export function melFrames(samples) {
  const n = samples.length, frames = frameCount(n);
  const data = new Float32Array(frames * N_BANDS);
  const re = new Float64Array(FRAME_SIZE), im = new Float64Array(FRAME_SIZE), pow = new Float64Array(N_BINS);
  for (let f = 0; f < frames; f++) {
    const s = f * HOP_SIZE;
    for (let i = 0; i < FRAME_SIZE; i++) re[i] = (s + i < n ? samples[s + i] : 0) * HANN[i];
    powerSpectrum(re, im, pow);
    for (let b = 0; b < N_BANDS; b++) {
      const { start, w } = FILTERS[b];
      let e = 0;
      for (let k = 0; k < w.length; k++) e += w[k] * pow[start + k];
      data[f * N_BANDS + b] = Math.log10(1 + 10000 * e);
    }
  }
  return { frames, data };
}

/**
 * Log-mel frames -> the model's input patches [n × 128 × 96], hop 62 frames,
 * as TensorflowPredictEffnetDiscogs cuts them. A clip shorter than one patch
 * yields none — too little audio to judge, not a zero answer.
 * @returns {{ patches: number, data: Float32Array }}
 */
export function melPatches({ frames, data }) {
  if (frames < PATCH_FRAMES) return { patches: 0, data: new Float32Array(0) };
  const patches = Math.floor((frames - PATCH_FRAMES) / PATCH_HOP) + 1;
  const size = PATCH_FRAMES * N_BANDS;
  const out = new Float32Array(patches * size);
  for (let p = 0; p < patches; p++) out.set(data.subarray(p * PATCH_HOP * N_BANDS, p * PATCH_HOP * N_BANDS + size), p * size);
  return { patches, data: out };
}
