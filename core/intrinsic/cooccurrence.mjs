// Artist co-occurrence — this account's own taxonomy, expressed without a
// vocabulary.
//
// Every other genre signal in this project is somebody else's opinion about an
// artist: Last.fm's crowd, Discogs' submitters, or the shipped tag table that
// is one library's taste checked for shape rather than truth. This module reads
// no opinion at all. It reads where the listener put things.
//
// If two artists keep turning up in the same playlists, they belong together
// *in this person's world* — which is the only world the filing decision is
// about. A listener who files Chicago house and Detroit techno into one bucket
// and a listener who keeps them rigorously apart produce different graphs from
// the same catalogue, and both graphs are right about their owner.
//
// Raw co-occurrence counts are the wrong measure, for exactly the reason raw
// tag counts were: a prolific artist co-occurs with everybody and would come
// out as everybody's neighbour. So pairs are scored by positive pointwise
// mutual information, which asks whether two artists appear together *more
// than their individual frequencies already explain*.
//
//     ppmi(a,b) = max(0, log( P(a,b) / (P(a)·P(b)) ))
//
// with probabilities estimated over playlists rather than tracks, so a
// 400-track bucket and a 12-track bucket each cast one vote about whether two
// artists belong together. Counting tracks instead would let one enormous
// playlist decide the whole graph.
import { mirrorPredicate } from '../playlists/mirror.mjs';

export const COOCCURRENCE_VERSION = '4.0.0';

/**
 * An artist appearing in exactly one playlist has no co-occurrence evidence
 * worth the name — every pair it forms is a single coincidence, and including
 * it inflates the pair count without adding signal. Two is the smallest number
 * that can distinguish a pattern from an accident.
 */
export const MIN_ARTIST_PLAYLISTS = 2;

/**
 * Neighbourhoods are truncated to the strongest K. A full PPMI row over a few
 * thousand artists is mostly near-zero noise, and the tail costs memory and
 * time on a phone for nothing. K=50 is a starting prior, not a measured
 * optimum — it goes into the fit sweep like everything else.
 */
export const TOP_K = 50;

/**
 * A playlist with an enormous distinct-artist count contributes O(n²) pairs
 * while saying very little per pair — "these 800 artists are all vaguely
 * house" is not the same claim as "these 9 artists go together". Past this
 * width a playlist still contributes its artists' document frequencies but not
 * its pairs, which keeps one sprawling bucket from dominating the graph and
 * keeps the build tractable.
 *
 * This is deliberately separate from mirror detection. A mirror is a record of
 * everything and is dropped entirely; a merely *broad* playlist is a real
 * filing decision whose pairwise evidence is just too diffuse to use.
 */
export const MAX_PAIRWISE_ARTISTS = 400;

/** Billing order matters: the first credit carries the record, a fourth
 *  featured vocalist does not. Weights decay geometrically from the front. */
export const BILLING_DECAY = 0.5;

/**
 * The distinct artist ids in a playlist, as a Set.
 *
 * Distinct, because a playlist holding nine tracks by one artist is one
 * statement about that artist and not nine — the same reason `playlistReach()`
 * counts playlists rather than placements.
 */
export function artistsOf(playlist, { skip = null } = {}) {
  const out = new Set();
  for (const t of playlist?.tracks ?? []) {
    if (!t?.id) continue;
    if (skip?.has(t.id)) continue;
    for (const a of t.artists ?? []) if (a?.id) out.add(a.id);
  }
  return out;
}

/**
 * Build the co-occurrence graph over an account's own playlists.
 *
 * `skip` is the mechanism that makes honest validation possible: the
 * leave-one-out harness passes the held-out track's id, and every count below
 * is computed as though that track had never been filed. Without it the graph
 * has already seen the answer it is about to be tested on — see
 * `core/validate/loo.mjs`, which has a test whose whole job is to prove the
 * difference is real.
 *
 * @param {object} lib          a library.json-shaped object
 * @param {object}   [opts]
 * @param {Set<string>} [opts.skip]     track ids to treat as unfiled
 * @param {Function} [opts.isMirror]    caller-known mirror predicate, in
 *                                      addition to the structural one
 * @returns {{ppmi: Map<string, Map<string, number>>, df: Map<string, number>,
 *            playlists: number, artists: number, pairsConsidered: number,
 *            wideSkipped: number, version: string}}
 */
