// The second ear: MAEST, a music transformer, on the laptop path (WP-C1).
//
// It runs beside Discogs-EffNet, never instead of it. Its answer goes into the
// record's optional `maest` field (record.mjs v2) and is only used for
// placement once the owner's Score run shows it beats the first ear
// (core/validate/gate.mjs `earChoice`). Until then it changes no suggestion.
//
// Model: Essentia's `discogs-maest-10s-pw-2` (MTG-UPF, CC BY-NC-SA 4.0, like
// the first ear), dynamically quantised to int8 by
// scripts/audio-maest/quantise.py: 344 MB → 88.6 MB, which fits GitHub's
// 100 MB file limit and a laptop's memory. Measured on 144 Deezer previews
// against the fp32 model: same top style 93%, top-5 styles overlap 96%,
// embedding cosine median 0.9985 (min 0.9977); 0.15 s per window natively.
//
// Input, from Essentia's TensorflowPredictMAEST: the *same* log-mel frames as
// the first ear (core/audio/mel.mjs; TensorflowInputMusiCNN), then
// (x − 2.0676) / (2 · 1.2683), cut into patches of 626 frames (10 s) with a
// hop of 625. The 10 s checkpoint fits the two ~10 s windows a record hears,
// so each window is one patch. A window a little short of 626 frames is
// filled by repeating its own start (Essentia's lastPatchMode 'repeat');
// below MIN_FRAMES (5 s) it is too little to judge and is skipped.
//
// Outputs: `activations` (400 sigmoids, the same Discogs400 label order as
// EffNet, so core/sources/audio-vocab.mjs applies unchanged) and per-layer
// token embeddings [tokens × 768]. The embedding kept is the mean over all
// tokens of EMB_OUTPUT. Which layer was measured, not assumed: on the same
// 144 previews, leave-one-out nearest-centroid placement across 15 genres,
// layer index 8 gave 61.1% top-1 (EffNet 55.6%; layer 6, Essentia's default,
// 52.1%; 11, 61.1%; 10, 58.3%), and EffNet+MAEST together 63.9% / 86.1%
// top-2. Picked on that set, so it flatters slightly; the owner's Score run
// is the measurement that counts.
//
// `ort` is injected, like infer.mjs: CI never needs the model.
import { melFrames, N_BANDS } from './mel.mjs';
import { MAEST_DIM, MAEST_N_STYLES, makeEar, withEar, earCurrent } from './record.mjs';

export const MAEST_VERSION = '1.0.0';
export const MAEST_FILE = 'discogs-maest-10s-pw-2-int8.onnx';
export const MAEST_LABELS_FILE = 'discogs-maest-10s-pw-2.json';
export const MAEST_PATCH_FRAMES = 626;
export const MAEST_PATCH_HOP = 625;
export const MAEST_MIN_FRAMES = 313;
export const MAEST_MEAN = 2.06755686098554;
export const MAEST_STD = 1.268292820667291;
export const INPUT_NAME = 'melspectrogram';
export const ACT_OUTPUT = 'activations';
export const EMB_OUTPUT = 'layer_08_embeddings';

/**
 * Log-mel frames of one window → MAEST's normalised input patches.
 * @param {{ frames: number, data: Float32Array }} mel  from melFrames()
 * @returns {{ patches: number, data: Float32Array }} row-major [patches × 626 × 96]
 */
export function maestPatches({ frames, data }) {
  if (!(frames >= MAEST_MIN_FRAMES)) return { patches: 0, data: new Float32Array(0) };
  const full = frames >= MAEST_PATCH_FRAMES ? Math.floor((frames - MAEST_PATCH_FRAMES) / MAEST_PATCH_HOP) + 1 : 0;
  const patches = Math.max(1, full);
  const size = MAEST_PATCH_FRAMES * N_BANDS, scale = 1 / (MAEST_STD * 2);
  const out = new Float32Array(patches * size);
  for (let p = 0; p < patches; p++) {
    for (let f = 0; f < MAEST_PATCH_FRAMES; f++) {
      // Past the end (short window only): repeat from the window's own start.
      const src = (p * MAEST_PATCH_HOP + f) % frames;
      for (let b = 0; b < N_BANDS; b++) out[p * size + f * N_BANDS + b] = (data[src * N_BANDS + b] - MAEST_MEAN) * scale;
    }
  }
  return { patches, data: out };
}

/**
 * Load the session. `run(patchData, patches)` returns the mean activations
 * [400] and mean embedding [768] over the patches given.
 *
 * @param {{ ort: object, modelUrl: string|Uint8Array, sessionOptions?: object }} deps
 */
export async function createMaestEar({ ort, modelUrl, sessionOptions }) {
  const session = await ort.InferenceSession.create(modelUrl, sessionOptions ?? { executionProviders: ['wasm'] });
  const input = session.inputNames?.includes(INPUT_NAME) ? INPUT_NAME : (session.inputNames?.[0] ?? INPUT_NAME);
  const size = MAEST_PATCH_FRAMES * N_BANDS;
  // No `fetches` list: onnxruntime-node 1.21 was seen returning a fetched
  // subset under the wrong names. The shipped model has only the two outputs
  // (scripts/audio-maest/quantise.py prunes the other twelve), so all of them is both.

  async function run(patchData, patches) {
    if (!(patches > 0)) throw new Error('no patches to run');
    if (patchData.length !== patches * size) throw new Error(`expected ${patches}×${MAEST_PATCH_FRAMES}×${N_BANDS} floats, got ${patchData.length}`);
    const activations = new Float32Array(MAEST_N_STYLES), embedding = new Float32Array(MAEST_DIM);
    for (let p = 0; p < patches; p++) {
      const x = new ort.Tensor('float32', patchData.subarray(p * size, (p + 1) * size), [1, MAEST_PATCH_FRAMES, N_BANDS]);
      const out = await session.run({ [input]: x });
      const { act, tokens } = pickMaestOutputs(out);
      for (let k = 0; k < MAEST_N_STYLES; k++) activations[k] += act[k] / patches;
      const n = tokens.length / MAEST_DIM;
      for (let t = 0; t < n; t++) for (let k = 0; k < MAEST_DIM; k++) embedding[k] += tokens[t * MAEST_DIM + k] / (n * patches);
    }
    return { activations, embedding };
  }
  return { run, release: async () => { await session.release?.(); } };
}

