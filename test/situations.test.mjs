// E2 (docs/BUILD-7-PLAN.md): weigh each source per situation (artist already
// filed / never filed) instead of one fit for all. Measured on synthetic
// libraries only, held out (top-1):
//
//                  one fit   per situation   never-filed one -> per situation
//   shaped seed 11  52.7%     51.1%           17.3% -> 13.6%
//   shaped seed 5   57.5%     57.0%           15.1% -> 15.1%
//   shaped seed 3   58.2%     58.6%           21.0% -> 21.0%
//   typical         31.1%     31.1%            9.4% ->  9.4%
//   large           13.0%     12.8%            2.8% ->  2.3%
//   blend with tags, large: 21.6% -> 21.7% (never-filed 28.2% -> 29.8%)
//
// The bar was +2 top-1 overall with no never-filed loss: missed. So the Score
// run reports it ("Weights per situation") and nothing applies it; the
// owner's own run is the deciding one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shapedLibrary } from './fixtures/shaped-library.mjs';
import { placementAccuracy } from '../core/validate/loo.mjs';
import { fitSituations, weightsFromRun, SITUATION_MIN } from '../core/validate/weights.mjs';
import { blendAccuracy } from '../core/validate/blend.mjs';
import { situationLine } from '../web/screens/engine.mjs';

const pc = x => (x == null ? '—' : Math.round(x * 100) + '%');

test('per-situation fit on the shaped seeds: measured, and it does not clear the bar', { timeout: 120000 }, () => {
  const got = [];
  for (const seed of [11, 5, 3]) {
    const lib = shapedLibrary({ seed });
    const r = placementAccuracy(lib, { targets: new Set(lib.targets), fitParts: true, genreGraph: true });
    const s = fitSituations(r.partRows);
    assert.equal(s.filed.scored + s.neverFiled.scored, s.scored);
    assert.ok(s.filed.own && s.neverFiled.own, 'both situations have enough rows here');
    got.push([seed, s.one.top1, s.fitted.top1, s.beats]);
  }
  assert.deepEqual(got, [[11, 0.5266, 0.5114, false], [5, 0.5746, 0.5698, false], [3, 0.582, 0.5855, false]],
    'the measured result moved: re-measure and update the table above');
});

test('a small situation keeps the one fit; weightsFromRun carries the result', () => {
  const lib = shapedLibrary({ seed: 11 });
  const r = placementAccuracy(lib, { targets: new Set(lib.targets), fitParts: true, genreGraph: true });
  const few = r.partRows.filter(x => !x.fresh).concat(r.partRows.filter(x => x.fresh).slice(0, SITUATION_MIN - 1));
  const s = fitSituations(few);
  assert.equal(s.neverFiled.own, false);
  assert.equal(s.neverFiled.top1, s.neverFiled.one);
  const fit = weightsFromRun({ partRows: r.partRows });
  assert.equal(typeof fit.situations.beats, 'boolean');
  assert.equal(fitSituations([]), null);
});

test('the blend per situation: a weight each for filed and never-filed, nested', () => {
  // Tags right on the never-filed tracks, the engine right on the filed ones.
  const tagRows = [], natRows = [], nf = new Set();
  for (let i = 0; i < 200; i++) {
    const id = 't' + i, fresh = i % 2 === 0;
    if (fresh) nf.add(id);
    tagRows.push({ id, truth: ['A'], scores: fresh ? [['A', 1], ['B', 0.5]] : [['B', 1], ['A', 0.5]] });
    natRows.push({ id, truth: ['A'], scores: fresh ? [['B', 1], ['A', 0.4]] : [['A', 1], ['B', 0.4]] });
  }
  const b = blendAccuracy(tagRows, natRows, { neverFiled: nf, situations: true });
  assert.ok(b.bySituation.top1 > b.top1, `${b.bySituation.top1} > ${b.top1}`);
  assert.equal(b.bySituation.weights.neverFiled, 1, 'never filed: tags');
  assert.ok(b.bySituation.weights.filed <= 0.5, 'filed: leans on the engine (ties go to the weight nearest tags)');
  assert.equal(b.bySituation.beatsOne, true);
  assert.equal(blendAccuracy(tagRows, natRows, { neverFiled: nf }).bySituation, undefined, 'off unless asked');
  const line = situationLine({ weights: { situations: { one: { top1: 0.5 }, fitted: { top1: 0.49 }, neverFiled: { one: 0.2, top1: 0.1 } } },
                               blend: { top1: b.top1, neverFiled: b.neverFiled, bySituation: b.bySituation } }, pc);
  assert.match(line, /^Weights per situation \(filed artist \/ never filed\): engine 50% -> 49% \(never-filed 20% -> 10%\); with tags/);
  assert.match(line, /ahead, not used yet$/);
  assert.equal(situationLine({}, pc), null);
});
