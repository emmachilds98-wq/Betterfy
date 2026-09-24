// §25's four products, built on core/recommend/similarity.mjs.
//
// All four are proposals. Nothing here writes, queues a write, or produces an
// instruction to move an existing placement — that is §21 (misfile), which is
// the other half of phase 10 and is not built yet on purpose. The distinction
// is not pedantry: "this track would also fit here" and "this track is in the
// wrong place" are the same similarity number read with different authority,
// and only the second one can lose somebody their filing.
//
// What §25 calls Discover is split in two here, because only one half is
// reachable. External discovery — music you do not own — needs a network
// source, and Spotify's /recommendations endpoint is gone (README, "Why it
// uses Last.fm and Discogs"); v1's discover.mjs does it from Last.fm's
// similar-artist graph and continues to. What v3 adds is the half that needs
// nothing at all: music you already own that your filing never reached, and
// the genres you are actively playing but have barely filed.
import { similarTracks, fitToPlaylist, compare, SIMILARITY, RECOMMEND_VERSION } from './similarity.mjs';
import { CONFIDENCE } from '../analysis/classify.mjs';
import { lineageOf } from '../ontology/index.mjs';

/** Every distinct track in a library, once, with its profile entry attached. */
export function libraryTracks(lib, profiles) {
  const out = new Map();
  const consider = t => {
    if (!t?.id || out.has(t.id)) return;
    const e = profiles?.get?.(t.id);
    if (e?.dna) out.set(t.id, { id: t.id, name: t.name, artists: t.artists ?? [], dna: e.dna, profile: e.profile });
  };
  for (const p of lib?.playlists ?? []) for (const t of p.tracks ?? []) consider(t);
  for (const t of lib?.liked ?? []) consider(t);
  return out;
}

/**
 * Which playlists each track is filed in.
 *
 * Exported so a caller asking several of these questions in one pass builds
 * it once. It is a full walk of every playlist, and missingFromPlaylist() is
 * asked once per bucket — rebuilding it inside each call makes the cost
 * quadratic in playlists for no reason.
 */
export function placements(lib) {
  const where = new Map();
  for (const p of lib?.playlists ?? [])
    for (const t of p.tracks ?? []) {
      if (!t?.id) continue;
      if (!where.has(t.id)) where.set(t.id, new Set());
      where.get(t.id).add(p.id);
    }
  return where;
}

/**
 * "More like this" — §25's first product.
 *
 * Note what it will not do. It declines on a seed the engine cannot classify,
 * and it drops matches that rest on a shared artist cloud, so a track whose
 * only evidence is its artist's tags produces an empty answer rather than
 * that artist's back catalogue at a similarity of 1.0. An empty answer with a
 * reason is more use than a confident-looking list of the same artist.
 */
export function moreLikeThis(trackId, { lib, profiles, tracks = null, top = 20,
                                        allowSameArtist = false } = {}) {
  const all = tracks ?? libraryTracks(lib, profiles);
  const seed = all.get(trackId);
  if (!seed) return { declined: 'UNKNOWN_TRACK', seed: trackId, results: [] };
  const out = similarTracks(seed.dna, all.values(), { top, allowSameArtist });
  return { ...out, seedName: seed.name ?? null, seedArtist: seed.artists?.[0]?.name ?? null };
}

/**
 * "Missing from playlist" — tracks you own that belong in a bucket and are
 * not in it.
 *
 * Declines on anything that is not a filing destination, which is where the
 * plan's worked example lands: a 20-track "Fabric September 2025" is an EVENT
 * playlist, so it is never offered additions, however well its contents match
 * the rest of the library. An event is a record of a night, and topping it up
 * six months later is not an improvement to it.
 *
 * Rejections are honoured permanently (§39, and CorrectionLog.rejectedFor's
 * "they meant it"): a track the listener has said no to for this playlist is
 * never offered for it again, whatever the evidence later says.
 */
