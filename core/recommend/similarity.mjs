// The similarity primitives behind §25 — the read-only half of phase 10.
//
// Everything here answers "how alike are these two pieces of music", and
// nothing here moves anything. §21's misfile detection is the other half of
// phase 10 and is deliberately not built on top of this yet: a similarity
// score becomes an instruction to move somebody's music, and the fit sweep
// (npm run benchmark:fit) still reports four of fifteen thresholds as
// uncontradicted rather than validated.
//
// The one thing this does that v1's rank() structurally cannot:
//
//   v1 compares a track's tag vector to a playlist centroid and always
//   returns a ranking. For a track whose only evidence is its artist's tag
//   cloud — which is most tracks — that vector IS the artist's vector, so
//   the top of any "more like this" is the rest of that artist's catalogue at
//   a similarity of 1.0. That is not a finding about the music. It is one set
//   of records compared with itself, and it looks identical to a real match.
//
// So similarity here is reported with the basis it rests on, and a pair that
// is alike only because it shares an artist cloud is marked as such rather
// than ranked first.
import { dnaSimilarity } from '../analysis/music-dna.mjs';
import { CONFIDENCE } from '../analysis/classify.mjs';
import { isWithin, commonAncestor, lineageOf } from '../ontology/index.mjs';

export const RECOMMEND_VERSION = '3.0.0';

/* Thresholds, gathered and named for the same reason the classifier's are:
 * so re-fitting them is a diff rather than an archaeology exercise. None of
 * these has been fitted against anything yet — they are declared priors, and
 * this comment is the honest label on them. */
export const SIMILARITY = {
  // Below this two tracks are not alike, they merely both exist. A cosine
  // over lineage vectors is generous: any two electronic tracks share a root
  // and score well above zero.
  MIN_SCORE: 0.45,
  // A "more like this" that is one artist's discography has answered a
  // different question than the one asked.
  MAX_PER_ARTIST: 2,
  // A recommendation resting on a shared artist cloud is not wrong, it is
  // uninformative — it says "same artist", which the listener can see.
  SHARED_CLOUD_DISCOUNT: 0.5,
  // Under this, a playlist's centroid describes too little to rank against.
  MIN_PLAYLIST_COHERENCE: 0.35,
};

/** Bands in order, so a pair can be capped at its weaker half. */
const BAND_ORDER = [CONFIDENCE.INSUFFICIENT_DATA, CONFIDENCE.AMBIGUOUS,
                    CONFIDENCE.LIKELY, CONFIDENCE.HIGH];

/**
 * The band a comparison may claim.
 *
 * Never stronger than its weaker half: a HIGH track matched against one the
 * engine knows nothing about is an INSUFFICIENT_DATA claim, however good the
 * cosine looks. The cosine is computed from both vectors, so it inherits the
 * uncertainty of both.
 */
export function pairConfidence(a, b) {
  const ia = BAND_ORDER.indexOf(a ?? CONFIDENCE.INSUFFICIENT_DATA);
  const ib = BAND_ORDER.indexOf(b ?? CONFIDENCE.INSUFFICIENT_DATA);
  return BAND_ORDER[Math.max(0, Math.min(ia < 0 ? 0 : ia, ib < 0 ? 0 : ib))];
}

/**
 * Whether two DNA vectors are alike only because they were computed from the
 * same records.
 *
 * True when the two share a credited artist and neither answer was reached
 * from anything more specific than that artist. In that case both vectors
 * came out of one tag cloud and their similarity is a tautology: it measures
 * the cloud against itself and would read 1.0 for an artist's ambient record
 * and their jungle one alike. That is the §4.1 failure the whole engine
 * exists to avoid, and it reappears here the moment two profiles are
 * compared rather than read.
 */
export function sharedBasis(a, b) {
  if (!a || !b) return false;
  const ids = new Set(a.artistIds ?? []);
  const shares = (b.artistIds ?? []).some(id => ids.has(id));
  if (!shares) return false;
  return (a.basis ?? 'artist') === 'artist' && (b.basis ?? 'artist') === 'artist';
}

/**
 * How two tracks relate, with the reason attached.
 *
 * `score` is the raw cosine, kept intact so it stays comparable with v1's and
 * with the playlist coherence numbers. `rank` is what a list should be
 * ordered by — the same number discounted when the pair rests on a shared
 * cloud. Keeping both means the discount is visible rather than baked into a
 * number that then gets quoted as a similarity.
 */
export function compare(a, b) {
  const score = dnaSimilarity(a, b);
  const shared = sharedBasis(a, b);
  const ancestor = a?.primaryGenre && b?.primaryGenre
    ? (a.primaryGenre === b.primaryGenre ? a.primaryGenre : commonAncestor(a.primaryGenre, b.primaryGenre))
    : null;
  return {
    score: +score.toFixed(4),
    rank: +(shared ? score * SIMILARITY.SHARED_CLOUD_DISCOUNT : score).toFixed(4),
    confidence: pairConfidence(a?.genreConfidence, b?.genreConfidence),
    basis: shared ? 'same-artist-cloud' : (a?.basis === 'track' && b?.basis === 'track' ? 'track' : 'mixed'),
    sharedArtist: shared,
    // What they actually have in common, in ontology terms. "Both house" is
    // a reason a listener can check; a cosine of 0.82 is not.
    via: ancestor,
    exact: !!(a?.primaryGenre && a.primaryGenre === b?.primaryGenre),
  };
}

