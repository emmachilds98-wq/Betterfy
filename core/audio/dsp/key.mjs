// Musical key from audio, in plain JS (WP-D2, docs/AUDIO-BUILD-PLAN.md).
//
// 16 kHz mono samples -> a key, a Camelot code and a confidence. Isomorphic:
// no DOM, no Node APIs, no dependencies, so the browser worker and Node
// scripts share it. Written from scratch; the clean key library is AGPL
// (essentia.js), which the page can't ship (AUDIO-ANALYSIS-PLAN.md §2, §9).
//
// Status: the synthetic tests (test/audiokey.test.mjs) pass. Accuracy on
// real music is NOT measured yet. scripts/audio-dsp/key-vs-rekordbox.mjs
// measures it against the owner's Rekordbox keys, and per the build plan's
// §0 rule 7 this ships into records or the UI (WP-D4) only with that number.
//
// Pipeline:
//   1. STFT with a long frame (8192 at 16 kHz ≈ 0.5 s, 1.95 Hz per bin), so
//      neighbouring semitones are resolvable down to ~60 Hz. mel.mjs's 512
//      frame is far too short for pitch (31 Hz per bin).
//   2. Spectral peaks only: a local maximum that stands TONAL_SNR above the
//      local mean magnitude and within 60 dB of the frame's loudest bin (so
//      window sidelobes don't count). This is the whitening step: broadband drums and
//      noise rarely make a peak, and the bass doesn't drown the treble
//      because each peak is weighted by how far it stands above its own
//      neighbourhood (log ratio), not by raw energy.
//   3. Tuning: the weighted circular mean of every peak's offset from the
//      A440 grid. Records tuned off 440 (or pitched by a DJ) still map
//      cleanly. After correcting, a peak more than TUNING_TOLERANCE semitones
//      from a note is dropped (inharmonic partials, glides, noise).
//   4. Chroma: each surviving peak adds to its pitch class, cos²-tapered by
//      its distance from the note centre. Summed over all frames.
//   5. Profiles: Pearson correlation of the chroma with the Krumhansl–Kessler
//      and Temperley major/minor profiles rotated to all 12 tonics; the two
//      correlations are averaged per key.
//   6. Confidence: a heuristic, not a probability. It is the product of how
//      tonal the excerpt is ("gridness": how tightly the peaks sit on one
//      semitone grid, the length of step 3's circular mean, ~0.75 for
//      harmonic tones and ~0.03 for noise, whose peaks land anywhere), how
//      well the best key fits, and how far it leads the runner-up. Silence -> 0 and
//      key null; noise -> a guess with near-zero confidence. Its calibration
//      against real keys is what the comparison script reports by band.

import { SAMPLE_RATE } from '../mel.mjs';

export const KEY_VERSION = '1.0.0';

// ---------- names, Camelot, Open Key ----------

/** Pitch-class spellings. Majors and minors follow the usual Camelot-wheel spelling. */
const MAJOR_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const MINOR_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'];
const PC_OF = { C: 0, 'B#': 0, 'C#': 1, DB: 1, D: 2, 'D#': 3, EB: 3, E: 4, FB: 4, F: 5, 'E#': 5, 'F#': 6, GB: 6,
                G: 7, 'G#': 8, AB: 8, A: 9, 'A#': 10, BB: 10, B: 11, CB: 11 };

/** Pitch class (0 = C) of a tonic spelled 'C', 'F#', 'Eb', 'E♭', 'bb'…; null if unreadable. */
export function pitchClass(tonic) {
  if (typeof tonic === 'number') return Number.isInteger(tonic) ? ((tonic % 12) + 12) % 12 : null;
  if (typeof tonic !== 'string') return null;
  const s = tonic.trim().replace(/♯/g, '#').replace(/♭/g, 'b');
  if (!s) return null;
  return PC_OF[s[0].toUpperCase() + s.slice(1).toUpperCase()] ?? null;
}

const camelotNumber = (pc, mode) => {
  const majorPc = mode === 'minor' ? (pc + 3) % 12 : pc;   // a minor key sits on its relative major's number
  return ((majorPc * 7) % 12 + 7) % 12 + 1;                // C major = 8, each fifth up = +1
};

/**
 * Camelot code ('8A' = A minor, '8B' = C major) for a tonic and mode.
 * Accepts sharps or flats; mode is 'major' | 'minor' (also 'maj'/'min'/'m').
 * Returns null for anything unreadable rather than guessing.
 */
export function toCamelot(tonic, mode) {
  const pc = pitchClass(tonic);
  const m = normMode(mode);
  if (pc == null || !m) return null;
  return camelotNumber(pc, m) + (m === 'minor' ? 'A' : 'B');
}

