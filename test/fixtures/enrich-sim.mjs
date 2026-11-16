// A request-by-request model of the page's enrichment runs (BUILD-6 D9), so
// "share of the top-100 listened artists covered after five minutes" can be
// measured before and after on the fixtures, with no network.
//
// Each `*Order` function reproduces, line for line, the order the page asks in
// (web/app/sync-tags.js enrichMissing, keyless.js fillFromWikidata, engine.js
// engineBridge, blend.js blendFetch); `before` is origin/main's order and
// `after` adds enrichOrder() on top, as the page now does.
//
// Pacing is the page's own sleeps (PACE in core/intrinsic/bridge-fetch.mjs, the
// 200 ms Last.fm gap, Wikidata's 1 s between batches) plus an assumed round
// trip (LATENCY below), stated so the number can be re-run with others.
import { byListening, listeningWeights } from '../../profile.mjs';
import { enrichOrder, listenedWeights } from '../../core/personal/relevance.mjs';
import { sourceArtists } from '../../core/intrinsic/bridge.mjs';
import { scoredTracks } from '../../core/validate/loo.mjs';
import { PACE } from '../../core/intrinsic/bridge-fetch.mjs';

export const LATENCY = { lastfm: 250, wikidata: 2000, deezer: 150 };
export const WINDOW_MS = 5 * 60 * 1000;

/** How many artists each run gets through in `ms`. */
export const perWindow = (ms = WINDOW_MS) => ({
  lastfm: Math.floor(ms / (200 + LATENCY.lastfm)),
  // 300 ids a request, a second between requests.
  wikidata: Math.floor(ms / (PACE.wikidata + LATENCY.wikidata)) * 300,
  // Two Deezer requests an artist (ISRC, then related), after the MBID batches.
  deezer: n => Math.max(0, Math.floor((ms - Math.ceil(n / 300) * (PACE.wikidata + LATENCY.wikidata))
                                     / (2 * (PACE.deezer + LATENCY.deezer)))),
});

const tracksOf = lib => [...lib.playlists.flatMap(p => p.tracks ?? []), ...(lib.liked ?? [])];

/** The 100 library artists (ids) this account plays most: listening only, no library floor. */
export function topListened(lib, raw, n = 100) {
  const w = listeningWeights({ topWindows: raw.topWindows, recentArtists: raw.recentArtists });
  const byName = new Map();
  for (const t of tracksOf(lib)) for (const a of t.artists ?? []) if (a.id && w.has(a.name) && !byName.has(a.name)) byName.set(a.name, a.id);
  return new Set([...byName].sort((x, y) => w.get(y[0]) - w.get(x[0])).slice(0, n).map(([, id]) => id));
}

/** The page's listening weights, floor included, exactly as listeningSeeds() builds them. */
function pageWeights(lib, raw) {
  const libraryArtists = [];
  for (const p of lib.playlists) for (const t of p.tracks) for (const a of t.artists ?? []) libraryArtists.push(a.name);
  for (const t of lib.liked ?? []) for (const a of t.artists ?? []) libraryArtists.push(a.name);
  return listeningWeights({ topWindows: raw.topWindows, recentArtists: raw.recentArtists, libraryArtists });
}

const gapCount = tags => id => tags?.[id]?.tags?.length ?? 0;

/** Last.fm tag-gap fill (enrichMissing): [id, name] in asking order. */
export function lastfmOrder(lib, raw, tags = {}, { after = true } = {}) {
  const names = new Map();
  for (const t of tracksOf(lib)) for (const a of t.artists ?? []) if (a.id && (tags[a.id]?.tags?.length ?? 0) < 3) names.set(a.id, a.name);
  const todo = byListening([...names], pageWeights(lib, raw));
  return after ? enrichOrder(todo, { weights: listenedWeights(raw), tagCount: gapCount(tags) }) : todo;
}

/** Wikidata genre fill (fillFromWikidata): ids in asking order. */
export function wikidataOrder(lib, raw, tags = {}, { after = true } = {}) {
  const out = new Map();
  for (const t of tracksOf(lib)) for (const a of t.artists ?? []) if (a?.id && !(tags[a.id]?.tags?.length)) out.set(a.id, a.name);
  const todo = [...out];
  return (after ? enrichOrder(todo, { weights: listenedWeights(raw), tagCount: gapCount(tags) }) : todo)
    .map(([id]) => id);
}

/** Score's similar-artist lookups (engineBridge over the scored tracks): ids in asking order. */
export function scoreBridgeOrder(lib, raw, tags = {}, { after = true, limit = 600 } = {}) {
  const artists = sourceArtists(scoredTracks(lib, { limit }));
  const list = after ? enrichOrder(artists, { weights: listenedWeights(raw), tagCount: gapCount(tags),
                                              nameOf: ([, a]) => a.name }) : [...artists];
  return list.map(([id]) => id);
}

/** File's background lookups (blendFetch over the backlog): ids in asking order. */
export function blendBridgeOrder(lib, raw, tags = {}, { after = true } = {}) {
  const filed = new Set(lib.playlists.flatMap(p => p.tracks.map(t => t.id)));
  const backlog = (lib.liked ?? []).filter(t => !filed.has(t.id));
  const listen = new Map();
  for (const win of raw.topWindows ?? []) (win.items ?? []).forEach((name, i, all) => {
    const k = String(name ?? '').toLowerCase();
    if (k) listen.set(k, (listen.get(k) ?? 0) + (win.weight ?? 1) * (1 - i / all.length));
  });
  for (const name of raw.recentArtists ?? []) { const k = String(name ?? '').toLowerCase(); if (k) listen.set(k, (listen.get(k) ?? 0) + 1); }
  const playOf = t => Math.max(0, ...(t.artists ?? []).map(a => listen.get(String(a?.name ?? '').toLowerCase()) ?? 0));
  const tracks = backlog.map((t, i) => ({ t, i, w: playOf(t) })).sort((a, b) => b.w - a.w || a.i - b.i).map(x => x.t);
  const artists = sourceArtists(tracks);
  const list = after ? enrichOrder(artists, { weights: listenedWeights(raw), tagCount: gapCount(tags),
                                              nameOf: ([, a]) => a.name }) : [...artists];
  return list.map(([id]) => id);
}

/** Of `top`, the share (0-100, one decimal) that sits in the first `n` of `order`, over the ones `order` asks about at all. */
export function coveredShare(order, top, n) {
  const ids = order.map(x => (Array.isArray(x) ? x[0] : x));
  const inRun = ids.filter(id => top.has(id)).length;
  if (!inRun) return null;
  const got = ids.slice(0, n).filter(id => top.has(id)).length;
  return Math.round(1000 * got / inRun) / 10;
}
