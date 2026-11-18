// @bundle engine BetterfyPairs 109
// The playlists it confuses (docs/archive/NEXT-WORKPLAN.md package 5).
//
// Family first (#145) already settles "it's drum & bass" and asks only which
// playlist inside the family. What is left is telling two neighbours apart:
// jungle vs rollers, UKG vs speed garage, Late Night House vs house. Here each
// confusable pair gets its own small sound check:
//
//   d(track) = how close it sits to A's nearest heard members
//            − how close it sits to B's nearest heard members
//
// (mood.mjs nearScore, so the same ear and the same k), with one threshold on
// d fitted on half of the pair's heard members and checked on the other half,
// then swapped and pooled. A pair is used only where the checked two-way
// accuracy reaches PAIR_GATE.minAccuracy on at least PAIR_GATE.minHeard
// heard tracks, and only to order the two picks of a family card: it never
// makes a card Sure, never adds a pick, never files anything.
//
// Which pairs: the ones this account's own held-out rows confuse (truth one
// of the two, the other ranked above it, both in the engine's top two), plus
// the Score run's "Can't tell apart" list. Nothing is trained or pooled across
// accounts; it is a threshold over this account's own heard tracks.
import { nearScore } from './mood.mjs';

export const PAIRS_VERSION = '1.0.0';

export const PAIR_GATE = Object.freeze({
  minHeard: 20,        // heard tracks across the pair before it is fitted, and checked
  minAccuracy: 0.7,    // checked two-way accuracy, held out
  minSide: 5,          // heard members on each side
  k: 5,                // nearest members averaged (as mood.mjs)
  maxMembers: 120,     // members per side compared, for cost
  maxPairs: 8,         // pairs fitted per Score run
});

const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };
// Salted, so the split is independent of mood.mjs's and of the fold assignment.
const half = id => hash(`pair:${id}`) & 1;
const sample = (ids, n) => ids.length <= n ? ids : [...ids].sort((a, b) => hash(a) - hash(b)).slice(0, n);
const rate = (a, b) => (b ? +(a / b).toFixed(4) : null);

/** A pair's key, the same whichever way round. */
export const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** d for one track: closeness to A's nearest members minus closeness to B's (self skipped). */
export function pairScore(emb, membersA, membersB, k = PAIR_GATE.k, self = null) {
  const a = nearScore(emb, membersA, k, self), b = nearScore(emb, membersB, k, self);
  return a == null || b == null ? null : a - b;
}

/**
 * The threshold on d that best splits `scored` ([d, isA]): "A" when d ≥ tau.
 * Tried at every midpoint; ties go to the threshold nearest 0 (no lean either way).
 */
export function fitThreshold(scored) {
  if (!scored.length) return null;
  const s = [...scored].sort((x, y) => x[0] - y[0]);
  const nA = s.filter(x => x[1]).length;
  // Everything called A (tau below every d): right on every A.
  let best = { tau: s[0][0] - 1e-9, right: nA };
  let aBelow = 0, bBelow = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i][1]) aBelow++; else bBelow++;
    if (i + 1 < s.length && s[i + 1][0] === s[i][0]) continue;
    const tau = i + 1 < s.length ? (s[i][0] + s[i + 1][0]) / 2 : s[i][0] + 1e-9;
    const right = bBelow + (nA - aBelow);
    if (right > best.right || (right === best.right && Math.abs(tau) < Math.abs(best.tau))) best = { tau, right };
  }
  return best.tau;
}

const accuracyAt = (scored, tau) => {
  let right = 0;
  for (const [d, isA] of scored) if ((d >= tau) === isA) right++;
  return { n: scored.length, right, accuracy: rate(right, scored.length) };
};

/** Heard members of a playlist, as [id, emb], minus `not` (tracks in both). */
function heardMembers(p, index, not, max) {
  const ids = [...new Set((p?.tracks ?? []).map(t => t?.id).filter(id => id && index.has(id) && !not.has(id)))];
  return sample(ids, max).map(id => [id, index.get(id).emb]);
}

/** Both sides of a pair, heard, tracks in both left out. Remembered per
 *  library and index, since File asks on every render. */
let SIDES = { lib: null, index: null, map: new Map() };
function sidesOf(lib, index, a, b, max) {
  if (SIDES.lib !== lib || SIDES.index !== index) SIDES = { lib, index, map: new Map() };
  const key = `${pairKey(a, b)}|${max}`;
  if (SIDES.map.has(key)) return SIDES.map.get(key);
  const byId = new Map((lib?.playlists ?? []).map(p => [p.id, p]));
  const pa = byId.get(a), pb = byId.get(b);
  let out = null;
  if (pa && pb && index instanceof Map) {
    const ida = new Set((pa.tracks ?? []).map(t => t?.id)), idb = new Set((pb.tracks ?? []).map(t => t?.id));
    const both = new Set([...ida].filter(id => idb.has(id)));
    out = { A: heardMembers(pa, index, both, max), B: heardMembers(pb, index, both, max) };
  }
  SIDES.map.set(key, out);
  return out;
}

