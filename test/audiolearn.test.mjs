// WP-L1: the audio learner (core/intrinsic/audio-learn.mjs).
//
// Synthetic sets first, where the right answer is known: a separable set both
// models must get, a set where the class signal hides under louder noise
// dimensions (cosine to a centroid cannot see it; a standardised linear model
// can), and pure noise, where the learner must neither find a pattern nor
// sound sure. Then the plumbing WP-E2 relies on, and last the real phase 0
// embeddings, reported.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  trainingSet, holdoutSplit, trainPrototypes, trainLogistic, predictProba, fitSet, learnAudio,
  learnedScores, calibrationScores, trainLearner, crossValidate, capPerClass, LEARN_DEFAULTS,
} from '../core/intrinsic/audio-learn.mjs';
import { audioIndex, buildAudioProfiles, MIN_AUDIO_MEMBERS } from '../core/intrinsic/audio.mjs';
import { softmax } from '../core/intrinsic/calibrate.mjs';
import { makeRecord, unpackEmbedding, N_STYLES, EMB_DIM } from '../core/audio/record.mjs';
import { resolveOrder } from '../bundler.mjs';

/* ---------- deterministic synthetic data ---------- */

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(r) { return Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r()); }
const unit = v => { const n = Math.hypot(...v); return Float32Array.from(v, x => x / n); };

/** A labelled set: K classes × n each; `make(c, r)` draws one raw vector. */
function synth({ K, n, make, seed = 1 }) {
  const r = rng(seed), classes = Array.from({ length: K }, (_, c) => `p${c}`);
  const ids = [], X = [], Y = [];
  for (let c = 0; c < K; c++) for (let i = 0; i < n; i++) { ids.push(`p${c}-t${i}`); X.push(unit(make(c, r))); Y.push([c]); }
  return { classes, ids, X, Y, counts: classes.map(() => n), short: [] };
}

/** Well-separated clusters on random directions. */
const separable = (seed = 1) => {
  const r0 = rng(99), D = 32, K = 4;
  const means = Array.from({ length: K }, () => Array.from({ length: D }, () => gauss(r0)));
  return synth({ K, n: 30, seed, make: (c, r) => means[c].map(m => m + 0.3 * gauss(r)) });
};

/**
 * The class lives in 4 quiet dimensions; 12 loud dimensions carry shared noise
 * ten times bigger. Cosine is dominated by the loud ones, so centroids barely
 * separate; standardising each dimension recovers the quiet signal.
 */
const hidden = (seed = 2) => {
  const K = 4;
  return synth({ K, n: 40, seed, make: (c, r) => [
    ...Array.from({ length: 12 }, () => 5 + 3 * gauss(r)),
    ...Array.from({ length: 4 }, (_, k) => (k === c ? 0.6 : 0) + 0.08 * gauss(r)),
  ] });
};

/** No signal at all: labels are independent of the vectors. */
const noise = (seed = 3) => synth({ K: 4, n: 30, seed, make: (_, r) => Array.from({ length: 24 }, () => 1 + gauss(r)) });

/* ---------- synthetic: the three regimes ---------- */

test('separable set: prototypes and the learner both place nearly everything', () => {
  const cv = crossValidate(separable(), { folds: 5 });
  assert.ok(cv.prototype.top1 >= 0.95, `prototype ${cv.prototype.top1}`);
  assert.ok(cv.logistic.top1 >= 0.95, `logistic ${cv.logistic.top1}`);
  assert.ok(cv.auto.top1 >= 0.95, `auto ${cv.auto.top1}`);
});

test('hidden signal: logistic regression beats the centroid baseline, and auto picks it', () => {
  const cv = crossValidate(hidden(), { folds: 5 });
  assert.ok(cv.prototype.top1 < 0.6, `the baseline should struggle here: ${cv.prototype.top1}`);
  assert.ok(cv.logistic.top1 >= cv.prototype.top1 + 0.25, `logistic ${cv.logistic.top1} vs prototype ${cv.prototype.top1}`);
  assert.ok(cv.auto.top1 >= cv.logistic.top1 - 0.05, `auto ${cv.auto.top1}`);
  assert.ok(cv.auto.logisticShare >= 0.8, `auto chose logistic ${cv.auto.logisticShare} of the time`);
});

