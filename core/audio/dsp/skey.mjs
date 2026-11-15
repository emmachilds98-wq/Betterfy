// Musical key from S-KEY, a small ONNX model (build 5 §6.1 step 2).
//
// S-KEY (Kong, Meseguer-Brocal, Lostanlen, Lagrange, Hennequin, "S-KEY:
// Self-supervised Learning of Major and Minor Keys from Audio", ICASSP 2025,
// arXiv 2501.12907) is Deezer's self-supervised key model: a ChromaNet
// (ConvNeXt blocks over a VQT) trained without key labels. The ONNX file is
// the community conversion at huggingface.co/aaatmy/skey-onnx (324,536 bytes,
// FP32, opset 17, sha256 50bac66d…12b1): input `audio` [1, samples] float32
// mono at 22,050 Hz, output `scores` [1, 24], a softmax already applied. Peak
// normalisation, the VQT and the time average are inside the graph, so this
// file only feeds samples and reads 24 numbers. Licence: MIT (Deezer SA); see
// docs/models/LICENSE.
//
// `ort` is injected — onnxruntime-web in the page, onnxruntime-node in
// scripts — as infer.mjs createEar() does, so this file has no runtime of its
// own and tests pass a fake session.
//
// Per window, like key.mjs: the model runs on each contiguous window on its
// own (never across the join) and the windows' probabilities are averaged.
// The answer has key.mjs's shape, so combine.mjs, dsp-view.mjs and "mixes
// with" read it unchanged.
//
// Measured on the Beatport EDM Key Dataset's held-out half (the split key.mjs
// v2 was fitted on, scripts/audio-dsp/skey-eval.mjs): see SKEY_MEASURED.

import { toCamelot, CAMELOT, relation } from './key.mjs';

export const SKEY_VERSION = '1.0.0';
export const SKEY_SAMPLE_RATE = 22050;
/** The application minimum the conversion's author uses; shorter input gets no answer. */
export const SKEY_MIN_SECONDS = 3;
export const SKEY_MODEL_FILE = 'skey-1.onnx';
export const SKEY_INPUT = 'audio';

/** Output order, from the conversion's manifest.json: majors from A, minors from B. */
export const SKEY_LABELS = Object.freeze([
  'A Major', 'Bb Major', 'B Major', 'C Major', 'C# Major', 'D Major', 'D# Major', 'E Major', 'F Major', 'F# Major', 'G Major', 'G# Major',
  'B minor', 'C minor', 'C# minor', 'D minor', 'D# minor', 'E minor', 'F minor', 'F# minor', 'G minor', 'G# minor', 'A minor', 'Bb minor',
]);

/** Camelot code of each output index. */
export const SKEY_CAMELOT = Object.freeze(SKEY_LABELS.map(l => {
  const [tonic, mode] = l.split(' ');
  return toCamelot(tonic, mode.toLowerCase());
}));

const SILENCE_PEAK = 1e-4;   // about -80 dBFS: the graph peak-normalises, so silence would become noise
const round3 = x => Math.round(x * 1000) / 1000;

/**
 * Load the model.
 * @param {{ ort: { InferenceSession: { create(url: string|Uint8Array, opts?: object): Promise<any> }, Tensor: any },
 *           modelUrl: string|Uint8Array, sessionOptions?: object }} deps
 * @returns {Promise<{ run(samples22k: Float32Array): Promise<Float32Array|null>, release(): Promise<void> }>}
 *   run() gives the 24 probabilities in SKEY_LABELS order, or null for input
 *   that is too short or silent.
 */
export async function createSkey({ ort, modelUrl, sessionOptions }) {
  const session = await ort.InferenceSession.create(modelUrl, sessionOptions ?? { executionProviders: ['wasm'] });
  const input = session.inputNames?.includes(SKEY_INPUT) ? SKEY_INPUT : (session.inputNames?.[0] ?? SKEY_INPUT);
  async function run(samples) {
    if (!samples || samples.length < SKEY_MIN_SECONDS * SKEY_SAMPLE_RATE) return null;
    let peak = 0;
    for (let i = 0; i < samples.length; i++) { const a = Math.abs(samples[i]); if (a > peak) peak = a; }
    if (!(peak > SILENCE_PEAK)) return null;
    const x = new ort.Tensor('float32', samples instanceof Float32Array ? samples : Float32Array.from(samples), [1, samples.length]);
    const out = await session.run({ [input]: x });
    const t = out.scores ?? Object.values(out)[0];
    const data = t?.data ?? t;
    if (!data || data.length !== 24) throw new Error('S-KEY output is not 24 scores');
    return Float32Array.from(data);
  }
  return { run, release: async () => { await session.release?.(); } };
}

/**
 * Average per-window probabilities (nulls skipped). Null when none.
 * @param {(ArrayLike<number>|null)[]} list
 */
export function meanScores(list) {
  const good = (list ?? []).filter(s => s && s.length === 24);
  if (!good.length) return null;
  const out = new Float32Array(24);
  for (const s of good) for (let i = 0; i < 24; i++) out[i] += s[i] / good.length;
  return out;
}