/**
 * Fit one pair. `a`, `b` are playlist ids. Tracks in both are left out: they
 * answer neither way.
 * @returns {{ a, b, key, n, tau, tauBy, checked, use, why }}
 */
export function fitPair(lib, index, a, b, gate = PAIR_GATE) {
  const g = { ...PAIR_GATE, ...gate };
  const row = { a, b, key: pairKey(a, b), n: 0, tau: null, tauBy: null, checked: null, use: false, why: null };
  const sides = sidesOf(lib, index, a, b, g.maxMembers);
  if (!sides) { row.why = 'playlist not found'; return row; }
  const { A, B } = sides;
  row.n = A.length + B.length;
  if (A.length < g.minSide || B.length < g.minSide || row.n < g.minHeard) {
    row.why = `only ${A.length} + ${B.length} heard, ${g.minHeard} needed with ${g.minSide} a side`;
    return row;
  }
  const halves = [[], []];
  for (const [id, emb] of A) { const d = pairScore(emb, A, B, g.k, id); if (d != null) halves[half(id)].push([d, true]); }
  for (const [id, emb] of B) { const d = pairScore(emb, A, B, g.k, id); if (d != null) halves[half(id)].push([d, false]); }
  if (!halves[0].length || !halves[1].length) { row.why = 'too few heard tracks to split in two'; return row; }
  const t0 = fitThreshold(halves[0]), t1 = fitThreshold(halves[1]);
  const c0 = accuracyAt(halves[1], t0), c1 = accuracyAt(halves[0], t1);
  const n = c0.n + c1.n, right = c0.right + c1.right;
  row.checked = { n, right, accuracy: rate(right, n) };
  row.tauBy = [+t0.toFixed(6), +t1.toFixed(6)];
  row.tau = +fitThreshold([...halves[0], ...halves[1]]).toFixed(6);
  row.use = n >= g.minHeard && row.checked.accuracy >= g.minAccuracy;
  row.why = row.use ? null : n < g.minHeard ? 'too few held-out tracks'
    : `held-out two-way ${Math.round(row.checked.accuracy * 100)}%, ${Math.round(g.minAccuracy * 100)}% needed`;
  return row;
}

/**
 * The pairs worth fitting: held-out rows where the engine's top two are the
 * pair and the truth is the one ranked second, counted per pair, most
 * confused first; then the Score run's "Can't tell apart" pairs
 * (reports.mjs bucketPairs, `indistinguishable` only: a "view" is one
 * playlist inside another, not a confusion). `inScope(id)` limits both to the
 * genre playlists.
 * @returns {Array<{a, b, key, misses}>}
 */
export function pairCandidates(rows, enginePairs = [], { limit = PAIR_GATE.maxPairs, inScope = null, together = null, extra = [] } = {}) {
  const seen = new Map();
  const ok = id => id && (!inScope || inScope(id));
  // `together(a, b)`: the two may be a pair at all (same family). Default: any two.
  const tog = (a, b) => !together || together(a, b);
  for (const r of rows ?? []) {
    const [x, y] = r?.scores ?? [];
    if (!x || !y || !ok(x[0]) || !ok(y[0]) || !tog(x[0], y[0])) continue;
    const truth = new Set(r.truth ?? []);
    if (truth.has(x[0]) || !truth.has(y[0])) continue;
    const key = pairKey(x[0], y[0]);
    const p = seen.get(key) ?? { a: x[0] < y[0] ? x[0] : y[0], b: x[0] < y[0] ? y[0] : x[0], key, misses: 0 };
    p.misses++;
    seen.set(key, p);
  }
  const out = [...seen.values()].filter(p => p.misses >= 2).sort((p, q) => q.misses - p.misses || (p.key < q.key ? -1 : 1));
  for (const e of enginePairs ?? []) {
    if (e?.verdict && e.verdict !== 'indistinguishable') continue;
    const a = e?.a?.id ?? e?.a, b = e?.b?.id ?? e?.b;
    if (!ok(a) || !ok(b) || a === b || !tog(a, b)) continue;
    const key = pairKey(a, b);
    if (!out.some(p => p.key === key)) out.push({ a: a < b ? a : b, b: a < b ? b : a, key, misses: 0 });
  }
  const kept = out.slice(0, limit);
  // `extra` (weak.mjs weakPairs): a weak playlist and the one it is mistaken
  // for. Kept on top of `limit` and whatever the family, because a playlist
  // the engine never ranks second can never be a confusion pair above, and is
  // exactly the one whose fix depends on the answer: two playlists that sound
  // alike are a merge question, two that don't need more examples. Marked
  // `weak`: unless the engine also confused them above, it never re-orders a card.
  for (const e of extra ?? []) {
    if (!ok(e?.a) || !ok(e?.b) || e.a === e.b) continue;
    const key = pairKey(e.a, e.b);
    const have = kept.find(p => p.key === key);
    if (have) { have.weak = e.weak ?? true; continue; }
    kept.push({ a: e.a < e.b ? e.a : e.b, b: e.a < e.b ? e.b : e.a, key, misses: e.misses ?? 0, weak: e.weak ?? true });
  }
  return kept;
}

