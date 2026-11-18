// The hosted app's sound learner is prototypes only (docs/archive/BUILD-5-PLAN.md §2
// item 3, option b): each playlist's sound is the average of the account's own
// heard tracks in it, and no regression is fitted to playlist membership in
// the page or its worker. Logistic regression stays in audio-learn.mjs for
// offline measurement (scripts/, tests), where `model` defaults to 'auto'.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { fixture } from './fixtures/engine-library.mjs';
import { buildSpace, withAudioLayer } from '../core/intrinsic/space.mjs';
import { placementAccuracy } from '../core/validate/loo.mjs';
import { trainLearner, LEARN_DEFAULTS } from '../core/intrinsic/audio-learn.mjs';
import { makeRecord, N_STYLES, EMB_DIM } from '../core/audio/record.mjs';

const LIB = fixture();
function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5; }
const hashOf = s => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
function recordFor(id) {
  const fam = id.split('-')[0], dir = rng(1 + hashOf(fam)), r = rng(hashOf(id));
  const activations = new Float32Array(N_STYLES).fill(0.01);
  activations[(id.length * 13) % N_STYLES] = 0.8;
  return makeRecord({ id, isrc: 'GBXXX0000001', activations,
    embeddings: Float32Array.from({ length: EMB_DIM }, () => dir() + 0.6 * r()), patches: 1,
    source: { kind: 'deezer-isrc', deezerId: 1, windows: [[0, 165000]], seconds: 10 }, mel: '1.0.0', at: 1000 });
}
const RECORDS = LIB.all.map(t => recordFor(t.id));

/** A trainer that is the real one, recording what it was asked for and what it fitted. */
function spy() {
  const calls = [];
  const learn = (...a) => { const r = trainLearner(...a); calls.push({ n: a.length, opts: a[1], kind: r?.learner?.model?.kind ?? null }); return r; };
  return { learn, calls };
}

test('offline, logistic regression is still there: the module default stays auto', () => {
  assert.equal(LEARN_DEFAULTS.model, 'auto');
});

test('buildSpace hands `model` to the trainer, and without it calls the trainer exactly as before', () => {
  const a = spy();
  buildSpace(LIB, { audio: { records: RECORDS, learn: a.learn, model: 'prototype' } });
  assert.equal(a.calls.length, 1);
  assert.deepEqual(a.calls[0].opts, { model: 'prototype' });
  assert.equal(a.calls[0].kind, 'prototype');

  const b = spy();
  buildSpace(LIB, { audio: { records: RECORDS, learn: b.learn } });
  assert.equal(b.calls[0].n, 1, 'no second argument when no model was asked for');
});

test('`model` alone marks the options shape: { records, model } is not read as a pile of records', () => {
  const space = buildSpace(LIB, { audio: { records: RECORDS, model: 'prototype' } });
  assert.ok(space.audio?.index.size > 0, 'the records were heard');
  assert.equal(typeof space.learned, 'function');
});

test('withAudioLayer and every placementAccuracy fold pass the same model through', () => {
  const a = spy();
  withAudioLayer(buildSpace(LIB), { records: RECORDS, learn: a.learn, model: 'prototype' });
  assert.deepEqual(a.calls.map(c => c.opts), [{ model: 'prototype' }]);

  const b = spy();
  placementAccuracy(LIB, { audio: { records: RECORDS, learn: b.learn, model: 'prototype' }, folds: 3 });
  assert.equal(b.calls.length, 3);
  assert.ok(b.calls.every(c => c.opts?.model === 'prototype' && (c.kind === 'prototype' || c.kind === null)));
});

test('forced to prototype, a class big enough for auto to try logistic still gets prototypes', () => {
  // Every family padded past minForLogistic, so 'auto' would fit the regression.
  const profiles = new Map(), index = new Map();
  for (const fam of ['a', 'b', 'c']) {
    const ids = [];
    for (let i = 0; i < LEARN_DEFAULTS.minForLogistic + 4; i++) {
      const id = `${fam}-${i}`; ids.push(id);
      const dir = rng(1 + hashOf(fam)), r = rng(hashOf(id));
      const e = Float32Array.from({ length: 16 }, () => dir() + 0.4 * r());
      const m = Math.hypot(...e); index.set(id, { emb: e.map(x => x / m) });
    }
    profiles.set(`p-${fam}`, { ids: new Set(ids) });
  }
  const auto = trainLearner({ index, profiles, minMembers: 2 });
  assert.ok(auto.learner.held?.logistic, 'auto tried logistic on this set');
  const proto = trainLearner({ index, profiles, minMembers: 2 }, { model: 'prototype' });
  assert.equal(proto.learner.model.kind, 'prototype');
  assert.equal(proto.learner.held?.logistic, undefined, 'and never fitted it');
});

