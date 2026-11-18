// Hard to find: songs in your playlists that Spotify's own search shows as a
// different track.
//
// The symptom (emma, 2026-11-18): "I search for a song I know is in my playlist,
// but the tick doesn't appear; if I go into the playlist it's there." Spotify's
// tick on a search result means "this exact track id is in your library or one
// of your playlists". A song added years ago is often held under an old id: an
// earlier pressing, a single later folded into an album, a region release, or a
// release Spotify since replaced. Search shows the current id, which is not the
// one in your playlist, so no tick, and the song looks lost.
//
// Spotify will not say which id it considers current (linked_from went in
// February 2026), so the check asks the same question the listener does: search
// for the song the way a person would and see whether the top answer is the
// copy you hold. Pure: the page supplies the library, the search results and
// what was checked before; nothing here calls Spotify.
import { norm, trackKey } from '../../norm.mjs';

/** Re-check a song after this long: Spotify swaps releases over time. */
export const RECHECK_MS = 30 * 24 * 3600 * 1000;
/** Songs checked per run: about a minute at the page's shared-quota pace. */
export const RUN_SIZE = 150;

const normIsrc = s => String(s ?? '').replace(/-/g, '').toUpperCase();
const artistLine = t => (t?.artists ?? []).map(a => a?.name).filter(Boolean).join(', ');

/** A Spotify track object (search result) in the library's own row shape. */
export function shapeHit(t) {
  if (!t?.id) return null;
  const im = t.album?.images ?? [];
  return {
    id: t.id, name: t.name ?? '', artists: (t.artists ?? []).map(a => ({ id: a?.id, name: a?.name })),
    album: t.album?.name ?? '', albumType: t.album?.album_type, released: t.album?.release_date,
    art: (im.find(x => x.width && x.width <= 400) ?? im[im.length - 1] ?? {}).url,
    duration_ms: t.duration_ms ?? 0, isrc: t.external_ids?.isrc,
    playable: t.is_playable !== false,
  };
}

/** Two tracks are the same song: one ISRC, or one title/artist/version at the same length. */
export function sameSong(a, b) {
  if (!a || !b) return false;
  if (a.isrc && b.isrc) return normIsrc(a.isrc) === normIsrc(b.isrc)
    // Different ISRCs can still be the same master on two releases (a single
    // and the album it went on), so fall through to the name test, but only
    // with the lengths agreeing closely.
    || (trackKey(a) === trackKey(b) && Math.abs((a.duration_ms ?? 0) - (b.duration_ms ?? 0)) <= 2000);
  return trackKey(a) === trackKey(b) && Math.abs((a.duration_ms ?? 0) - (b.duration_ms ?? 0)) <= 3000;
}

/** What a person would type to find it: the title and the first artist. */
export function searchQuery(t) {
  const title = String(t?.name ?? '').replace(/\s*[(\[]\s*(feat\.?|ft\.?|featuring)\s[^)\]]*[)\]]/ig, '').trim();
  return `${title} ${t?.artists?.[0]?.name ?? ''}`.trim();
}

/**
 * Every song in the listener's own playlists, once per track id, oldest-added
 * first (the old adds are the ones that drift). Each knows where it sits.
 * `done` maps id -> { at } for songs already checked; those inside RECHECK_MS
 * are left out. Liked Songs count as a place too: a liked song shows the tick
 * the same way.
 */
export function songsToCheck(lib, done = {}, now = Date.now()) {
  const byId = new Map();
  const put = (t, place, added) => {
    if (!t?.id || t.is_local) return;
    let e = byId.get(t.id);
    if (!e) byId.set(t.id, e = { track: t, places: [], liked: false, added: added ?? null });
    if (place) { if (!e.places.some(p => p.id === place.id)) e.places.push(place); }
    else e.liked = true;
    if (added && (!e.added || added < e.added)) e.added = added;
  };
  for (const p of lib?.playlists ?? []) for (const t of p.tracks ?? []) put(t, { id: p.id, name: p.name }, t.added_at);
  for (const t of lib?.liked ?? []) put(t, null, t.added_at);
  return [...byId.values()]
    .filter(e => !(done[e.track.id] && now - (done[e.track.id].at ?? 0) < RECHECK_MS))
    .sort((a, b) => String(a.added ?? '9').localeCompare(String(b.added ?? '9')));
}

