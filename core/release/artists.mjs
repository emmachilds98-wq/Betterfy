// The artists Release Radar watches (docs/RELEASE-RADAR-PLAN.md §2, §4.7).
//
// Distinct artist ids across every owned playlist, liked songs, the three
// top-artist windows and recently played: credited artists, not just the
// first-billed one, so a producer you own one track by is watched too. No
// `user-follow-read`, no new scope: what the library and listening history
// already name, nothing else (BUILD-6-PLAN §2.3).
//
// Order is by listening, so an interrupted first sync has already covered the
// artists you actually play: the same `listeningWeights()` the tag enrichment
// sorts by (profile.mjs, `byListening`), keyed by artist name as it is
// everywhere else. Ties go to the artist with more tracks in the library, then
// to first appearance.
//
// "Various Artists" is excluded by id (normalise.mjs). A collaboration credit
// that is its own artist id ("Shy FX & T Power" as one profile) is watched as
// that id, and flagged `collab`; its members are watched when the library
// credits them by their own ids too. Names are never resolved to ids here:
// that would take a search request per name and could pick the wrong person.
//
// §4.7, an id is not a person. Spotify links nothing: aliases (Aphex Twin /
// AFX) are separate ids with separate catalogues, and two different people can
// share one name. The heuristic, documented and tested rather than guessed at:
//   - never merge two ids, whatever their names; report per credited id;
//   - two ids with the same normalised name are flagged `homonym` (with each
//     other's ids in `alsoIds`), so the feed can tell them apart by a track you
//     own rather than showing two identical names;
//   - a release reached through several ids (an alias pair credited together,
//     a duo and its member) is still one row, because rows are keyed by
//     release (normalise.mjs §4.2), not by artist.
// Alias resolution (MusicBrainz) is a later, optional bonus, never this.
import { norm } from '../../norm.mjs';
import { parts } from '../../credits.mjs';
import { listeningWeights } from '../../profile.mjs';
import { VARIOUS_ARTISTS_ID } from './normalise.mjs';

const WINDOWS = [['short_term', 3], ['medium_term', 2], ['long_term', 1.5]];

/**
 * Listening weights from library.json alone (its `top_artists` and
 * `recently_played`), weighted exactly as listening.mjs and the page weight them.
 */
export function weightsFromLibrary(lib) {
  const topWindows = WINDOWS.map(([range, weight]) => ({
    weight, items: (lib?.top_artists?.[range] ?? []).map(a => a?.name).filter(Boolean) }));
  const recentArtists = (lib?.recently_played ?? []).flatMap(t => (t?.artists ?? []).map(a => a?.name)).filter(Boolean);
  const libraryArtists = [];
  for (const p of lib?.playlists ?? []) for (const t of p?.tracks ?? []) for (const a of t?.artists ?? []) libraryArtists.push(a?.name);
  for (const t of lib?.liked ?? []) for (const a of t?.artists ?? []) libraryArtists.push(a?.name);
  return listeningWeights({ topWindows, recentArtists, libraryArtists: libraryArtists.filter(Boolean) });
}

/**
 * `[{ id, name, sources, tracks, weight, collab, homonym, alsoIds }]`, most
 * listened first. `lib` is library.json's shape; `top` and `recent` (optional)
 * override its `top_artists` / `recently_played` with fresher reads
 * (`{ short_term: [{id,name}], ... }` and `[{ artists:[{id,name}] }]`);
 * `weights` (optional) overrides the listening weights.
 */
export function artistSet(lib, { top = lib?.top_artists, recent = lib?.recently_played, weights } = {}) {
  const by = new Map();
  let order = 0;
  const add = (a, source, isTrack) => {
    if (!a?.id || a.id === VARIOUS_ARTISTS_ID) return;
    let e = by.get(a.id);
    if (!e) by.set(a.id, e = { id: a.id, name: a.name ?? '', sources: [], tracks: 0, weight: 0, order: order++ });
    if (!e.name && a.name) e.name = a.name;
    if (!e.sources.includes(source)) e.sources.push(source);
    if (isTrack) e.tracks++;
  };
  for (const p of lib?.playlists ?? []) for (const t of p?.tracks ?? []) for (const a of t?.artists ?? []) add(a, 'playlist', true);
  for (const t of lib?.liked ?? []) for (const a of t?.artists ?? []) add(a, 'liked', true);
  for (const [range] of WINDOWS) for (const a of top?.[range] ?? []) add(a, 'top', false);
  for (const t of recent ?? []) for (const a of t?.artists ?? []) add(a, 'recent', false);

  const w = weights ?? weightsFromLibrary({ ...lib, top_artists: top, recently_played: recent });
  const byName = new Map();
  for (const e of by.values()) {
    e.weight = w?.get?.(e.name) ?? 0;
    e.collab = parts(e.name).length > 1;
    const k = norm(e.name);
    if (k) { if (!byName.has(k)) byName.set(k, []); byName.get(k).push(e.id); }
  }
  for (const e of by.values()) {
    const same = byName.get(norm(e.name)) ?? [];
    e.homonym = same.length > 1;
    e.alsoIds = e.homonym ? same.filter(id => id !== e.id) : [];
  }
  return [...by.values()]
    .sort((a, b) => (b.weight - a.weight) || (b.tracks - a.tracks) || (a.order - b.order))
    .map(({ order: _, ...e }) => e);
}

/**
 * A word to tell two same-named ids apart in the feed (§4.7): the title of a
 * track you own by that id, or null when the library has none.
 */
export function disambiguator(artistId, lib) {
  for (const p of lib?.playlists ?? []) for (const t of p?.tracks ?? [])
    if ((t?.artists ?? []).some(a => a?.id === artistId)) return t.name ?? null;
  for (const t of lib?.liked ?? []) if ((t?.artists ?? []).some(a => a?.id === artistId)) return t.name ?? null;
  return null;
}