test('pure noise: near chance, and the learner does not sound sure', () => {
  const set = noise();
  const cv = crossValidate(set, { folds: 5 });
  for (const k of ['prototype', 'logistic', 'auto']) assert.ok(cv[k].top1 <= 0.25 + 0.15, `${k} ${cv[k].top1}`);
  // Probabilities on unseen noise stay spread out: early stopping and the
  // held-out temperature must not let a model memorise noise into certainty.
  const fresh = noise(77);
  const m = fitSet(set);
  const meanTop = fresh.X.reduce((s, x) => s + Math.max(...predictProba(m, x)), 0) / fresh.X.length;
  assert.ok(meanTop < 0.55, `mean top probability on noise ${meanTop.toFixed(3)} (chance 0.25)`);
});

test('class balance: a big playlist does not win by being big', () => {
  // Same two-cluster geometry, one class four times the size. Balanced loss
  // keeps recall on the small class close to the big one.
  const r0 = rng(5), D = 16;
  const mu = [Array.from({ length: D }, () => gauss(r0)), Array.from({ length: D }, () => gauss(r0))];
  const r = rng(6), ids = [], X = [], Y = [];
  [[0, 120], [1, 30]].forEach(([c, n]) => { for (let i = 0; i < n; i++) { ids.push(`c${c}-${i}`); X.push(unit(mu[c].map((m, k) => 0.5 * m + 1.2 * gauss(r)))); Y.push([c]); } });
  const set = { classes: ['big', 'small'], ids, X, Y, counts: [120, 30], short: [] };
  const cv = crossValidate(set, { folds: 5, model: 'logistic' });
  assert.ok(cv.logistic.top1 > 0.7);
  const m = trainLogistic(set, { epochs: 60 });
  const recall = c => { const xs = X.filter((_, i) => Y[i][0] === c); return xs.filter(x => { const p = predictProba(m, x); return p[c] >= p[1 - c]; }).length / xs.length; };
  assert.ok(recall(1) >= recall(0) - 0.15, `small-class recall ${recall(1)} vs big ${recall(0)}`);
});

/* ---------- the model pieces ---------- */

test('prototype model matches plain cosine to centroids', () => {
  const set = separable();
  const m = trainPrototypes(set, { T: 0.05 });
  const x = set.X[3];
  const cos = m.centroids.map(c => c.reduce((s, v, k) => s + v * x[k], 0));
  const p = predictProba(m, x);
  const ref = softmax(cos.map((v, c) => [c, v]).sort((a, b) => b[1] - a[1]), 0.05);
  for (const [c, q] of ref) assert.ok(Math.abs(p[c] - q) < 1e-9);
});

test('the prior starts logistic regression exactly at the prototype model', () => {
  const set = hidden();
  const proto = trainPrototypes(set, { T: 0.05 });
  const lr = trainLogistic(set, { epochs: 0, prior: true, T0: 0.05 });
  for (const x of set.X.slice(0, 10)) {
    const a = predictProba(proto, x), b = predictProba(lr, x);
    for (let c = 0; c < a.length; c++) assert.ok(Math.abs(a[c] - b[c]) < 1e-4, `${a[c]} vs ${b[c]}`);
  }
});

test('holdout split is deterministic, per class, never empties a class, and keeps groups together', () => {
  const set = separable();
  const a = holdoutSplit(set), b = holdoutSplit(set);
  assert.deepEqual(a, b);
  for (let c = 0; c < set.classes.length; c++) {
    const v = a.val.filter(i => set.Y[i][0] === c).length, t = a.train.filter(i => set.Y[i][0] === c).length;
    assert.ok(v >= 1 && t >= 1);
    assert.ok(Math.abs(v - 0.2 * 30) <= 1);
  }
  const groupOf = id => id.replace(/t(\d+)$/, (_, n) => `g${Math.floor(n / 3)}`);
  const g = holdoutSplit(set, { groupOf });
  const side = new Map();
  for (const i of g.train) side.set(groupOf(set.ids[i]), 'train');
  for (const i of g.val) assert.notEqual(side.get(groupOf(set.ids[i])), 'train');
  // A class of one example is never held out entirely.
  const tiny = { ...set, ids: ['x'], X: [set.X[0]], Y: [[0]], counts: [1, 0, 0, 0] };
  assert.deepEqual(holdoutSplit(tiny).val, []);
});