export function missingFromPlaylist(playlistId, { lib, profiles, tracks = null, fingerprints,
                                                  classifications, corrections = null, filedIn = null,
                                                  top = 25, perArtist = SIMILARITY.MAX_PER_ARTIST } = {}) {
  const fp = fingerprints?.get?.(playlistId);
  const cls = classifications?.get?.(playlistId);
  if (!fp || !cls) return { declined: 'UNKNOWN_PLAYLIST', playlist: playlistId, results: [] };
  if (!cls.isTarget)
    return { declined: 'NOT_A_FILING_DESTINATION', playlist: playlistId, name: fp.name,
             type: cls.type, results: [],
             // Said plainly, because this is the answer most often mistaken
             // for a bug: the playlist is fine, it is just not a bucket.
             why: `${cls.type} playlists do not take filing suggestions` };

  const all = tracks ?? libraryTracks(lib, profiles);
  const already = new Set((lib?.playlists ?? []).find(p => p.id === playlistId)?.tracks?.map(t => t.id) ?? []);
  const where = filedIn ?? placements(lib);

  const results = [];
  for (const t of all.values()) {
    if (already.has(t.id)) continue;
    if (corrections?.rejectedFor?.(t.id)?.includes?.(playlistId)) continue;
    const fit = fitToPlaylist(t.dna, fp);
    if (!fit.fits) continue;
    results.push({ id: t.id, name: t.name, artist: t.artists?.[0]?.name ?? null,
                   genre: t.dna.primaryGenre, score: fit.centroid,
                   confidence: fit.confidence, basis: t.dna.basis ?? null,
                   // How many playlists this track is already in. A stray and
                   // a track filed in three other buckets are two different
                   // suggestions — one is "you lost this", the other is "this
                   // could also live here" — and they score identically, so
                   // the count is the only thing that tells them apart.
                   filedIn: where.get(t.id)?.size ?? 0 });
  }
  results.sort((a, b) => b.score - a.score || (a.name ?? '').localeCompare(b.name ?? ''));

  const seen = new Map(), capped = [];
  for (const r of results) {
    const key = r.artist ?? r.id;
    const n = seen.get(key) ?? 0;
    if (n >= perArtist) continue;
    seen.set(key, n + 1);
    capped.push(r);
    if (capped.length >= top) break;
  }
  return { playlist: playlistId, name: fp.name, type: cls.type, target: fp.primaryGenre,
           considered: all.size,
           // Split out because it is the number worth acting on first: a
           // bucket missing tracks nothing else holds is missing them, and a
           // bucket that could absorb half the library is a different report.
           strays: capped.filter(r => r.filedIn === 0).length,
           results: capped, version: RECOMMEND_VERSION };
}

/**
 * Music you own that your filing never reached.
 *
 * Liked-but-unfiled is the honest definition: a track in no playlist is one
 * the listener kept and then lost. Each comes with the destination it would
 * go to, if one is confident enough to name — and with nothing at all if not,
 * rather than a best guess, because an unfiled track with no good home is a
 * real and common state and pretending otherwise fills buckets with noise.
 */
export function unfiled({ lib, profiles, tracks = null, fingerprints = null,
                          classifications = null, filedIn = null, top = 50 } = {}) {
  const all = tracks ?? libraryTracks(lib, profiles);
  const where = filedIn ?? placements(lib);
  const targets = [];
  if (fingerprints && classifications)
    for (const [id, cls] of classifications) if (cls.isTarget) {
      const fp = fingerprints.get(id);
      if (fp) targets.push({ id, fp });
    }

  const out = [];
  for (const t of lib?.liked ?? []) {
    if (!t?.id || (where.get(t.id)?.size ?? 0) > 0) continue;
    const entry = all.get(t.id);
    if (!entry) continue;
    let best = null;
    for (const { id, fp } of targets) {
      const fit = fitToPlaylist(entry.dna, fp);
      if (!fit.fits) continue;
      if (!best || fit.centroid > best.score)
        best = { playlist: id, name: fp.name, score: fit.centroid, confidence: fit.confidence };
    }
    out.push({ id: t.id, name: t.name, artist: t.artists?.[0]?.name ?? null,
               genre: entry.dna.primaryGenre, confidence: entry.dna.genreConfidence,
               // Absent, not null-with-a-guess, when nothing fits.
               ...(best ? { suggested: best } : {}) });
  }
  out.sort((a, b) => (b.suggested?.score ?? 0) - (a.suggested?.score ?? 0));
  return { unfiled: out.length, withDestination: out.filter(x => x.suggested).length,
           results: out.slice(0, top), version: RECOMMEND_VERSION };
}

/**
 * Genres you are actively playing and have barely filed.
 *
 * Deliberately does NOT use listeningWeights(). That function blends real
 * plays with a floor derived from how much of an artist you already own,
 * which is the right weighting for "whose tags should I fetch first" and
 * exactly the wrong one here: this question compares playing against owning,
 * and a signal containing both cannot answer it. Only the artists Spotify
 * reports as recently or heavily played are counted.
 *
 * @param {{recentlyActive?: Set<string>}} listening  from listening.mjs
 */
