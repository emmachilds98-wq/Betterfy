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
import { clean, isFiling, undoneSet } from '../measure/history.mjs';

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

/* ---------- three card states (docs/BUILD-7-PLAN.md U1) ----------
 * Every File card is in exactly one of three states, decided here and nowhere
 * else, so the card, its buttons and "File the N sure ones" cannot disagree:
 *   sure      one filled button: the band is HIGH, more than tags back the
 *             pick (pickBacked) and nothing that was asked disagrees with it;
 *   twoWay    "Rollers or Jungle?": the family is settled but not the playlist,
 *             a pair check ordered the top two, or the lead is likely but not
 *             sure, so the top two are shown as equals;
 *   yourCall  nothing is a sure fit: the top three as equals, none lit.
 * Pure, and it changes no engine number: it only reads the band and the
 * pick's own parts. */
export const CARD_STATES = Object.freeze(['sure', 'twoWay', 'yourCall']);

const isHigh = b => b === 'HIGH' || b === 'high';
const isLikely = b => b === 'LIKELY' || b === 'medium';

/**
 * @param {object|null} pick  the leading pick
 * @param {{band?: string|null, backed?: boolean, agree?: boolean, family?: boolean,
 *          pair?: boolean, others?: number}} [o]
 *   band    the card's calibrated band (cardBand/backedBand), else the pick's own;
 *   backed  sound or filing history behind the pick (default pickBacked(pick));
 *   agree   the other source asked does not contradict it (default true);
 *   family  the Engine settled the family and asks which playlist inside it;
 *   pair    a pair check put these two in order (#152);
 *   others  how many other picks the card shows.
 * @returns {'sure'|'twoWay'|'yourCall'}
 */
export function cardState(pick, { band = pick?.band ?? null, backed, agree = true, family = false, pair = false, others = 0 } = {}) {
  if (!pick) return 'yourCall';
  if (family) return 'twoWay';
  const ok = backed ?? pickBacked(pick);
  if (isHigh(band) && ok && agree && !pair) return 'sure';
  if (!(others > 0)) return 'yourCall';
  // No band at all (a filing-history pick before any calibration): backed is enough to be one of two.
  return pair || isHigh(band) || isLikely(band) || (band == null && ok) ? 'twoWay' : 'yourCall';
}

/**
 * Does the rest of what is known agree with a pick? Only one disagreement is
 * on record without new work: a sound-led pick the track's tags do not name
 * at all, when the track has tag picks (soundfirst.js sets `tagsAgree`).
 */
export function pickAgrees(pick, row = null) {
  if (!pick) return false;
  if (pick.via === 'sound' && pick.tagsAgree === false) return !(row?.suggest?.length > 0);
  return true;
}

/** cardState for a queue row with its picks, its band and the Engine's decision. */
export function cardStateOf(row, picks, { band = null, decision = null, backed } = {}) {
  const top = picks?.[0] ?? null;
  return cardState(top, {
    band: band ?? top?.band ?? null, backed,
    agree: pickAgrees(top, row),
    family: decision?.kind === 'family' && !!decision.family,
    pair: !!top?.pair,
    others: Math.max(0, (picks?.length ?? 0) - 1),
  });
}

/* ---------- the honest scoreboard (USER-REVIEW "always right" 4) ----------
 * "Last 30 days: 94% of the picks you filed stayed": every track filed from
 * File (one card, a roll-forward, the sure batch) in the window, and how many
 * were neither undone nor later taken out of that playlist. Counted per track,
 * from History alone (core/measure/history.mjs), and shown only from KEPT_MIN
 * filings, so a handful of taps never reads as a verdict. */
export const KEPT_DAYS = 30;
export const KEPT_MIN = 20;

export function keptRate(log, now = Date.now(), { days = KEPT_DAYS, min = KEPT_MIN } = {}) {
  const all = clean(log), undone = undoneSet(all);
  const from = new Date(now - days * 864e5).toISOString();
  let n = 0, kept = 0;
  for (const e of all) {
    if (!isFiling(e) || e.at < from) continue;
    const back = !!e.undoneAt || undone.has(e.at);
    for (const id of Array.isArray(e.trackIds) ? e.trackIds : []) {
      n++;
      const out = back || all.some(x => x.op === 'remove' && x.at > e.at && x.playlistId === e.playlistId
        && !(x.group && x.group === e.group) && (x.trackIds ?? []).includes(id));
      if (!out) kept++;
    }
  }
  return { n, kept, rate: n ? kept / n : null, days, show: n >= min };
}

/** The line itself, or '' below the minimum. */
export function keptLine(k) {
  if (!k?.show || k.rate == null) return '';
  return `Last ${k.days} days: ${Math.round(k.rate * 100)}% of the picks you filed stayed`;
}

/* ---------- "it learned" (USER-REVIEW item 6) ----------
 * After a Skip, a pick other than the first, or an undo, the next card by the
 * same artist says what was taken from it. Only what was recorded is claimed:
 * a filing is learned (learnFiled, FB.accepted), a skip or an undo is noted. */
export function learnedNote(l) {
  if (!l?.artist) return '';
  if (l.kind === 'picked' && l.playlist) return `Learned: you file ${l.artist} in ${l.playlist}.`;
  if (l.kind === 'undo' && l.playlist) return `Noted: you took ${l.artist} back out of ${l.playlist}.`;
  if (l.kind === 'skip') return `Noted: you skipped the last one by ${l.artist}.`;
  return '';
}

/** Does this queue row get the note: the same first-billed artist, another track. */
export function learnedFor(l, row) {
  return !!l?.artistId && !!row && row.id !== l.trackId && row.artists?.[0]?.id === l.artistId;
}

/**
 * The cards that are sure, each with where it goes: a calibrated HIGH band and
 * a leading pick in the Sure state (cardStateOf), not skipped, not rejected for
 * that playlist. In queue order.
 * `picksOf(row)` and `bandOf(row, picks)` come from the page.
 * @returns {{row: object, playlistId: string, name: string}[]}
 */
export function sureOnes(rows, { picksOf, bandOf, limit = 300 } = {}) {
  const out = [];
  for (const row of (rows ?? []).slice(0, limit)) {
    if ((row.skips ?? 0) > 0) continue;
    const picks = picksOf(row) ?? [];
    const top = picks[0];
    const band = top?.id ? bandOf(row, picks) : null;
    // The page's bandOf already drops an unbacked HIGH (backedBand); what is left
    // to ask is the rest of the Sure state: agreement, and no pair in question.
    if (band !== 'HIGH' || cardStateOf(row, picks, { band, backed: true }) !== 'sure') continue;
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
