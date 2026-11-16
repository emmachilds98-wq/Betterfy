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
import { CONFIDENCE } from '../analysis/confidence.mjs';
import { mirrorPredicate } from '../playlists/mirror.mjs';

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
export function playlistReach(lib, { isMirror = null } = {}) {
  const mirror = isMirror ?? mirrorPredicate(lib);
  const reach = new Map();
  for (const p of lib?.playlists ?? []) {
    // A record-of-everything playlist adds one to every track alike, which is
    // not blast radius — it is a constant, and it pushed the whole library
    // over the queue's MANY_PLAYLISTS threshold at once.
    if (mirror(p)) continue;
    // Distinct playlists, not placements. A playlist that contains the same
    // track twice is a duplicate — which this project has a whole report
    // about — and counting it twice inflated the blast radius of exactly the
    // tracks most likely to be duplicated.
    const seen = new Set();
    for (const t of p.tracks ?? []) {
      if (!t?.id || seen.has(t.id)) continue;
      seen.add(t.id);
      reach.set(t.id, (reach.get(t.id) ?? 0) + 1);
    }
  }
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

/** What the engine knows about an artist from its tag count, on the confidence scale. */
const artistConfidence = n => (n <= 0 ? CONFIDENCE.INSUFFICIENT_DATA : n < 3 ? CONFIDENCE.AMBIGUOUS : CONFIDENCE.LIKELY);

/**
 * The order to spend enrichment requests in (BUILD-6 D9): the tag-gap fill and
 * the similar-artist lookups, most-listened and least-known artists first, by
 * analysisPriority, so a run cut short by a closed tab, a quota or a five-minute
 * attention span has already covered what this listener actually plays.
 *
 * `weights` are listening only — Spotify's top artists over three windows and
 * recently played, by name (listenedWeights below: no library floor). When there
 * are none (no listening data, or it failed) the entries come back in exactly
 * the order they went in: byte-identical to not calling this at all.
 *
 * No `reach` (spread) term, deliberately, though analysisPriority takes one:
 * measured on the large non-owner fixture (test/enrichorder.test.mjs), adding
 * the number of playlists an artist is filed in let widely-filed artists nobody
 * plays push listened ones out of the first 100 Last.fm requests (96% -> 88%
 * of the top-100 listened covered). Uncertainty stays: an artist with no tags
 * at all goes before one with a thin answer, at equal listening.
 *
 * @param {Iterable} entries     e.g. [artistId, name] pairs, or [id, {name}] for a bridge Map
 * @param {object}   o
 * @param {Map<string, number>} [o.weights]  listening weight by artist name
 * @param {(id: string) => number} [o.tagCount]  tags the artist already has
 * @param {(e) => string} [o.idOf]
 * @param {(e) => string} [o.nameOf]
 */
export function enrichOrder(entries, { weights = null, tagCount = () => 0,
                                       idOf = e => e[0], nameOf = e => e[1] } = {}) {
  const list = [...(entries ?? [])];
  if (!weights?.size) return list;
  const scored = list.map((e, i) => {
    const id = idOf(e);
    const p = analysisPriority({ profile: { genre: { confidence: artistConfidence(tagCount(id)) } } },
                               { weights, track: { id, artists: [{ name: nameOf(e) }] } });
    return [e, i, p];
  });
  return scored.sort((a, b) => (b[2] - a[2]) || (a[1] - b[1])).map(x => x[0]);
}

/** Listening-only weights from the raw listening fetch ({ topWindows, recentArtists }), or null when there is none. */
export function listenedWeights(raw) {
  const w = listeningWeights({ topWindows: raw?.topWindows ?? [], recentArtists: raw?.recentArtists ?? [] });
  return w.size ? w : null;
}
