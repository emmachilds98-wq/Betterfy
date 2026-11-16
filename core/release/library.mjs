// What the account already has, held against each release
// (docs/RELEASE-RADAR-PLAN.md §4.4–4.6).
//
// §4.6 owned: every release carries `owned: none | some | all`. With the
// release's track list (one `/albums/{id}` call) it is counted per track:
// same track id, same ISRC, or the weak match below. Without it, it is counted
// from the library's own album ids and album keys, which costs nothing and is
// marked `ownedBasis: 'album'`.
//
// §4.4 reissues: a release whose tracks you already own *from an earlier
// release* is not new to you. Decided by ISRC where an ISRC is known, else by
// (same credited artist, same base title and version, duration within 2s),
// which is marked `weak`. Never by "Remastered"/"Deluxe" in a title: that is
// one library's vocabulary and fails on the next account.
//
// What the API hands us (February 2026): `/albums/{id}` lists simplified
// tracks, which carry no ISRC, and `GET /tracks?ids=` is gone. So a match
// starts weak and is upgraded by probing a matched track with `/tracks/{id}`
// (`probeIds` says which, at most PROBE_MAX per release): the same ISRC as the
// library's copy makes it `isrc`; a different ISRC means a different
// recording (a re-recording, a new mix under the old title) and the match is
// dropped. A weak match is kept as weak, never promoted on a guess.
import { baseTitle, versionOf } from '../../norm.mjs';
import { parseDate, inWindow, DAY_MS } from './dates.mjs';
import { releaseKey } from './normalise.mjs';

/** A library copy must predate the release by this much for the release to be a reissue of it. */
export const REISSUE_GAP_MS = 180 * DAY_MS;
/** Share of a release's tracks owned from earlier releases above which it is a reissue. */
export const REISSUE_SHARE = 0.5;
/** Weak match: durations this close count as the same recording. */
export const DURATION_SLACK_MS = 2000;
/** At most this many `/tracks/{id}` probes per release. */
export const PROBE_MAX = 2;

/** A release key without its track count: name, year and primary artist. */
const looseKey = (name, year, artistId) => releaseKey({ name, year, totalTracks: 'n', primaryArtistId: artistId });

const titleKey = (artistId, name) => `${artistId}|${baseTitle(name)}|${versionOf(name)}`;

/**
 * Index the library once per sync: `lib` is library.json's shape (`playlists[].tracks`,
 * `liked`), or the page's LIB. Tracks are `{ id, name, artists:[{id,name}], album,
 * albumId, albumTracks, trackNo, released, duration_ms, isrc }`.
 */
export function libraryIndex(lib) {
  const seen = new Map();
  for (const p of lib?.playlists ?? []) for (const t of p?.tracks ?? []) if (t?.id && !seen.has(t.id)) seen.set(t.id, t);
  for (const t of lib?.liked ?? []) if (t?.id && !seen.has(t.id)) seen.set(t.id, t);
  const tracks = [...seen.values()];

  const isrcs = new Map(), byAlbumId = new Map(), byAlbumKey = new Map(), byLooseKey = new Map(), byTitle = new Map(),
        byArtist = new Map(), albumNames = new Map();
  const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
  for (const t of tracks) {
    const rel = parseDate(t.released);
    const row = { t, ts: rel.ok ? rel.ts : null };
    if (t.isrc) push(isrcs, t.isrc, row);
    if (t.albumId) push(byAlbumId, t.albumId, row);
    // The page's library carries no album id or track count (feedback.js
    // shapeTrack), so a copy without a count is indexed by name, year and
    // artist alone, and found by looseKey() below.
    if (t.album && t.albumTracks != null) push(byAlbumKey, releaseKey({ name: t.album, year: rel.y, totalTracks: t.albumTracks,
      primaryArtistId: t.artists?.[0]?.id }), row);
    else if (t.album) push(byLooseKey, looseKey(t.album, rel.y, t.artists?.[0]?.id), row);
    for (const a of t.artists ?? []) {
      if (!a?.id) continue;
      push(byTitle, titleKey(a.id, t.name), row);
      push(byArtist, a.id, row);
      if (t.album) push(albumNames, `${a.id}|${baseTitle(t.album)}`, row);
    }
  }
  return { tracks, trackIds: new Set(seen.keys()), isrcs, byAlbumId, byAlbumKey, byLooseKey, byTitle, byArtist, albumNames };
}

/** The library rows a release track matches, strongest first: [{ row, how: 'id'|'isrc'|'weak' }]. */
export function matchTrack(rt, artistIds, idx) {
  const out = [];
  if (rt.id && idx.trackIds.has(rt.id)) {
    for (const row of idx.byArtist.get(artistIds[0]) ?? []) if (row.t.id === rt.id) { out.push({ row, how: 'id' }); break; }
    if (!out.length) out.push({ row: { t: { id: rt.id }, ts: null }, how: 'id' });
  }
  if (rt.isrc) for (const row of idx.isrcs.get(rt.isrc) ?? []) out.push({ row, how: 'isrc' });
  const who = [...new Set([...(rt.artists ?? []), ...artistIds])];
  for (const a of who) for (const row of idx.byTitle.get(titleKey(a, rt.name)) ?? []) {
    if (Math.abs((row.t.duration_ms ?? 0) - (rt.ms ?? 0)) > DURATION_SLACK_MS) continue;
    // A probe that came back with a different ISRC from the library's copy: a
    // different recording under the same title. Not a match.
    if (rt.isrc && row.t.isrc && rt.isrc !== row.t.isrc) continue;
    out.push({ row, how: rt.isrc && row.t.isrc === rt.isrc ? 'isrc' : 'weak' });
  }
  return out;
}

