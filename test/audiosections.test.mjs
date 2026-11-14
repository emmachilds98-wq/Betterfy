import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sectionsOf, leadShares, agreement, hybridOf, isHybrid } from '../core/audio/sections.mjs';
import { makeRecord, makeMiss, N_STYLES, EMB_DIM, MISS } from '../core/audio/record.mjs';

// Build a real record (through the frozen contract) whose patch p leads with style tops[p].
function rec(tops, { overall } = {}) {
  const n = tops.length;
  const act = new Float32Array(n * N_STYLES).fill(0.01);
  tops.forEach((s, p) => { act[p * N_STYLES + s] = 0.8; });
  if (overall) for (let p = 0; p < n; p++) for (const [s, v] of overall) act[p * N_STYLES + s] = v;
  return makeRecord({ id: 't', isrc: 'X', activations: act, embeddings: new Float32Array(n * EMB_DIM).fill(0.1), patches: n,
                      source: { kind: 'deezer-isrc', deezerId: 1, windows: [[0, 1]], seconds: 10 }, mel: '1.0.0', at: 1 });
}

test('sectionsOf gives runs of the leading style in time order', () => {
  const runs = sectionsOf(rec([5, 5, 5, 9, 9, 5]));
  assert.deepEqual(runs.map(r => [r.style, r.from, r.to, r.length]), [[5, 0, 2, 3], [9, 3, 4, 2], [5, 5, 5, 1]]);
  assert.equal(runs[0].meanP, 0.8);
  assert.deepEqual(sectionsOf({}), []);
});

test('one style throughout: agreement 1, not a hybrid', () => {
  const r = rec([5, 5, 5, 5]);
  assert.equal(agreement(r), 1);
  assert.deepEqual(leadShares(r), [[5, 1]]);
  assert.equal(isHybrid(r), false);
});

test('intro one style, drop another: a hybrid by sections', () => {
  const r = rec([5, 5, 9, 9, 9]);
  assert.deepEqual(hybridOf(r), { hybrid: true, styles: [9, 5], why: 'sections' });
  assert.equal(agreement(r), 0.6);
});

test('a brief second style under 30% is not a hybrid', () => {
  assert.equal(isHybrid(rec([5, 5, 5, 5, 9, 5, 5, 5, 5, 5])), false);
});

test('two styles neck and neck overall: a hybrid by margin', () => {
  const r = rec([5, 5, 5], { overall: [[5, 0.5], [9, 0.47]] });
  assert.deepEqual(hybridOf(r), { hybrid: true, styles: [5, 9], why: 'margin' });
  const weak = rec([5, 5, 5], { overall: [[5, 0.06], [9, 0.05]] });
  assert.equal(isHybrid(weak), false, 'two near-zero sigmoids are not a signal');
});

test('a miss or an empty record is never a hybrid', () => {
  assert.equal(isHybrid(makeMiss({ id: 'x', reason: MISS.NO_PREVIEW })), false);
  assert.equal(isHybrid(null), false);
  assert.equal(agreement({ styles: [] }), null);
});
