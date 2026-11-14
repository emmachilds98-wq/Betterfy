// CLAP, the "describe it in words" ear (WP-C2, docs/AUDIO-BUILD-PLAN.md).
//
// LAION CLAP's music checkpoint (the weights behind laion/larger_clap_music;
// CC0-1.0, converted by scripts/audio-clap/clap_model.py, which says why the
// Hugging Face upload itself is not used) maps audio and text into one 512-d
// space, so "how close is this track to *dark rolling bassline*" is a dot
// product. Its text encoder is RoBERTa-base (125 M parameters, >100 MB even
// quantised), so text is embedded at BUILD time only
// (scripts/audio-clap/build-text-table.py → docs/models/clap-text-table.json,
// a reviewed prompt list). The page ships the quantised AUDIO encoder
// (77 MB, docs/models/larger_clap_music-audio-q8-1.onnx), downloaded only
// when the listener switches "Describe the sound in words" on.
//
// What is here, all isomorphic (no DOM, no Node APIs):
//  - the model's front end in plain JS: 48 kHz mono, Hann 1024 / hop 480,
//    |rfft|², 64 Slaney mel bands 50 Hz–14 kHz (Slaney-normalised), 10·log10,
//    10 s per clip with "repeatpad" — Hugging Face's ClapFeatureExtractor with
//    the checkpoint's own preprocessor_config (truncation rand_trunc, which is
//    the non-fusion path). Held to the reference by test/audioclap.test.mjs
//    (fixture: scripts/audio-clap/make-fixture.py). One change: a clip longer
//    than 10 s is cut from its middle, not at random, so a track always gets
//    the same embedding.
//  - createClapEar(): the ONNX session, `ort` injected like infer.mjs.
//  - clapEmbed(): windows → one L2-normalised embedding (mean over windows).
//  - the text table: loadTextTable() checks and unpacks it; rankPrompts()
//    ranks prompts against an audio embedding.
//  - decodeTo48k(): the page's 48 kHz decode (the listening ear decodes at
//    16 kHz, which would cut everything above 8 kHz out of CLAP's input).
//  - addClap() / fillClap(): put the `clap` field on a record, in the same
//    pass as listening (worker.js analyseOne with deps.clap) or later, for a
//    record heard before (like fillDsp).
//
// Nothing here changes a suggestion: CLAP names clusters and powers search
// (WP-C3); filing never reads it.

import { CLAP_DIM, CLAP_MODEL, MISS, CACHEABLE_MISS, makeEar, withEar, earCurrent, unpackEmbedding } from './record.mjs';
import { scanFrames, downmix } from './decode.mjs';

export const CLAP_VERSION = '1.0.0';
export const CLAP_SR = 48000;
export const CLAP_FFT = 1024;
export const CLAP_HOP = 480;
export const CLAP_MELS = 64;
export const CLAP_FMIN = 50;
export const CLAP_FMAX = 14000;
export const CLAP_SAMPLES = 480000;              // 10 s
export const CLAP_FRAMES = CLAP_SAMPLES / CLAP_HOP + 1;   // 1001, centred frames
export const CLAP_MODEL_FILE = `${CLAP_MODEL}.onnx`;
export const CLAP_TABLE_FILE = 'clap-text-table.json';
export const CLAP_INPUT = 'input_features';
export const TEXT_TABLE_VERSION = 1;
/** Shortest window worth hearing: under 1 s, repeatpad would be mostly a loop. */
export const CLAP_MIN_SAMPLES = CLAP_SR;

const N_BINS = CLAP_FFT / 2 + 1;

// --- Slaney mel scale, as transformers.audio_utils (and librosa) ---------
const MIN_LOG_HZ = 1000, MIN_LOG_MEL = 15, LOG_STEP = 27 / Math.log(6.4);
const hzToMel = f => (f >= MIN_LOG_HZ ? MIN_LOG_MEL + Math.log(f / MIN_LOG_HZ) * LOG_STEP : 3 * f / 200);
const melToHz = m => (m >= MIN_LOG_MEL ? MIN_LOG_HZ * Math.exp((m - MIN_LOG_MEL) / LOG_STEP) : 200 * m / 3);