test('the same library trains the same model, bit for bit', () => {
  const a = fitSet(hidden()), b = fitSet(hidden());
  assert.equal(a.chosen, b.chosen);
  assert.deepEqual(Array.from(a.W ?? []), Array.from(b.W ?? []));
  assert.deepEqual(a.held, b.held);
});

test('capPerClass keeps at most the cap per class, deterministically', () => {
  const set = separable();
  const c = capPerClass(set, 10);
  assert.deepEqual(c.counts, [10, 10, 10, 10]);
  assert.deepEqual(capPerClass(set, 10).ids, c.ids);
  assert.equal(capPerClass(set, 1000), set);
});

/* ---------- learnAudio / learnedScores: what WP-E2 consumes ---------- */

/** An index (audioIndex shape) and playlists from a synthetic set. */
function asLibrary(set, extra = []) {
  const index = new Map(set.ids.map((id, i) => [id, { emb: set.X[i] }]));
  const playlists = set.classes.map((c, k) => ({ id: c, tracks: set.ids.filter((_, i) => set.Y[i][0] === k).map(id => ({ id })) }));
  return { index, playlists: [...playlists, ...extra] };
}

test('no audio, no learner: null in, null out', () => {
  assert.equal(learnAudio([], new Map()), null);
  assert.equal(learnAudio([{ id: 'p', tracks: ['a'] }], null), null);
  assert.equal(learnedScores('a', null), null);
  assert.equal(trainLearner({ index: new Map(), profiles: new Map() }), null);
  // One learnable playlist is not a choice.
  const set = separable();
  const { index, playlists } = asLibrary(set);
  assert.equal(learnAudio(playlists.slice(0, 1), index), null);
});

test('learnedScores: probabilities over learned playlists, null for short ones and unheard tracks', () => {
  const set = separable();
  const shortIds = set.ids.filter((_, i) => set.Y[i][0] === 0).slice(0, MIN_AUDIO_MEMBERS - 1);
  const { index, playlists } = asLibrary(set, [{ id: 'short', tracks: shortIds }, { id: 'unheard', tracks: ['nobody'] }]);
  const L = learnAudio(playlists, index);
  assert.deepEqual(L.classes, ['p0', 'p1', 'p2', 'p3']);
  assert.deepEqual(L.short, ['short']);
  const s = learnedScores('p2-t1', L);
  const sum = L.classes.reduce((a, c) => a + s.get(c), 0);
  assert.ok(Math.abs(sum - 1) < 1e-4);
  assert.equal(s.get('short'), null);
  assert.equal(s.has('unheard'), false, 'a playlist with no analysed members is simply not judged');
  assert.equal([...s].filter(([, p]) => p != null).sort((a, b) => b[1] - a[1])[0][0], 'p2');
  assert.equal(learnedScores('not-heard', L), null);
  assert.equal(learnedScores({ id: 'p2-t1' }, { learned: L }).get('p2'), s.get('p2'), 'accepts a space carrying .learned');
});

test('skip leaves tracks out as if never filed', () => {
  const set = separable();
  const { index, playlists } = asLibrary(set);
  const skip = new Set(set.ids.filter((_, i) => i % 5 === 0));
  const L = learnAudio(playlists, index, { skip });
  assert.equal(L.examples, set.ids.length - skip.size);
});

test('a track in two playlists is one example split between them', () => {
  const set = separable();
  const { index, playlists } = asLibrary(set);
  playlists[1].tracks.push({ id: 'p0-t0' });
  const ts = trainingSet(playlists, index);
  assert.equal(ts.ids.length, set.ids.length);
  assert.deepEqual(ts.Y[ts.ids.indexOf('p0-t0')], [0, 1]);
});

