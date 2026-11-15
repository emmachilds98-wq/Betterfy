// @bundle engine BetterfyBlendScore 106
// Held-out accuracy for the blend of the two engines, and the one weight it
// runs at — docs/SMARTER-GENRES-PLAN.md phase 1.
//
// The Score run already ranks every scored track twice over the same folds:
// once by today's tag engine (`baselineAccuracy(…, { collect: true })`) and
// once by the account-native engine with its neighbour bridge
// (`placementAccuracy(…, { collect: true, bridge })`). Both keep the full
// ranking per track. This joins the two per track and asks one question: at
// what weight between them does the account's own filing come out best?
//
// The weight is fitted honestly. For each fold, it is chosen on the *other*
// folds' tracks and then scored on this fold's, so the reported number is for
// tracks the weight was never tuned on — a grid search over eleven values is a
// fit like any other, and reporting its best in-sample score would flatter it.
// The weight the File screen then uses is fitted on every track, which is the
// usual cross-validation bargain: the score describes the procedure, the
// final fit is the procedure run on everything.
//
// No model is trained. It is one number per account, from counts.
import { foldOf, DEFAULT_FOLDS } from './loo.mjs';
import { mirrorPredicate } from '../playlists/mirror.mjs';
import { normalised, blendScores, BLEND_GRID, BLEND_VERSION } from '../intrinsic/blend.mjs';

export const BLEND_ACCURACY_VERSION = '1.0.0';

/**
 * How far the blend has to beat the tag engine, on held-out tracks, before the
 * File screen uses it: a point of top-1, with top-3 no more than a point down.
 * Less than a point on a few hundred tracks is fold noise, and switching an
 * account's filing over on noise is the thing every phase has refused to do.
 */
export const BEAT_MARGIN = 0.01;

/** Same as space.mjs's MIN_DEFINITION_TRACKS: a destination needs five members. */
const MIN_MEMBERS = 5;

const rate = (n, d) => (d > 0 ? +(n / d).toFixed(4) : null);

/**
 * Which scored tracks are by "never-filed" artists, decided exactly as
 * `placementAccuracy` decides it: none of the track's artists is in any
 * destination of the space built without the track's fold. Worked out here
 * from the library rather than carried on the rows, so the harness's own
 * output (pinned byte for byte by test/fixtures/space-v4-golden.json) is
 * unchanged.
 */
export function neverFiledIds(lib, ids, { folds = DEFAULT_FOLDS, targets = null, isMirror = null } = {}) {
  const mirror = mirrorPredicate(lib, { also: isMirror ?? undefined });
  const allowed = targets ? new Set(targets) : null;
  const scored = new Set(ids);
  const byFold = new Map();
  for (const id of scored) {
    const f = foldOf(id, folds);
    if (!byFold.has(f)) byFold.set(f, []);
    byFold.get(f).push(id);
  }
  const trackArtists = new Map();
  for (const p of lib?.playlists ?? []) for (const t of p.tracks ?? [])
    if (t?.id && scored.has(t.id) && !trackArtists.has(t.id)) trackArtists.set(t.id, t.artists ?? []);
  const out = new Set();
  for (const [, members] of byFold) {
    const skip = new Set(members);
    const filed = new Set();
    for (const p of lib?.playlists ?? []) {
      if (!p?.id || mirror(p) || (allowed && !allowed.has(p.id))) continue;
      const kept = (p.tracks ?? []).filter(t => t?.id && !skip.has(t.id));
      if (kept.length < MIN_MEMBERS) continue;
      for (const t of kept) for (const a of t.artists ?? []) if (a?.id) filed.add(a.id);
    }
    for (const id of members)
      if (!(trackArtists.get(id) ?? []).some(a => a?.id && filed.has(a.id))) out.add(id);
  }
  return out;
}

/**
 * @param {Array<{id, scores: [string, number][], truth: string[]}>} tagRows    baseline rows
 * @param {Array<{id, scores: [string, number][], truth: string[]}>} nativeRows placementAccuracy rows
 *        (with the bridge when there was one)
 * @param {object} [opts]
 * @param {number}   [opts.folds]       the folds the rows were scored with
 * @param {number[]} [opts.grid]        weights on the tag engine to try
 * @param {Set<string>} [opts.neverFiled]  ids of tracks by never-filed artists
 * @returns {null | {scored, weight, top1, top3, tags, native, neverFiled, foldWeights, beatsTags, …}}
 *          null when there is nothing to join.
 */