let FILTERS = null;
/** [CLAP_MELS][N_BINS] triangles, Slaney area-normalised. Built once. */
export function melFilters() {
  if (FILTERS) return FILTERS;
  const fft = Float64Array.from({ length: N_BINS }, (_, i) => i * (CLAP_SR / 2) / (N_BINS - 1));
  const m0 = hzToMel(CLAP_FMIN), m1 = hzToMel(CLAP_FMAX);
  const f = Float64Array.from({ length: CLAP_MELS + 2 }, (_, i) => melToHz(m0 + (m1 - m0) * i / (CLAP_MELS + 1)));
  FILTERS = [];
  for (let m = 0; m < CLAP_MELS; m++) {
    const row = new Float64Array(N_BINS), lo = f[m], mid = f[m + 1], hi = f[m + 2];
    const norm = 2 / (hi - lo);
    for (let k = 0; k < N_BINS; k++) {
      const down = (fft[k] - lo) / (mid - lo), up = (hi - fft[k]) / (hi - mid);
      row[k] = Math.max(0, Math.min(down, up)) * norm;
    }
    FILTERS.push(row);
  }
  return FILTERS;
}

// --- radix-2 FFT, size CLAP_FFT ---------------------------------------
let TW = null, REV = null;
function fftTables() {
  if (TW) return;
  const n = CLAP_FFT, bits = Math.log2(n);
  REV = new Uint16Array(n);
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); REV[i] = r; }
  TW = { cos: new Float64Array(n / 2), sin: new Float64Array(n / 2) };
  for (let i = 0; i < n / 2; i++) { TW.cos[i] = Math.cos(2 * Math.PI * i / n); TW.sin[i] = -Math.sin(2 * Math.PI * i / n); }
}
function fftInPlace(re, im) {
  const n = re.length;
  for (let i = 0; i < n; i++) { const j = REV[i]; if (j > i) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let s = 0; s < n; s += size) for (let k = 0; k < half; k++) {
      const c = TW.cos[k * step], d = TW.sin[k * step], a = s + k, b = a + half;
      const tr = re[b] * c - im[b] * d, ti = re[b] * d + im[b] * c;
      re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
    }
  }
}

/**
 * 48 kHz samples → exactly CLAP_SAMPLES of them, as the reference prepares a
 * clip: longer is cut (from the middle, here), shorter is repeated whole
 * `floor(10 s / length)` times and zero-padded ("repeatpad").
 * @param {Float32Array} x
 * @returns {Float32Array}
 */
export function fitClip(x) {
  if (x.length === CLAP_SAMPLES) return x;
  if (x.length > CLAP_SAMPLES) {
    const at = Math.floor((x.length - CLAP_SAMPLES) / 2);
    return x.subarray(at, at + CLAP_SAMPLES);
  }
  const out = new Float32Array(CLAP_SAMPLES);
  if (!x.length) return out;
  const reps = Math.floor(CLAP_SAMPLES / x.length);
  for (let r = 0; r < reps; r++) out.set(x, r * x.length);
  return out;
}

/**
 * One clip's log-mel input, [CLAP_FRAMES × CLAP_MELS] row-major (time-major),
 * the [1, 1001, 64] slice of the model's [n, 1, 1001, 64] input.
 * @param {Float32Array} samples48k  any length; fitted with fitClip()
 * @returns {Float32Array}
 */
export function clapFeatures(samples48k) {
  fftTables();
  const x = fitClip(samples48k), fb = melFilters();
  const pad = CLAP_FFT / 2, n = x.length;
  // Centre with reflect padding (numpy 'reflect': the edge sample is not repeated).
  const at = i => (i < 0 ? x[-i] : i >= n ? x[2 * n - 2 - i] : x[i]);
  const win = Float64Array.from({ length: CLAP_FFT }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / CLAP_FFT)); // periodic Hann
  const out = new Float32Array(CLAP_FRAMES * CLAP_MELS);
  const re = new Float64Array(CLAP_FFT), im = new Float64Array(CLAP_FFT), pow = new Float64Array(N_BINS);
  for (let t = 0; t < CLAP_FRAMES; t++) {
    const start = t * CLAP_HOP - pad;
    for (let i = 0; i < CLAP_FFT; i++) { re[i] = at(start + i) * win[i]; im[i] = 0; }
    fftInPlace(re, im);
    for (let k = 0; k < N_BINS; k++) pow[k] = re[k] * re[k] + im[k] * im[k];
    for (let m = 0; m < CLAP_MELS; m++) {
      const row = fb[m];
      let s = 0;
      for (let k = 0; k < N_BINS; k++) if (row[k]) s += row[k] * pow[k];
      out[t * CLAP_MELS + m] = 10 * Math.log10(Math.max(1e-10, s));
    }
  }
  return out;
}

/**
 * The audio encoder. `ort` is onnxruntime-web in the page (or -node in a
 * script); the model takes [n, 1, 1001, 64] and returns [n, 512], already
 * L2-normalised per row.
 * @returns {Promise<{ run(feats: Float32Array, n: number): Promise<Float32Array>, release(): Promise<void> }>}
 */
