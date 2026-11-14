// The neighbour bridge — "where did you file artists like this one?"
//
// The account-native engine's weakest case is a track by an artist this
// account has never filed: the artist graph has nothing to say about them, so
// it can only go on the record's shape (length, single or album, era), and
// shape cannot tell bassline from UKG. docs/SMARTER-GENRES-PLAN.md §4.1(b).
//
// The bridge borrows a neighbourhood from outside — Deezer's "fans also like"
// and ListenBrainz's listening-session similarity — and then asks only the
// account's own question of it: of this artist's neighbours that you HAVE
// filed, which of your playlists did they go into? So the outside sources never
// get to name a genre or define a playlist. They only say who sits near whom,
// and the votes land in this listener's own buckets, which keeps the engine
// account-native.
//
// Everything here is pure. The fetching is in `bridge-fetch.mjs`, and a bridge
// is plain JSON so it can cross to the worker and sit in IndexedDB unchanged.
// With no bridge, nothing in the engine changes: `buildSpace` adds nothing to
// the space and `placements` adds no component (test/bridge.test.mjs holds it
// to that).
import { BILLING_DECAY } from './cooccurrence.mjs';
import { normName } from '../sources/deezer.mjs';

export const BRIDGE_VERSION = '1.0.0';

/**
 * Who to look up: the first-billed artist of each track, with one ISRC to reach
 * them on Deezer by. First-billed, because the ISRC route checks the Deezer
 * credit against this name and the main credit is the one that reliably
 * matches. Order is kept, so a caller can put the artists that matter most
 * first and a run that stops early still did the useful half.
 *
 * @returns {Map<string, {name: string, isrc: string|null}>}
 */
export function sourceArtists(tracks) {
  const out = new Map();
  for (const t of tracks ?? []) {
    const a = (t?.artists ?? []).find(x => x?.id);
    if (!a) continue;
    const isrc = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(String(t.isrc ?? '').replace(/-/g, '').toUpperCase())
      ? String(t.isrc).replace(/-/g, '').toUpperCase() : null;
    const seen = out.get(a.id);
    if (!seen) out.set(a.id, { name: a.name ?? '', isrc });
    else if (!seen.isrc && isrc) seen.isrc = isrc;
  }
  return out;
}

/**
 * Every artist in the library, by normalised name — the fallback that maps an
 * outside neighbour back onto a Spotify artist when no exact id is known.
 *
 * A name two different artists in this library share maps to nothing. Inside
 * one person's library that is rare, and guessing between them is exactly the
 * same-name poisoning the ISRC route exists to avoid.
 */
export function libraryNames(lib) {
  const byName = new Map();
  const add = t => {
    for (const a of t?.artists ?? []) {
      if (!a?.id || !a.name) continue;
      const n = normName(a.name);
      if (!n) continue;
      const prev = byName.get(n);
      if (prev === undefined) byName.set(n, a.id);
      else if (prev !== a.id) byName.set(n, null);
    }
  };
  for (const p of lib?.playlists ?? []) for (const t of p.tracks ?? []) add(t);
  for (const t of lib?.liked ?? []) add(t);
  return byName;
}

/**
 * Turn raw lookups into a bridge: Spotify artist -> library neighbours, weighted.
 *
 * `raw[spotifyArtistId]` is what `gatherBridge()` stored:
 *   { deezerId, deezer: [{id, name}], mbid, listenbrainz: [{mbid, name, score}] }
 * Any of those may be missing; a source that was never answered just adds
 * nothing.
 *
 * A neighbour is mapped back exactly where it can be — a Deezer id or MBID that
 * some looked-up library artist resolved to — and by unique name otherwise.
 * Neighbours that are not in the library are dropped: they could never vote.
 *
 * Weights: Deezer's list is ranked, so rank sets the weight (first = 1, last =
 * 1/n); ListenBrainz gives a score, scaled so its best = 1. An artist both
 * sources name gets both — agreement between two independent sources is worth
 * more than either alone.
 */
