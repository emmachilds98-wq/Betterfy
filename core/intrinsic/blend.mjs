// Blending today's tag engine with the account-native engine (and its
// neighbour bridge) — docs/SMARTER-GENRES-PLAN.md §4.2(1), phase 1.
//
// The two engines are right about different tracks. Tags know what an artist
// is called by the crowd, so they place a well-tagged artist you have never
// filed; the account-native engine knows where *you* put that artist's
// neighbours, so it places the scene artists Last.fm has three listeners for.
// Rather than pick one, each (track, playlist) gets one score:
//
//   blended = w · tag/max(tag) + (1 − w) · native/max(native)
//
// Each engine is divided by its own best score for the track first, so the
// two are on one scale (the leader of each is 1) whatever either's raw range
// is. `w` is one number per account, fitted on the account's own held-out
// filing (core/validate/blend.mjs), never a guess.
//
// A side with nothing to say for a track (no tags at all, or the engine
// declined to score any playlist) drops out and the other carries the whole
// score — the same renormalising rule `combine()` uses for components. So an
// untagged track still gets the native engine's picks, which is half the point.
//
// Pure, and plain arrays in and out, so it runs the same in the worker, on the
// page and in Node.

export const BLEND_VERSION = '1.0.0';

/** The weights on the tag engine the fit tries: 0 (native only) … 1 (tags only). */
export const BLEND_GRID = Object.freeze([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]);

/**
 * One engine's scores for one track as a Map(playlist id → score ÷ best),
 * keeping only positive scores. Takes `[[id, score]]` (calibrate's `scoresOf`
 * shape), `[{id, score}]` (profile.mjs's `rank`), `[{playlistId, score}]`
 * (space.mjs's `placements`) or a Map. Empty when nothing scored above zero.
 */
export function normalise(scores) {
  const pairs = [];
  if (scores instanceof Map) for (const [id, s] of scores) pairs.push([id, s]);
  else for (const r of scores ?? []) {
    if (Array.isArray(r)) pairs.push([r[0], r[1]]);
    else if (r) pairs.push([r.id ?? r.playlistId, r.score]);
  }
  let best = 0;
  for (const [, s] of pairs) if (Number.isFinite(s) && s > best) best = s;
  const out = new Map();
  if (!(best > 0)) return out;
  for (const [id, s] of pairs) if (id != null && Number.isFinite(s) && s > 0) out.set(String(id), s / best);
  return out;
}

/**
 * The blended ranking for one track: `[[playlist id, score]]`, best first,
 * ties by id so two runs agree. `w` is the weight on the tag engine.
 *
 * A playlist only one engine scored gets 0 from the other. A track only one
 * engine has anything to say about is ranked by that engine alone.
 */
export function blendScores(tagScores, nativeScores, w) {
  const tag = tagScores instanceof Map && isNormalised(tagScores) ? tagScores : normalise(tagScores);
  const nat = nativeScores instanceof Map && isNormalised(nativeScores) ? nativeScores : normalise(nativeScores);
  let wt = Number.isFinite(w) ? Math.min(1, Math.max(0, w)) : 0.5;
  if (!tag.size && !nat.size) return [];
  if (!tag.size) wt = 0;
  else if (!nat.size) wt = 1;
  const ids = new Set([...tag.keys(), ...nat.keys()]);
  const out = [];
  for (const id of ids) {
    const s = wt * (tag.get(id) ?? 0) + (1 - wt) * (nat.get(id) ?? 0);
    if (s > 0) out.push([id, +s.toFixed(5)]);
  }
  return out.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

// A Map whose values already lie in (0, 1] with a 1 in it is taken as already
// normalised, so callers that normalise once and blend at several weights (the
// fit does, eleven times per track) don't pay for it again.
const NORMALISED = new WeakSet();
function isNormalised(m) { return NORMALISED.has(m); }

/** `normalise`, marked so `blendScores` uses it as it is. */
export function normalised(scores) {
  const m = normalise(scores);
  NORMALISED.add(m);
  return m;
}
