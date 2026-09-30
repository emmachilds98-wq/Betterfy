// What this account's own structure says about itself.
//
// The placement engine answers "where does this track go". These reports answer
// the questions the owner actually asked: what *are* the differences between my
// playlists, which of them are really the same thing twice, and what am I
// keeping apart that the library says is one pile?
//
// None of it needs a genre vocabulary, which is what makes it work on any
// account. A distinction is visible here when the tracks either side of it
// differ; it is invisible when they do not. That is a statement about the
// listener's library rather than about music, and it is the only kind of
// statement that transfers between accounts.
import { cosine, trackVector } from './cooccurrence.mjs';
import { placements, THRESHOLDS, MIN_DEFINITION_TRACKS, BANDS } from './space.mjs';
import { mirrorPredicate } from '../playlists/mirror.mjs';

export const REPORTS_VERSION = '4.0.0';

export const PAIRS = {
  /** Above this, two buckets sit in the same place in the artist graph. */
  SIMILAR: 0.6,
  /** Above this share of shared members, one is a view of the other rather
   *  than a separate idea that happens to resemble it. */
  OVERLAP: 0.5,
};

/** A cluster smaller than this is a handful of records, not a missing bucket. */
export const MIN_CLUSTER = 5;

/* ---------- 1. which buckets are actually different ---------- */

/**
 * Compare every pair of buckets on two independent axes, because the
 * interesting cases need both.
 *
 *   - **similarity** — do their members sit in the same region of the artist
 *     graph?
 *   - **overlap** — do they literally share tracks?
 *
 * High on both is a *view*: "Tech House" and "Tech House — Favourites". The
 * engine should not treat those as rival destinations, and §19's containment
 * relationships already find them.
 *
 * High similarity with *low* overlap is the finding worth surfacing: two
 * buckets the listener keeps apart, holding different records, that the library
 * cannot tell apart. Either the distinction lives in something not captured
 * here — a feel, a tempo, a memory — or it has quietly stopped being a
 * distinction. Only the owner can say which, which is exactly why this reports
 * rather than acts.
 */
export function bucketPairs(space, { similar = PAIRS.SIMILAR, overlap = PAIRS.OVERLAP } = {}) {
  const buckets = [...space.destinations.values()];
  const out = [];

  for (let i = 0; i < buckets.length; i++) {
    for (let j = i + 1; j < buckets.length; j++) {
      const a = buckets[i], b = buckets[j];
      const similarity = cosine(a.centroid, b.centroid);

      // Overlap against the smaller bucket: a 12-track bucket wholly inside a
      // 400-track one is entirely contained, and dividing by the larger would
      // report that as 3% and miss it.
      let shared = 0;
      const small = a.n <= b.n ? a : b;
      const large = small === a ? b : a;
      for (const id of small.trackIds ?? []) if (large.trackIds?.has(id)) shared++;
      const share = small.n ? shared / small.n : 0;

      let verdict = 'distinct';
      if (share >= overlap) verdict = 'view';
      else if (similarity >= similar) verdict = 'indistinguishable';

      if (verdict !== 'distinct') {
        out.push({
          a: { id: a.id, name: a.name, n: a.n },
          b: { id: b.id, name: b.name, n: b.n },
          similarity: +similarity.toFixed(4),
          overlap: +share.toFixed(4),
          sharedTracks: shared,
          verdict,
        });
      }
    }
  }

  return out.sort((x, y) => y.similarity - x.similarity);
}

/* ---------- 2. the tracks that sit on a border ---------- */

/**
 * Tracks whose best two destinations are too close to separate.
 *
 * These are the genuinely hard cases, and they are the best possible material
 * for the review queue: asking about a track the engine already places
 * confidently teaches it nothing, while asking about one it cannot split
 * resolves a boundary rather than a single record.
 */
export function boundaryTracks(lib, space, { margin = THRESHOLDS.AMBIGUOUS_MARGIN * 2,
                                             limit = 100, isMirror = null } = {}) {
  const mirror = mirrorPredicate(lib, { also: isMirror ?? undefined });
  const seen = new Set();
  const out = [];

  for (const p of lib?.playlists ?? []) {
    if (!p?.id || mirror(p)) continue;
    for (const t of p.tracks ?? []) {
      if (!t?.id || seen.has(t.id)) continue;
      seen.add(t.id);
      const r = placements(t, space, { limit: 2 });
      if (r.declined || r.results.length < 2) continue;
      const gap = r.results[0].score - r.results[1].score;
      if (gap > margin) continue;
      out.push({
        trackId: t.id, name: t.name ?? null,
        artists: (t.artists ?? []).map(a => a?.name ?? a?.id).filter(Boolean),
        between: r.results.slice(0, 2).map(x => ({ id: x.playlistId, name: x.name, score: x.score })),
        gap: +gap.toFixed(4),
        filedIn: [...(space.destinations.values())].filter(d => d.trackIds?.has(t.id)).map(d => d.id),
      });
    }
  }

  return out.sort((a, b) => a.gap - b.gap).slice(0, limit);
}

