// "Since you last opened": the digest card at the top of File (BUILD-6-PLAN
// §4.1/§4.2 F5, RELEASE-RADAR-PLAN §9.5). Pure counts over what the page
// already holds — the History log, the reports, the liked songs, the playlists'
// snapshot ids, and the top-artists windows the listening fetch cached — so it
// costs no request, and nothing in it leaves the device.
//
// Every figure is a count of one source, nothing estimated:
//   filed     filings in the History log (core/measure/history.mjs isFiling) in
//             the period, as distinct tracks; `back` is how many of those
//             tracks had a filing that was later undone or taken out of the same
//             playlist (history.mjs reversed(), the batch measure's own test).
//   misfits   rows in R.misfiled (track + playlist) that were not there at the
//             last open.
//   genres    the "new genre?" clusters (screenjobs.js COLD.newGenre) that do
//             not overlap any cluster seen at the last open.
//   liked     liked songs added in the period that are still waiting in File.
//   playlists playlists whose snapshot id changed since the last open, new ones,
//             gone ones, and the net change in their track counts.
//   listening of the short-term top artists, how many are not in the long-term
//             top: a supporting line, never a reason to show the card alone.
//
// The baseline ("last opened") is a small record kept in this browser only:
// digestBaseline() makes it, and the page stores it once per session.

import { clean, isFiling, undoneSet, reversed } from './history.mjs';

export const DAY = 24 * 60 * 60 * 1000;
/** With no record of a last open, the digest covers this long. */
export const FALLBACK_MS = 7 * DAY;
/** A cluster counts as the same genre as one seen before at this overlap. */
export const SAME_GENRE = 0.5;
/** Ids kept per remembered cluster, and remembered misfits, so the record stays small. */
export const KEEP_IDS = 60;
export const KEEP_MISFITS = 3000;
/** Fewest artists in each top window before the listening line says anything. */
export const MIN_TOP = 5;

const ms = iso => { const x = Date.parse(iso); return Number.isFinite(x) ? x : NaN; };
const idsOf = c => (Array.isArray(c?.ids) ? c.ids : Array.isArray(c?.tracks) ? c.tracks.map(t => t?.id) : []).filter(Boolean);
export const misfitKey = m => `${m?.id}|${m?.currentPlaylistId ?? ''}`;

/** The window the digest covers: from the last open (or a week back) to the start of this session. */
export function digestWindow(base, now) {
  const last = ms(base?.at);
  const since = Number.isFinite(last) && last <= now ? last : now - FALLBACK_MS;
  return { since, until: now, sinceLastOpen: Number.isFinite(last) && last <= now };
}

/** Filings in [since, until): entries, distinct tracks, and the tracks later moved or undone. */
export function filedIn(rawLog, since, until) {
  const log = clean(rawLog), undone = undoneSet(log);
  const inWin = e => { const t = ms(e.at); return t >= since && t < until; };
  const filings = log.filter(e => isFiling(e) && inWin(e));
  const tracks = new Set(), back = new Set();
  for (const e of filings) {
    const ids = Array.isArray(e.trackIds) ? e.trackIds : [];
    for (const id of ids) tracks.add(id);
    if (reversed(e, log, undone)) for (const id of ids) back.add(id);
  }
  return { entries: filings.length, tracks: tracks.size, back: back.size };
}

/** Do two id lists share at least SAME_GENRE of the smaller one? */
function sameCluster(a, b) {
  const B = new Set(b);
  const shared = a.filter(x => B.has(x)).length;
  return shared >= SAME_GENRE * Math.min(a.length, b.length) && shared > 0;
}

/** Playlists, keyed by id: [snapshot id, track count, name]. Unread ones (no snapshot id) are left out. */
export function playlistMap(playlists, isMirror = () => false) {
  const out = {};
  for (const p of playlists ?? []) {
    if (!p?.id || !p.snapshot_id || isMirror(p)) continue;
    out[p.id] = [p.snapshot_id, Array.isArray(p.tracks) ? p.tracks.length : 0, p.name ?? ''];
  }
  return out;
}

/** What changed between two playlistMap()s. */
export function playlistDiff(before, after) {
  if (!before || !after) return null;
  let changed = 0, added = 0, gone = 0, plus = 0, minus = 0;
  for (const [id, [snap, n]] of Object.entries(after)) {
    const was = before[id];
    if (!was) { added++; plus += n; continue; }
    if (was[0] === snap) continue;
    changed++;
    const d = n - (was[1] | 0);
    if (d > 0) plus += d; else minus -= d;
  }
  for (const [id, was] of Object.entries(before)) if (!after[id]) { gone++; minus += was[1] | 0; }
  return { changed, added, gone, plus, minus };
}

/** Short-term top artists against the long-term ones, from the cached listening fetch. */
export function listeningShift(raw) {
  const win = r => (raw?.topWindows ?? []).find(w => w?.range === r)?.items ?? [];
  const short = [...new Set(win('short_term'))], long = new Set(win('long_term'));
  if (short.length < MIN_TOP || long.size < MIN_TOP) return null;
  const fresh = short.filter(a => !long.has(a));
  return { top: short.length, overlap: short.length - fresh.length, fresh: fresh.length, examples: fresh.slice(0, 3) };
}

