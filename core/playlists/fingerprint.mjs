// Playlist fingerprints — §16 of the v3 plan.
//
// v1 describes a playlist with one centroid: the average tag vector of its
// tracks. That is enough to rank a track against it and not much else. It
// cannot say a playlist is 48% Tech House and 27% Deep House, cannot tell a
// tight bucket from a broad one without conflating breadth with axis (the
// coherence experiment the browser build records as rejected), and has no
// notion at all of when the playlist was built or whose records are in it.
//
// A fingerprint is the fuller description: distributions rather than one
// average, over every dimension Music DNA carries, plus the two structural
// signals that need no vocabulary — how concentrated its artists are, and
// the shape of its addition dates.
import { dnaSimilarity } from '../analysis/music-dna.mjs';
import { GENRE_INDEX, lineageOf, commonAncestor } from '../ontology/index.mjs';

export const FINGERPRINT_VERSION = '3.0.0';

/** Below this, a distribution is noise rather than a description. */
export const MIN_PROFILED_TRACKS = 5;

/**
 * Normalised Shannon entropy of a distribution, 0 (all one thing) to 1
 * (evenly spread over everything present).
 *
 * This is the "is it mixed" number, and it is deliberately *not* the
 * coherence signal that was tried and rejected for telling genre from mood.
 * That one measured how tightly a playlist's tags agree, which turned out to
 * measure breadth. This measures breadth on purpose, and is only ever used to
 * say a playlist is mixed — never to say which axis it sits on.
 */
export function entropy(shares) {
  const vals = shares.filter(x => x > 0);
  if (vals.length < 2) return 0;
  const h = -vals.reduce((s, p) => s + p * Math.log(p), 0);
  return h / Math.log(vals.length);
}

/** Sum weighted values into shares of the total. */
function distribution(pairs) {
  const total = new Map();
  let sum = 0;
  for (const [key, w] of pairs) {
    if (!key || !(w > 0)) continue;
    total.set(key, (total.get(key) ?? 0) + w);
    sum += w;
  }
  if (!sum) return {};
  return Object.fromEntries([...total].sort((a, b) => b[1] - a[1]).map(([k, w]) => [k, +(w / sum).toFixed(4)]));
}

/**
 * How concentrated a playlist's artists are, as the Herfindahl index of their
 * shares: 1 when every track is by one artist, near 0 when every track is by
 * a different one. This is what separates an artist playlist from a genre
 * playlist without reading the name.
 */
export function artistConcentration(tracks) {
  const counts = new Map();
  let n = 0;
  for (const t of tracks ?? []) {
    const name = t?.artists?.[0]?.name;
    if (!name) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
    n++;
  }
  if (!n) return { concentration: 0, distinct: 0, top: [] };
  const shares = [...counts].map(([name, c]) => [name, c / n]).sort((a, b) => b[1] - a[1]);
  return {
    concentration: +shares.reduce((s, [, p]) => s + p * p, 0).toFixed(4),
    distinct: counts.size,
    top: shares.slice(0, 5).map(([name, share]) => ({ name, share: +share.toFixed(3) })),
  };
}

/* When a playlist was built, and whether it was left alone afterwards.
 *
 * Carried over from the browser build's addedShape(), which is the one
 * content signal there that holds up — and it holds up precisely because it
 * needs no vocabulary at all, so it works for a library nobody has tuned for.
 * Percentiles rather than first-to-last, so one track added late does not
 * hide a playlist otherwise built in an evening. */
export const ADDED_MIN_TRACKS = 8;

export function addedShape(tracks, now = Date.now()) {
  const at = (tracks ?? []).map(t => Date.parse(t?.added_at)).filter(Number.isFinite).sort((a, b) => a - b);
  if (at.length < ADDED_MIN_TRACKS) return null;
  const lo = at[Math.floor(at.length * 0.1)], hi = at[Math.ceil(at.length * 0.9) - 1];
  return {
    spanDays: +((hi - lo) / 86400000).toFixed(2),
    sinceDays: +((now - at[at.length - 1]) / 86400000).toFixed(2),
    firstAt: at[0],
    lastAt: at[at.length - 1],
    dated: at.length,
  };
}

/** The mean DNA genre vector of a set of tracks — the v1 centroid's successor. */
export function centroidOf(dnas) {
  const c = new Map();
  const usable = dnas.filter(d => d && Object.keys(d.genre ?? {}).length);
  if (!usable.length) return {};
  for (const d of usable)
    for (const [k, x] of Object.entries(d.genre)) c.set(k, (c.get(k) ?? 0) + x / usable.length);
  return Object.fromEntries([...c].sort((a, b) => b[1] - a[1]));
}

/**
 * The share of a playlist's genre weight that sits under each top-level
 * genre. A playlist can be 90% electronic and still be split three ways
 * inside it, and those are different facts about it — the first says what it
 * is, the second says whether it is one bucket or several.
 */
function rootDistribution(genreShares) {
  const roots = [];
  for (const [concept, share] of Object.entries(genreShares)) {
    const line = lineageOf(concept);
    roots.push([line[line.length - 1] ?? concept, share]);
  }
  return distribution(roots);
}

/** A clear majority of the tracks agreeing is enough to name the playlist. */
export const CONSENSUS_SHARE = 0.5;

/**
 * The playlist's genre, from what its tracks were actually classified as.
 *
 * Deliberately NOT the top of the lineage-weighted `genre` distribution.
 * That distribution carries every track's whole ancestry — a Tech House track
 * contributes to tech-house, house and electronic — which is right for
 * comparing two playlists and wrong for naming one: summed over forty
 * identical tracks, the parent outweighs the answer and a pure Tech House
 * bucket reports itself as "house".
 *
 * So the answers are counted, and when no single answer holds a majority the
 * playlist backs off to what its leading answers have in common. That is the
 * same reconciliation the track classifier does, one level up: a bucket split
 * between Tech House and Jungle is an electronic playlist, not whichever of
 * the two happened to have more tracks.
 */