/** Open Key code ('1m' = A minor, '1d' = C major) for a tonic and mode. */
export function toOpenKey(tonic, mode) {
  const c = toCamelot(tonic, mode);
  if (!c) return null;
  const n = parseInt(c, 10);
  return (((n - 8) % 12 + 12) % 12 + 1) + (c.endsWith('A') ? 'm' : 'd');
}

function normMode(mode) {
  const m = String(mode ?? '').trim().toLowerCase();
  if (m === 'major' || m === 'maj' || m === 'ionian') return 'major';
  if (m === 'minor' || m === 'min' || m === 'm' || m === 'aeolian') return 'minor';
  return null;
}

/**
 * All 24 keys, by Camelot code:
 *   CAMELOT['8A'] = { camelot: '8A', openKey: '1m', tonic: 'A', mode: 'minor', pc: 9, key: 'A minor' }
 * Frozen.
 */
export const CAMELOT = Object.freeze(Object.fromEntries(
  ['major', 'minor'].flatMap(mode => Array.from({ length: 12 }, (_, pc) => {
    const tonic = (mode === 'major' ? MAJOR_NAMES : MINOR_NAMES)[pc];
    const camelot = toCamelot(pc, mode);
    return [camelot, Object.freeze({ camelot, openKey: toOpenKey(pc, mode), tonic, mode, pc, key: `${tonic} ${mode}` })];
  })),
));

/**
 * How key b relates to key a on the Camelot wheel, or null if not a
 * neighbour: 'same', 'relative' (same number, other letter), 'fifth-up'
 * (+1, same letter), 'fifth-down' (−1, same letter), 'parallel' (same tonic,
 * other mode). Codes are Camelot strings.
 */
export function relation(a, b) {
  const A = CAMELOT[a], B = CAMELOT[b];
  if (!A || !B) return null;
  if (a === b) return 'same';
  const na = parseInt(a, 10), nb = parseInt(b, 10), la = a.slice(-1), lb = b.slice(-1);
  if (na === nb) return 'relative';
  if (la === lb && nb === na % 12 + 1) return 'fifth-up';
  if (la === lb && na === nb % 12 + 1) return 'fifth-down';
  if (A.pc === B.pc) return 'parallel';
  return null;
}

// ---------- key profiles ----------

// Krumhansl & Kessler (1982) probe-tone ratings.
const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
// Temperley (1999), "What's key for key?": the revised probe-tone profiles.
const TP_MAJOR = [5.0, 2.0, 3.5, 2.0, 4.5, 4.0, 2.0, 4.5, 2.0, 3.5, 1.5, 4.0];
const TP_MINOR = [5.0, 2.0, 3.5, 4.5, 2.0, 4.0, 2.0, 4.5, 3.5, 2.0, 1.5, 4.0];

export const PROFILES = Object.freeze({
  krumhansl: { major: KK_MAJOR, minor: KK_MINOR },
  temperley: { major: TP_MAJOR, minor: TP_MINOR },
});

// ---------- analysis settings ----------

const FRAME_SECONDS = 0.512;     // 8192 samples at 16 kHz
const HOP_FRACTION = 0.25;       // hop 2048: ~7.8 frames per second
const F_MIN = 60;                // below this a semitone is under two bins wide
const F_MAX = 5000;              // above this, partials are mostly overtones and cymbals
const DYNAMIC_RANGE = 10 ** (-60 / 20); // ignore anything 60 dB under the frame's loudest bin (window sidelobes)
const TONAL_SNR = 3;             // a peak must stand this many times above its local mean
const FLOOR_HALF_WIDTH_HZ = 40;  // half-width of the local-mean window
const TUNING_TOLERANCE = 0.4;    // semitones from the nearest note, after tuning
const SILENCE = 1e-4;            // RMS below this (−80 dBFS) is silence
const A4 = 440;

// Confidence shaping (see the header; uncalibrated until measured).
const GRID_NONE = 0.08;          // gridness at or below which the excerpt counts as atonal (noise measures ~0.03)
const GRID_FULL = 0.33;          // gridness at which it counts as fully tonal (synthetic chords ~0.75)
const FIT_LOW = 0.2, FIT_HIGH = 0.75;
const MARGIN_FULL = 0.12;

// ---------- FFT ----------

const fftCache = new Map();
function fftTables(n) {
  let t = fftCache.get(n);
  if (t) return t;
  const bits = Math.log2(n);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = -Math.sin(2 * Math.PI * i / n); }
  const hann = Float64Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n));
  t = { rev, cos, sin, hann };
  fftCache.set(n, t);
  return t;
}

