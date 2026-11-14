// Loudness and "energy" for a 30-second preview, in plain JS.
//
// This is a HEURISTIC, not a measurement standard. It borrows the shape of
// EBU R128 / ITU-R BS.1770 loudness (K-weighting, 400 ms blocks with 75 %
// overlap, 3 s short-term windows, absolute -70 and relative -10 LU gates),
// but it is not a compliant meter and its numbers are "LUFS-like", not LUFS:
//   - it runs on 16 kHz mono, so everything above 8 kHz is gone, and the
//     K-weighting filters are re-derived for 16 kHz from analogue-style
//     parameters (BS.1770 specifies coefficients at 48 kHz only);
//   - the input is a decoded, resampled lossy preview, not the master;
//   - no channel weighting, no true-peak, no conformance test signals.
// Spectral centroid and onset density are ordinary textbook descriptors.
// `energy` is a hand-picked blend of the three (formula at ENERGY below),
// meant only to rank tracks against each other within one library. It has
// not been fitted to listener judgements and is not Spotify's "energy".
//
// Isomorphic — no DOM, no Node APIs, no dependencies — so the browser worker
// and Node scripts share it. The STFT uses the mel front end's frame and hop
// (512 / 256), so onsets live on the same frame grid as the rest of the
// audio pipeline.

import { SAMPLE_RATE, FRAME_SIZE, HOP_SIZE } from '../mel.mjs';

export const LOUDNESS_VERSION = '1.0.0';

// Floors keep every output finite (JSON-safe: no -Infinity, no NaN).
const RMS_FLOOR_DB = -120;
const LUFS_FLOOR = -70; // BS.1770's absolute gate; quieter counts as silence
const LUFS_OFFSET = -0.691; // BS.1770's constant, kept so numbers look familiar

const BLOCK_S = 0.4, BLOCK_STEP_S = 0.1, SHORT_TERM_S = 3;

// ---------------------------------------------------------------------------
// K-weighting: two RBJ biquads with the parameters pyloudnorm uses to
// approximate BS.1770's stage 1 (high shelf, +4 dB above ~1.5 kHz) and
// stage 2 (RLB high-pass, ~38 Hz) at an arbitrary sample rate.

function highShelf(fs, fc = 1500, gainDb = 4, Q = Math.SQRT1_2) {
  const A = 10 ** (gainDb / 40), w0 = 2 * Math.PI * fc / fs, cs = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Q), sA = 2 * Math.sqrt(A) * alpha;
  const a0 = (A + 1) - (A - 1) * cs + sA;
  return [
    A * ((A + 1) + (A - 1) * cs + sA) / a0,
    -2 * A * ((A - 1) + (A + 1) * cs) / a0,
    A * ((A + 1) + (A - 1) * cs - sA) / a0,
    2 * ((A - 1) - (A + 1) * cs) / a0,
    ((A + 1) - (A - 1) * cs - sA) / a0,
  ];
}

function highPass(fs, fc = 38, Q = 0.5) {
  const w0 = 2 * Math.PI * fc / fs, cs = Math.cos(w0), alpha = Math.sin(w0) / (2 * Q);
  const a0 = 1 + alpha;
  return [(1 + cs) / 2 / a0, -(1 + cs) / a0, (1 + cs) / 2 / a0, -2 * cs / a0, (1 - alpha) / a0];
}

/** Prefix sums of the K-weighted signal's squares: cum[i] = Σ_{j<i} k[j]². */
function kWeightedEnergyPrefix(x, fs) {
  const [b0, b1, b2, a1, a2] = highShelf(fs);
  const [c0, c1, c2, d1, d2] = highPass(fs);
  const cum = new Float64Array(x.length + 1);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0, z1 = 0, z2 = 0, acc = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const y = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = xi;
    const z = c0 * y + c1 * y1 + c2 * y2 - d1 * z1 - d2 * z2;
    y2 = y1; y1 = y; z2 = z1; z1 = z;
    acc += z * z;
    cum[i + 1] = acc;
  }
  return cum;
}

const toLufs = ms => (ms > 0 ? LUFS_OFFSET + 10 * Math.log10(ms) : -Infinity);

/** Mean squares of windows of `len` samples every `step` samples (one window if the clip is shorter). */
function windowMeans(cum, len, step) {
  const n = cum.length - 1;
  if (n === 0) return [];
  if (n <= len) return [cum[n] / n];
  const out = [];
  for (let s = 0; s + len <= n; s += step) out.push((cum[s + len] - cum[s]) / len);
  return out;
}

