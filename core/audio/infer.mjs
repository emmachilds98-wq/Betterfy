// The ear: Discogs-EffNet inference over mel patches (WP-A3).
//
// `ort` is injected — onnxruntime-web in the page, onnxruntime-node in
// scripts — so this file has no runtime of its own and CI never needs the
// model. Tests pass a fake session.
//
// Patches are run at most MAX_BATCH at a time. A patch is 128 frames (~2 s)
// with a ~1 s hop, so a 30 s preview is ~29 patches and two 10 s windows are
// 19 (measured in WP-B1); a single run usually splits into two batches; it is the cap that keeps a phone's
// memory flat if a caller hands it something long.
//
// Outputs are told apart by width (400 styles, 1280 embedding), not by name:
// phase 0 read them positionally (`SESS.run(None, …)`), and a re-export that
// renames them should not silently swap the two.
import { PATCH_FRAMES, N_BANDS } from './mel.mjs';
import { N_STYLES, EMB_DIM } from './record.mjs';

export const INFER_VERSION = '1.0.0';
export const MAX_BATCH = 16;
export const INPUT_NAME = 'melspectrogram';

/**
 * @param {{ ort: { InferenceSession: { create(url: string|Uint8Array, opts?: object): Promise<any> }, Tensor: any },
 *           modelUrl: string|Uint8Array, sessionOptions?: object }} deps
 * @returns {Promise<{ run(patchData: Float32Array, patches: number): Promise<{ activations: Float32Array, embeddings: Float32Array }>, release(): Promise<void> }>}
 */
export async function createEar({ ort, modelUrl, sessionOptions }) {
  const session = await ort.InferenceSession.create(modelUrl, sessionOptions ?? { executionProviders: ['wasm'] });
  const input = session.inputNames?.includes(INPUT_NAME) ? INPUT_NAME : (session.inputNames?.[0] ?? INPUT_NAME);
  const size = PATCH_FRAMES * N_BANDS;

  async function run(patchData, patches) {
    if (!(patches > 0)) throw new Error('no patches to run');
    if (patchData.length !== patches * size) throw new Error(`expected ${patches}×${PATCH_FRAMES}×${N_BANDS} floats, got ${patchData.length}`);
    const activations = new Float32Array(patches * N_STYLES);
    const embeddings = new Float32Array(patches * EMB_DIM);
    for (let p0 = 0; p0 < patches; p0 += MAX_BATCH) {
      const n = Math.min(MAX_BATCH, patches - p0);
      const x = new ort.Tensor('float32', patchData.subarray(p0 * size, (p0 + n) * size), [n, PATCH_FRAMES, N_BANDS]);
      const out = await session.run({ [input]: x });
      const { act, emb } = pickOutputs(out, n);
      activations.set(act, p0 * N_STYLES);
      embeddings.set(emb, p0 * EMB_DIM);
    }
    return { activations, embeddings };
  }
  return { run, release: async () => { await session.release?.(); } };
}

/** Find the 400-wide and 1280-wide outputs among whatever the session returned. */
export function pickOutputs(out, n) {
  let act = null, emb = null;
  for (const t of Object.values(out)) {
    const data = t?.data ?? t;
    if (!data?.length) continue;
    if (data.length === n * N_STYLES && !act) act = data;
    else if (data.length === n * EMB_DIM && !emb) emb = data;
  }
  if (!act || !emb) throw new Error('model outputs are not [n×400] activations and [n×1280] embeddings');
  return { act: Float32Array.from(act), emb: Float32Array.from(emb) };
}
