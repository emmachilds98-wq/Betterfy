// The File queue's order and its sure batch (docs/BUILD-5-PLAN.md §5.2).
//
// Pure counts over what Spotify already gives every account: the three
// top-artist windows, recently played and /me/top/tracks. Nothing here is
// trained, fetched or pooled. Bundled into the page and exposed as globals.
//
// Order = how much you play it x how little the engine knows it, the same two
// halves core/personal/relevance.mjs names (relevanceOf, UNCERTAINTY). Listening
// only decides what to ask about first, never what a track is.
import { relevanceOf, UNCERTAINTY } from '../personal/relevance.mjs';

export const FILEQUEUE_VERSION = '1.0.0';

/** What the card's band is called in the History log, which Score reads (core/measure/history.mjs). */
export const BAND_LOG = { HIGH: 'sure', LIKELY: 'likely', AMBIGUOUS: 'unsure' };

/** The Engine's calibrated decide() kinds, as the bands the chip draws. */
export const DECISION_BAND = { confident: 'HIGH', family: 'LIKELY', choose: 'LIKELY', unsure: 'AMBIGUOUS' };

/** The band for a card: the calibrated verdict when the Engine has judged this
 *  track, else the leading pick's own band, else none. */
export function cardBand(picks, decision = null) {
  return DECISION_BAND[decision?.kind] ?? picks?.[0]?.band ?? null;
}

/**
 * Track-level listening, as a count: a place in each /me/top/tracks window
 * (weighted like the artist windows) plus how often it turns up in recently
 * played. Map of track id -> weight.
 */
export function trackWeights({ topTracks = [], recentTracks = [] } = {}) {
  const w = new Map();
  const bump = (id, x) => { if (id) w.set(id, (w.get(id) ?? 0) + x); };
  for (const { items, weight } of topTracks) (items ?? []).forEach((id, i) => bump(id, weight * (1 - i / 60)));
  for (const id of recentTracks) bump(id, 0.6);
  return w;
}

/**
 * How little is known about where a row goes, 0..1. The band when there is one
 * (relevance.mjs's UNCERTAINTY), else the top pick's own score, else nothing.
 */
export function rowUncertainty(row, band = null) {
  if (band && band in UNCERTAINTY) return UNCERTAINTY[band];
  const s = row?.suggest?.[0]?.score;
  return Number.isFinite(s) ? Math.max(0.05, 1 - Math.min(1, s)) : 1;
}

/** Listening weight x uncertainty, for one backlog row. */
export function valueOf(row, { weights = null, tracks = null, bandOf = null } = {}) {
  const played = relevanceOf(row, weights) + (tracks?.get?.(row?.id) ?? 0);
  return +(played * rowUncertainty(row, bandOf?.(row) ?? null)).toFixed(4);
}

/**
 * The queue in order of value. Skipped tracks stay below everything unseen
 * (the old rule); within a skip count, most valuable first, ties newest-liked
 * first. Without any listening data every weight is the same 1, so this is the
 * uncertainty order alone, and with neither it is the old newest-first order.
 * Returns a new array.
 */
export function orderBacklog(rows, ctx = {}) {
  const v = new Map((rows ?? []).map(r => [r.id, valueOf(r, ctx)]));
  return [...(rows ?? [])].sort((a, b) => ((a.skips ?? 0) - (b.skips ?? 0))
    || (v.get(b.id) - v.get(a.id)) || (b.added ?? '').localeCompare(a.added ?? ''));
}

/**
 * Is this pick backed by more than tags? Only sound (the track was heard) or
 * filing history (this artist already sits in that playlist) can earn the green
 * "Sure" look: a tags-only pick is a choice, never a commitment
 * (docs/review/USER-REVIEW.md item 2).
 */
export function pickBacked(sg) {
  if (!sg || typeof sg !== 'object') return false;
  if (sg.via === 'history' || sg.via === 'sound' || sg.filed === true) return true;
  const ev = sg.evidence;
  return !!ev && ((Number(ev.sound) || 0) > 0 || (Number(ev.history) || 0) > 0 || (Number(ev.learned) || 0) > 0);
}

/** The band to show for a pick: a HIGH ("Sure") band the pick can't back drops to LIKELY. */
export function backedBand(band, sg) {
  return (band === 'HIGH' || band === 'high') && !pickBacked(sg) ? (band === 'HIGH' ? 'LIKELY' : 'medium') : band ?? null;
}

/**
 * The cards that are sure, each with where it goes: a calibrated HIGH band and
 * a leading pick, not skipped, not rejected for that playlist. In queue order.
 * `picksOf(row)` and `bandOf(row, picks)` come from the page.
 * @returns {{row: object, playlistId: string, name: string}[]}
 */
export function sureOnes(rows, { picksOf, bandOf, limit = 300 } = {}) {
  const out = [];
  for (const row of (rows ?? []).slice(0, limit)) {
    if ((row.skips ?? 0) > 0) continue;
    const picks = picksOf(row) ?? [];
    const top = picks[0];
    if (!top?.id || bandOf(row, picks) !== 'HIGH') continue;
    out.push({ row, playlistId: top.id, name: top.name });
  }
  return out;
}

/**
 * The label code in an ISRC: country + registrant, its first five characters
 * (the same reading core/intrinsic/features.mjs registrantOf makes, kept here
 * so File does not need the lazy Engine bundle). Null when malformed.
 */
export function registrantOfIsrc(isrc) {
  const raw = String(isrc ?? '').replace(/-/g, '').toUpperCase();
  return /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(raw) ? raw.slice(0, 5) : null;
}
