// AudioRecord — the one shape every audio package reads or writes.
//
// This file is the contract docs/AUDIO-BUILD-PLAN.md freezes first, so the
// fetcher, the worker, the store, the engine component and the UI can be built
// in parallel against it. Change it only with a version bump and a migration
// note in that plan; a silent change here breaks packages built against it.
//
// What is kept per track is deliberately small (~2 KB): the audio itself is
// never stored (plan §7). Everything is plain JSON so IndexedDB, Firestore-free
// sync and Node scripts all hold it the same way.

export const RECORD_VERSION = 2;
/**
 * Oldest version still read as current. v2 only added the optional second
 * ears (`maest`, `clap`), so a v1 record is a complete v2 record without them
 * and nobody has to re-listen. Raise this only for a change that breaks v1.
 */
export const MIN_RECORD_VERSION = 1;
const readable = v => Number.isInteger(v) && v >= MIN_RECORD_VERSION && v <= RECORD_VERSION;

/** Identifies the ear. Bump MODEL when the backbone or its input changes. */
export const MODEL = 'discogs-effnet-bsdynamic-1';
export const N_STYLES = 400;
export const EMB_DIM = 1280;
export const TOP_STYLES = 10;      // styles kept per track
export const SECTION_TOP = 3;      // styles kept per section (patch)

/**
 * Second ears (record v2, Option C). Each is optional, carries its own model
 * id, and is checked on its own by earCurrent(): a stale or missing second ear
 * re-queues only that ear, never the base record above.
 *
 * MAEST (WP-C1): a transformer on the same Discogs400 label order as effnet,
 * run per 10 s window. `styles` like rec.styles, `emb` its 768-d embedding.
 * CLAP (WP-C2): the audio half of a text–audio model; `emb` only, compared
 * against the build-time text table.
 */
export const MAEST_MODEL = 'discogs-maest-10s-pw-2-int8';
export const MAEST_DIM = 768;
export const MAEST_N_STYLES = 400;
// larger_clap_music_and_speech, not larger_clap_music: the music-only
// checkpoint's text tower is collapsed (every prompt within cosine 0.999 of
// every other, measured 2026-11-14), so text and audio could never be matched.
// Same architecture and size; see docs/AUDIO-BUILD-PLAN.md §7.
export const CLAP_MODEL = 'larger_clap_music_and_speech-audio-q8-1';
export const CLAP_DIM = 512;
export const EARS = Object.freeze({
  maest: Object.freeze({ model: MAEST_MODEL, dim: MAEST_DIM, nStyles: MAEST_N_STYLES }),
  clap: Object.freeze({ model: CLAP_MODEL, dim: CLAP_DIM, nStyles: 0 }),
});

/** Why a track has no audio answer. A miss is cached too, with a TTL. */
export const MISS = Object.freeze({
  NO_ISRC: 'NO_ISRC',             // Spotify gave no ISRC: never guess by name
  NOT_ON_DEEZER: 'NOT_ON_DEEZER',
  NO_PREVIEW: 'NO_PREVIEW',       // on Deezer, but no readable preview
  IDENTITY: 'IDENTITY',           // duration check failed: probably another recording
  TOO_SHORT: 'TOO_SHORT',         // fewer than one 128-frame patch decoded
  FAILED: 'FAILED',               // network/decode error: NEVER cached as a miss
});
/** Misses that are facts about the catalogue, re-asked after MISS_TTL_MS. */
export const CACHEABLE_MISS = new Set([MISS.NO_ISRC, MISS.NOT_ON_DEEZER, MISS.NO_PREVIEW, MISS.IDENTITY, MISS.TOO_SHORT]);
export const MISS_TTL_MS = 90 * 24 * 3600 * 1000;

/**
 * Quantise an embedding to int8 with one scale, base64-packed: 1280 floats
 * -> ~1.7 KB of text, cosine preserved to ~0.9999 (tested).
 * @param {Float32Array|number[]} emb
 * @returns {{ s: number, q: string }}
 */
export function packEmbedding(emb) {
  let max = 0;
  for (const v of emb) max = Math.max(max, Math.abs(v));
  const s = max > 0 ? max / 127 : 1;
  const bytes = new Uint8Array(emb.length);
  for (let i = 0; i < emb.length; i++) bytes[i] = (Math.round(emb[i] / s) + 256) & 0xff;
  return { s, q: toBase64(bytes) };
}

/** @returns {Float32Array} */
export function unpackEmbedding({ s, q }) {
  const bytes = fromBase64(q);
  const out = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = (bytes[i] > 127 ? bytes[i] - 256 : bytes[i]) * s;
  return out;
}

/**
 * Build a record from one analysis. `activations` and `embeddings` are the
 * model's per-patch outputs, row-major ([patches × 400], [patches × 1280]).
 *
 * @param {object} a
 * @param {string} a.id            Spotify track id (the store key)
 * @param {string} a.isrc
 * @param {Float32Array} a.activations
 * @param {Float32Array} a.embeddings
 * @param {number} a.patches
 * @param {object} a.source        { kind: 'deezer-isrc', deezerId, windows: [[startByte, bytes]...], seconds }
 * @param {string} a.mel           MEL_VERSION used
 * @param {object} [a.heads]       optional head outputs, see HEADS in docs/AUDIO-BUILD-PLAN.md
 * @param {object} [a.dsp]         optional { bpm, bpmConf, key, keyConf, loudness, energy }
 * @param {object} [a.maest]       optional second ear, see makeEar()
 * @param {object} [a.clap]        optional second ear, see makeEar()
 * @param {number} [a.at]
 */