/**
 * The digest. `base` is the record from the last open (or null); the rest is
 * what the page holds now. `genres` is null while the new-genre clusters have
 * not been worked out this session (then that line is simply absent).
 */
export function buildDigest({ base = null, now, log = [], backlog = [], liked = [], misfiled = [], genres = null,
                              playlists = null, listening = null }) {
  const { since, until, sinceLastOpen } = digestWindow(base, now);
  const filed = filedIn(log, since, until);

  const waiting = new Set((backlog ?? []).map(b => b?.id).filter(Boolean));
  const likedNew = (liked ?? []).filter(t => { const at = ms(t?.added_at); return at >= since && at < until; });
  const likedWaiting = likedNew.filter(t => waiting.has(t.id)).length;

  // "New" needs something to compare with: without a last open, these say nothing.
  let misfits = null, newGenres = null, pl = null;
  if (base) {
    if (Array.isArray(base.misfits)) {
      const seen = new Set(base.misfits);
      misfits = new Set((misfiled ?? []).map(misfitKey).filter(k => !seen.has(k))).size;
    }
    if (Array.isArray(base.genres) && Array.isArray(genres)) {
      newGenres = genres.map(idsOf).filter(ids => ids.length && !base.genres.some(old => sameCluster(ids, old))).length;
    }
    if (base.pls && playlists) pl = playlistDiff(base.pls, playlists);
  }
  const shift = listeningShift(listening);

  const plMoved = pl ? pl.changed + pl.added + pl.gone : 0;
  const any = filed.tracks > 0 || likedWaiting > 0 || (misfits ?? 0) > 0 || (newGenres ?? 0) > 0 || plMoved > 0;
  return { since, until, sinceLastOpen, days: Math.max(0, Math.round((until - since) / DAY)),
           filed, likedNew: likedNew.length, likedWaiting, misfits, newGenres, playlists: pl, listening: shift,
           empty: !any };
}

/**
 * The record kept for the next open. Values this session could not work out
 * (`genres` null: the clusters were never computed) carry over from `prev`, so a
 * session that never opened Library does not make every cluster look new later.
 */
export function digestBaseline({ prev = null, now, misfiled = [], genres = null, playlists = null }) {
  return {
    v: 1,
    at: new Date(now).toISOString(),
    misfits: (misfiled ?? []).map(misfitKey).slice(0, KEEP_MISFITS),
    genres: Array.isArray(genres) ? genres.map(c => idsOf(c).slice(0, KEEP_IDS)).filter(x => x.length)
      : Array.isArray(prev?.genres) ? prev.genres : null,
    pls: playlists ?? prev?.pls ?? null,
  };
}

/** Read a stored baseline back; anything malformed is no baseline. */
export function parseBaseline(text) {
  try {
    const b = JSON.parse(text);
    return b && typeof b === 'object' && Number.isFinite(ms(b.at)) ? b : null;
  } catch { return null; }
}

const plural = (n, one, many = one + 's') => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** The digest as lines: `head` for the card's title, `lines` for each figure, in order. */
export function digestLines(d) {
  if (!d || d.empty) return null;
  const head = d.sinceLastOpen
    ? (d.days >= 1 ? `Since you last opened, ${plural(d.days, 'day')} ago` : 'Since you last opened')
    : `In the last ${plural(d.days, 'day')}`;
  const lines = [];
  if (d.filed.tracks) lines.push({ k: 'filed', short: `${d.filed.tracks.toLocaleString()} filed`, text: `Filed ${plural(d.filed.tracks, 'song')}`
    + (d.filed.back ? `, ${d.filed.back.toLocaleString()} later moved or undone` : ', none moved or undone since') });
  if (d.likedWaiting) lines.push({ k: 'liked', short: `${d.likedWaiting.toLocaleString()} new liked`, text: `${plural(d.likedWaiting, 'new liked song')} waiting to be filed` });
  if (d.misfits) lines.push({ k: 'misfits', short: plural(d.misfits, 'misfit'), text: `${plural(d.misfits, 'new misfit')} found`, go: 'tidy' });
  if (d.newGenres) lines.push({ k: 'genres', short: plural(d.newGenres, 'new genre'), text: `${plural(d.newGenres, 'new genre')} forming in what File is unsure about`, go: 'lists' });
  const p = d.playlists;
  if (p && p.changed + p.added + p.gone) {
    const bits = [p.changed && `${plural(p.changed, 'playlist')} changed`, p.added && `${p.added} new`, p.gone && `${p.gone} gone`].filter(Boolean);
    const net = [p.plus && `+${p.plus.toLocaleString()}`, p.minus && `−${p.minus.toLocaleString()}`].filter(Boolean);
    lines.push({ k: 'playlists', short: `${plural(p.changed + p.added + p.gone, 'playlist')} changed`, text: `${bits.join(', ')}${net.length ? ` (${net.join(' / ')} ${p.plus + p.minus === 1 ? 'track' : 'tracks'})` : ''}` });
  }
  if (d.listening) {
    const L = d.listening;
    lines.push({ k: 'listening', text: L.fresh
      ? `${L.fresh} of your top ${L.top} artists lately aren't in your all-time top${L.examples.length ? ` (${L.examples.join(', ')})` : ''}`
      : `Your top ${L.top} artists lately are all in your all-time top` });
  }
  return { head, lines };
}