export function consensusGenre(primaryShares) {
  const ranked = Object.entries(primaryShares);
  if (!ranked.length) return null;
  const [top, share] = ranked[0];
  if (share >= CONSENSUS_SHARE) return top;
  const leaders = ranked.filter(([, s]) => s >= share / 2).map(([g]) => g);
  return leaders.reduce((a, b) => (a && b ? (commonAncestor(a, b) ?? null) : null)) ?? top;
}

/**
 * Build a playlist's fingerprint from the profiles of its tracks.
 *
 * @param {{id: string, name: string, tracks: object[]}} playlist
 * @param {Map<string, {profile: object, dna: object}>} profiles  by Spotify track id
 * @param {{now?: number}} [opts]
 */
export function fingerprint(playlist, profiles, { now = Date.now() } = {}) {
  const tracks = playlist?.tracks ?? [];
  const entries = tracks.map(t => profiles?.get?.(t?.id)).filter(Boolean);
  const dnas = entries.map(e => e.dna).filter(Boolean);
  const profiled = dnas.filter(d => d.primaryGenre).length;

  // Every dimension is weighted by how confident the track's own answer was,
  // so a playlist full of INSUFFICIENT_DATA tracks does not acquire a
  // confident identity by sheer count.
  const genrePairs = [], subgenrePairs = [], moodPairs = [], contextPairs = [], eraPairs = [];
  const primaryPairs = [];
  const bands = {};
  for (const d of dnas) {
    bands[d.genreConfidence] = (bands[d.genreConfidence] ?? 0) + 1;
    if (d.primaryGenre) primaryPairs.push([d.primaryGenre, 1]);
    for (const [concept, w] of Object.entries(d.genre ?? {})) {
      genrePairs.push([concept, w]);
      // A "subgenre" here is any concept with a parent — the level a listener
      // actually files on, as opposed to the roots everything rolls up into.
      if (GENRE_INDEX.get(concept)?.parent) subgenrePairs.push([concept, w]);
    }
    for (const [concept, w] of Object.entries(d.mood ?? {})) moodPairs.push([concept, w]);
    for (const [concept, w] of Object.entries(d.context ?? {})) contextPairs.push([concept, w]);
    if (d.era) eraPairs.push([d.era, 1]);
  }

  const genre = distribution(genrePairs);
  const primaryGenres = distribution(primaryPairs);
  const centroid = centroidOf(dnas);
  const coherence = dnas.length > 1
    ? +(dnas.reduce((s, d) => s + dnaSimilarity(d, { genre: centroid }), 0) / dnas.length).toFixed(4)
    : (dnas.length ? 1 : 0);

  const bpms = dnas.map(d => d.bpm).filter(x => Number.isFinite(Number(x))).map(Number).sort((a, b) => a - b);

  return {
    id: playlist?.id ?? null,
    name: playlist?.name ?? '',
    tracks: tracks.length,
    profiled,
    // The honest denominator for everything below. A fingerprint over four
    // profiled tracks out of ninety is a description of four tracks.
    coverage: tracks.length ? +(profiled / tracks.length).toFixed(3) : 0,
    enoughToDescribe: profiled >= MIN_PROFILED_TRACKS,

    // Two distributions, for two different questions. `genre` is lineage-
    // weighted and is what playlists are compared with; `primaryGenres` is
    // what the tracks were each actually classified as, and is what the
    // playlist is named and measured for spread by.
    genre,
    primaryGenres,
    roots: rootDistribution(genre),
    subgenre: distribution(subgenrePairs),
    mood: distribution(moodPairs),
    context: distribution(contextPairs),
    era: distribution(eraPairs),

    primaryGenre: consensusGenre(primaryGenres),
    leadingGenre: Object.keys(primaryGenres)[0] ?? null,
    // How much of the playlist's genre picture rests on answers the track
    // engine was actually confident about. A playlist of forty tracks the
    // classifier called AMBIGUOUS looks perfectly coherent — every track is
    // uncertain in the same way — and without this it would acquire a
    // confident identity from forty shrugs.
    trackConfidence: bands,
    confidentShare: dnas.length
      ? +(((bands.HIGH ?? 0) + (bands.LIKELY ?? 0)) / dnas.length).toFixed(3) : 0,
    // Spread over the answers, not over their ancestry. Over the lineage
    // vector this was ~0.98 for every playlist including perfectly uniform
    // ones, because a three-deep ancestry always looks evenly spread.
    genreEntropy: +entropy(Object.values(primaryGenres)).toFixed(4),
    rootEntropy: +entropy(Object.values(rootDistribution(genre))).toFixed(4),
    coherence,

    artists: artistConcentration(tracks),
    added: addedShape(tracks, now),
    // Present only when something actually measured it, same rule as a track
    // profile: an absent BPM profile is a fact, a zero would be a lie.
    ...(bpms.length >= MIN_PROFILED_TRACKS ? { bpm: {
      median: bpms[Math.floor(bpms.length / 2)],
      p10: bpms[Math.floor(bpms.length * 0.1)],
      p90: bpms[Math.ceil(bpms.length * 0.9) - 1],
      n: bpms.length,
    } } : {}),

    centroid,
    version: FINGERPRINT_VERSION,
  };
}

/** Fingerprint every playlist in a library. */
export function fingerprintLibrary(lib, profiles, { now = Date.now() } = {}) {
  const out = new Map();
  for (const p of lib?.playlists ?? []) if (p?.id) out.set(p.id, fingerprint(p, profiles, { now }));
  return out;
}
