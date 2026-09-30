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
import { cooccurrence, trackVector, cosine, centroid, norm } from './cooccurrence.mjs';
import { registrantIndex, profileOf, shapeScores, registrantOf, registrantWeight,
         formatOf, eraOf } from './features.mjs';
import { mirrorPredicate } from '../playlists/mirror.mjs';
import { explain } from './explain.mjs';
import { bonusIndex, bonusProfileOf, bonusScores } from './bonus-rekordbox.mjs';

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
  // Bonus layer (§4.7). Present only for a listener who has imported a
  // Rekordbox collection, and null for every track that import does not cover —
  // which `combine()` drops rather than scoring zero, so the weights below
  // cannot affect anybody who does not have the file.
  bpm:         0.40,
  key:         0.25,
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
export function buildSpace(lib, { skip = null, isMirror = null, rekordbox = null } = {}) {
  // Absent by default and absent for almost everybody. `bonusIndex(null)` is an
  // empty lookup, which makes every bonus score null, which makes the whole
  // layer free.
  const bonus = bonusIndex(rekordbox);
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
    // Counts rather than only membership, because an explanation has to be able
    // to say "who are in this playlist 12 times" — a set can say that an artist
    // is here, which is not the same claim and is far less convincing.
    const artistCounts = new Map();
    const registrantCounts = new Map();
    for (const t of tracks) {
      for (const a of t.artists ?? []) {
        if (!a?.id) continue;
        const row = artistCounts.get(a.id) ?? { name: a.name ?? null, n: 0 };
        row.n++;
        if (!row.name && a.name) row.name = a.name;
        artistCounts.set(a.id, row);
      }
      const r = registrantOf(t);
      if (r) registrantCounts.set(r, (registrantCounts.get(r) ?? 0) + 1);
    }

    const centroidVec = centroid(tracks.map(t => trackVector(t, graph)));
    destinations.set(p.id, {
      id: p.id,
      name: p.name ?? null,
      n: tracks.length,
      profile: profileOf(p, { skip }),
      centroid: centroidVec,
      centroidNorm: norm(centroidVec),
      artists: new Set(artistCounts.keys()),
      artistCounts,
      registrantCounts,
      // Membership by id, so overlap between two buckets can be measured
      // without walking either one again.
      trackIds: new Set(tracks.map(t => t.id)),
      bonusProfile: bonus.size ? bonusProfileOf(p, bonus, { skip }) : null,
    });
  }

  // Library-wide base rates, so an explanation can tell a distinguishing fact
  // from a universal one. "A single, and 100% of this bucket is too" is not a
  // reason to choose this bucket when 100% of every bucket is a single — it is
  // a horoscope. The same IDF instinct that stopped "electronic" dominating
  // every tag comparison, applied to explanations.
  const everyTrack = [];
  for (const d of destinations.values()) everyTrack.push(d);
  const baseline = { albumType: new Map(), era: new Map(), n: 0 };
  for (const d of everyTrack) {
    for (const [k, share] of d.profile.albumType) {
      baseline.albumType.set(k, (baseline.albumType.get(k) ?? 0) + share * d.n);
    }
    for (const [k, share] of d.profile.era) {
      baseline.era.set(k, (baseline.era.get(k) ?? 0) + share * d.n);
    }
    baseline.n += d.n;
  }
  if (baseline.n) {
    for (const m of [baseline.albumType, baseline.era]) {
      for (const [k, v] of m) m.set(k, v / baseline.n);
    }
  }

  return { graph, registrants, destinations, baseline, bonus, version: SPACE_VERSION };
}

/**
 * Combine the present components into one score.
 *
 * Renormalising over what is present is the whole trick: it means "we could not
 * judge this" and "this scored badly" are different outcomes, which is the
 * distinction the tag engine could never make and the reason it always returned
 * its strongest guess.
 */
export function combine(parts, weights = WEIGHTS) {
  let num = 0, den = 0;
  const used = {};
  for (const [k, w] of Object.entries(weights)) {
    const v = parts[k];
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    num += w * v;
    den += w;
    used[k] = +v.toFixed(4);
  }
  return { score: den > 0 ? num / den : 0, used, judged: Object.keys(used).length };
}

/**
 * Returns `{ declined }` rather than a weak list when there is nothing to go
 * on — the same refusal the v3 classifier makes, for the same reason: a ranking
 * is always *producible*, which is exactly why producing one is not evidence
 * that it means anything.
 */
/**
 * Rank this account's buckets for one track.
 *
 * `why` is off by default because the harness scores thousands of tracks and
 * none of them needs prose. A UI asks for it; a sweep does not.
 */
export function placements(track, space, { limit = 5, exclude = null, why = false,
                                           weights = WEIGHTS } = {}) {
  if (!track?.id) return { declined: 'NO_TRACK', results: [] };
  if (!space?.destinations?.size) return { declined: 'NO_DESTINATIONS', results: [] };

  const vec = trackVector(track, space.graph);
  const vecNorm = norm(vec);
  const rows = [];
  for (const d of space.destinations.values()) {
    if (exclude?.has(d.id)) continue;
    const shape = shapeScores(track, d.profile, { registrants: space.registrants });
    const graph = vec.size && d.centroid.size
      ? cosine(vec, d.centroid, vecNorm, d.centroidNorm) : null;
    const extra = space.bonus?.size ? bonusScores(track, d.bonusProfile, space.bonus)
                                    : { bpm: null, key: null };
    const { score, used, judged } = combine({ graph, ...shape, ...extra }, weights);
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

  const results = rows.slice(0, limit);
  if (why) {
    for (const r of results) {
      r.why = explain(track, space.destinations.get(r.playlistId), space);
    }
  }

  return {
    declined: band === BANDS.NONE ? 'WEAK_SIGNAL' : null,
    band,
    margin: +margin.toFixed(4),
    results,
    version: SPACE_VERSION,
  };
}