export function underservedGenres({ lib, profiles, tracks = null, listening = null,
                                    filedIn = null, minPlayed = 3 } = {}) {
  const active = listening?.recentlyActive;
  if (!active?.size)
    return { declined: 'NO_LISTENING_HISTORY', results: [],
             why: 'nothing to compare filing against without recent plays' };

  const all = tracks ?? libraryTracks(lib, profiles);
  const where = filedIn ?? placements(lib);
  const played = new Map(), filed = new Map();
  const bump = (m, k) => { if (k) m.set(k, (m.get(k) ?? 0) + 1); };

  for (const t of all.values()) {
    const g = t.dna.primaryGenre;
    if (!g) continue;
    // Roll up to the level a listener would name a playlist at: the concept
    // itself and its parents, so eight tracks split across four house
    // subgenres read as eight house tracks rather than four thin ones.
    const line = lineageOf(g);
    const isPlayed = (t.artists ?? []).some(a => a?.name && active.has(a.name));
    for (const c of line) {
      if (isPlayed) bump(played, c);
      if ((where.get(t.id)?.size ?? 0) > 0) bump(filed, c);
    }
  }

  const results = [];
  for (const [concept, plays] of played) {
    if (plays < minPlayed) continue;
    const have = filed.get(concept) ?? 0;
    results.push({ concept, played: plays, filed: have,
                   ratio: +(plays / Math.max(1, have)).toFixed(2) });
  }
  results.sort((a, b) => b.ratio - a.ratio || b.played - a.played);
  return { results, version: RECOMMEND_VERSION };
}

/**
 * Propose a playlist for a concept — §25's builder.
 *
 * A proposal, returned; nothing is created. Tracks are ordered by how
 * specifically they were classified rather than by a similarity score: a
 * track whose own answer IS the requested genre belongs ahead of one that
 * merely sits under it, and both belong ahead of one that got there through
 * an artist cloud.
 */
export function buildPlaylist({ genre, size = 40, minConfidence = CONFIDENCE.AMBIGUOUS } = {},
                              { lib, profiles, tracks = null, corrections = null } = {}) {
  if (!genre) return { declined: 'NO_TARGET', results: [] };
  const all = tracks ?? libraryTracks(lib, profiles);
  const allowed = { [CONFIDENCE.HIGH]: 3, [CONFIDENCE.LIKELY]: 2,
                    [CONFIDENCE.AMBIGUOUS]: 1, [CONFIDENCE.INSUFFICIENT_DATA]: 0 };
  const floor = allowed[minConfidence] ?? 1;

  const picks = [];
  for (const t of all.values()) {
    // A correction is this listener's answer and outranks the evidence
    // entirely (§39: never overwrite a user correction) — including the
    // confidence floor, since a person who has said what a track is has
    // settled it whatever the providers manage to say about it.
    const corrected = corrections?.genreOf?.(t.id) ?? null;
    const g = corrected ?? t.dna.primaryGenre;
    if (!g) continue;
    const depth = lineageOf(g).indexOf(genre);
    if (depth < 0) continue;                    // not under the requested genre at all
    if (!corrected && (allowed[t.dna.genreConfidence] ?? 0) < floor) continue;
    picks.push({ id: t.id, name: t.name, artist: t.artists?.[0]?.name ?? null,
                 genre: g, exact: depth === 0, distance: depth,
                 confidence: corrected ? 'CORRECTED' : t.dna.genreConfidence,
                 basis: corrected ? 'correction' : (t.dna.basis ?? null) });
  }

  // Ordered by how specifically the track was placed, not by a similarity
  // score: an exact answer beats one that merely sits under the target, a
  // statement about the recording beats one about its artist, and the
  // listener's own correction beats all of it.
  const rankOf = p => (p.exact ? 0 : p.distance) * 10
    + (p.basis === 'correction' ? -1 : p.basis === 'track' ? 0 : p.basis === 'release' ? 1 : 2)
    + (3 - (p.basis === 'correction' ? 3 : (allowed[p.confidence] ?? 0)));
  picks.sort((a, b) => rankOf(a) - rankOf(b) || (a.name ?? '').localeCompare(b.name ?? ''));

  return {
    target: genre,
    // The honest denominator: how many of the library's tracks could even be
    // considered, before any of the ranking above.
    considered: all.size,
    matched: picks.length,
    results: picks.slice(0, size),
    version: RECOMMEND_VERSION,
  };
}

export { compare, similarTracks, fitToPlaylist, SIMILARITY };
