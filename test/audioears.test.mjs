// WP-C1: the second ear measured against the first, same folds, same tracks.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fixture, FAMILIES } from './fixtures/engine-library.mjs';
import { earComparison, earVerdict, EAR_BAR } from '../core/validate/ears.mjs';
import { audioIndex } from '../core/intrinsic/audio.mjs';
import { makeRecord, makeEar, withEar, N_STYLES, EMB_DIM, MAEST_DIM, MAEST_N_STYLES } from '../core/audio/record.mjs';

const LIB = fixture();

function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5; }
const hashId = id => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
/** An embedding of `dim` where one family sounds alike; `noise` sets how well this ear hears it. */
function emb(id, dim, noise, salt) {
  const fam = id.split('-')[0];
  const d = rng(1 + FAMILIES.indexOf(fam) * 7919 + salt), r = rng(hashId(id) + salt);
  return Float32Array.from({ length: dim }, () => d() + noise * r());
}
function rec(id, { base = 1.2, second = 0.3, withSecond = true } = {}) {
  const r = makeRecord({ id, isrc: 'GBXXX0000001', activations: new Float32Array(N_STYLES).fill(0.01),
    embeddings: emb(id, EMB_DIM, base, 0), patches: 1,
    source: { kind: 'deezer-isrc', deezerId: 1, windows: [[0, 1]], seconds: 10 }, mel: '1.0.0', at: 1000 });
  if (!withSecond) return r;
  const act = new Float32Array(MAEST_N_STYLES).fill(0.01); act[5] = 0.7;
  return withEar(r, 'maest', makeEar('maest', { embedding: emb(id, MAEST_DIM, second, 99), activations: act }));
}

test('audioIndex reads a second ear at its own width, and only from records that carry one', () => {
  const recs = [rec(LIB.all[0].id), rec(LIB.all[1].id, { withSecond: false })];
  const m = audioIndex(recs, { ear: 'maest' });
  assert.deepEqual([...m.keys()], [LIB.all[0].id]);
  assert.equal(m.get(LIB.all[0].id).emb.length, MAEST_DIM);
  assert.equal(m.get(LIB.all[0].id).styles[0][0], 5, 'the second ear’s own styles');
  assert.equal(audioIndex(recs).size, 2, 'the default index is unchanged');
  assert.throws(() => audioIndex(recs, { ear: 'nope' }), /unknown ear/);
});

test('same tracks for both ears: a record without the second ear is left out of both', () => {
  const recs = LIB.all.map((t, i) => rec(t.id, { withSecond: i % 2 === 0 }));
  const c = earComparison(LIB, recs, { folds: 5 });
  assert.equal(c.paired, Math.ceil(LIB.all.length / 2));
  assert.equal(c.base.heard, c.second.heard, 'both ears heard exactly the same scored tracks');
});

test('a clearly better second ear is measured as better on the fixture', () => {
  const recs = LIB.all.map(t => rec(t.id, { base: 3, second: 0.2 }));
  const c = earComparison(LIB, recs, { folds: 5 });
  assert.ok(c.second.top1 >= c.base.top1, `${c.second.top1} vs ${c.base.top1}`);
  assert.ok(c.verdict.reason, 'a verdict travels with the numbers');
});

test('nothing heard by both ears is NOT_RUN, never a pass', () => {
  const recs = LIB.all.map(t => rec(t.id, { withSecond: false }));
  const c = earComparison(LIB, recs, { folds: 5 });
  assert.equal(c.paired, 0);
  assert.equal(c.verdict.pass, null);
  assert.equal(c.verdict.reason, 'NOT_RUN');
});

const run = (top1, nf, heard = 100, heardNF = 20) => ({ withAudio: { top1, heard, heardNeverFiled: heardNF, neverFiled: { top1: nf } } });

test('verdict: beats at the bar, fails below it or on any never-filed loss, undecided on too little', () => {
  assert.equal(earVerdict(run(0.5, 0.4), run(0.52, 0.4)).pass, true, 'exactly +2 points with no never-filed loss');
  assert.equal(earVerdict(run(0.5, 0.4), run(0.51, 0.5)).reason, 'NOT_ENOUGH_GAIN');
  assert.equal(earVerdict(run(0.5, 0.4), run(0.6, 0.39)).reason, 'COSTS_NEVER_FILED');
  assert.equal(earVerdict(run(0.5, 0.4, 10), run(0.9, 0.9, 10)).reason, 'TOO_FEW_PAIRED');
  assert.equal(earVerdict(run(0.5, 0.4, 100, 3), run(0.9, 0.9, 100, 3)).reason, 'TOO_FEW_NEVER_FILED');
  assert.equal(EAR_BAR.minGain, 0.02);
});
