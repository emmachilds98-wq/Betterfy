// Tempo (BPM) from 16 kHz mono audio, in plain JS.
//
// WP-D1 of docs/AUDIO-BUILD-PLAN.md. Isomorphic (no DOM, no Node APIs), no
// dependencies. It reads the same log-mel frames the model does
// (core/audio/mel.mjs), so the worker can get a tempo for the cost of an
// autocorrelation by calling tempoFromMel() on frames it already has.
//
// Pipeline:
//   1. onset strength: spectral flux of the log-mel frames (62.5 frames/s) in
//      four band groups (kick, body, snare, hats), each minus a 1 s moving
//      average, half-wave rectified, lightly smoothed;
//   2. autocorrelation of each group, normalised and averaged: A(lag), to 6 s;
//   3. a comb over the tempo range: comb(T) = mean of A at 1..4 beat periods;
//      local maxima are candidates, each refined to 0.01 BPM with every
//      harmonic that fits in the autocorrelation (that is what buys ±1 BPM at
//      62.5 frames/s);
//   4. score(T) = comb gated by A at the beat period itself (kills 3:2 and
//      2:1 ghosts that only share multiples with the real pulse) × a
//      log-normal tempo prior (120 BPM, σ one octave) × an accent term that
//      marks down a level evenly divided by a faster in-range level (clicks
//      at 174 are not "87 with 8ths").
//
// Octave ambiguity is reported, not averaged away (music-dna.mjs measured()
// treats half/double time as the failure that matters): if the candidate at
// twice or half the winner scores at least OCTAVE_AMBIGUOUS of the winner,
// `octaveAmbiguous` is true and that partner is always in `alternates`. The
// periodicity of a pulse train is genuinely the same at T and T/2; only the
// prior and the accent pattern separate them, and on real music (DnB at
// 87/174, footwork at 80/160) that is often not enough to be sure.
//
// Not measured on real music yet. This ships only with a measured number:
// scripts/audio-dsp/tempo-vs-rekordbox.mjs compares it with Rekordbox on the
// owner's files, and that accuracy goes into AUDIO-ANALYSIS-PLAN.md §0 before
// anything shows or uses these values (WP-D4).

import { melFrames, SAMPLE_RATE, HOP_SIZE, N_BANDS } from '../mel.mjs';

export const TEMPO_VERSION = '1.0.0';

/** Envelope frame rate: one log-mel frame per hop. */
export const FPS = SAMPLE_RATE / HOP_SIZE; // 62.5

/** Partner (×2 or ×½) score at or above this fraction of the winner's: ambiguous. */
export const OCTAVE_AMBIGUOUS = 0.7;

const PRIOR_CENTER = 120;   // BPM; log-normal tempo prior on log2(T)
const PRIOR_SIGMA = 1;      // octaves
const ACCENT_PENALTY = 0.35;
const MAX_LAG_S = 6;        // autocorrelation horizon
const MIN_SECONDS = 4;      // shorter than this: no answer
const SILENCE_RMS = 1e-4;   // about -80 dBFS
const GRID_STEP = 0.25;     // BPM, coarse comb grid
const MAX_ALTERNATES = 4;
const MIN_PERIODICITY = 0.1; // below this the envelope has no beat: no answer

const none = () => ({ bpm: null, confidence: 0, alternates: [], octaveAmbiguous: false, version: TEMPO_VERSION });
const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

/**
 * Estimate tempo from 16 kHz mono samples.
 * Other sample rates are linearly resampled to 16 kHz first (good enough for
 * onset timing; not for the model).
 *
 * @param {Float32Array|number[]} samples contiguous audio (not spliced windows)
 * @param {{ sampleRate?: number, min?: number, max?: number }} [opts]
 * @returns {{ bpm: number|null, confidence: number, alternates: {bpm:number, score:number}[],
 *             octaveAmbiguous: boolean, version: string }}
 *   `confidence` 0–1; `alternates` other tempi, best first, score relative to
 *   the winner's (1 = as good). Silence or too little audio: bpm null, confidence 0.
 */
export function tempo(samples, { sampleRate = SAMPLE_RATE, min = 60, max = 200 } = {}) {
  checkRange(min, max);
  if (!(sampleRate > 0)) throw new RangeError(`sampleRate must be positive, got ${sampleRate}`);
  const x = sampleRate === SAMPLE_RATE ? samples : resample(samples, sampleRate, SAMPLE_RATE);
  if (x.length < MIN_SECONDS * SAMPLE_RATE) return none();
  let ss = 0;
  for (let i = 0; i < x.length; i++) ss += x[i] * x[i];
  if (Math.sqrt(ss / x.length) < SILENCE_RMS) return none();
  return tempoFromMel(melFrames(x), { min, max });
}

/**
 * Same as tempo(), from melFrames() output the caller already has.
 * @param {{ frames: number, data: Float32Array }} mel
 * @param {{ min?: number, max?: number }} [opts]
 */