/** BS.1770-style gated integration over 400 ms block mean squares. */
function gatedIntegrated(blocks) {
  const abs = blocks.filter(ms => toLufs(ms) > LUFS_FLOOR);
  if (!abs.length) return LUFS_FLOOR;
  const relGate = toLufs(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const rel = abs.filter(ms => toLufs(ms) > relGate);
  return Math.max(LUFS_FLOOR, toLufs(rel.reduce((a, b) => a + b, 0) / rel.length));
}

// ---------------------------------------------------------------------------
// STFT (frame 512, hop 256, periodic Hann), magnitude spectra only. Own FFT:
// mel.mjs keeps its FFT private and is a frozen contract.

const N_BINS = FRAME_SIZE / 2 + 1;
const M = FRAME_SIZE / 2; // real FFT of N via one complex FFT of N/2
const LOG2M = Math.log2(M);
const HANN = Float64Array.from({ length: FRAME_SIZE }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / FRAME_SIZE));
const BITREV = Uint16Array.from({ length: M }, (_, i) => {
  let r = 0; for (let b = 0; b < LOG2M; b++) r |= ((i >> b) & 1) << (LOG2M - 1 - b); return r;
});
// Twiddles e^{-2πik/N}, k < N/2: the M-point FFT uses every other one.
const COS = Float64Array.from({ length: M }, (_, i) => Math.cos(2 * Math.PI * i / FRAME_SIZE));
const SIN = Float64Array.from({ length: M }, (_, i) => -Math.sin(2 * Math.PI * i / FRAME_SIZE));

