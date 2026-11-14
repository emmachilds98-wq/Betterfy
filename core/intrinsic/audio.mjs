// What a track sounds like, against what each of this account's playlists
// sounds like.
//
// WP-E1 of docs/AUDIO-BUILD-PLAN.md. Records come from the audio worker in the
// frozen shape of `core/audio/record.mjs`; this module turns them into one more
// nullable component for the intrinsic space, shaped like
// `bonus-rekordbox.mjs`: an index, a per-destination profile, and a score that
// is `null` — never 0 — whenever it cannot be judged.
//
// The rule it inherits from that module (and CLAUDE.md): with no audio records
// the engine's output is byte-identical. Nothing here touches a space; it only
// reads one. `combine()` drops null components and renormalises, so an account
// with no analysed tracks pays nothing. `test/audiocomponent.test.mjs` asserts
// it.
//
// Geometry, matching what phase 0 measured (scripts/audio-phase0/score.py §2,
// 58% top-1 / 76% top-2 by nearest centroid): every embedding is unit-normalised
// first, a playlist's centroid is the mean of its analysed members' unit
// embeddings renormalised, and a track scores the plain cosine to it. The score
// is a raw cosine in [-1, 1], not rescaled: how much weight it earns, and how
// sharply to read it, is WP-E2's measured decision and calibrate.mjs's fit, not
// a prior baked in here.
//
// Deliberately no import from `space.mjs`. WP-E2 wires this module into
// space.mjs, and `bundler.mjs` refuses an import cycle (there is no order to
// emit one in), so importing `MIN_DEFINITION_TRACKS` from there would make the
// wiring unbuildable. The value is restated as `MIN_AUDIO_MEMBERS` and a test
// pins the two equal, so they cannot drift apart silently.
import { validRecord, isCurrent, unpackEmbedding, EMB_DIM } from '../audio/record.mjs';

export const AUDIO_COMPONENT_VERSION = '1.0.0';

/**
 * A playlist needs this many *analysed* members before its sound is a
 * definition rather than a coincidence. Equal to space.mjs's
 * `MIN_DEFINITION_TRACKS` (pinned by test), and for the same reason: below it
 * a centroid is one or two records wearing a playlist's name.
 */
export const MIN_AUDIO_MEMBERS = 5;

const idOf = t => (typeof t === 'string' ? t : t?.id) || null;

/** Unit-normalise into a new Float32Array, or null for a zero/non-finite vector. */
function unit(v) {
  let ss = 0;
  for (let i = 0; i < v.length; i++) ss += v[i] * v[i];
  if (!(ss > 0) || !Number.isFinite(ss)) return null;
  const inv = 1 / Math.sqrt(ss);
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] * inv;
  return out;
}

function dot(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d;
}

/** Records may arrive as an array, any iterable, a Map, or a plain id → record object. */
function recordsOf(records) {
  if (!records || typeof records !== 'object') return [];
  if (records instanceof Map) return records.values();
  if (typeof records[Symbol.iterator] === 'function') return records;
  return Object.values(records);
}

/**
 * Spotify id → `{ emb, styles, rec }` for every usable analysed record.
 *
 * Usable means: passes `validRecord` (the shape check for anything read back
 * from storage), is not a miss, is from the current model (`isCurrent` — an
 * embedding from another backbone lives in a different space and must never
 * share a centroid with this one), and has a non-zero embedding. `emb` is
 * unit-normalised. Never throws: junk, misses and stale records are simply
 * not in the index, which is the ordinary case.
 *
 * Two records for one id: the newer (`at`) wins.
 *
 * @param {Iterable<object>|Record<string, object>|null} records
 * @param {{ mel?: string }} [opts]  pass the page's MEL_VERSION to also drop
 *        records computed with another front end
 * @returns {Map<string, { emb: Float32Array, styles: Array<[number, number]>, rec: object }>}
 */
export function audioIndex(records, { mel = undefined } = {}) {
  const index = new Map();
  for (const rec of recordsOf(records)) {
    if (!validRecord(rec) || rec.miss) continue;
    if (!isCurrent(rec, { mel })) continue;
    const prev = index.get(rec.id);
    if (prev && !((rec.at ?? 0) > (prev.rec.at ?? 0))) continue;
    let emb;
    try { emb = unit(unpackEmbedding(rec.emb)); } catch { emb = null; }
    if (!emb || emb.length !== EMB_DIM) continue;
    index.set(rec.id, { emb, styles: rec.styles, rec });
  }
  return index;
}

/**
 * A playlist's sound: the mean of its analysed members' unit embeddings,
 * renormalised. `members` counts distinct analysed tracks (a track filed twice
 * is one sound, not two votes toward the definition threshold).
 *
 * Also carries what leave-one-out needs to be O(dimensions) instead of a
 * rebuild: `sum` (the un-normalised sum of member unit embeddings) and `ids`
 * (which tracks are in it). See `profileWithout`.
 *
 * @param {Iterable<string|{id:string}>} playlistTrackIds  ids or track objects
 * @param {Map} index  from `audioIndex`
 * @param {{ skip?: Set<string> }} [opts]  ids to treat as not filed (fold-level leave-out)
 * @returns {{ centroid: Float32Array|null, members: number, sum: Float64Array, ids: Set<string> } | null}
 *          null when no member is analysed. `centroid` is null only in the
 *          degenerate case of members cancelling to a zero vector.
 */
