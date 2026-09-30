// The intrinsic space — where a track sits, and which of this account's
// buckets it sits nearest.
//
// This is the layer that answers the reframed question. It never asks what a
// record is; it asks which of the listener's own buckets it resembles, and it
// answers from the buckets' own members. The vocabulary problem disappears
// because no vocabulary is involved.
//
// Every number below is a declared prior, not a fitted value. There is no
// recommendation benchmark to fit against yet — but unlike the tag engine's
// thresholds, these have somewhere to go: leave-one-out placement accuracy over
// the account's own library is a real fitness surface with thousands of rows,
// and `core/validate/loo.mjs` computes it.
import { cooccurrence, trackVector, cosine, centroid } from './cooccurrence.mjs';
import { registrantIndex, profileOf, shapeScores } from './features.mjs';
import { mirrorPredicate } from '../playlists/mirror.mjs';

export const SPACE_VERSION = '4.0.0';

/**
 * Relative weights. `graph` leads because the artist neighbourhood is the only
 * component that carries what the listener *means* rather than what the record
 * merely *is*: format and era describe an object, co-occurrence describes a
 * taxonomy.
 *
 * Components that cannot be judged for a given track are dropped and the rest
 * renormalised, so a missing ISRC costs nothing rather than scoring zero.
 */
export const WEIGHTS = {
  graph:       1.00,
  registrant:  0.50,
  minutes:     0.25,
  era:         0.30,
  albumType:   0.20,
  albumTracks: 0.15,
  popularity:  0.10,
};

/**
 * A bucket needs enough members to have a definition at all. Below this its
 * centroid is one or two records wearing a playlist's name, and treating that
 * as a learned meaning is how an engine acquires confident nonsense.
 *
 * Matches `MIN_PROFILED_TRACKS` in the playlist fingerprint deliberately: the
 * two answer the same question about the same libraries.
 */
export const MIN_DEFINITION_TRACKS = 5;

/** Bands, in the vocabulary the rest of the engine already uses. */
export const BANDS = { HIGH: 'HIGH', LIKELY: 'LIKELY', AMBIGUOUS: 'AMBIGUOUS', NONE: 'INSUFFICIENT_DATA' };

export const THRESHOLDS = {
  /** A top score below this is not a placement, it is a shrug. */
  MIN_SCORE: 0.10,
  /** How far clear of the runner-up the leader must be to read as HIGH. */
  HIGH_MARGIN: 0.08,
  /** And how strong in absolute terms. */
  HIGH_SCORE: 0.35,
  /** Below this margin two buckets are genuinely competing. */
  AMBIGUOUS_MARGIN: 0.02,
};

/**
 * Build everything the scorer needs, once.
 *
 * `skip` threads all the way down. Passing a track id here makes the entire
 * space — graph, registrant spans, bucket profiles and centroids — behave as
 * though that track had never been filed, which is what honest leave-one-out
 * requires and what `core/validate/loo.mjs` exercises.
 *
 * Destinations are chosen **structurally**: every non-mirror playlist with
 * enough members. Deliberately not `playlists.config.json`, whose `target`
 * flags are generated from one person's library — an account-native engine
 * cannot start by reading a file that assumes whose account it is.
 */
export function buildSpace(lib, { skip = null, isMirror = null } = {}) {
  const graph = cooccurrence(lib, { skip, isMirror });
  const registrants = registrantIndex(lib, { skip, isMirror });

  // A playlist holding essentially the whole library is a record rather than a
  // home. `cooccurrence` already drops it from the graph; it must also never be
  // offered as a destination, or it wins every comparison by the trivial merit
  // of containing everything — one of the four silent failures the mirror fix
  // was written for. Same structural predicate, so the two cannot disagree.
  const isStructuralMirror = mirrorPredicate(lib, { also: isMirror ?? undefined });

  const destinations = new Map();
  for (const p of lib?.playlists ?? []) {
    if (!p?.id || isStructuralMirror(p)) continue;
    const tracks = (p.tracks ?? []).filter(t => t?.id && !skip?.has(t.id));
    if (tracks.length < MIN_DEFINITION_TRACKS) continue;
    destinations.set(p.id, {
      id: p.id,
      name: p.name ?? null,
      n: tracks.length,
      profile: profileOf(p, { skip }),
      centroid: centroid(tracks.map(t => trackVector(t, graph))),
      artists: new Set(tracks.flatMap(t => (t.artists ?? []).map(a => a?.id).filter(Boolean))),
    });
  }

  return { graph, registrants, destinations, version: SPACE_VERSION };
}

/**
 * Combine the present components into one score.
 *
 * Renormalising over what is present is the whole trick: it means "we could not
 * judge this" and "this scored badly" are different outcomes, which is the
 * distinction the tag engine could never make and the reason it always returned
 * its strongest guess.
 */
export function combine(parts) {
  let num = 0, den = 0;
  const used = {};
  for (const [k, w] of Object.entries(WEIGHTS)) {
    const v = parts[k];
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    num += w * v;
    den += w;
    used[k] = +v.toFixed(4);
  }
  return { score: den > 0 ? num / den : 0, used, judged: Object.keys(used).length };
}

/**
 * Rank this account's buckets for one track.
 *
 * Returns `{ declined }` rather than a weak list when there is nothing to go
 * on — the same refusal the v3 classifier makes, for the same reason: a ranking
 * is always *producible*, which is exactly why producing one is not evidence
 * that it means anything.
 */
export function placements(track, space, { limit = 5, exclude = null } = {}) {
  if (!track?.id) return { declined: 'NO_TRACK', results: [] };
  if (!space?.destinations?.size) return { declined: 'NO_DESTINATIONS', results: [] };

  const vec = trackVector(track, space.graph);
  const rows = [];
  for (const d of space.destinations.values()) {
    if (exclude?.has(d.id)) continue;
    const shape = shapeScores(track, d.profile, { registrants: space.registrants });
    const graph = vec.size && d.centroid.size ? cosine(vec, d.centroid) : null;
    const { score, used, judged } = combine({ graph, ...shape });
    if (!judged) continue;
    const shared = (track.artists ?? []).filter(a => a?.id && d.artists.has(a.id)).length;
    rows.push({ playlistId: d.id, name: d.name, score: +score.toFixed(4),
                parts: used, judged, sharedArtists: shared, members: d.n });
  }

  if (!rows.length) return { declined: 'NOTHING_JUDGEABLE', results: [] };
  rows.sort((a, b) => b.score - a.score || a.playlistId.localeCompare(b.playlistId));

  const top = rows[0], second = rows[1] ?? null;
  const margin = second ? top.score - second.score : top.score;

  let band = BANDS.LIKELY;
  if (top.score < THRESHOLDS.MIN_SCORE) band = BANDS.NONE;
  else if (margin < THRESHOLDS.AMBIGUOUS_MARGIN) band = BANDS.AMBIGUOUS;
  else if (top.score >= THRESHOLDS.HIGH_SCORE && margin >= THRESHOLDS.HIGH_MARGIN) band = BANDS.HIGH;

  return {
    declined: band === BANDS.NONE ? 'WEAK_SIGNAL' : null,
    band,
    margin: +margin.toFixed(4),
    results: rows.slice(0, limit),
    version: SPACE_VERSION,
  };
}
