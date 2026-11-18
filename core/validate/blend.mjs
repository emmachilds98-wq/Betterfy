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
import { normalised, blendScores, BLEND_GRID, BLEND_VERSION,
         blendThree, THREE_GRID, ROUTES, routeMode, soundLeads } from '../intrinsic/blend.mjs';
import { playlistFamilies, familyAccuracy, fitFamilyCalibration, familyConfident, narrowToFamily } from '../intrinsic/family.mjs';
import { fitTemperature } from '../intrinsic/calibrate.mjs';

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
                                                     neverFiled = null, nativeByFold = null, nativeAll = null,
                                                     situations = false } = {}) {
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
  // E2 (docs/BUILD-7-PLAN.md): one weight per situation instead of one for all
  // (tracks by artists already filed / never filed), reported as `bySituation`,
  // nested the same way; a situation with fewer than SITUATION_MIN training
  // rows falls back to the one weight.
  const bySituation = situations && neverFiled ? situationFit(rows, rowsFor, foldIds, best, grid, out, head) : null;
  return {
    ...head,
    ...(bySituation ? { bySituation } : {}),
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

/** A situation needs this many training rows to get a weight of its own. */
export const SITUATION_MIN = 30;

function situationFit(rows, rowsFor, foldIds, best, grid, out, head) {
  const acc = { n: 0, b1: 0, b3: 0, t1: 0, t3: 0, n1: 0, n3: 0 };
  const accNf = { n: 0, b1: 0, b3: 0, t1: 0, t3: 0, n1: 0, n3: 0 };
  const foldWeights = {};
  for (const f of foldIds) {
    const these = rowsFor(f);
    const train = these.filter(r => r.fold !== f), test = these.filter(r => r.fold === f);
    const one = best(train.length ? train : test);
    const pick = {};
    for (const fresh of [false, true]) {
      const t = train.filter(r => r.fresh === fresh);
      pick[fresh] = t.length >= SITUATION_MIN ? best(t) : one;
    }
    foldWeights[f] = { filed: grid[pick[false]], neverFiled: grid[pick[true]] };
    for (const r of test) {
      const i = pick[r.fresh];
      for (const a of r.fresh ? [acc, accNf] : [acc]) {
        a.n++; if (r.hits[i][0]) a.b1++; if (r.hits[i][1]) a.b3++;
        if (r.tag[0]) a.t1++; if (r.tag[1]) a.t3++; if (r.nat[0]) a.n1++; if (r.nat[1]) a.n3++;
      }
    }
  }
  const all = rows;
  const w = {};
  for (const fresh of [false, true]) {
    const t = all.filter(r => r.fresh === fresh);
    w[fresh ? 'neverFiled' : 'filed'] = grid[t.length >= SITUATION_MIN ? best(t) : best(all)];
  }
  const o = out(acc);
  return { ...o, neverFiled: out(accNf), weights: w, foldWeights,
           beatsOne: o.top1 != null && head.top1 != null && o.top1 >= head.top1 + BEAT_MARGIN - 1e-9 };
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
  // E2: the per-situation weight is measured beside the one weight, and used by nothing yet.
  const r = blendAccuracy(base.rows, nativeRows, { folds, neverFiled: nf, situations: true, ...nested });
  if (!r) return null;
  // S1: sound joins the blend, per situation, on the same folds and tracks.
  let route = null;
  const soundRows = mine?.withAudio?.rows, led = mine?.withAudio?.led;
  if (soundRows?.length && led) {
    try {
      route = routeAccuracy(base.rows, nativeRows, soundRows, {
        folds, neverFiled: nf, led: new Set(led), blendFoldWeights: r.foldWeights, ...nested,
        families: familiesOf(lib, targets, isMirror),
        // File can only route through the blend when it runs the blend (blend.js blendActive).
        blendOnFile: !!r.beatsTags && withBridge });
    } catch { route = null; }
  }
  return { ...r, withBridge, ...(nested.nativeAll ? { nativeFitted: true } : {}), ...(route ? { route } : {}) };
}

/* ======================= S1: sound joins the blend, per situation =======================
 * docs/BUILD-7-PLAN.md. On File, a track listening has heard leads with sound
 * (web/app/soundfirst.js soundPicks) and the blend sits underneath; on the
 * owner's library the blend alone is right first time more often, and sound is
 * better only for artists never filed. So, on the same held-out folds as the
 * blend, five ways for a heard track (core/intrinsic/blend.mjs ROUTES):
 *
 *   today   sound leads, the blend underneath (File's rule)
 *   blend   the blend alone
 *   three   tags, the engine and sound blended, the weights fitted per fold
 *           on the other folds (nested exactly like the blend's weight)
 *   route   never-filed artist: sound leads; filed artist: the blend
 *   route3  never-filed artist: sound leads; filed artist: the three-way blend
 *
 * A track sound has nothing on gets the blend in every way, as it does today.
 * The best of the four new ways is used on File only if it beats today's by
 * ROUTE_GATE.top1 overall with no more than ROUTE_GATE.loss lost on never-filed
 * artists (or overall top-3). The family arm keeps the chosen way's ranking
 * inside the family when the family view is confident (the "family confident"
 * of core/intrinsic/family.mjs, fitted on the other folds), gated the same way.
 *
 * No model: a few weights and a temperature per account, from counts (R1). */

/** The bar, set before the run: +1 point top-1 overall, nothing worse than −1 on never-filed or top-3. */
export const ROUTE_GATE = Object.freeze({ top1: 0.01, loss: 0.01 });
/** The new ways, in the order a tie goes (simplest first). */
export const ROUTE_ARMS = Object.freeze(['blend', 'route', 'three', 'route3']);

/** Each genre playlist's family, from the library's playlist names. */
export function familiesOf(lib, targets = null, isMirror = null) {
  const allowed = targets ? new Set(targets) : null;
  const mirror = mirrorPredicate(lib, { also: isMirror ?? undefined });
  return playlistFamilies((lib?.playlists ?? []).filter(p => p?.id && !mirror(p) && (!allowed || allowed.has(p.id)))
    .map(p => [p.id, p.name ?? p.id]));
}

/**
 * May arm `a` replace arm `b` on File? `a` and `b` are `{ top1, top3,
 * neverFiled: { top1 } }` on the same tracks. A point of top-1 ahead, and no
 * more than a point behind on never-filed artists or on top-3.
 */
export function routeBeats(a, b, gate = ROUTE_GATE) {
  if (a?.top1 == null || b?.top1 == null) return false;
  if (a.top1 < b.top1 + gate.top1 - 1e-9) return false;
  if (a.top3 != null && b.top3 != null && a.top3 < b.top3 - gate.loss - 1e-9) return false;
  const an = a.neverFiled?.top1, bn = b.neverFiled?.top1;
  if (an != null && bn != null && an < bn - gate.loss - 1e-9) return false;
  return true;
}

/** The arm File should use instead of today's, or null: the best that clears the gate. */
export function routeChoice(arms, gate = ROUTE_GATE) {
  let best = null;
  for (const name of ROUTE_ARMS) {
    const a = arms?.[name];
    if (!a || !routeBeats(a, arms.today, gate)) continue;
    if (!best || a.top1 > arms[best].top1 + 1e-9 || (Math.abs(a.top1 - arms[best].top1) < 1e-9 && a.top3 > arms[best].top3 + 1e-9)) best = name;
  }
  return best;
}

/** Top-1 and top-3 of a ranking (ids, best first) against the truth. */
const hitsOf = (ids, want) => [!!ids[0] && want.has(ids[0]), ids.slice(0, 3).some(id => want.has(id))];

/**
 * @param {Array<{id, scores, truth}>} tagRows    the tag engine's held-out rows
 * @param {Array<{id, scores, truth}>} nativeRows the engine's, with similar artists when there were any
 * @param {Array<{id, scores, truth}>} soundRows  the sound-first engine's (placementAccuracy withAudio.rows)
 * @param {object} o
 * @param {Set<string>} o.led          ids of tracks sound led on (withAudio.led)
 * @param {object}  o.blendFoldWeights the blend's weight per fold (blendAccuracy foldWeights)
 * @param {Set<string>} [o.neverFiled]
 * @param {Map<string,string>} [o.families]  playlist → family, for the family arm
 * @param {boolean} [o.blendOnFile]    whether File runs the blend (else nothing here may be used)
 */
export function routeAccuracy(tagRows, nativeRows, soundRows, { folds = DEFAULT_FOLDS, led, blendFoldWeights,
                                                                neverFiled = null, nativeByFold = null, nativeAll = null,
                                                                families = null, blendOnFile = true, grid = THREE_GRID } = {}) {
  if (!tagRows?.length || !nativeRows?.length || !soundRows?.length || !led || !blendFoldWeights) return null;
  const tagById = new Map(tagRows.map(r => [r.id, r]));
  const sndById = new Map(soundRows.map(r => [r.id, r]));
  // One entry per track all three were asked about; on a led track, for every
  // three-way weight, whether its first answer (and first three) were right.
  const join = natRows => {
    const out = [];
    for (const n of natRows ?? []) {
      const t = tagById.get(n.id), s = sndById.get(n.id);
      if (!t || !s) continue;
      const want = new Set(n.truth ?? t.truth ?? []);
      if (!want.size) continue;
      const isLed = led.has(n.id);
      const tag = normalised(t.scores), nat = normalised(n.scores), snd = isLed ? normalised(s.scores) : null;
      out.push({ id: n.id, fold: foldOf(n.id, folds), fresh: !!neverFiled?.has(n.id), led: isLed, want, tag, nat, snd,
                 sound: s.scores, hits: null });
    }
    return out;
  };
  const withHits = rows => {
    for (const r of rows) if (r.led && !r.hits) r.hits = grid.map(w => hitsOf(blendThree(r.tag, r.nat, r.snd, w).slice(0, 3).map(x => x[0]), r.want));
    return rows;
  };
  const rows = join(nativeRows);
  if (!rows.length) return null;
  const nested = !!nativeByFold;
  const perFold = new Map();
  const rowsFor = f => {
    if (!nested || !nativeByFold[f]) return rows;
    if (!perFold.has(f)) perFold.set(f, join(nativeByFold[f]));
    return perFold.get(f);
  };
  // Best three-way weight on `subset`: top-1, then top-3, then the least sound,
  // then the most tags — a tie never moves anyone further from today's blend.
  const best = subset => {
    withHits(subset);
    let bi = 0, b1 = -1, b3 = -1;
    grid.forEach((w, i) => {
      let h1 = 0, h3 = 0;
      for (const r of subset) { if (r.hits[i][0]) h1++; if (r.hits[i][1]) h3++; }
      const g = grid[bi];
      if (h1 > b1 || (h1 === b1 && (h3 > b3 || (h3 === b3 && (w[2] < g[2] || (w[2] === g[2] && w[0] > g[0])))))) { bi = i; b1 = h1; b3 = h3; }
    });
    return bi;
  };
  // The family view, fitted on other folds' sound rows (the rows File's family
  // view is read from: engine.js engineFamilyFit).
  const famFit = trainRows => {
    if (!families?.size) return null;
    const usable = trainRows.filter(r => r?.scores?.length && r.truth?.length);
    const acc = usable.length ? familyAccuracy(usable, families) : null;
    if (!acc || acc.families < 2) return null;
    return { T: fitTemperature(usable), cal: fitFamilyCalibration(acc.rows) };
  };

  const names = ['today', ...ROUTE_ARMS];
  const tally = () => ({ n: 0, h1: 0, h3: 0 });
  const acc = Object.fromEntries(names.map(k => [k, { all: tally(), nf: tally(), heard: tally(), fam: { all: tally(), nf: tally() } }]));
  const famStat = { n: 0, confident: 0, right: 0 };
  const foldWeights = {};
  const foldIds = [...new Set(rows.map(r => r.fold))].sort((a, b) => a - b);
  const add = (t, [h1, h3]) => { t.n++; if (h1) t.h1++; if (h3) t.h3++; };
  for (const f of foldIds) {
    const these = rowsFor(f);
    const trainLed = these.filter(r => r.fold !== f && r.led);
    const test = these.filter(r => r.fold === f);
    const i3 = best(trainLed.length ? trainLed : test.filter(r => r.led));
    foldWeights[f] = grid[i3];
    const fam = famFit(soundRows.filter(r => foldOf(r.id, folds) !== f));
    const wb = blendFoldWeights[f] ?? blendFoldWeights[String(f)];
    for (const r of test) {
      const blendIds = blendScores(r.tag, r.nat, wb).map(x => x[0]);
      const soundIds = r.led ? r.sound.map(x => x[0]) : null;
      const byMode = {
        blend: blendIds,
        sound: r.led ? soundLeads(soundIds, blendIds) : blendIds,
        three: r.led ? blendThree(r.tag, r.nat, r.snd, grid[i3]).map(x => x[0]) : blendIds,
      };
      const family = fam ? familyConfident(r.sound, families, fam.T, fam.cal) : null;
      famStat.n++;
      if (family) {
        famStat.confident++;
        if ([...r.want].some(id => (families.get(id) ?? `own:${id}`) === family)) famStat.right++;
      }
      for (const k of names) {
        const ids = byMode[routeMode(k, { fresh: r.fresh, led: r.led })];
        const h = hitsOf(ids, r.want), a = acc[k];
        add(a.all, h);
        if (r.fresh) add(a.nf, h);
        if (r.led) add(a.heard, h);
        const hf = family ? hitsOf(narrowToFamily(ids, family, families), r.want) : h;
        add(a.fam.all, hf);
        if (r.fresh) add(a.fam.nf, hf);
      }
    }
  }
  const pct = t => ({ scored: t.n, top1: rate(t.h1, t.n), top3: rate(t.h3, t.n) });
  const arms = {}, famArms = {};
  for (const k of names) {
    const a = acc[k];
    arms[k] = { ...pct(a.all), neverFiled: pct(a.nf), heard: pct(a.heard) };
    famArms[k] = { ...pct(a.fam.all), neverFiled: pct(a.fam.nf) };
  }
  const choice = blendOnFile ? routeChoice(arms) : null;
  const famBase = choice ?? 'today';
  const famUse = !!blendOnFile && !!families?.size && famStat.confident > 0 && routeBeats(famArms[famBase], arms[famBase]);
  // The final fits on every track, used by File: the cross-validation bargain, as for the blend's weight.
  const allRows = nested && nativeAll ? join(nativeAll) : rows;
  const ledAll = allRows.filter(r => r.led);
  const weights = ledAll.length ? grid[best(ledAll)] : null;
  const famAll = famUse ? famFit(soundRows) : null;
  return {
    scored: arms.today.scored, heard: arms.today.heard.scored,
    arms, weights, foldWeights,
    choice, use: !!choice, blendOnFile: !!blendOnFile,
    family: {
      tracks: famStat.n, confident: rate(famStat.confident, famStat.n), right: rate(famStat.right, famStat.confident),
      base: famBase, arm: famArms[famBase], arms: famArms, use: famUse,
      ...(famAll ? { T: famAll.T, cal: famAll.cal } : {}),
    },
    gate: ROUTE_GATE,
  };
}