/** Which of the two a heard track sounds like, by a fitted pair: `x`, `y` or null (not used / not heard). */
export function pairPick(trackId, x, y, fit, index, lib, { tauOf = null } = {}) {
  // A weak pair the engine never ranked as its top two (weak.mjs) is measured
  // for the diagnosis only: it was not part of the swap's check, so it never
  // re-orders a card.
  const row = fit?.rows?.find(r => r.use && r.key === pairKey(x, y) && (!r.weak || r.misses > 0));
  const rec = index?.get?.(trackId);
  if (!row || !rec?.emb) return null;
  const sides = sidesOf(lib, index, row.a, row.b, PAIR_GATE.maxMembers);
  if (!sides) return null;
  const d = pairScore(rec.emb, sides.A, sides.B, PAIR_GATE.k, trackId);
  if (d == null) return null;
  const tau = tauOf ? tauOf(row, trackId) : row.tau;
  return d >= tau ? row.a : row.b;
}

/**
 * Re-order a card's two picks by the pair check: [first, second] in the order
 * the check says, and whether it swapped them. Unchanged when the pair is not
 * in use or the track was not heard.
 */
export function pairOrder(trackId, picks, fit, index, lib) {
  const [x, y] = picks ?? [];
  if (!x || !y) return { picks, swapped: false };
  const p = pairPick(trackId, x, y, fit, index, lib);
  if (p === y) return { picks: [y, x, ...picks.slice(2)], swapped: true };
  return { picks, swapped: false };
}

/**
 * Whether the pair checks may be used at all: on the Score run's held-out
 * rows (`rows`, the engine that places), the top-1 with the top two
 * re-ordered by each used pair, against the top-1 without. Each track is
 * judged with the threshold fitted on the half it is not in, and is never one
 * of its own nearest members. `use` only when overall top-1 is not lower.
 */
export function pairsImpact(rows, fit, index, lib) {
  let n = 0, before = 0, after = 0, judged = 0, swapped = 0;
  const tauOf = (row, id) => row.tauBy?.[1 - half(id)] ?? row.tau;
  for (const r of rows ?? []) {
    if (!r?.scores?.length || !r.truth?.length) continue;
    n++;
    const truth = new Set(r.truth);
    const x = r.scores[0][0], y = r.scores[1]?.[0];
    let lead = x;
    if (y) {
      const p = pairPick(r.id, x, y, fit, index, lib, { tauOf });
      if (p) { judged++; if (p !== x) swapped++; lead = p; }
    }
    if (truth.has(x)) before++;
    if (truth.has(lead)) after++;
  }
  return { n, judged, swapped, before: rate(before, n), after: rate(after, n), use: judged > 0 && after >= before };
}

/**
 * Fit the pairs for one Score run and decide whether they are used.
 * @param {object} lib
 * @param {Map} index    heard tracks (audio.mjs audioIndex: id → { emb })
 * @param {Array} rows   held-out rows of the engine that places (placementAccuracy collect)
 * @param {Array} enginePairs  the "Can't tell apart" list (reports.mjs bucketPairs)
 */
export function fitPairs(lib, index, rows, enginePairs = [], { inScope = null, together = null, gate = PAIR_GATE, extra = [] } = {}) {
  const cands = pairCandidates(rows, enginePairs, { inScope, together, limit: gate.maxPairs ?? PAIR_GATE.maxPairs, extra });
  const fit = { version: PAIRS_VERSION, rows: cands.map(c => ({ ...fitPair(lib, index, c.a, c.b, gate), misses: c.misses,
                                                                 ...(c.weak ? { weak: c.weak } : {}) })) };
  // The swap is checked on the pairs the engine itself confuses; a weak pair
  // it never ranked as its top two is there for weak.mjs's diagnosis only.
  fit.impact = fit.rows.some(r => r.use && (!r.weak || r.misses > 0)) ? pairsImpact(rows, fit, index, lib) : null;
  fit.use = !!fit.impact?.use;
  return fit;
}

/** The Score line: what was measured and whether it is used. */
export function pairsLine(fit, nameOf = id => id) {
  const rows = fit?.rows ?? [];
  if (!rows.length) return '';
  const pc = x => `${Math.round(x * 100)}%`;
  const used = rows.filter(r => r.use);
  const list = rows.map(r => `${nameOf(r.a)} vs ${nameOf(r.b)} `
    + (r.use ? `(right ${pc(r.checked.accuracy)} of ${r.checked.n} held out)` : `(not used: ${r.why})`));
  const imp = fit.impact;
  const tail = imp ? ` Top-1 with them ${pc(imp.after)} vs ${pc(imp.before)} without (${imp.judged} of ${imp.n} cards judged, ${imp.swapped} re-ordered)`
    + `${fit.use ? '' : ', so they are not used'}.` : '';
  return `Pair checks: ${used.length} of ${rows.length} confusable pairs told apart by sound. ${list.join('; ')}.${tail}`;
}