export function makeRecord({ id, isrc, activations, embeddings, patches, source, mel, heads = null, dsp = null, maest = null, clap = null, at = Date.now() }) {
  if (!id || !(patches > 0)) throw new Error('makeRecord needs an id and at least one patch');
  if (activations.length !== patches * N_STYLES || embeddings.length !== patches * EMB_DIM)
    throw new Error('activation/embedding shape does not match patch count');

  const meanAct = new Float32Array(N_STYLES), meanEmb = new Float32Array(EMB_DIM);
  const sections = [];
  for (let p = 0; p < patches; p++) {
    const row = activations.subarray(p * N_STYLES, (p + 1) * N_STYLES);
    for (let k = 0; k < N_STYLES; k++) meanAct[k] += row[k] / patches;
    for (let k = 0; k < EMB_DIM; k++) meanEmb[k] += embeddings[p * EMB_DIM + k] / patches;
    sections.push(topK(row, SECTION_TOP));
  }
  return {
    v: RECORD_VERSION, id, isrc, model: MODEL, mel, at,
    source,
    styles: topK(meanAct, TOP_STYLES),   // [[classIndex, prob], ...] — labels are a hint, not a verdict
    sections,                            // per patch, in time order: what changes inside the clip
    emb: packEmbedding(meanEmb),         // the ear: what placement and learning use
    heads, dsp, maest, clap,
  };
}

/**
 * A second ear's field. `embedding` is the ear's mean embedding; `activations`
 * (MAEST only) its mean style probabilities, of which the top TOP_STYLES are kept.
 * @param {'maest'|'clap'} ear
 * @param {{ embedding: Float32Array|number[], activations?: Float32Array|number[] }} out
 */
export function makeEar(ear, { embedding, activations = null }) {
  const spec = EARS[ear];
  if (!spec) throw new Error(`unknown ear: ${ear}`);
  if (embedding?.length !== spec.dim) throw new Error(`${ear} embedding must be ${spec.dim}-d`);
  const field = { model: spec.model, emb: packEmbedding(embedding) };
  if (spec.nStyles) {
    if (activations?.length !== spec.nStyles) throw new Error(`${ear} needs ${spec.nStyles} activations`);
    field.styles = topK(Float32Array.from(activations), TOP_STYLES);
  }
  return field;
}

/** A copy of `rec` with one second ear filled (or cleared with null). The base ear is untouched. */
export function withEar(rec, ear, value) {
  if (!EARS[ear]) throw new Error(`unknown ear: ${ear}`);
  if (!rec || rec.miss) throw new Error('a second ear needs a heard record');
  if (value != null && !validEar(ear, value)) throw new Error(`malformed ${ear} field`);
  return { ...rec, v: RECORD_VERSION, [ear]: value ?? null };
}

/** Does this record carry a current, well-formed `ear`? False when absent or from an older model. */
export function earCurrent(rec, ear) {
  const v = rec?.[ear];
  return !!v && !rec.miss && v.model === EARS[ear]?.model && validEar(ear, v);
}

function validEar(ear, v) {
  const spec = EARS[ear];
  try {
    if (!spec || !v || typeof v.model !== 'string') return false;
    if (!Number.isFinite(v.emb?.s) || unpackEmbedding(v.emb).length !== spec.dim) return false;
    if (!spec.nStyles) return true;
    return Array.isArray(v.styles) && v.styles.length > 0 &&
      v.styles.every(([i, p]) => Number.isInteger(i) && i >= 0 && i < spec.nStyles && p >= 0 && p <= 1);
  } catch { return false; }
}

/** A cacheable "could not hear it" answer. FAILED is refused: a dropped request is not an answer. */
export function makeMiss({ id, isrc = null, reason, at = Date.now() }) {
  if (!CACHEABLE_MISS.has(reason)) throw new Error(`not a cacheable miss: ${reason}`);
  return { v: RECORD_VERSION, id, isrc, model: MODEL, at, miss: reason };
}

/**
 * Is this stored value still a usable, current answer? Stale model/mel
 * versions and expired misses both mean "analyse again".
 */
export function isCurrent(rec, { mel, now = Date.now() } = {}) {
  if (!rec || !readable(rec.v) || rec.model !== MODEL) return false;
  if (rec.miss) return now - rec.at < MISS_TTL_MS;
  return !mel || rec.mel === mel;
}

/** Shape check for anything read back from storage. Never throws. */
export function validRecord(rec) {
  try {
    if (!rec || !readable(rec.v) || typeof rec.id !== 'string') return false;
    if (rec.miss) return CACHEABLE_MISS.has(rec.miss);
    if (!Array.isArray(rec.styles) || !rec.styles.length) return false;
    if (!rec.styles.every(([i, p]) => Number.isInteger(i) && i >= 0 && i < N_STYLES && p >= 0 && p <= 1)) return false;
    // A second ear may be absent or null; present, it must be well-formed (any model id: earCurrent judges that).
    for (const ear of Object.keys(EARS)) if (rec[ear] != null && !validEar(ear, rec[ear])) return false;
    return unpackEmbedding(rec.emb).length === EMB_DIM && Number.isFinite(rec.emb.s);
  } catch { return false; }
}

function topK(arr, k) {
  const idx = Array.from(arr.keys()).sort((a, b) => arr[b] - arr[a]).slice(0, k);
  return idx.map(i => [i, +arr[i].toFixed(4)]);
}

// btoa/atob exist in browsers and Node ≥16; Buffer is not used so this stays isomorphic.
function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromBase64(str) {
  const s = atob(str), out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