test('calibrationScores: log p, so calibrate.softmax at T = 1 gives the learner\'s own probabilities', () => {
  const set = separable();
  const { index, playlists } = asLibrary(set);
  const s = learnedScores('p1-t4', learnAudio(playlists, index));
  const rows = calibrationScores(s);
  assert.equal(rows[0][0], 'p1');
  for (const [id, p] of softmax(rows, 1)) assert.ok(Math.abs(p - s.get(id)) < 1e-3);
  assert.deepEqual(calibrationScores(null), []);
});

test('trainLearner plugs into audio.mjs profiles (the WP-E2 hook), from real records', () => {
  // Real records through the real index, so the shapes WP-E2 passes are the ones tested.
  const r = rng(11), K = 3, n = 8;
  const dirs = Array.from({ length: K }, () => Array.from({ length: EMB_DIM }, () => gauss(r)));
  const records = [], playlists = [];
  for (let c = 0; c < K; c++) {
    const tracks = [];
    for (let i = 0; i < n; i++) {
      const id = `k${c}-${i}`;
      const emb = Float32Array.from(dirs[c], v => v + 0.8 * gauss(r));
      const activations = new Float32Array(N_STYLES).fill(0.01);
      records.push(makeRecord({ id, isrc: 'GBXXX0000001', activations, embeddings: emb, patches: 1,
        source: { kind: 'deezer-isrc', deezerId: 1, windows: [[0, 165000]], seconds: 10 }, mel: '1.0.0', at: 1000 }));
      tracks.push({ id });
    }
    playlists.push({ id: `pl${c}`, tracks });
  }
  const index = audioIndex(records);
  const skip = new Set(['k0-0', 'k1-0', 'k2-0']);
  const audio = buildAudioProfiles(playlists, index, { skip });
  const hook = trainLearner({ index, profiles: audio.profiles, minMembers: audio.minMembers });
  assert.equal(hook.learner.examples, K * n - skip.size, 'trains only on the fold\'s analysed members');
  for (const id of skip) {
    const s = hook.learnedScores({ id });
    assert.equal([...s].sort((a, b) => b[1] - a[1])[0][0], `pl${id[1]}`, `held-out ${id} placed home`);
  }
  assert.equal(hook.learnedScores({ id: 'nope' }), null);
});

test('bundles: no import of space.mjs (WP-E2 wires this module into it)', () => {
  const src = readFileSync(new URL('../core/intrinsic/audio-learn.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /from '\.\/space\.mjs'/);
  assert.doesNotThrow(() => resolveOrder(['core/intrinsic/audio-learn.mjs']));
});

/* ---------- the phase 0 embeddings, reported ---------- */

test('phase 0 fixture: cross-validated accuracy, artist-grouped folds (reported)', t => {
  const F = JSON.parse(readFileSync(new URL('./fixtures/audio-learn-phase0.json', import.meta.url), 'utf8'));
  const classes = [...new Set(F.rows.map(r => r.label))].sort();
  const ids = F.rows.map(r => String(r.deezerId));
  const set = {
    classes, ids,
    X: F.rows.map(r => unit(Array.from(unpackEmbedding(r.emb)))),
    Y: F.rows.map(r => [classes.indexOf(r.label)]),
  };
  set.counts = classes.map((_, c) => set.Y.filter(y => y[0] === c).length);
  const artist = new Map(F.rows.map(r => [String(r.deezerId), r.artist.toLowerCase()]));
  // One L2 strength keeps this test to seconds; the full grid's numbers are in the PR.
  const cv = crossValidate(set, { folds: 3, groupOf: id => artist.get(id), l2: [LEARN_DEFAULTS.l2[1]] });
  t.diagnostic(`n=${cv.n} classes=${classes.length} prototype ${cv.prototype.top1}/${cv.prototype.top2} ` +
               `logistic ${cv.logistic.top1}/${cv.logistic.top2} auto ${cv.auto.top1}/${cv.auto.top2}`);
  assert.ok(cv.n >= 700);
  assert.ok(cv.prototype.top1 >= 0.55, 'the baseline phase 0 measured (58% from nine examples) should hold');
  assert.ok(cv.auto.top1 >= cv.prototype.top1 - 0.02, 'the learner must not lose to the baseline');
  assert.ok(cv.auto.top2 >= cv.prototype.top2, 'nor on the short list');
});
