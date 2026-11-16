// @bundle engine BetterfyAgree 101
// "Sure" only when the sources agree (docs/NEXT-WORKPLAN.md package 4).
//
// A placement is a mix of sources that make different mistakes:
//
//   sound    how the track sounds next to each playlist's heard members
//            (the `audio` and `learned` parts; only for a heard track, and
//            only on the sound-first engine that lets them in)
//   history  where this account files this artist and its neighbours (the
//            artist graph, the `graph` part)
//   similar  where the artist's outside neighbours are filed (the `bridge`
//            part; only when similar artists were looked up)
//   tags     the crowd-tag engine's ranking (core/classify rank()), joined
//            in from outside because the intrinsic space never reads tags
//
// Each source is read on its own: which playlists IT ranks first. A card on
// which two or more independent sources rank the same playlist first, and none
// ranks it outside its own top 3, is far more often right than its combined
// margin says. calibrate.mjs fits a separate "confident" threshold per
// agreement level on the account's own held-out rows, so the extra trust is
// measured, never assumed.
//
// Nothing here is trained or fetched. It reads the parts a placement already
// carries.

export const AGREE_VERSION = '1.0.0';

/** Sources, in the order they are listed. */
export const SOURCES = Object.freeze(['sound', 'history', 'similar', 'tags']);

/** Levels. `agree`: 2+ sources rank the lead first and none against it.
 *  `single`: one source does, none against. `split`: anything else. */
export const LEVELS = Object.freeze(['agree', 'single', 'split']);

/** How deep a source's list is kept: a source "is against" the lead when the
 *  lead is not in its own top this-many. */
export const DEPTH = 3;

const PART_OF = { history: ['graph'], similar: ['bridge'], sound: ['learned', 'audio'] };

/**
 * One source's top-`DEPTH` ids from per-destination scores ([[id, score]] or a
 * Map), or null when the source has nothing to say: no positive score, or no
 * spread between the destinations it scored (a source that rates everything
 * the same ranks nothing).
 */
export function topOf(scored, depth = DEPTH) {
  const list = (scored instanceof Map ? [...scored] : scored ?? [])
    .filter(([id, v]) => id != null && Number.isFinite(v));
  if (list.length < 1) return null;
  list.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const hi = list[0][1], lo = list[list.length - 1][1];
  if (!(hi > 0)) return null;
  if (list.length > 1 && !(hi - lo > 1e-9)) return null;
  return list.slice(0, depth).map(([id]) => id);
}

/**
 * Each source's own top picks from a placement's results (every destination,
 * `placements(…, { limit: Infinity })`). Only sources present in the parts are
 * listed: an unheard track has no `sound`, a space without a bridge no
 * `similar`. `tags` is optional: the tag engine's [[id, score]] for the track.
 *
 * @returns {{sound?: string[], history?: string[], similar?: string[], tags?: string[]}}
 */
export function sourceTops(results, { tags = null, depth = DEPTH } = {}) {
  const out = {};
  for (const [src, keys] of Object.entries(PART_OF)) {
    const scored = [];
    for (const r of results ?? []) {
      const p = r?.parts;
      if (!p) continue;
      let v = null;
      for (const k of keys) if (Number.isFinite(p[k])) v = (v ?? 0) + p[k];
      if (v !== null) scored.push([r.playlistId, v]);
    }
    const top = scored.length ? topOf(scored, depth) : null;
    if (top) out[src] = top;
  }
  const t = tags ? topOf(tags, depth) : null;
  if (t) out.tags = t;
  return out;
}

/**
 * How the sources line up behind one lead playlist.
 * @returns {{ level: 'agree'|'single'|'split', agree: string[], against: string[], spoke: number }}
 */
export function agreement(lead, src) {
  const agree = [], against = [];
  let spoke = 0;
  for (const s of SOURCES) {
    const top = src?.[s];
    if (!top?.length) continue;
    spoke++;
    if (top[0] === lead) agree.push(s);
    else if (!top.includes(lead)) against.push(s);
  }
  const level = lead == null || against.length ? 'split' : agree.length >= 2 ? 'agree' : agree.length === 1 ? 'single' : 'split';
  return { level, agree, against, spoke };
}

/** The level alone, for a row's lead ([[id, score]] highest first). */
export const levelOf = (scores, src) => agreement(scores?.[0]?.[0] ?? null, src).level;

/**
 * Put `agree` (a level) on held-out rows. `srcById` gives each row's sources
 * by track id (from the run that produced the rows, or joined from others);
 * `tagsById` optionally adds the tag engine's own top picks per track id.
 * Rows are copied, never changed in place. A row with no sources at all is
 * `split`: nothing vouches for it. `drop` leaves named sources out.
 */
export function withAgreement(rows, srcById, tagsById = null, { drop = null } = {}) {
  const get = (m, id) => (m instanceof Map ? m.get(id) : m?.[id]) ?? null;
  return (rows ?? []).map(r => {
    const src = { ...(get(srcById, r.id) ?? {}) };
    const t = tagsById ? get(tagsById, r.id) : null;
    if (t?.length) src.tags = t;
    // A source the live card will not have (e.g. similar artists before File
    // has them) must not shape the level it is judged at.
    for (const k of drop ?? []) delete src[k];
    return { ...r, agree: levelOf(r.scores, src) };
  });
}

/** The tag engine's top picks per track id, from its held-out rows ({id, scores}). */
export function tagTopsOf(tagRows, depth = DEPTH) {
  const out = {};
  for (const r of tagRows ?? []) {
    if (!r?.id) continue;
    const t = topOf(r.scores, depth);
    if (t) out[r.id] = t;
  }
  return out;
}

/** Each row's sources by id, merged over several runs' rows (later runs add
 *  sources the earlier ones lacked, e.g. `similar` from the bridge run). */
export function srcByIdOf(...rowLists) {
  const out = {};
  for (const rows of rowLists) for (const r of rows ?? []) {
    if (!r?.id || !r.src) continue;
    out[r.id] = { ...(out[r.id] ?? {}), ...r.src };
  }
  return out;
}

/** Engine screen line for one calibration report with agreement levels. */
export function agreeLine(report) {
  const a = report?.agree;
  if (!a) return '';
  const pc = x => `${Math.round(x * 100)}%`;
  if (!a.use) {
    const why = a.why ?? 'not enough held-out cards where the sources agree';
    return `Sure when sources agree: not used yet (${why}).`;
  }
  return `Sure when sources agree: ${pc(a.share)} of cards, right ${pc(a.right)} of ${a.n} held out.`
    + (a.share < 0.25 ? ' Fewer than a quarter of cards so far.' : '');
}