export function cooccurrence(lib, { skip = null, isMirror = null } = {}) {
  const structural = mirrorPredicate(lib, { also: isMirror ?? undefined });

  // A playlist holding the whole library co-occurs everything with everything
  // and would flatten the graph into uniform noise. It is a record, not a
  // filing decision — see core/playlists/mirror.mjs.
  const sets = [];
  for (const p of lib?.playlists ?? []) {
    if (structural(p)) continue;
    const a = artistsOf(p, { skip });
    if (a.size >= 2) sets.push(a);
  }

  const N = sets.length;
  const df = new Map();
  for (const s of sets) for (const a of s) df.set(a, (df.get(a) ?? 0) + 1);

  // Two passes on purpose. Filtering to artists with real document frequency
  // *before* enumerating pairs is what keeps this from being quadratic in the
  // whole artist list: a library's long tail of one-playlist artists is
  // usually most of it.
  const keep = new Set();
  for (const [a, n] of df) if (n >= MIN_ARTIST_PLAYLISTS) keep.add(a);

  // Pair counts in a nested Map rather than one keyed by `${a}\0${b}`.
  // Measured, not preferred: at 400 playlists the string-keyed version
  // allocated a key per pair — 5.2 million of them — and pushed the heap past
  // 1.1 GB, which a phone does not have. Nesting reuses the outer artist id and
  // allocates nothing per pair.
  const pair = new Map();          // a -> (b -> playlists containing both)
  let pairsConsidered = 0, wideSkipped = 0;
  for (const s of sets) {
    const list = [...s].filter(a => keep.has(a)).sort();
    if (list.length > MAX_PAIRWISE_ARTISTS) { wideSkipped++; continue; }
    for (let i = 0; i < list.length; i++) {
      let row = pair.get(list[i]);
      if (!row) { row = new Map(); pair.set(list[i], row); }
      for (let j = i + 1; j < list.length; j++) {
        row.set(list[j], (row.get(list[j]) ?? 0) + 1);
        pairsConsidered++;
      }
    }
  }

  // ppmi(a,b) = max(0, log( (df(a,b)·N) / (df(a)·df(b)) )).
  // Reached from P(a,b)/(P(a)P(b)) with every probability over playlists; the N
  // ends up in the numerator because two of the three denominators cancel.
  const rows = new Map();
  for (const [a, row] of pair) {
    const dfa = df.get(a);
    for (const [b, co] of row) {
      const v = Math.log((co * N) / (dfa * df.get(b)));
      if (!(v > 0)) continue;      // also rejects NaN, which a zero df would give
      let ra = rows.get(a); if (!ra) { ra = new Map(); rows.set(a, ra); }
      let rb = rows.get(b); if (!rb) { rb = new Map(); rows.set(b, rb); }
      ra.set(b, v);
      rb.set(a, v);
    }
  }

  // Truncate to the strongest K per artist. Done after scoring rather than
  // during, because a pair's strength is not known until both document
  // frequencies are.
  const ppmi = new Map();
  for (const [a, row] of rows) {
    const top = [...row.entries()].sort((x, y) => y[1] - x[1]).slice(0, TOP_K);
    ppmi.set(a, new Map(top));
  }

  return { ppmi, df, playlists: N, artists: ppmi.size,
           pairsConsidered, wideSkipped, version: COOCCURRENCE_VERSION };
}

/**
 * A track's position in the artist graph: the billing-weighted blend of its
 * credited artists' neighbourhoods, plus each artist itself.
 *
 * Including the artist's own identity matters. Two tracks by one artist should
 * read as related even in a library where that artist appears in only one
 * playlist and therefore has no neighbours at all — and in a *new* account
 * that is the common case rather than the edge case.
 */
export function trackVector(track, graph) {
  const artists = (track?.artists ?? []).map(a => a?.id).filter(Boolean);
  if (!artists.length) return new Map();

  const vec = new Map();
  let total = 0;
  artists.forEach((id, i) => {
    const w = Math.pow(BILLING_DECAY, i);
    total += w;
    vec.set(id, (vec.get(id) ?? 0) + w);          // identity
    for (const [nb, v] of graph?.ppmi?.get(id) ?? []) {
      vec.set(nb, (vec.get(nb) ?? 0) + w * v);    // neighbourhood
    }
  });

  if (total > 0) for (const [k, v] of vec) vec.set(k, v / total);
  return vec;
}

/** The Euclidean norm of a sparse vector. */
export function norm(v) {
  let n = 0;
  for (const x of v.values()) n += x * x;
  return Math.sqrt(n);
}

/**
 * Cosine over two sparse maps. Iterates the shorter side.
 *
 * `normA` / `normB` let a caller supply a norm it already knows. That is not a
 * micro-optimisation: ranking one track against 400 buckets recomputed each
 * bucket's norm every time, and a bucket centroid can hold thousands of
 * entries, which was most of the 52 ms a single placement took on a large
 * library. Precomputed once at `buildSpace`, it is a rounding error.
 */
export function cosine(a, b, normA = null, normB = null) {
  if (!a?.size || !b?.size) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [k, v] of small) { const o = large.get(k); if (o) dot += v * o; }
  if (!dot) return 0;
  const d = (normA ?? norm(a)) * (normB ?? norm(b));
  return d > 0 ? dot / d : 0;
}

/** Mean of sparse vectors — a playlist's position in the artist graph. */
export function centroid(vectors) {
  const sum = new Map();
  let n = 0;
  for (const v of vectors) {
    if (!v?.size) continue;
    n++;
    for (const [k, x] of v) sum.set(k, (sum.get(k) ?? 0) + x);
  }
  if (!n) return new Map();
  for (const [k, x] of sum) sum.set(k, x / n);
  return sum;
}