/** |X[k]|, k = 0..N/2, of one real windowed frame `x` (length N). */
function magnitudeSpectrum(x, re, im, out) {
  for (let i = 0; i < M; i++) { const j = BITREV[i]; re[j] = x[2 * i]; im[j] = x[2 * i + 1]; }
  for (let size = 2; size <= M; size <<= 1) {
    const half = size >> 1, step = (FRAME_SIZE / size);
    for (let s = 0; s < M; s += size) {
      for (let k = 0; k < half; k++) {
        const c = COS[k * step], sn = SIN[k * step];
        const a = s + k, b = a + half;
        const tr = re[b] * c - im[b] * sn, ti = re[b] * sn + im[b] * c;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
  // Split Z (the packed even/odd FFT) into X: X[k] = E[k] + W^k O[k].
  for (let k = 0; k <= M; k++) {
    const p = k % M, q = (M - k) % M;
    const a = re[p], b = im[p], c = re[q], d = im[q];
    const er = (a + c) / 2, ei = (b - d) / 2, or = (b + d) / 2, oi = (c - a) / 2;
    const wr = k < M ? COS[k] : -1, wi = k < M ? SIN[k] : 0;
    const xr = er + wr * or - wi * oi, xi = ei + wr * oi + wi * or;
    out[k] = Math.sqrt(xr * xr + xi * xi);
  }
}

// ---------------------------------------------------------------------------
// Onsets: log-compressed spectral flux, then peaks above an adaptive
// threshold (local median + a multiple of the track's own flux spread).

const FLUX_GAMMA = 100;     // log(1 + γ|X|) compression
const MEDIAN_HALF_S = 0.15; // local median window, each side
const PEAK_HALF_S = 0.05;   // a peak must be the max within ±50 ms
const MIN_GAP_S = 0.05;     // and at least 50 ms after the previous onset
const SPREAD_K = 6;         // threshold = local median + K · the track's flux MAD
const REL_FLOOR = 0.1;      // and at least 10 % of the track's strongest flux
// and an absolute floor: on average every bin must rise by ≥0.05 (log units).
// Steady tones wobble far below this (a 30 s sine peaks under 4); a
// broadband hit clears it many times over.
const ABS_FLOOR = 0.05 * N_BINS;

function median(arr) {
  const s = Float64Array.from(arr).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function countOnsets(flux, fps) {
  const n = flux.length;
  if (n < 3) return 0;
  let max = 0;
  for (let i = 0; i < n; i++) if (flux[i] > max) max = flux[i];
  if (max < ABS_FLOOR) return 0;
  const med = median(flux);
  const spread = median(Array.from(flux, v => Math.abs(v - med))) || 1e-9;
  const mh = Math.max(1, Math.round(MEDIAN_HALF_S * fps));
  const ph = Math.max(1, Math.round(PEAK_HALF_S * fps));
  const gap = Math.max(1, Math.round(MIN_GAP_S * fps));
  const floor = Math.max(ABS_FLOOR, REL_FLOOR * max);
  let count = 0, last = -Infinity;
  const win = [];
  for (let t = 0; t < n; t++) {
    const v = flux[t];
    if (v < floor) continue;
    let isPeak = true;
    for (let j = Math.max(0, t - ph); j <= Math.min(n - 1, t + ph); j++) {
      if (flux[j] > v || (flux[j] === v && j < t)) { isPeak = false; break; }
    }
    if (!isPeak || t - last < gap) continue;
    win.length = 0;
    for (let j = Math.max(0, t - mh); j <= Math.min(n - 1, t + mh); j++) win.push(flux[j]);
    if (v > median(win) + SPREAD_K * spread) { count++; last = t; }
  }
  return count;
}

// ---------------------------------------------------------------------------
// ENERGY = 0.5·L + 0.25·C + 0.25·O, each term clamped to 0–1:
//   L = (loudness + 45) / 40      -45 LUFS-like → 0, -5 → 1
//   C = log2(centroid / 250) / 4  250 Hz → 0, 4 kHz → 1
//   O = onsetDensity / 8          8 onsets per second or more → 1
// Loudness dominates because it is the most robust of the three on a lossy
// preview; brightness and onset rate separate "loud but smooth" from "loud
// and busy". A silent clip (loudness at the -70 floor) is 0.

const clamp01 = v => (v > 1 ? 1 : v > 0 ? v : 0);
export const ENERGY_WEIGHTS = Object.freeze({ loudness: 0.5, centroid: 0.25, onsets: 0.25 });

export function energyFrom({ loudness, centroidHz, onsetDensity }) {
  if (loudness <= LUFS_FLOOR) return 0;
  const L = clamp01((loudness + 45) / 40);
  const C = centroidHz > 0 ? clamp01(Math.log2(centroidHz / 250) / 4) : 0;
  const O = clamp01(onsetDensity / 8);
  return ENERGY_WEIGHTS.loudness * L + ENERGY_WEIGHTS.centroid * C + ENERGY_WEIGHTS.onsets * O;
}

const round = (v, d) => { const p = 10 ** d; return Math.round(v * p) / p; };

/**
 * Loudness, brightness, onset rate and a blended energy for mono audio.
 * @param {Float32Array|number[]} samples  mono, normally 16 kHz
 * @param {{ sampleRate?: number }} [opts]
 * @returns {{ rmsDb: number, loudness: number, shortTermMax: number,
 *   centroidHz: number, onsetDensity: number, energy: number, version: string }}
 *   loudness is the gated integrated LUFS-like value; shortTermMax the
 *   loudest 3 s window; all values finite, rounded for stable storage.
 */
export function loudness(samples, { sampleRate = SAMPLE_RATE } = {}) {
  const n = samples.length;
  const seconds = n / sampleRate;

  // RMS of the raw signal.
  let sq = 0;
  for (let i = 0; i < n; i++) sq += samples[i] * samples[i];
  const rmsDb = n && sq > 0 ? Math.max(RMS_FLOOR_DB, 10 * Math.log10(sq / n)) : RMS_FLOOR_DB;

  // K-weighted, gated loudness.
  const cum = kWeightedEnergyPrefix(samples, sampleRate);
  const step = Math.round(BLOCK_STEP_S * sampleRate);
  const blocks = windowMeans(cum, Math.round(BLOCK_S * sampleRate), step);
  const integrated = gatedIntegrated(blocks);
  const shortTerm = windowMeans(cum, Math.round(SHORT_TERM_S * sampleRate), step);
  const shortTermMax = shortTerm.length ? Math.max(LUFS_FLOOR, toLufs(Math.max(...shortTerm))) : LUFS_FLOOR;

  // STFT pass: centroid of the long-term magnitude spectrum, and flux.
  const frames = n >= FRAME_SIZE ? Math.floor((n - FRAME_SIZE) / HOP_SIZE) + 1 : (n > 0 ? 1 : 0);
  const frame = new Float64Array(FRAME_SIZE), re = new Float64Array(M), im = new Float64Array(M);
  let mag = new Float64Array(N_BINS), prev = new Float64Array(N_BINS);
  const flux = new Float64Array(frames);
  const binHz = sampleRate / FRAME_SIZE;
  let num = 0, den = 0;
  for (let f = 0; f < frames; f++) {
    const s = f * HOP_SIZE;
    for (let i = 0; i < FRAME_SIZE; i++) frame[i] = (s + i < n ? samples[s + i] : 0) * HANN[i];
    magnitudeSpectrum(frame, re, im, mag);
    let fl = 0;
    for (let k = 0; k < N_BINS; k++) {
      const m = mag[k];
      num += k * binHz * m; den += m;
      const c = Math.log1p(FLUX_GAMMA * m);
      prev[k] = c - prev[k]; // reuse prev as scratch: diff, then swap below
      if (f > 0 && prev[k] > 0) fl += prev[k];
      prev[k] = c;
    }
    flux[f] = fl;
  }
  const centroidHz = den > 1e-12 ? num / den : 0;
  const onsetDensity = seconds > 0 ? countOnsets(flux, sampleRate / HOP_SIZE) / seconds : 0;

  const out = {
    rmsDb: round(rmsDb, 2),
    loudness: round(integrated, 2),
    shortTermMax: round(shortTermMax, 2),
    centroidHz: round(centroidHz, 1),
    onsetDensity: round(onsetDensity, 3),
  };
  out.energy = round(energyFrom({ loudness: integrated, centroidHz, onsetDensity }), 4);
  out.version = LOUDNESS_VERSION;
  return out;
}