export function tempoFromMel(mel, { min = 60, max = 200 } = {}) {
  checkRange(min, max);
  if (!mel || mel.frames < MIN_SECONDS * FPS) return none();
  const acf = autocorrelation(onsetEnvelopes(mel), Math.min(Math.round(MAX_LAG_S * FPS), Math.floor(mel.frames / 2)));
  if (!acf) return none();

  const at = lag => interp(acf, lag);
  const lagOf = bpm => 60 * FPS / bpm;
  const maxLag = acf.length - 3;
  // comb over the first `K` beat periods that fit; A below zero counts as zero
  const comb = (bpm, K = 4) => {
    const P = lagOf(bpm);
    const k = Math.min(K, Math.floor(maxLag / P));
    if (k < 1) return -1;
    let s = 0;
    for (let i = 1; i <= k; i++) s += Math.max(0, at(i * P));
    return s / k;
  };
  // fine position: every harmonic that fits, K fixed from the starting point
  const refine = (bpm0, halfWidth) => {
    const K = Math.max(1, Math.floor(maxLag / lagOf(Math.max(min, bpm0 - halfWidth))));
    const lo = Math.max(min, bpm0 - halfWidth), steps = Math.floor((Math.min(max, bpm0 + halfWidth) - lo) / 0.01 + 1e-6);
    let best = bpm0, bestV = -Infinity;
    for (let i = 0; i <= steps; i++) {
      const b = lo + i * 0.01, v = comb(b, K);
      if (v > bestV) { bestV = v; best = b; }
    }
    return best;
  };
  const prior = bpm => Math.exp(-0.5 * (Math.log2(bpm / PRIOR_CENTER) / PRIOR_SIGMA) ** 2);
  // periodicity: the comb, gated by the first period itself. A tempo fills
  // the comb at some lags just by sharing multiples with the real one; if its
  // own beat period shows little self-similarity (120 on clicks at 60, 85 on
  // a 128 kick with off-beat hats) it is not a tempo. Full credit once A(P)
  // reaches half the comb mean, so the gate removes, it does not rank.
  const periodicity = bpm => {
    const c = comb(bpm);
    return c > 0 ? c * Math.min(1, Math.max(0, at(lagOf(bpm)) / (0.5 * c))) : 0;
  };
  // How evenly a faster level d·T (d = 2 or 3) divides this one: A at P/d
  // over A at P. Near 1, this level carries no accent of its own: clicks at
  // 174 are not "87 with 8ths", clicks at 200 are not "66.7 in triplets".
  // Only asked when d·T is itself a tempo this call could answer, since it
  // exists to choose between the two.
  const evenness = bpm => {
    const P = lagOf(bpm), a = at(P);
    let e = 0;
    for (const d of [2, 3]) {
      if (d * bpm > max + 0.01) continue;
      e = Math.max(e, a > 0 ? Math.min(1, Math.max(0, at(P / d)) / a) : 1);
    }
    return e;
  };
  const score = bpm => {
    const c = periodicity(bpm);
    return c > 0 ? c * prior(bpm) * (1 - ACCENT_PENALTY * evenness(bpm)) : 0;
  };

  // coarse grid, local maxima
  const grid = [];
  for (let i = 0; min + i * GRID_STEP <= max + 1e-9; i++) grid.push([min + i * GRID_STEP, comb(min + i * GRID_STEP)]);
  const top = Math.max(...grid.map(g => g[1]));
  if (!(top > 0)) return none();
  const peaks = [];
  for (let i = 0; i < grid.length; i++) {
    const v = grid[i][1];
    if (v < 0.25 * top) continue;
    if (i > 0 && grid[i - 1][1] > v) continue;
    if (i < grid.length - 1 && grid[i + 1][1] >= v) continue;
    peaks.push(grid[i][0]);
  }

  const cands = [];
  const add = bpm => {
    if (bpm < min - 1e-9 || bpm > max + 1e-9) return null;
    const near = cands.find(c => Math.abs(c.bpm - bpm) / bpm < 0.015);
    if (near) return near;
    const c = { bpm, score: score(bpm) };
    cands.push(c);
    return c;
  };
  for (const p of peaks) add(refine(p, 1));
  cands.sort((a, b) => b.score - a.score);
  const best = cands[0];
  if (!best || !(periodicity(best.bpm) > MIN_PERIODICITY)) return none();

  // octave partners, evaluated even when they are not peaks of their own
  const partners = [best.bpm * 2, best.bpm / 2]
    .filter(b => b >= min - 0.01 && b <= max + 0.01)
    .map(b => Math.min(max, Math.max(min, b)))
    .map(b => add(refine(b, b * 0.01)))
    .filter(Boolean);
  const partner = partners.sort((a, b) => b.score - a.score)[0] ?? null;
  const ratio = partner ? partner.score / best.score : 0;
  const octaveAmbiguous = ratio >= OCTAVE_AMBIGUOUS;

  cands.sort((a, b) => b.score - a.score);
  const others = cands.filter(c => c !== best && c.score > 0);
  const alternates = others.slice(0, MAX_ALTERNATES);
  if (octaveAmbiguous && !alternates.includes(partner)) alternates.splice(MAX_ALTERNATES - 1, 1, partner);

  // confidence: how periodic the envelope is at the winner (gated comb, ~0.9
  // for a clean click track, under 0.1 for noise), mapped to 0–1, then
  // discounted by how close the octave partner came (×0.5 when level).
  // Uncalibrated: the Rekordbox comparison is what gives it a meaning.
  const conf = Math.min(1, Math.max(0, (periodicity(best.bpm) - MIN_PERIODICITY) / 0.6)) * (1 - ratio / 2);

  return {
    bpm: round(best.bpm, 1),
    confidence: round(conf, 3),
    alternates: alternates.map(c => ({ bpm: round(c.bpm, 1), score: round(c.score / best.score, 3) })),
    octaveAmbiguous,
    version: TEMPO_VERSION,
  };
}