/* ---------- 3. buckets drifting from themselves ---------- */

/**
 * Whether a bucket's most recent additions still resemble the rest of it.
 *
 * `misfile.mjs` has a tag-based `findDrift`; this is its vocabulary-free twin.
 * Drift is not automatically wrong — taste moves, and a bucket that has quietly
 * become something else is a normal thing for a bucket to do. It is worth
 * *saying*, because the alternative is an engine that keeps filing into what
 * the bucket used to be.
 */
export function drift(lib, space, { recent = 10, isMirror = null } = {}) {
  const mirror = mirrorPredicate(lib, { also: isMirror ?? undefined });
  const out = [];

  for (const p of lib?.playlists ?? []) {
    if (!p?.id || mirror(p)) continue;
    const d = space.destinations.get(p.id);
    if (!d || d.n < MIN_DEFINITION_TRACKS * 2) continue;

    const dated = (p.tracks ?? []).filter(t => t?.id && t.added_at)
      .sort((a, b) => Date.parse(a.added_at) - Date.parse(b.added_at));
    if (dated.length < MIN_DEFINITION_TRACKS * 2) continue;

    const tail = dated.slice(-recent);
    const head = dated.slice(0, -recent);
    if (head.length < MIN_DEFINITION_TRACKS || tail.length < 3) continue;

    // Each half compared with the other, rather than each with the whole — a
    // centroid that already contains the tail cannot be surprised by it.
    const mean = rows => {
      const sum = new Map();
      let n = 0;
      for (const t of rows) {
        const v = trackVector(t, space.graph);
        if (!v.size) continue;
        n++;
        for (const [k, x] of v) sum.set(k, (sum.get(k) ?? 0) + x);
      }
      if (n) for (const [k, x] of sum) sum.set(k, x / n);
      return sum;
    };

    const similarity = cosine(mean(head), mean(tail));
    out.push({
      id: p.id, name: p.name ?? null,
      older: head.length, newer: tail.length,
      similarity: +similarity.toFixed(4),
      since: tail[0].added_at,
    });
  }

  return out.sort((a, b) => a.similarity - b.similarity);
}

/* ---------- 4. piles with no bucket ---------- */

/**
 * Groups of tracks that hang together but belong to no bucket.
 *
 * Greedy agglomeration on the intrinsic vector, over tracks the engine will not
 * confidently place. A cluster here is a bucket the listener has not made yet —
 * and unlike v1's tag-vector clustering, it can form around a group that no tag
 * source has ever named, which is the case where a missing bucket is most
 * likely to be real.
 */
export function unnamedClusters(tracks, space, { minCluster = MIN_CLUSTER,
                                                 similarity = 0.5, limit = 20 } = {}) {
  // What counts as "fits no bucket" is not a low score, which was the first
  // and wrong answer here. A record by artists this library has never seen
  // still matches any bucket on format, era and popularity — generic shape
  // clears an absolute threshold every time — so scoring alone would report
  // every stranger as comfortably placed.
  //
  // The question is which *kind* of evidence was available. A placement with no
  // artist-graph component at all is the engine guessing from the shape of the
  // object, and a placement it cannot separate from the runner-up is the engine
  // saying so outright. Those are the records with no home.
  const candidates = [];
  for (const t of tracks ?? []) {
    if (!t?.id) continue;
    const r = placements(t, space, { limit: 2 });
    const top = r.results?.[0];
    const homeless = r.declined
      || !top
      || top.parts?.graph === undefined          // no artist evidence at all
      || r.band === BANDS.AMBIGUOUS
      || top.score < THRESHOLDS.MIN_SCORE;
    if (!homeless) continue;
    const vec = trackVector(t, space.graph);
    if (vec.size) candidates.push({ track: t, vec });
  }

  const clusters = [];
  const used = new Set();
  for (let i = 0; i < candidates.length; i++) {
    if (used.has(i)) continue;
    const group = [i];
    used.add(i);
    for (let j = i + 1; j < candidates.length; j++) {
      if (used.has(j)) continue;
      if (cosine(candidates[i].vec, candidates[j].vec) >= similarity) { group.push(j); used.add(j); }
    }
    if (group.length >= minCluster) {
      clusters.push({
        size: group.length,
        tracks: group.map(k => ({
          id: candidates[k].track.id,
          name: candidates[k].track.name ?? null,
          artists: (candidates[k].track.artists ?? []).map(a => a?.name ?? a?.id).filter(Boolean),
        })),
      });
    }
  }

  return clusters.sort((a, b) => b.size - a.size).slice(0, limit);
}