/** The style probabilities and the chosen layer's tokens, by name; by shape if renamed. */
export function pickMaestOutputs(out) {
  const data = t => t?.data ?? t;
  const all = Object.values(out ?? {}).map(data).filter(d => d?.length);
  let act = data(out?.[ACT_OUTPUT]), tokens = data(out?.[EMB_OUTPUT]);
  // By shape when renamed: 400 wide is the styles, a multiple of 768 the tokens.
  if (act?.length !== MAEST_N_STYLES) act = all.find(d => d.length === MAEST_N_STYLES);
  if (!tokens?.length || tokens.length % MAEST_DIM || tokens.length === MAEST_N_STYLES)
    tokens = all.find(d => d.length !== MAEST_N_STYLES && d.length % MAEST_DIM === 0);
  if (!act || act.length !== MAEST_N_STYLES || !tokens?.length || tokens.length % MAEST_DIM)
    throw new Error(`MAEST outputs are not [400] activations and [tokens×768] ${EMB_OUTPUT}`);
  return { act, tokens };
}

/**
 * Decoded 16 kHz windows (each contiguous audio, as worker.js decodes them)
 * → the record's `maest` field, or null when no window is long enough. Each
 * window is cut into its own patches, never across the join.
 *
 * @param {{ run: Function }} ear  from createMaestEar (or a Worker proxy of it)
 * @param {Float32Array[]} windows
 */
export async function hearMaest(ear, windows) {
  const per = [];
  for (const w of windows ?? []) {
    const p = maestPatches(melFrames(w));
    if (p.patches) per.push(p);
  }
  if (!per.length) return null;
  const activations = new Float32Array(MAEST_N_STYLES), embedding = new Float32Array(MAEST_DIM);
  const total = per.reduce((n, p) => n + p.patches, 0);
  for (const p of per) {
    const out = await ear.run(p.data, p.patches);
    // Weighted by patches, so a window is not worth more for being cut shorter.
    for (let k = 0; k < MAEST_N_STYLES; k++) activations[k] += out.activations[k] * p.patches / total;
    for (let k = 0; k < MAEST_DIM; k++) embedding[k] += out.embedding[k] * p.patches / total;
  }
  return makeEar('maest', { embedding, activations });
}

/** Records the laptop run should give a second ear: heard, not a miss, no current `maest`. */
export function needsMaest(rec) {
  return !!rec && !rec.miss && !!rec.isrc && !earCurrent(rec, 'maest');
}

/**
 * Give one stored record its second ear: look the ISRC up again, download and
 * decode the same two windows, run MAEST, and return the record with `maest`
 * filled. The first ear, its embedding and everything learned from it are
 * untouched (withEar). Same rules as worker.js fillDsp: ISRC or nothing,
 * only the very recording the record was made from, the audio dropped as soon
 * as the mel exists, the preview URL never kept.
 *
 * @param {object} deps  { lookup, fetchPreview, decode, maest: { run } }
 * @param {object} record  a stored, non-miss AudioRecord
 * @param {{ durationMs?: number }} [track]
 * @returns {Promise<{ record: object } | { skip: string } | { failed: { id, stage, detail } }>}
 */
export async function fillMaest(deps, record, track = {}) {
  const id = record?.id;
  const failed = (stage, detail) => ({ failed: { id, stage, detail: String(detail ?? '') } });
  if (!deps?.maest) return { skip: 'no-maest' };
  if (!id || record.miss || !record.isrc) return { skip: 'not-a-record' };
  if (earCurrent(record, 'maest')) return { skip: 'current' };

  let found;
  try { found = await deps.lookup(record.isrc, { spotifyDurationMs: track.durationMs }); }
  catch (e) { return failed('lookup', e?.message ?? e); }
  if (found?.miss) return found.miss === 'FAILED' ? failed('lookup', found.detail ?? found.miss) : { skip: found.miss };
  const was = record.source?.deezerId;
  if (was != null && found.deezerId !== was) return { skip: 'different-recording' };

  let got;
  try { got = await deps.fetchPreview(found.previewUrl); } catch (e) { return failed('download', e?.message ?? e); }
  if (got?.miss) return failed('download', got.detail ?? got.miss);
  let parts = [];
  try { for (let i = 0; i < got.buffers.length; i++) { parts.push(await deps.decode(got.buffers[i])); got.buffers[i] = null; } }
  catch (e) { return failed('decode', e?.message ?? e); }
  got = null;

  let field;
  try { field = await hearMaest(deps.maest, parts); }
  catch (e) { return failed('infer', e?.message ?? e); }
  parts = null; // drop the audio
  if (!field) return { skip: 'too-short' };
  return { record: withEar(record, 'maest', field) };
}