/** In-place radix-2 complex FFT; magnitudes of bins 0..n/2 into `mag`. */
function magnitudeSpectrum(re, im, n, { rev, cos, sin }, mag) {
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) { const t = re[i]; re[i] = re[j]; re[j] = t; }
    im[i] = 0;
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let s = 0; s < n; s += size) {
      for (let k = 0; k < half; k++) {
        const c = cos[k * step], sn = sin[k * step];
        const a = s + k, b = a + half;
        const tr = re[b] * c - im[b] * sn, ti = re[b] * sn + im[b] * c;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
  for (let k = 0; k <= n / 2; k++) mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
}

// ---------- chroma ----------

/**
 * Tuning-corrected 12-bin chroma (index 0 = C) plus what confidence needs.
 * Exported for tests and the comparison script; key() is the public entry.
 * @returns {{ chroma: Float64Array, tuningCents: number, seconds: number, tonalWeight: number, gridness: number, frames: number }}
 */
export function chromagram(samples, { sampleRate = SAMPLE_RATE } = {}) {
  const n = samples?.length ?? 0;
  const N = 2 ** Math.round(Math.log2(sampleRate * FRAME_SECONDS));
  const hop = Math.max(1, Math.round(N * HOP_FRACTION));
  const seconds = n / sampleRate;
  const chroma = new Float64Array(12);
  const empty = { chroma, tuningCents: 0, seconds, tonalWeight: 0, gridness: 0, frames: 0 };
  if (!n) return empty;

  const tables = fftTables(N);
  const binHz = sampleRate / N;
  const kMin = Math.max(2, Math.ceil(F_MIN / binHz));
  const kMax = Math.min(N / 2 - 2, Math.floor(Math.min(F_MAX, sampleRate / 2 * 0.95) / binHz));
  const halfW = Math.max(4, Math.round(FLOOR_HALF_WIDTH_HZ / binHz));
  const re = new Float64Array(N), im = new Float64Array(N), mag = new Float64Array(N / 2 + 1);
  const prefix = new Float64Array(N / 2 + 2);

  // Pass 1: peaks (semitones above A4, weight) from every non-silent frame.
  const semis = [], weights = [];
  const frames = n <= N ? 1 : Math.ceil((n - N) / hop) + 1;
  for (let f = 0; f < frames; f++) {
    const s = f * hop;
    let energy = 0;
    for (let i = 0; i < N; i++) {
      const x = s + i < n ? samples[s + i] : 0;
      energy += x * x;
      re[i] = x * tables.hann[i];
    }
    if (Math.sqrt(energy / Math.min(N, n - s)) < SILENCE) continue;
    magnitudeSpectrum(re, im, N, tables, mag);
    prefix[0] = 0;
    let top = 0;
    for (let k = 0; k <= N / 2; k++) { prefix[k + 1] = prefix[k] + mag[k]; if (k >= kMin && k <= kMax && mag[k] > top) top = mag[k]; }
    const absFloor = top * DYNAMIC_RANGE;
    for (let k = kMin; k <= kMax; k++) {
      const m = mag[k];
      if (!(m > absFloor && m > mag[k - 1] && m >= mag[k + 1] && m > mag[k - 2] && m >= mag[k + 2])) continue;
      const lo = Math.max(0, k - halfW), hi = Math.min(N / 2, k + halfW);
      const floor = (prefix[hi + 1] - prefix[lo]) / (hi - lo + 1);
      if (!(floor > 0) || m < TONAL_SNR * floor) continue;
      // Quadratic interpolation on log magnitude for the true peak frequency.
      const a = Math.log(mag[k - 1] + 1e-12), b = Math.log(m + 1e-12), c = Math.log(mag[k + 1] + 1e-12);
      const den = a - 2 * b + c;
      const p = den < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / den)) : 0;
      const hz = (k + p) * binHz;
      semis.push(12 * Math.log2(hz / A4));
      weights.push(Math.log(m / floor));   // ≥ log(TONAL_SNR) > 0
    }
  }
  if (!semis.length) return { ...empty, frames };

  // Tuning: weighted circular mean of each peak's offset from the A440 grid.
  let cs = 0, sn = 0;
  for (let i = 0; i < semis.length; i++) {
    const ang = 2 * Math.PI * semis[i];
    cs += weights[i] * Math.cos(ang); sn += weights[i] * Math.sin(ang);
  }
  const tuning = Math.atan2(sn, cs) / (2 * Math.PI);  // semitones, −0.5..0.5
  let total = 0;
  for (let i = 0; i < weights.length; i++) total += weights[i];
  // How tightly the peaks sit on one semitone grid: ~1 for tuned instruments,
  // ~1/√peaks for noise, whose peaks land anywhere.
  const gridness = Math.hypot(cs, sn) / total;

  // Pass 2: fold into pitch classes, cos²-tapered, dropping off-grid peaks.
  let tonalWeight = 0;
  for (let i = 0; i < semis.length; i++) {
    const x = semis[i] - tuning;
    const note = Math.round(x), d = x - note;
    if (Math.abs(d) > TUNING_TOLERANCE) continue;
    const w = weights[i] * Math.cos(Math.PI * d) ** 2;
    chroma[(((note + 9) % 12) + 12) % 12] += w;   // A = 9
    tonalWeight += w;
  }
  return { chroma, tuningCents: Math.round(tuning * 1000) / 10, seconds, tonalWeight, gridness, frames };
}