export async function createClapEar({ ort, modelUrl, sessionOptions }) {
  const session = await ort.InferenceSession.create(modelUrl, sessionOptions ?? { executionProviders: ['wasm'] });
  const out = session.outputNames?.[0] ?? 'audio_embeds';
  return {
    async run(feats, n) {
      if (feats.length !== n * CLAP_FRAMES * CLAP_MELS) throw new Error('CLAP input shape does not match clip count');
      const res = await session.run({ [CLAP_INPUT]: new ort.Tensor('float32', feats, [n, 1, CLAP_FRAMES, CLAP_MELS]) });
      const data = res[out].data;
      if (data.length !== n * CLAP_DIM) throw new Error(`CLAP output is ${data.length / n}-d, expected ${CLAP_DIM}`);
      return Float32Array.from(data);
    },
    release: () => session.release?.() ?? Promise.resolve(),
  };
}

/** L2-normalise in place; a zero vector stays zero. */
export function normalise(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  if (n > 0) for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

/**
 * Windows of 48 kHz audio → the record's `clap` field (record.mjs makeEar):
 * each window is one clip, the clip embeddings are averaged and normalised.
 * Clips run one at a time: the int8 encoder picks its activation scale per
 * input, so clips batched together would nudge each other's embedding and a
 * track's answer would depend on its neighbours. Windows shorter than
 * CLAP_MIN_SAMPLES are left out; none left means nothing to say (null).
 * @param {{ run: Function }} ear  createClapEar()
 * @param {Float32Array[]} windows
 * @returns {Promise<null | { model: string, emb: { s: number, q: string } }>}
 */
export async function clapEmbed(ear, windows) {
  const clips = (windows ?? []).filter(w => w?.length >= CLAP_MIN_SAMPLES);
  if (!clips.length) return null;
  const mean = new Float32Array(CLAP_DIM);
  for (const w of clips) {
    const emb = await ear.run(clapFeatures(w), 1);
    for (let k = 0; k < CLAP_DIM; k++) mean[k] += emb[k] / clips.length;
  }
  if (!mean.every(Number.isFinite) || mean.every(v => v === 0)) return null;
  return makeEar('clap', { embedding: normalise(mean) });
}

/**
 * Check and unpack docs/models/clap-text-table.json. Throws on a table this
 * code can't use (wrong version or dimension), because a silent mismatch
 * would rank nonsense.
 * @returns {{ model: string, dim: number, prompts: { text: string, kind: string, concept?: string, vec: Float32Array }[] }}
 */
export function loadTextTable(json) {
  if (!json || json.v !== TEXT_TABLE_VERSION) throw new Error('CLAP text table: unknown version');
  if (json.dim !== CLAP_DIM) throw new Error(`CLAP text table is ${json.dim}-d, audio is ${CLAP_DIM}-d`);
  const prompts = (json.prompts ?? []).map(p => {
    const vec = unpackEmbedding(p.emb);
    if (vec.length !== CLAP_DIM) throw new Error(`CLAP text table: "${p.text}" is ${vec.length}-d`);
    return { text: p.text, kind: p.kind, ...(p.concept ? { concept: p.concept } : {}), vec: normalise(vec) };
  });
  return { model: json.model, dim: json.dim, template: json.template, prompts };
}

/**
 * Prompts ranked by cosine to one audio embedding (a record's `clap`, packed,
 * or a Float32Array).
 * @param {object|Float32Array} audio
 * @param {ReturnType<typeof loadTextTable>} table
 * @param {{ kind?: 'genre'|'description', top?: number }} [o]
 * @returns {{ text: string, kind: string, concept?: string, score: number }[]}
 */
export function rankPrompts(audio, table, { kind = null, top = 10 } = {}) {
  const a = audio instanceof Float32Array ? normalise(Float32Array.from(audio))
    : normalise(unpackEmbedding(audio?.emb ?? audio));
  if (a.length !== table.dim) throw new Error('audio and text embeddings differ in dimension');
  const out = [];
  for (const p of table.prompts) {
    if (kind && p.kind !== kind) continue;
    let s = 0;
    for (let k = 0; k < a.length; k++) s += a[k] * p.vec[k];
    out.push({ text: p.text, kind: p.kind, ...(p.concept ? { concept: p.concept } : {}), score: +s.toFixed(4) });
  }
  return out.sort((x, y) => y.score - x.score).slice(0, top);
}

/**
 * Compressed preview bytes → 48 kHz mono, for CLAP. Same approach and
 * reasons as decode.mjs decodeTo16k (decode on an OfflineAudioContext at the
 * target rate, MP3 trimmed to its first chained frame, (L+R)/2), at CLAP's
 * rate. Browser main thread only.
 */
export async function decodeTo48k(arrayBuffer, { offlineContextCtor, audioContextCtor } = {}) {
  const Offline = offlineContextCtor ?? globalThis.OfflineAudioContext ?? globalThis.webkitOfflineAudioContext;
  const Live = audioContextCtor ?? globalThis.AudioContext ?? globalThis.webkitAudioContext;
  if (!Offline && !Live) throw new Error('decodeTo48k: no Web Audio context available');
  const u8 = new Uint8Array(arrayBuffer);
  const first = scanFrames(u8);
  const bytes = first > 0 ? arrayBuffer.slice(first) : arrayBuffer;
  let ctx, live = false;
  if (Offline) ctx = new Offline(1, 1, CLAP_SR);
  else { ctx = new Live({ sampleRate: CLAP_SR }); live = true; }
  try {
    const audio = await ctx.decodeAudioData(bytes);
    if (audio.sampleRate !== CLAP_SR) throw new Error(`decodeTo48k: decoded at ${audio.sampleRate} Hz, not ${CLAP_SR}`);
    return downmix(Array.from({ length: audio.numberOfChannels }, (_, c) => audio.getChannelData(c)));
  } finally {
    if (live) ctx.close?.();
  }
}

// --- filling records ----------------------------------------------------

/** Records given a CLAP embedding per controller run, after the queue (like DSP_FILL_PER_RUN). */
export const CLAP_FILL_PER_RUN = 25;

/** Does this stored answer want a (current) CLAP embedding? */
export function needsClap(rec) {
  return !!rec && !rec.miss && typeof rec.id === 'string' && !earCurrent(rec, 'clap');
}

/**
 * Add the CLAP field to a fresh record from windows decoded at 48 kHz. CLAP
 * is a bonus: any failure returns the record unchanged, never a failed track.
 * @param {{ embed(windows: Float32Array[]): Promise<object|null> }} clap
 */
export async function addClap(clap, record, windows48k) {
  if (!clap || !record || record.miss || !windows48k?.length) return record;
  try {
    const field = await clap.embed(windows48k);
    return field ? withEar(record, 'clap', field) : record;
  } catch { return record; }
}

/**
 * Give a record heard before (or under an older CLAP model) its CLAP
 * embedding: look the ISRC up again, download, decode at 48 kHz, embed. The
 * base ear, heads and dsp are untouched, so nothing the engine learned from
 * is invalidated. Shaped like worker.js fillDsp().
 *
 * @param {object} deps  { lookup, fetchPreview, clap: { decode(buf) → Float32Array (48 kHz), embed(windows) → field|null } }
 * @returns {Promise<{ record } | { skip: string } | { failed: object }>}
 */
export async function fillClap(deps, record, track = {}) {
  const id = record?.id;
  const failed = (stage, detail) => ({ failed: { id, stage, detail: String(detail ?? '') } });
  if (!deps?.clap) return { skip: 'no-clap' };
  if (!id || record.miss || !record.isrc) return { skip: 'not-a-record' };

  let found;
  try { found = await deps.lookup(record.isrc, { spotifyDurationMs: track.durationMs }); }
  catch (e) { return failed('lookup', e?.message ?? e); }
  if (found?.miss) return CACHEABLE_MISS.has(found.miss) ? { skip: found.miss } : failed('lookup', found.detail ?? found.miss);
  // ISRC or nothing: only hear the very recording the record was made from.
  const was = record.source?.deezerId;
  if (was != null && found.deezerId !== was) return { skip: 'different-recording' };

  let got = await deps.fetchPreview(found.previewUrl).catch(e => ({ miss: MISS.FAILED, detail: e?.message ?? e }));
  if (got?.miss) return failed('download', got.detail ?? got.miss);
  let windows = [];
  try { for (let i = 0; i < got.buffers.length; i++) { windows.push(await deps.clap.decode(got.buffers[i])); got.buffers[i] = null; } }
  catch (e) { return failed('decode', e?.message ?? e); }
  got = null;

  let field = null;
  try { field = await deps.clap.embed(windows); }
  catch (e) { return failed('clap', e?.message ?? e); }
  windows = null; // drop the audio
  if (!field) return { skip: 'nothing-heard' };
  return { record: withEar(record, 'clap', field) };
}