function checkRange(min, max) {
  if (!(min > 0 && max > min)) throw new RangeError(`need 0 < min < max, got ${min}..${max}`);
}

/** Mel band groups (~0–230 Hz, 230–800 Hz, 0.8–2 kHz, 2–8 kHz): kick, body, snare, hats. */
const BAND_GROUPS = [[0, 7], [7, 24], [24, 52], [52, N_BANDS]];

/**
 * Onset strength per band group and mel frame: positive log-mel flux summed
 * over the group's bands, minus its 1 s moving average, half-wave rectified,
 * smoothed by a 5-tap binomial kernel.
 *
 * Why per group: a kick on the beat and a hat on the off-beat are, summed
 * across the spectrum, just an even pulse at twice the tempo, and that pulse
 * also fits 2/3 of the tempo (85 for a 128 track). Autocorrelating each group
 * separately keeps each instrument's own period and drops the cross terms.
 * @returns {Float64Array[]}
 */
function onsetEnvelopes({ frames, data }) {
  const half = Math.round(FPS / 2);
  const K = [1, 4, 6, 4, 1];
  return BAND_GROUPS.map(([b0, b1]) => {
    const flux = new Float64Array(frames);
    for (let f = 1; f < frames; f++) {
      let s = 0;
      const a = (f - 1) * N_BANDS, b = f * N_BANDS;
      for (let k = b0; k < b1; k++) { const d = data[b + k] - data[a + k]; if (d > 0) s += d; }
      flux[f] = s;
    }
    const cum = new Float64Array(frames + 1);
    for (let f = 0; f < frames; f++) cum[f + 1] = cum[f] + flux[f];
    const rect = new Float64Array(frames);
    for (let f = 0; f < frames; f++) {
      const lo = Math.max(0, f - half), hi = Math.min(frames, f + half + 1);
      rect[f] = Math.max(0, flux[f] - (cum[hi] - cum[lo]) / (hi - lo));
    }
    const out = new Float64Array(frames);
    for (let f = 0; f < frames; f++) {
      let s = 0, w = 0;
      for (let j = -2; j <= 2; j++) {
        const g = f + j;
        if (g >= 0 && g < frames) { s += K[j + 2] * rect[g]; w += K[j + 2]; }
      }
      out[f] = s / w;
    }
    return out;
  });
}

/**
 * Unbiased autocorrelation of each mean-removed envelope, normalised per
 * group to 1 at lag 0, then averaged with equal weight. Equal, not by
 * variance: on log-mel flux the hats have the most variance, and weighting
 * by it hands the answer to the hat pulse, which fits every multiple of the
 * half-beat (174 heard as 116). A group with almost no onset activity (under
 * 1e-3 of the busiest) is left out rather than amplified. Null when all are flat.
 */
function autocorrelation(envs, maxLag) {
  const n = envs[0].length;
  if (maxLag < 4) return null;
  const x = new Float64Array(n);
  const per = envs.map(env => {
    let mean = 0;
    for (let i = 0; i < n; i++) mean += env[i];
    mean /= n;
    for (let i = 0; i < n; i++) x[i] = env[i] - mean;
    const r = new Float64Array(maxLag + 1);
    for (let lag = 0; lag <= maxLag; lag++) {
      let s = 0;
      for (let i = 0; i + lag < n; i++) s += x[i] * x[i + lag];
      r[lag] = s / (n - lag);
    }
    return r;
  });
  const top = Math.max(...per.map(r => r[0]));
  if (!(top > 1e-12)) return null;
  const used = per.filter(r => r[0] > 1e-3 * top);
  const acf = new Float64Array(maxLag + 1);
  for (const r of used) for (let lag = 0; lag <= maxLag; lag++) acf[lag] += r[lag] / r[0] / used.length;
  return acf;
}

/** Catmull-Rom interpolation of `a` at fractional index `x`. */
function interp(a, x) {
  const i = Math.floor(x), t = x - i;
  const p0 = a[Math.max(0, i - 1)], p1 = a[i], p2 = a[Math.min(a.length - 1, i + 1)], p3 = a[Math.min(a.length - 1, i + 2)];
  return p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
}

function resample(x, from, to) {
  const n = Math.floor(x.length * to / from), out = new Float32Array(n), r = from / to;
  for (let i = 0; i < n; i++) {
    const p = i * r, j = Math.floor(p), t = p - j;
    out[i] = j + 1 < x.length ? x[j] * (1 - t) + x[j + 1] * t : x[Math.min(j, x.length - 1)];
  }
  return out;
}