// ---------- profile matching ----------

function pearson(x, y, rot) {
  let mx = 0, my = 0;
  for (let i = 0; i < 12; i++) { mx += x[i]; my += y[i]; }
  mx /= 12; my /= 12;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < 12; i++) {
    const a = x[(i + rot) % 12] - mx, b = y[i] - my;
    sxy += a * b; sxx += a * a; syy += b * b;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
}

/**
 * Score all 24 keys against a chroma vector. Sorted best first.
 * @param {ArrayLike<number>} chroma 12 bins, index 0 = C
 * @param {{ profiles?: string[] }} [opts] which of PROFILES to average (default both)
 * @returns {{ camelot: string, score: number }[]}
 */
export function scoreKeys(chroma, { profiles = ['krumhansl', 'temperley'] } = {}) {
  const out = [];
  for (const mode of ['major', 'minor']) {
    for (let pc = 0; pc < 12; pc++) {
      let s = 0;
      for (const name of profiles) s += pearson(chroma, PROFILES[name][mode], pc);
      out.push({ camelot: toCamelot(pc, mode), score: s / profiles.length });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

const clamp01 = x => Math.max(0, Math.min(1, x));
const round3 = x => Math.round(x * 1000) / 1000;

/**
 * Estimate the musical key of mono audio.
 *
 * @param {Float32Array|number[]} samples mono, at `sampleRate` (16 kHz is the tested rate)
 * @param {{ sampleRate?: number, profiles?: string[] }} [opts]
 * @returns {{
 *   key: string|null, tonic: string|null, mode: 'major'|'minor'|null,
 *   camelot: string|null, openKey: string|null, confidence: number,
 *   alternates: { key: string, camelot: string, score: number, relation: string|null, compatible: boolean }[],
 *   tuningCents: number, version: string,
 * }}
 * `key` is null (confidence 0) when there is nothing tonal to judge, e.g.
 * silence. `alternates` are the next three keys by score; `relation` says how
 * each sits to the answer on the Camelot wheel ('relative', 'fifth-up',
 * 'fifth-down', 'parallel' or null) and `compatible` is true for the three
 * a DJ mixes into freely (relative and either fifth).
 */
export function key(samples, { sampleRate = SAMPLE_RATE, profiles } = {}) {
  const { chroma, tuningCents, seconds, tonalWeight, gridness } = chromagram(samples, { sampleRate });
  const none = { key: null, tonic: null, mode: null, camelot: null, openKey: null, confidence: 0,
                 alternates: [], tuningCents: 0, version: KEY_VERSION };
  if (!(tonalWeight > 0) || !(seconds > 0)) return none;

  const ranked = scoreKeys(chroma, profiles ? { profiles } : undefined);
  const best = ranked[0], second = ranked[1];
  const k = CAMELOT[best.camelot];

  const tonality = clamp01((gridness - GRID_NONE) / (GRID_FULL - GRID_NONE));
  const fit = clamp01((best.score - FIT_LOW) / (FIT_HIGH - FIT_LOW));
  const lead = clamp01((best.score - second.score) / MARGIN_FULL);
  // The lead counts for half: a close relative or fifth is the usual runner-up
  // even when the answer is right, so a small lead mustn't zero the confidence.
  const confidence = round3(tonality * fit * (0.5 + 0.5 * lead));

  return {
    key: k.key, tonic: k.tonic, mode: k.mode, camelot: k.camelot, openKey: k.openKey,
    confidence,
    alternates: ranked.slice(1, 4).map(a => {
      const rel = relation(best.camelot, a.camelot);
      return { key: CAMELOT[a.camelot].key, camelot: a.camelot, score: round3(a.score), relation: rel,
               compatible: rel === 'relative' || rel === 'fifth-up' || rel === 'fifth-down' };
    }),
    tuningCents,
    version: KEY_VERSION,
  };
}