/**
 * 24 probabilities → key.mjs's answer shape.
 * `confidence` is the top probability (the model's own softmax, not
 * calibrated; SKEY_MEASURED gives exact-% by band on the held-out half).
 * @param {ArrayLike<number>} scores  SKEY_LABELS order
 */
export function skeyAnswer(scores) {
  const none = { key: null, tonic: null, mode: null, camelot: null, openKey: null, confidence: 0, alternates: [], version: SKEY_VERSION };
  if (!scores || scores.length !== 24) return none;
  const ranked = Array.from(scores, (p, i) => ({ camelot: SKEY_CAMELOT[i], p: Number(p) }))
    .filter(r => Number.isFinite(r.p)).sort((a, b) => b.p - a.p);
  if (!ranked.length) return none;
  const best = ranked[0], k = CAMELOT[best.camelot];
  return {
    key: k.key, tonic: k.tonic, mode: k.mode, camelot: k.camelot, openKey: k.openKey,
    confidence: round3(Math.max(0, Math.min(1, best.p))),
    alternates: ranked.slice(1, 4).map(a => {
      const rel = relation(best.camelot, a.camelot);
      return { key: CAMELOT[a.camelot].key, camelot: a.camelot, score: round3(a.p), relation: rel,
               compatible: rel === 'relative' || rel === 'fifth-up' || rel === 'fifth-down' };
    }),
    version: SKEY_VERSION,
  };
}

/**
 * Key of a track from its contiguous windows (22.05 kHz mono), each run on
 * its own and averaged. Null when no window gave an answer.
 * @param {{ run(s: Float32Array): Promise<Float32Array|null> }} skey  createSkey()
 * @param {Float32Array[]} windows22k
 * @returns {Promise<{ key: string, camelot: string, keyConf: number, keyAgree: boolean|null, scores: Float32Array } | null>}
 */
export async function skeyWindows(skey, windows22k) {
  const each = [];
  for (const w of windows22k ?? []) { try { each.push(await skey.run(w)); } catch { each.push(null); } }
  const mean = meanScores(each);
  if (!mean) return null;
  const a = skeyAnswer(mean);
  if (!a.key) return null;
  const tops = each.filter(Boolean).map(s => skeyAnswer(s).camelot);
  return { key: a.key, camelot: a.camelot, keyConf: a.confidence, keyAgree: tops.length > 1 ? tops.every(c => c === tops[0]) : null, scores: mean };
}

/**
 * Resample mono audio by windowed-sinc interpolation (Blackman-windowed,
 * `taps` zero crossings each side, cut off at the lower Nyquist). Used to feed
 * S-KEY from the 16 kHz samples the page already has (upsampling 16 → 22.05
 * kHz adds no content above 8 kHz; the measured effect on key is in
 * SKEY_MEASURED), so no second decode is needed. Pure JS, isomorphic.
 * @param {Float32Array} x
 * @param {number} from  Hz
 * @param {number} to    Hz
 * @param {{ taps?: number }} [o]
 */
export function resample(x, from, to, { taps = 16 } = {}) {
  if (!(from > 0) || !(to > 0) || !Number.isInteger(from) || !Number.isInteger(to)) throw new Error('resample: bad rates');
  if (from === to) return Float32Array.from(x);
  const n = Math.floor(x.length * to / from), out = new Float32Array(n);
  const fc = Math.min(1, to / from);                          // cutoff, as a fraction of the input Nyquist
  const half = Math.ceil(taps / fc), width = 2 * half;
  // Output j sits at input time j·from/to = c + ph/L: L phases, one kernel each.
  const g = gcd(from, to), L = to / g, M = from / g;
  const table = new Float32Array(L * width);
  for (let ph = 0; ph < L; ph++) {
    let sum = 0;
    for (let k = 0; k < width; k++) {
      const d = ph / L + half - 1 - k, u = d / half;          // distance from tap (c - half + 1 + k)
      let v = 0;
      if (u > -1 && u < 1) {
        const w = 0.42 + 0.5 * Math.cos(Math.PI * u) + 0.08 * Math.cos(2 * Math.PI * u);
        const a = Math.PI * fc * d;
        v = (a === 0 ? 1 : Math.sin(a) / a) * w;
      }
      table[ph * width + k] = v; sum += v;
    }
    for (let k = 0; k < width; k++) table[ph * width + k] /= sum;  // unity gain at DC
  }
  for (let j = 0; j < n; j++) {
    const num = j * M, c = Math.floor(num / L), ph = num - c * L, base = c - half + 1, t0 = ph * width;
    let s = 0;
    if (base >= 0 && base + width <= x.length) for (let k = 0; k < width; k++) s += x[base + k] * table[t0 + k];
    else for (let k = 0; k < width; k++) { const i = base + k; if (i >= 0 && i < x.length) s += x[i] * table[t0 + k]; }
    out[j] = s;
  }
  return out;
}

function gcd(a, b) { while (b) [a, b] = [b, a % b]; return a; }
