// @bundle engine BetterfyWeightFit 105
// The account-native engine's component weights, fitted to this account's own
// held-out filing — docs/SMARTER-GENRES-PLAN.md §4.2(1), "Weights fitted per
// account".
//
// `space.mjs`'s WEIGHTS are priors: graph 1.0 against a shape group (length,
// era, release type, album size, popularity) worth 1.0 between them and a
// registrant worth 0.5. On the owner's library that let the record's shape
// out-vote the artist graph even for artists the account *had* filed, and on a
// synthetic library shaped like it the graph at ×4 lifted filed-artist top-1
// from 77% to 90%. The right balance is a property of the account, not of the
// engine, so it is fitted per account here.
//
// What is fitted: one multiplier per group of components (graph, registrant,
// shape, the similar-artist bridge when there is one, and `graphN`, the graph
// with a wide playlist's dilution taken out, which starts at zero), from a
// seven-step grid, by coordinate ascent. A handful of combination weights
// chosen by counting held-out hits, the same kind of fit the blend weight and
// the calibration already do. No model is trained; nothing leaves the account.
//
// Cheap, because nothing is rebuilt. `placementAccuracy(…, { fitParts: true })`
// keeps every held-out track's raw components against every destination of
// its own fold's space, and any weights are then a re-combination of those
// numbers: a few milliseconds per candidate for 600 tracks.
//
// Honest, because it is nested. For each fold, the multipliers are chosen on
// the other folds' tracks and scored on this fold's, so the reported "fitted"
// number is for tracks the weights were never tuned on. The weights the page
// then uses are fitted on every track (the usual cross-validation bargain: the
// score describes the procedure, the final fit is the procedure run on all of
// it), and only when the held-out number beat the defaults by a point.
import { WEIGHTS } from '../intrinsic/space.mjs';
import { scoresOf } from '../intrinsic/calibrate.mjs';
import { DEFAULT_FOLDS } from './loo.mjs';

export const WEIGHT_FIT_VERSION = '1.0.0';

/** Fitted weights are used only when their held-out top-1 beats the defaults' by this. */
export const FIT_MARGIN = 0.01;

/** Which components move together. Bonus (Rekordbox) and sound are left as they are. */
export const GROUPS = Object.freeze({
  graph:      Object.freeze(['graph']),
  registrant: Object.freeze(['registrant']),
  shape:      Object.freeze(['minutes', 'era', 'albumType', 'albumTracks', 'popularity']),
  bridge:     Object.freeze(['bridge']),
  graphN:     Object.freeze(['graphN']),
});

/** The multipliers each group may take. Zero is in, so "drop it" is a candidate. */
export const MULTIPLIERS = Object.freeze([0, 0.25, 0.5, 1, 2, 4, 8]);

/** Where the search starts, and what "the defaults" means: WEIGHTS exactly. */
export const DEFAULT_MULT = Object.freeze({ graph: 1, registrant: 1, shape: 1, bridge: 1, graphN: 0 });

/**
 * Whether the search may also try `graphN` (space.mjs `graphNormalised`), the
 * graph with a wide playlist's dilution divided out. Measured on the shaped
 * synthetic library (test/fixtures/shaped-library.mjs, three seeds): offered
 * alongside the other groups it never beat the plain fit on held-out tracks
 * (−0.9 to +0.3 points of top-1; the graph's own multiplier already absorbs
 * the dilution), so the Score run leaves it out. Kept as an option so a
 * harness can measure it again on another library.
 */
export const GRAPH_N_SEARCHED = false;

/** Coordinate ascent stops after this many passes, or sooner when a pass moves nothing. */
const MAX_PASSES = 3;

const rate = (n, d) => (d > 0 ? +(n / d).toFixed(4) : null);
const tidy = x => +x.toFixed(6);

/**
 * The defaults, key for key as `placementAccuracy` scores them: WEIGHTS without
 * the bridge for the headline, with it appended for the similar-artist variant.
 * Key order matters only for floating-point ties, and is kept anyway.
 */
export function baseWeights(withBridge = false) {
  const base = { ...WEIGHTS };
  const b = base.bridge;
  delete base.bridge;
  return withBridge ? { ...base, bridge: b } : base;
}

/** Multipliers → the weights object `placements` takes. */
export function weightsFor(mult, { withBridge = false } = {}) {
  const w = baseWeights(withBridge);
  for (const [g, keys] of Object.entries(GROUPS)) {
    if (g === 'graphN') continue;
    const m = mult?.[g] ?? DEFAULT_MULT[g];
    for (const k of keys) if (k in w) w[k] = tidy(w[k] * m);
  }
  const n = mult?.graphN ?? 0;
  if (n > 0) w.graphN = tidy(WEIGHTS.graph * n);
  return w;
}

/**
 * Part rows → arrays the search can re-combine quickly. Destinations are kept
 * in `placements`' tie order (by id), and one with nothing judged is dropped,
 * exactly as `placements` drops it (`judged` counts present components
 * whatever their weight).
 */
