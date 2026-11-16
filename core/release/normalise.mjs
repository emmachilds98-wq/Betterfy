// One release record per real release (docs/RELEASE-RADAR-PLAN.md §4.2, §4.3, §5).
//
// §4.2 — the same release appears once per market. Every request passes
// `market=from_token`, and the survivors are deduplicated on
// (normalised name, release year, total tracks, primary artist id). The plan
// put the full release date in the key; the year is used instead, because the
// market copies this rule exists for can carry different days (an earlier
// territory, a pre-order date) and the name + track count + primary artist
// already separate two genuinely different releases in the same year. The
// earliest date seen is kept, and every id seen is kept, so a later pass
// recognises the release whichever id it is handed.
//
// §4.3 — `appears_on` is mostly compilations but also where remixes and guest
// verses live. Two lanes, never one chronology: `main` and `features`.
// Spotify removed `album_group` from album objects in February 2026, so the
// lane cannot be read off the item any more. It is decided from the album's
// own artists instead, which is what `album_group` used to encode: an item is
// `main` when the artist we asked about is one of the album's credited
// artists (and the album is not a Various Artists compilation), `features`
// otherwise. That holds whichever `include_groups` the item arrived through.
import { norm } from '../../norm.mjs';
import { parseDate } from './dates.mjs';

/** Spotify's "Various Artists": one id on thousands of compilations. Excluded by id, never by name. */
export const VARIOUS_ARTISTS_ID = '0LyfQWJT6nXafLPZqxe9Of';

/** Bumped whenever a stored record's format changes; anything older is re-read. */
export const SHAPE = 1;

/** The `include_groups` values the sync asks for, one request each (see plan.mjs). */
export const GROUPS = Object.freeze(['album', 'single', 'appears_on']);

/** §4.2's dedupe key. */
export function releaseKey({ name, year, totalTracks, primaryArtistId }) {
  return `${norm(name)}|${year || 0}|${totalTracks ?? 0}|${primaryArtistId ?? ''}`;
}

/** The smallest cover at least 64px wide (rows are 56px), else whatever there is. */
export function pickImage(images) {
  const ok = (images ?? []).filter(i => i?.url);
  if (!ok.length) return null;
  const big = ok.filter(i => (i.width ?? 0) >= 64).sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  return (big[0] ?? ok[0]).url;
}

/**
 * One item of `/artists/{id}/albums` (a simplified album object) as a release
 * record. `artistId` is the artist the request was for. Null for anything
 * that is not an album object with an id.
 */
export function normaliseItem(item, { artistId, at = 0 } = {}) {
  if (!item?.id || (item.type && item.type !== 'album')) return null;
  const artists = (item.artists ?? []).filter(a => a?.id).map(a => ({ id: a.id, name: a.name ?? '' }));
  const primary = artists[0]?.id ?? null;
  const various = primary === VARIOUS_ARTISTS_ID;
  const own = !various && artists.some(a => a.id === artistId);
  const date = parseDate(item.release_date, item.release_date_precision);
  return {
    shape: SHAPE,
    key: releaseKey({ name: item.name, year: date.y, totalTracks: item.total_tracks, primaryArtistId: primary }),
    ids: [item.id],
    name: item.name ?? '',
    artists,
    releaseDate: date.raw,
    precision: date.precision,
    ts: date.ts,
    albumType: item.album_type ?? 'album',
    totalTracks: item.total_tracks ?? 0,
    img: pickImage(item.images),
    lane: own ? 'main' : 'features',
    various,
    via: artistId ? [artistId] : [],
    owned: 'none',
    ownedBasis: null,
    reissue: false,
    reissueBasis: null,
    firstSeenAt: at,
  };
}

const union = (a = [], b = []) => [...new Set([...a, ...b])];

/**
 * Two records with the same key, as one. The earliest date wins (with its raw
 * string and precision), ids and the artists that surfaced it are unioned,
 * `main` beats `features` (one artist's own release is another's guest spot),
 * and the first sighting is kept: it cannot be backfilled (§4.5).
 */
export function mergeRelease(a, b) {
  if (!a) return b;
  if (!b) return a;
  const early = (b.ts < a.ts) ? b : a;
  return {
    ...a,
    ...b,
    key: a.key,
    ids: union(a.ids, b.ids),
    via: union(a.via, b.via),
    releaseDate: early.releaseDate, precision: early.precision, ts: early.ts,
    lane: a.lane === 'main' || b.lane === 'main' ? 'main' : 'features',
    img: a.img ?? b.img,
    firstSeenAt: Math.min(a.firstSeenAt ?? Infinity, b.firstSeenAt ?? Infinity),
    // Verdicts and the track list belong to whichever record has them; a fresh
    // sighting from the list endpoint carries neither.
    tracks: a.tracks ?? b.tracks,
    detailAt: a.detailAt ?? b.detailAt,
    probes: { ...(a.probes ?? {}), ...(b.probes ?? {}) },
    owned: a.owned, ownedBasis: a.ownedBasis, reissue: a.reissue, reissueBasis: a.reissueBasis,
    dismissed: a.dismissed ?? b.dismissed,
  };
}

/** A compact track list from `/albums/{id}` (simplified tracks: no ISRC unless Spotify adds one). */
export function compactTracks(album) {
  return (album?.tracks?.items ?? []).filter(t => t?.id || t?.name).map(t => ({
    id: t.id ?? null,
    name: t.name ?? '',
    ms: t.duration_ms ?? 0,
    no: t.track_number ?? 0,
    artists: (t.artists ?? []).map(a => a.id).filter(Boolean),
    isrc: t.external_ids?.isrc ?? null,
  }));
}
