// The audio worker's logic: one Spotify track in, one AudioRecord (or miss) out (WP-B1).
//
// Glue only: queue id → lookup → fetchPreview → decodeTo16k → melFrames →
// melPatches → ear.run → heads → makeRecord / makeMiss. Every stage is
// injected (`deps`), so analyseOne() is tested with every dependency faked,
// including each MISS path, and the same function runs in the page's module
// Worker and in a Node script.
//
// What it does NOT own:
//  - storage: the page owns IndexedDB; the result is returned / posted;
//  - decoding in the page: OfflineAudioContext does not exist in a Worker,
//    so the page decodes on the main thread and posts samples in, and the
//    worker side runs from `samples` (see analyseSamples);
//  - ordering: core/audio/queue.mjs decides what is next.
//
// Rules held here (build plan §0): never store audio (buffers are dropped
// as soon as they are decoded, samples as soon as the mel exists), never
// keep a preview URL (it lives only inside one analyseOne call), ISRC or
// nothing, and FAILED is returned as a result, never written as a miss.
import { melFrames, melPatches, MEL_VERSION, SAMPLE_RATE } from './mel.mjs';
import { makeRecord, makeMiss, MISS, CACHEABLE_MISS } from './record.mjs';

export const WORKER_VERSION = '1.0.0';

/**
 * Analyse one track end to end.
 *
 * @param {object} deps
 * @param {(isrc: string, o: { spotifyDurationMs?: number }) => Promise<object>} deps.lookup     fetch.mjs lookup, jsonp already bound
 * @param {(url: string) => Promise<object>} deps.fetchPreview                                  fetch.mjs fetchPreview, fetch already bound
 * @param {(buf: ArrayBuffer) => Promise<Float32Array>} deps.decode                              decode.mjs decodeTo16k, contexts bound
 * @param {{ run(data: Float32Array, n: number): Promise<{activations, embeddings}> }} deps.ear  infer.mjs createEar()
 * @param {{ run(emb: Float32Array, n: number): Promise<object> }} [deps.heads]                  heads.mjs createHeads(), optional
 * @param {(outputs: object, n: number) => object} [deps.summariseHeads]
 * @param {(samples: Float32Array) => object} [deps.dsp]                                         optional DSP (WP-D4)
 * @param {() => number} [deps.now]
 * @param {{ id: string, isrc?: string, durationMs?: number }} track
 * @returns {Promise<{ record: object } | { miss: object } | { failed: { id: string, stage: string, detail: string } }>}
 *   `record` and `miss` are storable; `failed` is not and must not be stored.
 */
export async function analyseOne(deps, track) {
  const now = deps.now ?? Date.now;
  const id = track?.id;
  if (!id) throw new Error('analyseOne needs a track id');
  const isrc = track.isrc || null;
  const miss = reason => ({ miss: makeMiss({ id, isrc, reason, at: now() }) });
  const failed = (stage, detail) => ({ failed: { id, stage, detail: String(detail ?? '') } });

  if (!isrc) return miss(MISS.NO_ISRC);

  let found;
  try { found = await deps.lookup(isrc, { spotifyDurationMs: track.durationMs }); }
  catch (e) { return failed('lookup', e?.message ?? e); }
  if (found?.miss) return CACHEABLE_MISS.has(found.miss) ? miss(found.miss) : failed('lookup', found.detail ?? found.miss);

  let got = await deps.fetchPreview(found.previewUrl).catch(e => ({ miss: MISS.FAILED, detail: e?.message ?? e }));
  if (got?.miss) return failed('download', got.detail ?? got.miss);

  // Decode each window separately (a cut MP3 resyncs on its own) and join them.
  let samples;
  try {
    const parts = [];
    for (let i = 0; i < got.buffers.length; i++) { parts.push(await deps.decode(got.buffers[i])); got.buffers[i] = null; }
    samples = concat(parts);
  } catch (e) { return failed('decode', e?.message ?? e); }
  const { windows, sliced } = got;
  got = null; // drop the compressed audio

  return analyseSamples(deps, { id, isrc, samples, source: { kind: 'deezer-isrc', deezerId: found.deezerId, windows, seconds: +(samples.length / SAMPLE_RATE).toFixed(2), ...(sliced ? { sliced: true } : {}) } });
}

/**
 * The worker-side half: decoded 16 kHz samples → record. The page calls this
 * inside its Worker after decoding on the main thread.
 */
export async function analyseSamples(deps, { id, isrc, samples, source }) {
  const now = deps.now ?? Date.now;
  const miss = reason => ({ miss: makeMiss({ id, isrc, reason, at: now() }) });
  const failed = (stage, detail) => ({ failed: { id, stage, detail: String(detail ?? '') } });

  let dsp = null;
  try { dsp = deps.dsp ? deps.dsp(samples) : null; } catch { dsp = null; } // DSP is a bonus: never fails a track
  let p = melPatches(melFrames(samples));
  samples = null; // drop the audio
  if (!(p.patches > 0)) return miss(MISS.TOO_SHORT);

  let out;
  try { out = await deps.ear.run(p.data, p.patches); }
  catch (e) { return failed('infer', e?.message ?? e); }
  const patches = p.patches; p = null;

  let heads = null;
  if (deps.heads) {
    try {
      const h = await deps.heads.run(out.embeddings, patches);
      heads = deps.summariseHeads ? deps.summariseHeads(h, patches) : h;
    } catch { heads = null; } // heads are optional: a failure leaves them out
  }
  const record = makeRecord({ id, isrc, activations: out.activations, embeddings: out.embeddings, patches, source, mel: MEL_VERSION, heads, dsp, at: now() });
  return { record };
}

/**
 * Run tracks one at a time until done or stopped. `signal` is an AbortSignal
 * (or anything with `.aborted`); the current track finishes, no new one starts.
 * `onResult` gets each result as it lands — the caller stores records and misses.
 * @returns {Promise<{ done: number, stopped: boolean }>}
 */
export async function runQueue(deps, tracks, { signal, onResult = () => {} } = {}) {
  let done = 0;
  for (const t of tracks) {
    if (signal?.aborted) return { done, stopped: true };
    let r;
    try { r = await analyseOne(deps, t); }
    catch (e) { r = { failed: { id: t?.id, stage: 'unknown', detail: String(e?.message ?? e) } }; }
    await onResult(r, t);
    done++;
  }
  return { done, stopped: false };
}

function concat(parts) {
  if (parts.length === 1) return parts[0];
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
