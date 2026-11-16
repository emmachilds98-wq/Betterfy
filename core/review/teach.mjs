// The teach queue (docs/SMARTER-GENRES-PLAN.md §4.3 and phase 4; BUILD-6 SG).
//
// A handful of one-tap questions about the waiting tracks whose answers should
// teach the engine most:
//
//   value = listening x uncertainty    (filequeue.mjs valueOf, the File order)
//         x reach                      (this artist's other waiting tracks: an
//                                       answer files the artist, and the File
//                                       card then offers the rest of them)
//         x openness                   (a choice of two or three over a yes/no)
//
// and never two questions about one artist in a batch. A track the Engine is
// confident about is never asked: the answer is one it already has.
//
// The choices are the Engine's checked short list where it has one
// (core/intrinsic/calibrate.mjs decide(), kind `choose`), else the card's own
// best guesses, labelled as guesses. An answer is an ordinary filing (the File
// screen's add, History entry and accept), so it feeds the same learning path
// every filing does: the next space built from the library has the track in it.
// Nothing is trained, fetched or pooled (plan §3, R1-R3).
//
// Whether it is worth showing is measured per account, not assumed:
// core/validate/teach.mjs `teachGate` on the account's own filing, run with the
// Score run. Bundled into the page and exposed as globals, like filequeue.mjs.
import { valueOf } from './filequeue.mjs';

export const TEACH_VERSION = '1.0.0';

export const TEACH = {
  /** Questions shown at once ("ten tracks at a time", plan §4.3). */
  batch: 10,
  /** A list of one is a yes/no rather than a choice: it teaches less. */
  singleWeight: 0.6,
  /** Best guesses shown for a track the Engine is not sure about. */
  guesses: 3,
};

/** decide() kinds as the bands filequeue.mjs reads uncertainty by. */
const KIND_BAND = { choose: 'LIKELY', unsure: 'AMBIGUOUS' };

/** The first artist's id (or name) of a backlog row or raw track. */
export function artistKeyOf(row) {
  const a = row?.artists?.[0];
  return a?.id ?? a?.name ?? (typeof row?.artist === 'string' ? row.artist.split(',')[0].trim() || null : null);
}

/** How many waiting rows each artist has: artist key -> count. */
export function artistSpread(rows) {
  const m = new Map();
  for (const r of rows ?? []) { const k = artistKeyOf(r); if (k) m.set(k, (m.get(k) ?? 0) + 1); }
  return m;
}

const asChoice = p => (typeof p === 'string' ? { id: p, name: p } : p?.id ? { id: p.id, name: p.name ?? p.id } : null);

/**
 * What to offer for one row: { choices: [{ id, name }], checked } or null.
 *
 *   choose     the Engine's checked short list (`checked: true`)
 *   unsure     the card's best guesses, `guesses(row)`, at most TEACH.guesses
 *              (`checked: false`: the page says they are guesses)
 *   confident  nothing: an answer the engine already has teaches it nothing
 *
 * A row with no Engine verdict at all is treated as unsure.
 */
export function choicesOf(row, decision, guesses = null) {
  if (decision?.kind === 'confident') return null;
  if (decision?.kind === 'choose' && decision.playlists?.length) {
    const choices = decision.playlists.map(asChoice).filter(Boolean);
    return choices.length ? { choices, checked: true } : null;
  }
  const g = (guesses?.(row) ?? []).map(asChoice).filter(Boolean).slice(0, TEACH.guesses);
  return g.length ? { choices: g, checked: false } : null;
}

/**
 * How much one answer about this row should teach, 0 when there is nothing to
 * ask. `spread` is artistSpread over the waiting rows.
 */
export function teachValue(row, { kind = null, choices = [] } = {}, { weights = null, tracks = null, spread = null } = {}) {
  if (!choices?.length || kind === 'confident') return 0;
  const base = valueOf(row, { weights, tracks, bandOf: () => KIND_BAND[kind] ?? null });
  const reach = 1 + Math.log2(Math.max(1, spread?.get?.(artistKeyOf(row)) ?? 1));
  const open = choices.length >= 2 ? 1 : TEACH.singleWeight;
  return +(base * reach * open).toFixed(4);
}

/**
 * The batch to ask about, most worth asking first:
 * [{ row, choices, checked, kind, value }].
 *
 * `decisionOf(row)` is the Engine's calibrated verdict (or null), `guesses(row)`
 * the card's picks for a row it is not sure about. Skipped rows and those in
 * `answered` (ids) are left out, and so is any choice already rejected for that
 * track (`rejected(row, playlistId)`); a row left with no choice is not asked.
 * One question per artist.
 */
export function teachQueue(rows, { decisionOf = null, guesses = null, weights = null, tracks = null,
                                   limit = TEACH.batch, answered = null, rejected = null } = {}) {
  const list = (rows ?? []).filter(r => r?.id && !(r.skips > 0) && !answered?.has?.(r.id));
  const spread = artistSpread(list);
  const out = [];
  for (const row of list) {
    const d = decisionOf?.(row) ?? null;
    const c = choicesOf(row, d, guesses);
    if (!c) continue;
    const choices = rejected ? c.choices.filter(x => !rejected(row, x.id)) : c.choices;
    if (!choices.length) continue;
    const kind = d?.kind ?? 'unsure';
    const value = teachValue(row, { kind, choices }, { weights, tracks, spread });
    if (value > 0) out.push({ row, choices, checked: c.checked, kind, value });
  }
  out.sort((a, b) => b.value - a.value || (b.row.added ?? '').localeCompare(a.row.added ?? '')
    || (a.row.id < b.row.id ? -1 : 1));
  const seen = new Set(), batch = [];
  for (const q of out) {
    const k = artistKeyOf(q.row);
    if (k && seen.has(k)) continue;
    if (k) seen.add(k);
    batch.push(q);
    if (batch.length >= limit) break;
  }
  return batch;
}