export function compileRows(partRows, keys) {
  const K = keys.length;
  const out = [];
  for (const r of partRows ?? []) {
    const truth = new Set(r.truth ?? []);
    if (!truth.size) continue;
    const dests = (r.dests ?? []).slice().sort((a, b) => a.playlistId.localeCompare(b.playlistId));
    const ids = [], vals = [];
    for (const d of dests) {
      const row = new Array(K);
      let present = 0;
      for (let k = 0; k < K; k++) {
        const v = d.parts?.[keys[k]];
        if (v === null || v === undefined || !Number.isFinite(v)) row[k] = NaN;
        else { row[k] = v; present++; }
      }
      if (!present) continue;
      ids.push(d.playlistId);
      vals.push(...row);
    }
    out.push({ id: r.id, fold: r.fold, fresh: !!r.fresh, truth, ids,
               hit: Uint8Array.from(ids, id => (truth.has(id) ? 1 : 0)), vals: Float64Array.from(vals) });
  }
  return out;
}

/** One row's scores at weight vector `w` (aligned with the compiled keys). */
function scoreRow(r, w, exact) {
  const K = w.length, n = r.ids.length, s = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let num = 0, den = 0;
    const o = i * K;
    for (let k = 0; k < K; k++) {
      const v = r.vals[o + k];
      if (v !== v) continue;   // NaN: not judged
      num += w[k] * v;
      den += w[k];
    }
    const x = den > 0 ? num / den : 0;
    s[i] = exact ? +x.toFixed(4) : Math.round(x * 1e4) / 1e4;
  }
  return s;
}

/** Top-1 and top-3 hits over `rows` at weight vector `w`. */
function evaluate(rows, w, exact = false) {
  let h1 = 0, h3 = 0;
  for (const r of rows) {
    const s = scoreRow(r, w, exact);
    // The three best, by score then id (ids are already in id order, so the
    // earlier index wins a tie), as placements sorts them.
    let a = -1, b = -1, c = -1;
    for (let i = 0; i < s.length; i++) {
      if (a < 0 || s[i] > s[a]) { c = b; b = a; a = i; }
      else if (b < 0 || s[i] > s[b]) { c = b; b = i; }
      else if (c < 0 || s[i] > s[c]) c = i;
    }
    if (a >= 0 && r.hit[a]) h1++;
    if ((a >= 0 && r.hit[a]) || (b >= 0 && r.hit[b]) || (c >= 0 && r.hit[c])) h3++;
  }
  return { n: rows.length, h1, h3 };
}

/** One row as calibrate's / the blend's `{ id, scores, truth }`. */
function scoredRow(r, w) {
  const s = scoreRow(r, w, true);
  const results = r.ids.map((id, i) => ({ playlistId: id, score: s[i] }));
  return { id: r.id, scores: scoresOf(results), truth: [...r.truth].sort() };
}

/**
 * Held-out top-1 and top-3 of part rows at one weights object, exactly as
 * `placementAccuracy(…, { weights })` would report them: for checking, and for
 * a harness measuring a candidate by hand.
 */
export function accuracyAt(partRows, weights) {
  const keys = Object.keys(weights ?? {});
  const rows = compileRows(partRows, keys);
  const r = evaluate(rows, keys.map(k => weights[k]), true);
  return { top1: rate(r.h1, r.n), top3: rate(r.h3, r.n) };
}

const better = (x, y) => x.h1 > y.h1 || (x.h1 === y.h1 && x.h3 > y.h3);

/**
 * Coordinate ascent over the groups' multipliers, from the defaults. A move is
 * taken only when it is strictly better (top-1, then top-3), so a library that
 * cannot tell two values apart keeps the default, and a flat surface stays at
 * WEIGHTS exactly.
 */
export function fitMultipliers(rows, keys, { groups, withBridge = false, grid = MULTIPLIERS } = {}) {
  const vec = mult => { const w = weightsFor(mult, { withBridge }); return keys.map(k => w[k] ?? 0); };
  let cur = { ...DEFAULT_MULT };
  let best = evaluate(rows, vec(cur));
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let moved = false;
    for (const g of groups) {
      for (const m of grid) {
        if (m === cur[g]) continue;
        const cand = { ...cur, [g]: m };
        const r = evaluate(rows, vec(cand));
        if (better(r, best)) { cur = cand; best = r; moved = true; }
      }
    }
    if (!moved) break;
  }
  return { mult: cur, ...best };
}

/**
 * Fit one variant (the headline engine, or the engine with similar artists)
 * from `placementAccuracy`'s part rows, nested over its folds.
 *
 * @returns {null | {
 *   scored, default: {top1, top3}, fitted: {top1, top3},
 *   neverFiled: {scored, default: {top1, top3}, fitted: {top1, top3}},
 *   multipliers, weights, foldMultipliers, use, margin,
 *   rows, byFold, all }}
 *   `rows` are each track's held-out ranking under its own fold's fit (for
 *   calibration); `byFold[f]` every track under fold f's fit and `all` every
 *   track under the final fit (for the nested blend). The last three are only
 *   kept when `use` is true, since nothing reads them otherwise.
 */