/* ---------- the page and its worker ---------- */

const PAGE = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
const WORKER_SRC = readFileSync(new URL('../docs/engine-worker.js', import.meta.url), 'utf8');
function slice(from, to) {
  const i = PAGE.indexOf(from), j = PAGE.indexOf(to, i);
  assert.ok(i > 0 && j > i, `${from} not found — rebuild with node build-web.mjs`);
  return PAGE.slice(i, j);
}

test('the page always asks the engine for the prototype learner, with or without feedback', () => {
  const s = { FB: {} };
  vm.createContext(s);
  vm.runInContext(slice('/** The records as the engine takes them', '/** Audio changes a suggestion only') +
    'globalThis.engineAudioIn = engineAudioIn;', s);
  const recs = [{ id: 'x' }];
  assert.equal(s.engineAudioIn(null), null, 'no records, nothing to hear');
  assert.deepEqual(JSON.parse(JSON.stringify(s.engineAudioIn(recs))), { records: recs, model: 'prototype' });
  s.FB.t1 = { rejected: ['p1'] };
  const withFb = s.engineAudioIn(recs);
  assert.equal(withFb.model, 'prototype');
  assert.equal(withFb.feedback, s.FB);
});

test('every place the page builds a sound space or scores one goes through engineAudioIn or the worker', () => {
  for (const m of PAGE.matchAll(/BetterfyIntrinsic\.(?:buildSpace|withAudioLayer)\([^\n]*\n?[^\n]*/g))
    if (/audio/.test(m[0])) assert.match(m[0], /engineAudioIn\(audio\)/, m[0]);
  assert.match(slice('const common = { folds: 5, limit: VALIDATE_N', 'const mine = BetterfyValidate.placementAccuracy(LIB, common)'),
    // engineAudioScore is engineAudioIn's records and model plus WP-C1's second-ear arms.
    /audio: engineAudio(?:In|Score)\(audio\)/);
});

function worker() {
  const seen = { build: [], validate: [] };
  const self = {};
  const ctx = { self, performance, Set, Map, Object, Math, JSON, Error, String, Array,
    importScripts: () => Object.assign(ctx, {
      BetterfyIntrinsic: { buildSpace: (lib, o) => { seen.build.push(o.audio); return {}; }, SOUND_FIRST_WEIGHTS: {} },
      BetterfyPersist: { serialiseSpace: () => ({}) }, BetterfyReports: { bucketPairs: () => [] },
      BetterfyValidate: { placementAccuracy: (lib, o) => { seen.validate.push(o.audio); return {}; } },
      BetterfyBaseline: { baselineAccuracy: () => null }, BetterfyIdentify: { identifyAccuracyFor: () => null },
    }) };
  self.postMessage = () => {};
  vm.createContext(ctx);
  vm.runInContext(WORKER_SRC, ctx);
  return { post: data => self.onmessage({ data }), seen };
}

test('the worker builds and scores with prototypes only, whatever the page sent', () => {
  const w = worker(), recs = [{ id: 'x' }];
  w.post({ id: 1, op: 'build', lib: {}, audio: recs });
  w.post({ id: 2, op: 'build', lib: {}, audio: null });
  w.post({ id: 3, op: 'validate', lib: {}, opts: {}, audio: { records: recs, feedback: { t: { rejected: ['p'] } } } });
  w.post({ id: 4, op: 'validate', lib: {}, opts: {}, audio: { records: recs, model: 'logistic' } });
  const plain = x => JSON.parse(JSON.stringify(x));
  assert.deepEqual(plain(w.seen.build), [{ records: recs, model: 'prototype' }, null]);
  assert.deepEqual(plain(w.seen.validate), [
    { records: recs, feedback: { t: { rejected: ['p'] } }, model: 'prototype' },
    { records: recs, model: 'prototype' }]);
});