export function audioProfileOf(playlistTrackIds, index, { skip = null } = {}) {
  if (!index?.size || !playlistTrackIds) return null;
  const ids = new Set();
  let sum = null;
  for (const t of playlistTrackIds) {
    const id = idOf(t);
    if (!id || ids.has(id) || skip?.has(id)) continue;
    const row = index.get(id);
    if (!row) continue;
    ids.add(id);
    sum ??= new Float64Array(row.emb.length);
    for (let i = 0; i < sum.length; i++) sum[i] += row.emb[i];
  }
  if (!ids.size) return null;
  return { centroid: unit(sum), members: ids.size, sum, ids };
}

/**
 * Leave-one-out: the same profile with one member taken out, as if it had
 * never been filed there. Returns the profile unchanged when the track is not
 * one of its analysed members, and null when removing it leaves nothing.
 *
 * Why it exists: scoring a filed track against a centroid that contains the
 * track itself flatters every accuracy number (the track votes for its own
 * home). WP-E2's with/without harness and WP-L1's learning curves need the
 * honest version per track, and rebuilding every profile per track is
 * needlessly slow. The result equals `audioProfileOf` over the remaining
 * members up to float rounding (tested to 1e-6).
 */
export function profileWithout(profile, trackId, index) {
  const id = idOf(trackId);
  if (!profile || !id || !profile.ids?.has(id)) return profile ?? null;
  const row = index?.get(id);
  if (!row || profile.members <= 1) return null;
  const sum = Float64Array.from(profile.sum);
  for (let i = 0; i < sum.length; i++) sum[i] -= row.emb[i];
  const ids = new Set(profile.ids);
  ids.delete(id);
  return { centroid: unit(sum), members: ids.size, sum, ids };
}

/** A destination-like thing → its member ids. Space destinations carry `trackIds`. */
function memberIdsOf(d) {
  if (d?.trackIds) return d.trackIds;
  if (Array.isArray(d?.tracks)) return d.tracks;
  return null;
}

/**
 * Every destination's sound profile, worked out once — the audio half of a
 * space. WP-E2 attaches the result as `space.audio`; this module never edits
 * the space it reads.
 *
 * `destinations` may be a whole space (its `.destinations` Map is used), that
 * Map itself, or an array of playlists `{ id, tracks }`. Using the space's own
 * destinations is the intended path: they are already filtered for mirrors,
 * `targets` and `skip`, so audio judges exactly the buckets the rest of the
 * engine does. `skip` is honoured again here for the raw-playlist path.
 *
 * Profiles below `minMembers` are kept (a UI can say "3 of 12 analysed") but
 * score null in `audioScores`.
 *
 * @returns {{ index: Map, profiles: Map<string, object>, size: number, version: string, minMembers: number }}
 *          `size` counts destinations with enough analysed members to judge.
 */
export function buildAudioProfiles(destinations, index, { skip = null, minMembers = MIN_AUDIO_MEMBERS } = {}) {
  const profiles = new Map();
  let size = 0;
  if (index?.size) {
    const src = destinations?.destinations ?? destinations;
    const list = src instanceof Map ? src.values() : (src ?? []);
    for (const d of list) {
      if (!d?.id) continue;
      const prof = audioProfileOf(memberIdsOf(d) ?? [], index, { skip });
      if (!prof) continue;
      profiles.set(d.id, prof);
      if (prof.members >= minMembers && prof.centroid) size++;
    }
  }
  return { index: index ?? new Map(), profiles, size, version: AUDIO_COMPONENT_VERSION, minMembers };
}

/**
 * Sound scores for one track: destination id → cosine to that destination's
 * centroid, or null for a destination with fewer than `minMembers` analysed
 * members (null, never 0: "can't judge" is not "sounds wrong").
 *
 * Returns null outright — as `bridgeScores` does — when the space has no audio
 * or the track has not been heard, so the caller adds nothing to `parts` and
 * the placement is byte-identical to one without this module.
 *
 * `space` is a space carrying `.audio` (from `buildAudioProfiles`), or that
 * audio object itself.
 *
 * `leaveOneOut: true` scores a track against each playlist it is itself an
 * analysed member of with itself removed (`profileWithout`), and re-applies
 * the `minMembers` floor to what remains. Off by default to match the other
 * components, which only leave a track out when the space was built with
 * `skip`; turn it on when grading the engine against tracks already filed
 * without rebuilding profiles per fold.
 *
 * @returns {Map<string, number|null> | null}
 */
export function audioScores(track, space, { leaveOneOut = false, minMembers = null } = {}) {
  const audio = space?.audio ?? (space?.profiles instanceof Map ? space : null);
  if (!audio?.index?.size || !audio.profiles?.size) return null;
  const id = idOf(track);
  const row = id ? audio.index.get(id) : null;
  if (!row) return null;
  const floor = minMembers ?? audio.minMembers ?? MIN_AUDIO_MEMBERS;

  const out = new Map();
  for (const [destId, base] of audio.profiles) {
    const prof = leaveOneOut ? profileWithout(base, id, audio.index) : base;
    out.set(destId, prof?.centroid && prof.members >= floor ? +dot(row.emb, prof.centroid).toFixed(6) : null);
  }
  return out;
}