/**
 * Judge one song against what search returned for it.
 *   ok       search's top answer is this copy, or this copy shows among the
 *            answers under a different song on top (a remix, a namesake)
 *   version  search shows the same song under a different id: the missing tick
 *   missing  search does not show this song at all: pulled, greyed out in
 *            this country, or renamed past recognition
 * `hits` are shaped (shapeHit). The version offered is the first playable one.
 */
export function judge(track, hits) {
  const list = (hits ?? []).filter(Boolean);
  if (!list.length) return { state: 'missing' };
  if (list[0].id === track.id) return { state: 'ok' };
  const same = list.filter(h => h.id !== track.id && sameSong(track, h));
  const top = same.find(h => h.playable) ?? null;
  // Our copy is in the answers and nothing above it is the same song: fine.
  const mine = list.findIndex(h => h.id === track.id);
  if (mine >= 0 && !list.slice(0, mine).some(h => sameSong(track, h))) return { state: 'ok' };
  if (top) return { state: 'version', to: top };
  return mine >= 0 ? { state: 'ok' } : { state: 'missing' };
}

/** Why the two copies differ, in a few words, for the row. */
export function versionNote(from, to) {
  const bits = [];
  if ((from.album ?? '') !== (to.album ?? '')) bits.push(`yours is on ${from.album || 'another release'}, search shows ${to.album || 'another release'}`);
  const y = s => String(s ?? '').slice(0, 4);
  if (y(from.released) && y(to.released) && y(from.released) !== y(to.released)) bits.push(`${y(from.released)} vs ${y(to.released)}`);
  if (!bits.length) bits.push('same release name, different Spotify id');
  return bits.join(' · ');
}

/**
 * The rows for the screen, from the saved checks: every song judged `version`
 * or `missing` that is still in the library, with where it sits.
 */
export function hiddenRows(lib, checks = {}) {
  const all = songsToCheck(lib, {}, 0);
  const rows = [];
  for (const e of all) {
    const c = checks[e.track.id];
    if (!c || c.state === 'ok' || c.fixed) continue;
    rows.push({ id: e.track.id, track: e.track, places: e.places, liked: e.liked, added: e.added,
                state: c.state, to: c.to ?? null, at: c.at });
  }
  return rows;
}

/** How far the checks have got: songs in the library, checked within RECHECK_MS, flagged. */
export function hiddenProgress(lib, checks = {}, now = Date.now()) {
  const all = songsToCheck(lib, {}, 0);
  let checked = 0;
  for (const e of all) { const c = checks[e.track.id]; if (c && now - (c.at ?? 0) < RECHECK_MS) checked++; }
  return { total: all.length, checked, left: all.length - checked };
}

/**
 * Find songs in the library by what someone types: every word must appear in
 * the title, artists or album. Each answer says where it sits and whether it is
 * liked, which is the thing Spotify's own search would not tell you.
 */
export function findInLibrary(lib, q, limit = 20) {
  const words = norm(q).split(' ').filter(Boolean);
  if (!words.length) return [];
  const out = [];
  for (const e of songsToCheck(lib, {}, 0)) {
    const t = e.track;
    const hay = ' ' + norm(`${t.name ?? ''} ${artistLine(t)} ${t.album ?? ''}`) + ' ';
    if (words.every(w => hay.includes(' ' + w) )) out.push(e);
    if (out.length >= limit) break;
  }
  return out;
}

export { artistLine };
