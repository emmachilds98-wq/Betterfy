// Listening behaviour as a *priority* signal — §22.
//
// "It must NOT automatically determine objective genre." That sentence is why
// this module is here rather than in core/analysis, and why nothing in the
// classifier imports it. Two questions that look similar and are not:
//
//     What is this track?          -> evidence. Listening says nothing.
//     Is it worth my attention?    -> listening, almost entirely.
//
// v1 already fetches the raw numbers (listening.mjs) and combines them
// (listeningWeights in profile.mjs). Both are reused verbatim — this adds the
// second half §28 asks for, which is combining relevance with *uncertainty*
// so that expensive work goes to tracks that are both played a lot and badly
// understood, rather than to whichever came first in playlist order.
import { listeningWeights } from '../../profile.mjs';
import { CONFIDENCE } from '../analysis/classify.mjs';

export const RELEVANCE_VERSION = '3.0.0';

export { listeningWeights };

/**
 * How little the engine knows about a track, 0 (certain) to 1 (nothing).
 *
 * Deliberately steep between AMBIGUOUS and LIKELY. A LIKELY answer is usually
 * right and re-asking about it is close to wasted; an AMBIGUOUS one is a
 * coin-flip the listener will eventually be shown, and every one of those
 * resolved is a misfile that never happens.
 */
export const UNCERTAINTY = {
  [CONFIDENCE.INSUFFICIENT_DATA]: 1.0,
  [CONFIDENCE.AMBIGUOUS]: 0.9,
  [CONFIDENCE.LIKELY]: 0.45,
  [CONFIDENCE.HIGH]: 0.05,
};

export const uncertaintyOf = profile => UNCERTAINTY[profile?.genre?.confidence] ?? 0.5;

/**
 * How much this listener actually plays a track, as a multiplier on a floor
 * of 1 rather than a term added to a 0-1 uncertainty.
 *
 * Listening weights are unbounded and relative (see listeningWeights), so
 * adding them would let one heavily-played artist swamp the uncertainty
 * signal entirely and turn the whole queue into "your top artist, forty
 * times".
 */
export function relevanceOf(track, weights) {
  const w = weights?.get?.(track?.artists?.[0]?.name) ?? 0;
  return 1 + w;
}

/**
 * How many playlists a track sits in — its blast radius.
 *
 * §35 ranks "tracks affecting many playlists" highly, and rightly: getting
 * one wrong about a track filed in six places is six wrong answers, and it
 * also drags six centroids.
 */
export function playlistReach(lib) {
  const reach = new Map();
  for (const p of lib?.playlists ?? [])
    for (const t of p.tracks ?? []) if (t?.id) reach.set(t.id, (reach.get(t.id) ?? 0) + 1);
  return reach;
}

/**
 * §28's priority: high-use and uncertain first, rare and already-confident
 * last. The number expensive analysis is spent in order of.
 *
 * @param {{profile: object}} entry
 * @param {{weights?: Map, reach?: Map, track: object}} ctx
 */
export function analysisPriority({ profile }, { weights = null, reach = null, track } = {}) {
  const uncertainty = uncertaintyOf(profile);
  const played = relevanceOf(track, weights);
  // Reach is capped: a track in twelve playlists is not twelve times more
  // important than one in six, and without a cap the mirror playlist's
  // contents would sort to the top of everything.
  const spread = 1 + Math.min(3, (reach?.get?.(track?.id) ?? 1) - 1) * 0.25;
  return +(uncertainty * played * spread).toFixed(4);
}