/**
 * Rank candidates against a seed.
 *
 * Declines rather than guesses (§4.6). A seed the engine knows nothing about
 * produces no recommendations at all — not a weak ranking, which is what v1
 * returns and what makes its weakest suggestions indistinguishable from its
 * strongest.
 *
 * @param {object} seed        seed DNA
 * @param {Iterable<{id, name, artists?, dna}>} candidates
 * @param {{top?: number, minScore?: number, perArtist?: number,
 *          allowSameArtist?: boolean, exclude?: Set<string>}} [opts]
 */
export function similarTracks(seed, candidates, {
  top = 20, minScore = SIMILARITY.MIN_SCORE, perArtist = SIMILARITY.MAX_PER_ARTIST,
  allowSameArtist = false, exclude = null,
} = {}) {
  if (!seed || seed.genreConfidence === CONFIDENCE.INSUFFICIENT_DATA || !seed.primaryGenre)
    return { declined: 'INSUFFICIENT_DATA', seed: seed?.id ?? null, results: [] };

  const scored = [];
  for (const c of candidates ?? []) {
    if (!c?.dna || c.id === seed.id) continue;
    if (exclude?.has?.(c.id)) continue;
    if (c.dna.genreConfidence === CONFIDENCE.INSUFFICIENT_DATA) continue;
    const rel = compare(seed, c.dna);
    if (rel.score < minScore) continue;
    if (rel.sharedArtist && !allowSameArtist) continue;
    scored.push({ id: c.id, name: c.name ?? null,
                  artist: c.artists?.[0]?.name ?? null,
                  // What the match itself was classified as. A row saying
                  // only "0.82" is not something a listener can check; a row
                  // saying "Deep House, 0.82, both house" is.
                  genre: c.dna.primaryGenre ?? null, ...rel });
  }
  scored.sort((a, b) => b.rank - a.rank || (a.name ?? '').localeCompare(b.name ?? ''));

  // Cap per artist after ranking, not before: the cap is about the shape of
  // the answer, and applying it first would throw away an artist's best match
  // in favour of whichever of their tracks came first in library order.
  const seen = new Map(), out = [];
  for (const r of scored) {
    const key = r.artist ?? r.id;
    const n = seen.get(key) ?? 0;
    if (n >= perArtist) continue;
    seen.set(key, n + 1);
    out.push(r);
    if (out.length >= top) break;
  }
  return { seed: seed.id ?? null, seedGenre: seed.primaryGenre,
           seedConfidence: seed.genreConfidence, results: out, version: RECOMMEND_VERSION };
}

/**
 * How well one track fits a playlist, measured against its fingerprint.
 *
 * Two numbers rather than one, because they answer different questions and
 * averaging them would hide both: `centroid` is the cosine against the
 * playlist's mean vector (does it sound like the rest), and `withinAxis` is
 * whether the track's own answer sits inside the playlist's genre (is it the
 * kind of thing this bucket is for). A Deep House track scores well on the
 * first against a Tech House playlist and fails the second; a track that
 * passes both is a real suggestion.
 */
export function fitToPlaylist(dna, fp) {
  if (!dna || !fp?.centroid || !Object.keys(fp.centroid).length)
    return { fits: false, reason: 'NO_CENTROID' };
  if (!fp.enoughToDescribe) return { fits: false, reason: 'TOO_FEW_PROFILED' };
  if ((fp.coherence ?? 0) < SIMILARITY.MIN_PLAYLIST_COHERENCE)
    return { fits: false, reason: 'PLAYLIST_TOO_BROAD', coherence: fp.coherence };

  const centroid = dnaSimilarity(dna, { genre: fp.centroid });
  const target = fp.primaryGenre ?? null;
  const withinAxis = !!(target && dna.primaryGenre
    && (dna.primaryGenre === target || isWithin(dna.primaryGenre, target)));

  return {
    fits: centroid >= SIMILARITY.MIN_SCORE && withinAxis,
    centroid: +centroid.toFixed(4),
    withinAxis,
    target,
    // How specific the claim is. A track landing in the playlist's exact
    // genre is a stronger suggestion than one landing three levels above it.
    depth: dna.primaryGenre ? lineageOf(dna.primaryGenre).length : 0,
    confidence: pairConfidence(dna.genreConfidence,
      (fp.confidentShare ?? 0) >= 0.5 ? CONFIDENCE.LIKELY : CONFIDENCE.AMBIGUOUS),
  };
}