export function blendAccuracy(tagRows, nativeRows, { folds = DEFAULT_FOLDS, grid = BLEND_GRID,
                                                     neverFiled = null, nativeByFold = null, nativeAll = null } = {}) {
  if (!tagRows?.length || !nativeRows?.length) return null;
  const tagById = new Map(tagRows.map(r => [r.id, r]));
  // One entry per track both engines were asked about, with each engine's
  // ranking normalised once and, for every weight on the grid, whether the
  // blend's first answer (and first three) held a playlist the track is in.
  const join = natRows => {
    const out = [];
    for (const n of natRows) {
      const t = tagById.get(n.id);
      if (!t) continue;
      const want = new Set(n.truth ?? t.truth ?? []);
      if (!want.size) continue;
      const tag = normalised(t.scores), nat = normalised(n.scores);
      const hits = grid.map(w => {
        const r = blendScores(tag, nat, w);
        return [!!r[0] && want.has(r[0][0]), r.slice(0, 3).some(x => want.has(x[0]))];
      });
      const top = list => [!!list[0] && want.has(list[0][0]), (list ?? []).slice(0, 3).some(x => want.has(x[0]))];
      out.push({ id: n.id, fold: foldOf(n.id, folds), fresh: !!neverFiled?.has(n.id),
                 hits, tag: top(t.scores ?? []), nat: top(n.scores ?? []) });
    }
    return out;
  };
  const rows = join(nativeRows);
  if (!rows.length) return null;
  // Nested (core/validate/weights.mjs): the native engine's own weights were
  // fitted per fold, so fold f's blend is chosen on the other folds' tracks
  // as ranked by the native engine fold f uses, and scored on fold f's under
  // the same. Nothing about fold f, weights or blend, is chosen on fold f.
  const nested = !!nativeByFold;
  const perFold = new Map();
  const rowsFor = f => {
    if (!nested || !nativeByFold[f]) return rows;
    if (!perFold.has(f)) perFold.set(f, join(nativeByFold[f]));
    return perFold.get(f);
  };

  // The grid index that does best on `subset`: top-1 first, then top-3, then
  // the weight nearest today's engine (tags), so a tie never moves anyone off
  // what they have for nothing.
  const best = subset => {
    let bi = -1, b1 = -1, b3 = -1;
    grid.forEach((w, i) => {
      let h1 = 0, h3 = 0;
      for (const r of subset) { if (r.hits[i][0]) h1++; if (r.hits[i][1]) h3++; }
      if (h1 > b1 || (h1 === b1 && (h3 > b3 || (h3 === b3 && w > grid[bi])))) { bi = i; b1 = h1; b3 = h3; }
    });
    return bi;
  };

  const foldIds = [...new Set(rows.map(r => r.fold))].sort((a, b) => a - b);
  const foldWeights = {};
  const all = { n: 0, b1: 0, b3: 0, t1: 0, t3: 0, n1: 0, n3: 0 };
  const nf = { n: 0, b1: 0, b3: 0, t1: 0, t3: 0, n1: 0, n3: 0 };
  for (const f of foldIds) {
    const these = rowsFor(f);
    const train = these.filter(r => r.fold !== f);
    const test = these.filter(r => r.fold === f);
    // A single fold has nothing to train on: fit on itself, which is the most
    // anyone can do, and the beat test below still compares like with like.
    const i = best(train.length ? train : test);
    foldWeights[f] = grid[i];
    for (const r of test) for (const acc of r.fresh ? [all, nf] : [all]) {
      acc.n++;
      if (r.hits[i][0]) acc.b1++;
      if (r.hits[i][1]) acc.b3++;
      if (r.tag[0]) acc.t1++;
      if (r.tag[1]) acc.t3++;
      if (r.nat[0]) acc.n1++;
      if (r.nat[1]) acc.n3++;
    }
  }
  const out = acc => ({ scored: acc.n, top1: rate(acc.b1, acc.n), top3: rate(acc.b3, acc.n),
                        tags: { top1: rate(acc.t1, acc.n), top3: rate(acc.t3, acc.n) },
                        native: { top1: rate(acc.n1, acc.n), top3: rate(acc.n3, acc.n) } });
  const head = out(all);
  const beatsTags = head.top1 != null && head.tags.top1 != null
    && head.top1 >= head.tags.top1 + BEAT_MARGIN - 1e-9
    && head.top3 >= head.tags.top3 - BEAT_MARGIN - 1e-9;
  return {
    ...head,
    weight: grid[best(nested && nativeAll ? join(nativeAll) : rows)],
    foldWeights,
    neverFiled: neverFiled ? out(nf) : null,
    beatsTags,
    margin: BEAT_MARGIN,
    blendVersion: BLEND_VERSION,
    version: BLEND_ACCURACY_VERSION,
    ...(nested ? { nested: true } : {}),
  };
}

/**
 * The whole step, as the Score run calls it: the rows from both engines (the
 * native side with its bridge when it had one), never-filed worked out the
 * harness's way, and the fit. Null when either side has no rows (no tags, or
 * the run was not collecting).
 */
export function blendFromRun(lib, { base, mine, folds = DEFAULT_FOLDS, targets = null, isMirror = null,
                                    nativeFit = null } = {}) {
  const withBridge = !!mine?.withBridge?.rows;
  const nativeRows = mine?.withBridge?.rows ?? mine?.rows ?? null;
  if (!base?.rows?.length || !nativeRows?.length) return null;
  const nf = neverFiledIds(lib, nativeRows.map(r => r.id), { folds, targets, isMirror });
  // The native engine's fitted weights, when this account's fit earned its
  // place (weights.mjs `use`): the blend is then fitted on top of the engine
  // the page will actually run. Otherwise the defaults, exactly as before.
  const fit = withBridge ? nativeFit?.bridge : nativeFit?.plain;
  const nested = fit?.use && fit.byFold && fit.all
    ? { nativeByFold: fit.byFold, nativeAll: fit.all } : {};
  const r = blendAccuracy(base.rows, nativeRows, { folds, neverFiled: nf, ...nested });
  return r ? { ...r, withBridge, ...(nested.nativeAll ? { nativeFitted: true } : {}) } : null;
}