export function bridgeFrom(raw, lib) {
  const byName = libraryNames(lib);
  const byDeezer = new Map(), byMbid = new Map();
  for (const [sid, e] of Object.entries(raw ?? {})) {
    if (e?.deezerId != null) byDeezer.set(String(e.deezerId), sid);
    if (e?.mbid) byMbid.set(String(e.mbid), sid);
  }
  const resolve = (exact, exactMap, name) =>
    (exact != null ? exactMap.get(String(exact)) : undefined) ?? byName.get(normName(name)) ?? null;

  const neighbours = {};
  const coverage = { asked: 0, deezer: 0, listenbrainz: 0, withNeighbours: 0 };
  for (const [sid, e] of Object.entries(raw ?? {})) {
    coverage.asked++;
    const w = new Map();
    const bump = (n, x) => { if (n && n !== sid && x > 0) w.set(n, (w.get(n) ?? 0) + x); };

    if (Array.isArray(e?.deezer)) {
      coverage.deezer += e.deezer.length ? 1 : 0;
      e.deezer.forEach((r, i, all) => bump(resolve(r.id, byDeezer, r.name), 1 - i / all.length));
    }
    if (Array.isArray(e?.listenbrainz)) {
      coverage.listenbrainz += e.listenbrainz.length ? 1 : 0;
      const best = Math.max(0, ...e.listenbrainz.map(r => Number(r.score) || 0));
      if (best > 0) for (const r of e.listenbrainz) bump(resolve(r.mbid, byMbid, r.name), (Number(r.score) || 0) / best);
    }

    if (w.size) {
      coverage.withNeighbours++;
      neighbours[sid] = [...w].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .map(([n, x]) => [n, +x.toFixed(4)]);
    }
  }
  return { version: BRIDGE_VERSION, neighbours, coverage };
}

/** The bridge as the scorer wants it: artist id -> [[neighbour id, weight]]. */
export function bridgeIndex(bridge) {
  const idx = new Map();
  for (const [sid, list] of Object.entries(bridge?.neighbours ?? {})) {
    if (!Array.isArray(list)) continue;
    const clean = list.filter(x => Array.isArray(x) && typeof x[0] === 'string' && Number.isFinite(x[1]) && x[1] > 0);
    if (clean.length) idx.set(sid, clean);
  }
  return idx;
}

/**
 * Where each artist is filed, across the space's destinations:
 * artist id -> { total, byDest: Map(destination id -> tracks) }.
 *
 * Built from the destinations' own counts, so it inherits `skip`: an artist
 * whose only filed tracks are held out is not filed anywhere, here as in the
 * rest of the space.
 */
export function artistHomes(destinations) {
  const homes = new Map();
  for (const d of destinations.values()) {
    for (const [aid, row] of d.artistCounts) {
      let h = homes.get(aid);
      if (!h) { h = { total: 0, byDest: new Map() }; homes.set(aid, h); }
      h.total += row.n;
      h.byDest.set(d.id, (h.byDest.get(d.id) ?? 0) + row.n);
    }
  }
  return homes;
}

/**
 * The bridge's vote for one track: destination id -> share, or null when it
 * has nothing to say (no neighbours known, or none of them filed anywhere).
 *
 * Each filed neighbour spreads its weight over the playlists it actually lives
 * in, in proportion — a neighbour with 9 tracks in Jungle and 1 in Favourites
 * votes 0.9 / 0.1, not 1 / 1. The track's own credited artists are left out:
 * their filing is the artist graph's job, and counting it twice would let the
 * bridge echo the graph instead of adding to it.
 *
 * Billing decays the way it does in the graph, so a featured vocalist's
 * neighbourhood colours the vote without leading it.
 */
export function bridgeScores(track, space) {
  const idx = space?.bridge;
  const homes = space?.artistHomes;
  if (!idx?.size || !homes) return null;
  const credits = track?.artists ?? [];
  const own = new Set(credits.map(a => a?.id).filter(Boolean));
  const votes = new Map();
  let mass = 0;
  credits.forEach((a, i) => {
    const list = a?.id ? idx.get(a.id) : null;
    if (!list) return;
    const bill = BILLING_DECAY ** i;
    for (const [n, w] of list) {
      if (own.has(n)) continue;
      const h = homes.get(n);
      if (!h?.total) continue;
      mass += bill * w;
      for (const [d, c] of h.byDest) votes.set(d, (votes.get(d) ?? 0) + (bill * w * c) / h.total);
    }
  });
  if (!(mass > 0)) return null;
  for (const [d, v] of votes) votes.set(d, v / mass);
  return votes;
}
