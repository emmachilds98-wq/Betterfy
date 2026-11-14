// The second ear for laptops: MAEST over the two preview windows (WP-C1).
//
// MAEST (Alonso-Jiménez et al., ISMIR 2023) is a transformer trained on the
// same Discogs400 label order as effnet. The 10 s variant fits a record's two
// 10 s windows exactly, so each window is one patch: no patches across the
// join, and two model runs per track. It answers with 400 style sigmoids and
// a 768-d embedding, stored as the record's optional `maest` ear
// (record.mjs makeEar / withEar), never in place of effnet's.
//
// Front end: the same 16 kHz, 96-band log-mel as effnet (Essentia's
// TensorflowInputMusiCNN, held to Essentia by test/mel.test.mjs), which is
// what Essentia's TensorflowPredictMAEST feeds the model, cut per window into
// one patch of MAEST_FRAMES and normalised with MAEST's training statistics.
//
// Not yet measured against the real model: the hosts that serve it are
// blocked from the build machines (docs/AUDIO-BUILD-PLAN.md, environment
// notes). The three things a real run must confirm are options, not
// constants buried in code, and test/audiomaest.test.mjs has a real-model
// check that runs when BETTERFY_MAEST_DIR is set:
//   - `frames` (626 for the 10 s model, as TensorflowPredictMAEST pads it);
//   - `normalise` (whether the exported graph already normalises);
//   - the input rank, read from the session's metadata when it has any.
//
// `ort` is injected exactly as in infer.mjs, so CI never needs the model.
import { melFrames, N_BANDS } from './mel.mjs';
import { MAEST_DIM, MAEST_N_STYLES } from './record.mjs';

export const MAEST_VERSION = '1.0.0';
/** Frames per patch for the 10 s model: 10 s at hop 256, padded by one as Essentia does. */
export const MAEST_FRAMES = 626;
/** A window shorter than this many frames (~5 s) is too little audio for a 10 s model. */
export const MAEST_MIN_FRAMES = 313;
/** MAEST's training statistics; input = (logmel − mean) / (2 · std), as in AST. */
export const MAEST_MEAN = 2.06755686098554;
export const MAEST_STD = 1.268292820667291;
export const MAEST_INPUT = 'melspectrogram';

/**
 * Decoded 16 kHz windows → MAEST patches, one per window that is long enough.
 * A short window is padded with silence (log-mel 0) up to `frames`; a longer
 * one keeps its first `frames`.
 *
 * @param {Float32Array[]} windows  each window on its own, never joined
 * @param {{ frames?: number, normalise?: boolean, minFrames?: number }} [o]
 * @returns {{ patches: number, data: Float32Array, frames: number }} row-major [patches × frames × 96]
 */
export function maestPatches(windows, { frames = MAEST_FRAMES, normalise = true, minFrames = MAEST_MIN_FRAMES } = {}) {
  const kept = [];
  for (const w of windows ?? []) {
    if (!w?.length) continue;
    const m = melFrames(w);
    if (m.frames >= minFrames) kept.push(m);
  }
  const size = frames * N_BANDS;
  const data = new Float32Array(kept.length * size);
  kept.forEach((m, p) => {
    const n = Math.min(m.frames, frames) * N_BANDS;
    data.set(m.data.subarray(0, n), p * size);
  });
  if (normalise) {
    const k = 1 / (2 * MAEST_STD);
    for (let i = 0; i < data.length; i++) data[i] = (data[i] - MAEST_MEAN) * k;
  }
  return { patches: kept.length, data, frames };
}

/**
 * @param {{ ort: object, modelUrl: string|Uint8Array, sessionOptions?: object,
 *           frames?: number, normalise?: boolean, embeddingOutput?: string }} deps
 *        embeddingOutput: name the embedding output when a re-export carries
 *        several 768-wide ones; otherwise it is found by width.
 * @returns {Promise<{ run(windows: Float32Array[]): Promise<{ activations: Float32Array, embedding: Float32Array, patches: number } | null>,
 *                     release(): Promise<void> }>}
 *   run() answers null when no window was long enough: no answer, not a zero one.
 */
export async function createMaestEar({ ort, modelUrl, sessionOptions, frames = MAEST_FRAMES, normalise = true, embeddingOutput } = {}) {
  const session = await ort.InferenceSession.create(modelUrl, sessionOptions ?? { executionProviders: ['wasm'] });
  const input = session.inputNames?.includes(MAEST_INPUT) ? MAEST_INPUT : (session.inputNames?.[0] ?? MAEST_INPUT);
  const rank = inputRank(session, input);

  async function run(windows) {
    const p = maestPatches(windows, { frames, normalise });
    if (!p.patches) return null;
    const dims = rank === 4 ? [p.patches, 1, frames, N_BANDS] : [p.patches, frames, N_BANDS];
    const out = await session.run({ [input]: new ort.Tensor('float32', p.data, dims) });
    const { act, emb } = pickMaestOutputs(out, p.patches, { embeddingOutput });
    return { activations: meanRows(act, p.patches, MAEST_N_STYLES), embedding: meanRows(emb, p.patches, MAEST_DIM), patches: p.patches };
  }
  return { run, release: async () => { await session.release?.(); } };
}

/** 4 when the graph wants [n, 1, frames, 96]; 3 otherwise (and when it does not say). */
function inputRank(session, input) {
  const meta = Array.isArray(session.inputMetadata)
    ? session.inputMetadata.find(m => m?.name === input) ?? session.inputMetadata[0]
    : session.inputMetadata?.[input];
  const shape = meta?.shape ?? meta?.dimensions;
  return Array.isArray(shape) && shape.length === 4 ? 4 : 3;
}

/**
 * Find the [n×400] activations and the [n×768] embedding. An output of
 * n×k×768 (one row per token, as some MAEST exports give) is averaged over
 * its k tokens. Outputs are told apart by width, as in infer.mjs.
 */
export function pickMaestOutputs(out, n, { embeddingOutput } = {}) {
  let act = null, emb = null;
  if (embeddingOutput && out[embeddingOutput]) emb = tokensMean(out[embeddingOutput]?.data ?? out[embeddingOutput], n);
  for (const t of Object.values(out)) {
    const data = t?.data ?? t;
    if (!data?.length) continue;
    if (!act && data.length === n * MAEST_N_STYLES) act = data;
    else if (!emb && data.length % (n * MAEST_DIM) === 0) emb = tokensMean(data, n);
  }
  if (!act || !emb) throw new Error('MAEST outputs are not [n×400] activations and an [n×768] embedding');
  return { act: Float32Array.from(act), emb };
}

function tokensMean(data, n) {
  const k = data.length / (n * MAEST_DIM);
  if (!Number.isInteger(k) || k < 1) throw new Error('MAEST embedding is not a multiple of 768 per patch');
  const out = new Float32Array(n * MAEST_DIM);
  for (let p = 0; p < n; p++)
    for (let t = 0; t < k; t++)
      for (let d = 0; d < MAEST_DIM; d++) out[p * MAEST_DIM + d] += data[(p * k + t) * MAEST_DIM + d] / k;
  return out;
}

function meanRows(data, n, w) {
  const out = new Float32Array(w);
  for (let p = 0; p < n; p++) for (let d = 0; d < w; d++) out[d] += data[p * w + d] / n;
  return out;
}