const fromEarlier = (row, release) =>
  !release.ids.includes(row.t.albumId) && row.ts != null && row.ts < release.ts - REISSUE_GAP_MS;

/** A release's tracks with any probed ISRCs filled in. */
const withProbes = r => (r.tracks ?? []).map(t => (t.id && r.probes?.[t.id] && !t.isrc) ? { ...t, isrc: r.probes[t.id] } : t);

/**
 * `{ owned, ownedBasis, reissue, reissueBasis, overlap }` for a release record
 * (normalise.mjs) against the library index. Pure; recomputed every sync, so a
 * library that changed since the release was read is reflected without a request.
 */
export function verdict(release, idx) {
  const artistIds = (release.artists ?? []).map(a => a.id);
  const tracks = withProbes(release);
  if (!tracks.length) {
    // No track list: count the library's tracks on this very release.
    const rows = new Map();
    for (const id of release.ids ?? []) for (const row of idx.byAlbumId.get(id) ?? []) rows.set(row.t.id, row);
    for (const row of idx.byAlbumKey.get(release.key) ?? []) rows.set(row.t.id, row);
    const y = parseDate(release.releaseDate, release.precision).y;
    for (const row of idx.byLooseKey.get(looseKey(release.name, y, release.artists?.[0]?.id)) ?? []) rows.set(row.t.id, row);
    const n = new Set([...rows.values()].map(r => r.t.trackNo ?? r.t.id)).size;
    const total = release.totalTracks || 1;
    // A single whose one title you own from an older release, with no track
    // list to check durations against: the weakest call this makes, kept weak.
    const nameOnly = release.totalTracks <= 3 && artistIds.some(a =>
      (idx.byTitle.get(titleKey(a, release.name)) ?? []).some(row => fromEarlier(row, release)));
    return { owned: n >= total ? 'all' : n ? 'some' : 'none', ownedBasis: 'album',
             reissue: !n && nameOnly, reissueBasis: !n && nameOnly ? 'weak' : null, overlap: null };
  }
  let owned = 0, earlier = 0, earlierIsrc = 0;
  for (const rt of tracks) {
    const m = matchTrack(rt, artistIds, idx);
    if (!m.length) continue;
    owned++;
    const old = m.filter(x => x.how !== 'id' && fromEarlier(x.row, release));
    if (old.length) { earlier++; if (old.some(x => x.how === 'isrc')) earlierIsrc++; }
  }
  const total = Math.max(tracks.length, 1);
  const overlap = earlier / total;
  const reissue = overlap >= REISSUE_SHARE;
  return {
    owned: owned >= tracks.length ? 'all' : owned ? 'some' : 'none',
    ownedBasis: 'tracks',
    reissue,
    // ISRC-backed only when most of the evidence is: one probed track out of ten
    // weak matches is still a weak call.
    reissueBasis: !reissue ? null : earlierIsrc * 2 >= earlier ? 'isrc' : 'weak',
    overlap,
  };
}

/**
 * Is this release's track list worth one `/albums/{id}` request? Only for the
 * main lane, inside the window, not yet read, and only when the library holds
 * something it could be a repackage of: an older track by one of its artists
 * (a multi-track release), or an older track or album with its very title.
 */
export function needsDetail(release, idx, cutoff) {
  if (release.lane !== 'main' || release.tracks || release.detailAt) return false;
  if (!inWindow(parseDate(release.releaseDate, release.precision), cutoff)) return false;
  const ids = (release.artists ?? []).map(a => a.id);
  const older = row => fromEarlier(row, release);
  if (ids.some(a => (idx.byTitle.get(titleKey(a, release.name)) ?? []).some(older))) return true;
  if (ids.some(a => (idx.albumNames.get(`${a}|${baseTitle(release.name)}`) ?? []).some(older))) return true;
  return release.totalTracks > 3 && ids.some(a => (idx.byArtist.get(a) ?? []).some(older));
}

/**
 * Which of a release's tracks to probe with `/tracks/{id}` for an ISRC: weak
 * matches against a library copy that has an ISRC, at most PROBE_MAX, none
 * already probed.
 */
export function probeIds(release, idx) {
  const artistIds = (release.artists ?? []).map(a => a.id);
  const out = [];
  for (const rt of release.tracks ?? []) {
    if (out.length >= PROBE_MAX) break;
    if (!rt.id || rt.isrc || release.probes?.[rt.id] !== undefined) continue;
    const m = matchTrack(rt, artistIds, idx);
    if (m.some(x => x.how === 'weak' && x.row.t.isrc)) out.push(rt.id);
  }
  return out;
}
