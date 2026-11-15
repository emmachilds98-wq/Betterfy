import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WEIGHTS, buildSpace, placements, componentParts, combine, graphNormalised } from '../core/intrinsic/space.mjs';
import { placementAccuracy, foldOf } from '../core/validate/loo.mjs';
import { blendFromRun } from '../core/validate/blend.mjs';
import { baselineAccuracy } from '../core/validate/baseline.mjs';
import { baseWeights, weightsFor, fitVariant, weightsFromRun, fitSummary, accuracyAt,
         DEFAULT_MULT, FIT_MARGIN, GRAPH_N_SEARCHED } from '../core/validate/weights.mjs';
import { fixture, FAMILIES } from './fixtures/engine-library.mjs';
import { shapedLibrary } from './fixtures/shaped-library.mjs';

/*
 * core/validate/weights.mjs: the account-native engine's component weights,
 * fitted on the account's own held-out filing, nested over the folds.
 * docs/SMARTER-GENRES-PLAN.md, "Weights fitted per account".
 */

const strip = r => { const { partRows, ...rest } = r; return rest; };
const run = (lib, opts = {}) => placementAccuracy(lib, { folds: 5, collect: true, genreGraph: true, fitParts: true, ...opts });

test('the default multipliers are WEIGHTS exactly, key for key as the harness scores them', () => {
  const plain = { ...WEIGHTS }; delete plain.bridge;
  assert.deepEqual(Object.entries(weightsFor(DEFAULT_MULT)), Object.entries(plain));
  assert.deepEqual(Object.entries(weightsFor(DEFAULT_MULT, { withBridge: true })),
                   Object.entries({ ...plain, bridge: WEIGHTS.bridge }));
  assert.deepEqual(baseWeights(true), weightsFor(DEFAULT_MULT, { withBridge: true }));
  assert.equal('graphN' in weightsFor(DEFAULT_MULT), false, 'the dilution fix is off unless fitted on');
  const w = weightsFor({ ...DEFAULT_MULT, graph: 4, shape: 0.25, graphN: 0.5 });
  assert.equal(w.graph, 4);
  assert.equal(w.minutes, WEIGHTS.minutes * 0.25);
  assert.equal(w.registrant, WEIGHTS.registrant);
  assert.equal(w.graphN, 0.5);
});

test('asking for part rows changes nothing else the harness reports', () => {
  const lib = fixture();
  const targets = new Set(FAMILIES.map(f => `p-${f}`));
  const without = placementAccuracy(lib, { folds: 5, collect: true, targets });
  const withParts = placementAccuracy(lib, { folds: 5, collect: true, targets, fitParts: true });
  assert.ok(withParts.partRows.length === withParts.scored);
  assert.deepEqual(strip(withParts), without);
  assert.equal('partRows' in without, false);
  assert.equal('partRows' in placementAccuracy(lib, { leaky: true, fitParts: true }), false, 'never on the canary');
});

test('a placement with default weights is unchanged; components recombine to exactly its scores', () => {
  const lib = shapedLibrary({ seed: 3 });
  const space = buildSpace(lib, { targets: lib.targets, bridge: lib.bridge, genreGraph: true });
  for (const t of lib.liked.slice(0, 15)) {
    const def = placements(t, space, { limit: Infinity });
    assert.deepEqual(placements(t, space, { limit: Infinity, weights: WEIGHTS }), def);
    // The same components, recombined at other weights, rank exactly as placements does.
    const w = weightsFor({ ...DEFAULT_MULT, graph: 4, shape: 0.5, graphN: 1 }, { withBridge: true });
    const direct = placements(t, space, { limit: Infinity, weights: w }).results.map(r => [r.playlistId, r.score]);
    const parts = componentParts(t, space).map(({ playlistId, parts }) => {
      const c = combine(parts, w);
      return c.judged ? [playlistId, +c.score.toFixed(4)] : null;
    }).filter(Boolean).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    assert.deepEqual(direct, parts);
    const top = placements(t, space, { weights: w }).results[0];
    if (top.parts.graph !== undefined) assert.ok('graphN' in top.parts, 'graphN is worked out when the weights name it');
    assert.equal('graphN' in (def.results[0]?.parts ?? {}), false, 'and never otherwise');
  }
});

test('graphNormalised takes a wide playlist\'s dilution out and is null where the graph is', () => {
  assert.equal(graphNormalised(null, { centroidNorm: 0.2 }), null);
  assert.equal(graphNormalised(0.16, { centroidNorm: 0 }), null);
  assert.equal(graphNormalised(0.16, { centroidNorm: 0.16 }), 1);
  assert.equal(graphNormalised(0.08, { centroidNorm: 0.16 }), 0.5);
  assert.equal(graphNormalised(0.9, { centroidNorm: 0.5 }), 1, 'capped');
});

test('re-scored at the defaults, the fit reproduces the harness\'s own numbers exactly', () => {
  for (const lib of [shapedLibrary({ seed: 11 }), shapedLibrary({ seed: 5 })]) {
    const mine = run(lib, { targets: new Set(lib.targets), bridge: lib.bridge });
    const plain = fitVariant(mine.partRows);
    const bridge = fitVariant(mine.partRows, { withBridge: true });
    assert.deepEqual(plain.default, { top1: mine.top1, top3: mine.top3 });
    assert.deepEqual(bridge.default, { top1: mine.withBridge.top1, top3: mine.withBridge.top3 });
    assert.deepEqual(plain.neverFiled.default, { top1: mine.neverFiled.top1, top3: mine.neverFiled.top3 });
    // And at any other weights, exactly what placementAccuracy reports with them.
    const w = weightsFor({ ...DEFAULT_MULT, graph: 4, shape: 0.25 });
    const direct = placementAccuracy(lib, { folds: 5, targets: new Set(lib.targets), genreGraph: true, weights: w });
    assert.deepEqual(accuracyAt(mine.partRows, w), { top1: direct.top1, top3: direct.top3 });
  }
});