export function fitVariant(partRows, { withBridge = false, grid = MULTIPLIERS, graphN = GRAPH_N_SEARCHED } = {}) {
  // Only the components some row has at all (sound and the Rekordbox bonus
  // are absent for almost everybody), which is also all `combine` would read.
  const seen = new Set();
  for (const r of partRows ?? []) for (const d of r.dests ?? []) for (const [k, v] of Object.entries(d.parts ?? {}))
    if (Number.isFinite(v)) seen.add(k);
  const keys = [...Object.keys(baseWeights(withBridge)), ...(graphN ? ['graphN'] : [])].filter(k => seen.has(k));
  const rows = compileRows(partRows, keys);
  if (!rows.length) return null;
  const groups = ['graph', ...(graphN ? ['graphN'] : []), 'registrant', 'shape', ...(withBridge ? ['bridge'] : [])];
  const vec = mult => { const w = weightsFor(mult, { withBridge }); return keys.map(k => w[k] ?? 0); };

  const folds = [...new Set(rows.map(r => r.fold))].sort((a, b) => a - b);
  const foldMultipliers = {};
  const acc = { n: 0, f1: 0, f3: 0 }, accNf = { n: 0, f1: 0, f3: 0 };
  const held = new Map();     // id → held-out row under its own fold's fit
  const foldW = {};
  for (const f of folds) {
    const train = rows.filter(r => r.fold !== f), test = rows.filter(r => r.fold === f);
    // A single fold has nothing to train on: it fits on itself, the most anyone
    // can do, and says so by reporting the one fold.
    const { mult } = fitMultipliers(train.length ? train : test, keys, { groups, withBridge, grid });
    foldMultipliers[f] = mult;
    const w = vec(mult);
    for (const r of test) {
      const one = evaluate([r], w, true);
      for (const a of r.fresh ? [acc, accNf] : [acc]) { a.n++; a.f1 += one.h1; a.f3 += one.h3; }
      held.set(r.id, scoredRow(r, w));
    }
    foldW[f] = w;
  }
  const def = evaluate(rows, vec(DEFAULT_MULT), true);
  const fresh = rows.filter(r => r.fresh);
  const defNf = evaluate(fresh, vec(DEFAULT_MULT), true);
  const final = fitMultipliers(rows, keys, { groups, withBridge, grid }).mult;

  const out = {
    scored: rows.length,
    default: { top1: rate(def.h1, def.n), top3: rate(def.h3, def.n) },
    fitted: { top1: rate(acc.f1, acc.n), top3: rate(acc.f3, acc.n) },
    neverFiled: { scored: fresh.length,
                  default: { top1: rate(defNf.h1, defNf.n), top3: rate(defNf.h3, defNf.n) },
                  fitted: { top1: rate(accNf.f1, accNf.n), top3: rate(accNf.f3, accNf.n) } },
    multipliers: final,
    weights: weightsFor(final, { withBridge }),
    foldMultipliers,
    margin: FIT_MARGIN,
  };
  out.use = out.fitted.top1 != null && out.default.top1 != null
    && out.fitted.top1 >= out.default.top1 + FIT_MARGIN - 1e-9;
  if (out.use) {
    // Every track under each fold's fit, so the blend for fold f can be chosen
    // on the other folds' tracks ranked by the native engine fold f would use.
    out.byFold = {};
    for (const f of folds) out.byFold[f] = rows.map(r => scoredRow(r, foldW[f]));
    out.all = rows.map(r => scoredRow(r, vec(final)));
    out.rows = rows.map(r => held.get(r.id));
  }
  return out;
}

/**
 * The whole step, as the Score run calls it: the headline engine, and the
 * engine with similar artists when the run had them, each fitted from the
 * run's part rows. Null without part rows. Takes the part rows off `mine`, so
 * they never cross from the worker or sit in memory after.
 */
export function weightsFromRun(mine, { grid = MULTIPLIERS, graphN = GRAPH_N_SEARCHED } = {}) {
  const partRows = mine?.partRows;
  if (mine) delete mine.partRows;
  if (!partRows?.length) return null;
  const plain = fitVariant(partRows, { withBridge: false, grid, graphN });
  const bridge = mine.withBridge ? fitVariant(partRows, { withBridge: true, grid, graphN }) : null;
  return { plain, bridge, folds: Object.keys(plain?.foldMultipliers ?? {}).length || DEFAULT_FOLDS,
           version: WEIGHT_FIT_VERSION };
}

/**
 * What crosses to the page: the weights, the numbers they were judged by, and
 * (only when they are used) each track's held-out ranking under its own fold's
 * fit, which the page's calibration is refitted on and then drops. The
 * per-fold rankings the nested blend read are left behind.
 */
export function fitSummary(fit) {
  if (!fit) return null;
  const strip = v => {
    if (!v) return null;
    const { byFold, all, ...rest } = v;
    return rest;
  };
  return { ...fit, plain: strip(fit.plain), bridge: strip(fit.bridge) };
}