test('on a library shaped like the owner\'s, the fit finds the graph should count for more, and earns its place', () => {
  const lib = shapedLibrary({ seed: 11 });
  const mine = run(lib, { targets: new Set(lib.targets), bridge: lib.bridge });
  const t0 = performance.now();
  const fit = weightsFromRun(mine);
  const ms = performance.now() - t0;
  assert.equal(mine.partRows, undefined, 'the part rows are taken off the result');
  for (const v of [fit.plain, fit.bridge]) {
    assert.ok(v.fitted.top1 >= v.default.top1 + 0.05, JSON.stringify([v.default, v.fitted]));
    assert.equal(v.use, true);
    assert.ok(v.multipliers.graph > v.multipliers.shape, JSON.stringify(v.multipliers));
    assert.equal(Object.keys(v.foldMultipliers).length, 5);
    assert.equal(v.rows.length, v.scored, 'held-out rows for calibration');
    assert.equal(Object.keys(v.byFold).length, 5, 'per-fold rankings for the nested blend');
  }
  assert.ok(ms < 8000, `the fit should stay cheap (took ${Math.round(ms)}ms)`);
  // What crosses to the page has no per-fold rankings.
  const s = fitSummary(fit);
  assert.equal(s.plain.byFold, undefined);
  assert.equal(s.plain.all, undefined);
  assert.ok(Array.isArray(s.plain.rows));
});

test('nested: the weights for fold f are chosen without looking at fold f', () => {
  const lib = shapedLibrary({ seed: 11 });
  const mine = run(lib, { targets: new Set(lib.targets) });
  const fit = fitVariant(mine.partRows);
  // Scramble fold 0's answers: its own multipliers must not move, and its
  // held-out score must change (it is scored against the scrambled truth).
  const all = [...new Set(mine.partRows.flatMap(r => r.dests.map(d => d.playlistId)))].sort();
  const scrambled = mine.partRows.map(r => r.fold !== 0 ? r
    : { ...r, truth: [all[(all.indexOf(r.truth[0]) + 7) % all.length]] });
  const again = fitVariant(scrambled);
  assert.deepEqual(again.foldMultipliers[0], fit.foldMultipliers[0]);
  assert.notDeepEqual(again.fitted, fit.fitted);
});

test('a library that cannot tell weights apart keeps the defaults, and they are not used', () => {
  // Every destination scores identically on every component: nothing to fit.
  const rows = Array.from({ length: 40 }, (_, i) => ({
    id: `t${i}`, fold: foldOf(`t${i}`), fresh: false, truth: [i % 2 ? 'a' : 'b'],
    dests: ['a', 'b', 'c'].map(id => ({ playlistId: id, parts: { graph: 0.5, registrant: 0.2, minutes: 0.7, era: 0.3 } })) }));
  const v = fitVariant(rows);
  assert.deepEqual(v.multipliers, DEFAULT_MULT);
  for (const m of Object.values(v.foldMultipliers)) assert.deepEqual(m, DEFAULT_MULT);
  assert.equal(v.use, false);
  assert.equal(v.rows, undefined, 'nothing kept for a fit that is not used');
  assert.equal(GRAPH_N_SEARCHED, false);
  assert.equal(FIT_MARGIN, 0.01);
});

test('the blend is fitted on top of the fitted engine, nested; without a fit it is exactly as before', () => {
  const lib = shapedLibrary({ seed: 11 });
  const targets = new Set(lib.targets);
  // Tags that know half the artists' scene, so the blend has two sides.
  const tags = {};
  lib.playlists.forEach((p, i) => p.tracks.forEach((t, j) => {
    if (j % 2) tags[t.artists[0].id] = { tags: [[`scene${i % 5}`, 100], [`g${i}`, 60]] };
  }));
  const common = { folds: 5, targets, bridge: lib.bridge, collect: true, genreGraph: true };
  const base = baselineAccuracy(lib, tags, common);
  const mine = run(lib, common);
  const fit = weightsFromRun(mine);
  const plainBlend = blendFromRun(lib, { base, mine, folds: 5, targets });
  assert.deepEqual(blendFromRun(lib, { base, mine, folds: 5, targets, nativeFit: null }), plainBlend);
  assert.deepEqual(blendFromRun(lib, { base, mine, folds: 5, targets,
    nativeFit: { ...fit, bridge: { ...fit.bridge, use: false } } }), plainBlend, 'a fit that is not used changes nothing');
  assert.equal(plainBlend.nested, undefined);

  const nested = blendFromRun(lib, { base, mine, folds: 5, targets, nativeFit: fit });
  assert.equal(nested.nested, true);
  assert.equal(nested.nativeFitted, true);
  assert.equal(nested.scored, plainBlend.scored);
  // The native side it reports is the fitted engine's held-out number.
  assert.equal(nested.native.top1, fit.bridge.fitted.top1);
  assert.equal(plainBlend.native.top1, mine.withBridge.top1);

  // Fold 0's blend weight never sees fold 0's tag rankings.
  const flipped = { ...base, rows: base.rows.map(r => foldOf(r.id) !== 0 ? r
    : { ...r, scores: r.scores.map(([id], i, all) => [id, all[all.length - 1 - i][1]]) }) };
  const again = blendFromRun(lib, { base: flipped, mine, folds: 5, targets, nativeFit: fit });
  assert.equal(again.foldWeights[0], nested.foldWeights[0]);
});
