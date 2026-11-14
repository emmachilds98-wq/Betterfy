// WP-L2: the learner learns from accept/reject (core/intrinsic/audio-feedback.mjs
// and the `feedback` option of core/intrinsic/audio-learn.mjs).
//
// First, as every engine package must: with no feedback, nothing changes. Then
// the adapter, then the behaviour the plan asks for (accepts pull a borderline
// track in, rejects push it away, corrections beat membership), then honesty:
// a verdict on a held-out track must never reach the learner that scores it.
// Last, the learning curve with simulated feedback on the phase 0 embeddings,
// reported.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { feedbackExamples, withoutTracks } from '../core/intrinsic/audio-feedback.mjs';
import {
  trainingSet, learnAudio, learnedScores, predictProba, fitSet, subset, holdoutSplit, trainLearner, LEARN_DEFAULTS,
} from '../core/intrinsic/audio-learn.mjs';
import { CorrectionLog, correction, fromV1Feedback } from '../core/personal/corrections.mjs';
import { fixture, FAMILIES } from './fixtures/engine-library.mjs';
import { buildSpace, placements, WEIGHTS, withAudioLayer } from '../core/intrinsic/space.mjs';
import { placementAccuracy } from '../core/validate/loo.mjs';
import { makeRecord, N_STYLES, EMB_DIM } from '../core/audio/record.mjs';
import { feedbackCurve } from '../scripts/audio-learn/feedback-curve.mjs';

/* ---------- deterministic synthetic sound ---------- */

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

/**
 * Two playlists, A and B, on two directions in 16 dimensions, 12 members each,
 * plus unfiled tracks: `mid-*` sit halfway between A and B (the borderline
 * ones), `nearA-*` just on A's side of the middle.
 */
function twoPlaylists(seed = 5) {
  const r = rng(seed), D = 16;
  const dirA = Array.from({ length: D }, (_, k) => (k === 0 ? 1 : 0));
  const dirB = Array.from({ length: D }, (_, k) => (k === 1 ? 1 : 0));
  const index = new Map(), A = [], B = [];
  const add = (id, mixA, sd) => {
    index.set(id, { emb: unit(dirA.map((a, k) => mixA * a + (1 - mixA) * dirB[k] + sd * gauss(r))) });
    return id;
  };
  for (let i = 0; i < 12; i++) A.push(add(`a${i}`, 0.75, 0.3));
  for (let i = 0; i < 12; i++) B.push(add(`b${i}`, 0.25, 0.3));
  for (let i = 0; i < 6; i++) add(`mid-${i}`, 0.5, 0.05);
  for (let i = 0; i < 6; i++) add(`nearA-${i}`, 0.56, 0.05);
  const dests = [{ id: 'A', trackIds: A }, { id: 'B', trackIds: B }];
  return { index, dests };
}
/** How much more A than B the learner hears in a track: log p(A) − log p(B), unrounded. */
const pA = (learner, id) => {
  const p = predictProba(learner.model, learner.index.get(id).emb);
  return Math.log(p[learner.classes.indexOf('A')]) - Math.log(p[learner.classes.indexOf('B')]);
};

/* ---------- THE GUARD ---------- */

test('THE FEEDBACK GUARD: with no feedback, every output is exactly what it was', () => {
  const { index, dests } = twoPlaylists();
  const plain = learnAudio(dests, index);
  const asJSON = l => JSON.stringify({ ...l, index: null, model: { ...l.model, W: l.model.W && [...l.model.W],
    b: l.model.b && [...l.model.b], centroids: l.model.centroids?.map(c => [...c]) } });
  // Nothing usable: absent, empty, a log with only skips, the page's state with
  // only skips, verdicts on tracks nobody heard or playlists that don't exist.
  const nothing = [
    null, undefined, {}, [], new CorrectionLog(), { entries: [] },
    new CorrectionLog([correction({ kind: 'skip', trackId: 'mid-0', at: 1 }), correction({ kind: 'genre', trackId: 'a1', value: 'x', at: 2 })]),
    { 'mid-0': { skips: 3, lastSkip: null, rejected: [] } },
    { 'nobody-heard-this': { rejected: ['A'] }, 'mid-1': { rejected: ['no-such-playlist'] } },
    { a0: { accepted: ['A'] } }, // already a member: accepting it changes nothing
  ];
  for (const feedback of nothing) {
    const l = learnAudio(dests, index, { feedback });
    assert.equal(asJSON(l), asJSON(plain), `feedback ${JSON.stringify(feedback)} changed the learner`);
    assert.ok(!('feedback' in l));
    assert.deepEqual(trainingSet(dests, index, { feedback }), trainingSet(dests, index));
  }
  // Logistic too, where the negative term lives.
  const lr = learnAudio(dests, index, { model: 'logistic' });
  assert.equal(asJSON(learnAudio(dests, index, { model: 'logistic', feedback: {} })), asJSON(lr));
});

test('THE FEEDBACK GUARD: the engine and the with/without harness are unchanged by empty feedback', () => {
  const LIB = fixture();
  const recs = LIB.all.map(t => recordFor(t.id));
  const strip = s => { const { learned, ...rest } = s; return JSON.stringify(rest, (k, v) => (v instanceof Map ? [...v] : ArrayBuffer.isView(v) ? [...v] : v)); };
  const a = buildSpace(LIB, { audio: recs }), b = buildSpace(LIB, { audio: { records: recs, feedback: {} } });
  assert.equal(strip(b), strip(a));
  const place = s => JSON.stringify(LIB.all.map(t => placements(t, s, { limit: Infinity, why: true, useAudio: true })));
  assert.equal(place(b), place(a));
  assert.equal(place(withAudioLayer(a, { records: recs, feedback: fromV1Feedback({}) })), place(a));
  const acc = placementAccuracy(LIB, { audio: recs, collect: true });
  assert.deepEqual(placementAccuracy(LIB, { audio: { records: recs, feedback: {} }, collect: true }), acc);
  assert.deepEqual(placementAccuracy(LIB, { audio: { records: recs, feedback: new CorrectionLog() }, collect: true }), acc);
});

/* ---------- the adapter ---------- */

test('adapter: the correction log, latest verdict per pair wins; a move is a reject and an accept', () => {
  const log = new CorrectionLog([
    correction({ kind: 'reject', trackId: 't1', playlistId: 'A', at: 1 }),
    correction({ kind: 'accept', trackId: 't1', playlistId: 'A', at: 5 }), // changed their mind
    correction({ kind: 'accept', trackId: 't2', playlistId: 'B', at: 2 }),
    correction({ kind: 'reject', trackId: 't2', playlistId: 'B', at: 6 }),
    correction({ kind: 'move', trackId: 't3', fromPlaylistId: 'A', playlistId: 'C', at: 3 }),
    correction({ kind: 'skip', trackId: 't4', at: 4 }),
    correction({ kind: 'not-sure', trackId: 't5', at: 4 }),
  ]);
  const fb = feedbackExamples(log);
  assert.deepEqual([...fb.pos], [['t1', ['A']], ['t3', ['C']]]);
  assert.deepEqual([...fb.neg], [['t2', ['B']], ['t3', ['A']]]);
  assert.equal(fb.n, 4);
  // The same log as JSON, as raw entries, or out of append order (times decide).
  assert.deepEqual(feedbackExamples(CorrectionLog.fromJSON(JSON.parse(JSON.stringify(log)))), fb);
  assert.deepEqual(feedbackExamples([...log.entries].reverse()), fb);
  // And an earlier result passes through unchanged.
  assert.deepEqual(feedbackExamples(fb), fb);
});

test('adapter: the page\'s synced feedback state, and later sources win', () => {
  const FB = { t9: { skips: 2, lastSkip: '2026-01-01', rejected: ['B', 'A'] }, t8: { skips: 1, rejected: [] },
               t7: { rejected: ['A'], accepted: ['A', 'C'] } };
  const fb = feedbackExamples(FB);
  assert.deepEqual([...fb.neg], [['t7', ['A']], ['t9', ['A', 'B']]], 'sorted, and a page reject beats a page accept');
  assert.deepEqual([...fb.pos], [['t7', ['C']]]);
  // v1 → CorrectionLog import says the same thing.
  assert.deepEqual([...feedbackExamples(fromV1Feedback({ t9: FB.t9 })).neg], [['t9', ['A', 'B']]]);
  // A later accept in the log overrides the page's reject for that pair.
  const both = feedbackExamples(FB, [correction({ kind: 'accept', trackId: 't9', playlistId: 'A', at: 1 })]);
  assert.deepEqual([...both.neg].find(([t]) => t === 't9'), ['t9', ['B']]);
  assert.deepEqual([...both.pos].find(([t]) => t === 't9'), ['t9', ['A']]);
  // withoutTracks drops every pair about a skipped track.
  const w = withoutTracks(fb, new Set(['t9']));
  assert.deepEqual([...w.neg], [['t7', ['A']]]);
  assert.equal(w.n, 2);
});

/* ---------- what feedback does to the learner ---------- */

test('accepts move a borderline track toward the playlist', () => {
  const { index, dests } = twoPlaylists();
  for (const model of ['prototype', 'logistic']) {
    const before = learnAudio(dests, index, { model });
    // The listener accepts the near-A tracks into A, one at a time.
    const feedback = { entries: [0, 1, 2, 3, 4, 5].map(i => correction({ kind: 'accept', trackId: `nearA-${i}`, playlistId: 'A', at: i })) };
    const after = learnAudio(dests, index, { model, feedback });
    assert.equal(after.feedback.accepted, 6);
    assert.equal(after.counts[after.classes.indexOf('A')], 18);
    for (let i = 0; i < 6; i++) {
      assert.ok(pA(after, `mid-${i}`) > pA(before, `mid-${i}`) + 0.01,
        `${model}: mid-${i} ${pA(before, `mid-${i}`)} → ${pA(after, `mid-${i}`)}`);
    }
  }
});

test('rejects push a borderline track away from the playlist', () => {
  const { index, dests } = twoPlaylists();
  for (const model of ['prototype', 'logistic']) {
    const before = learnAudio(dests, index, { model });
    // "Not A" for the near-A tracks: they sound like the borderline ones.
    const FB = Object.fromEntries([0, 1, 2, 3, 4, 5].map(i => [`nearA-${i}`, { skips: 0, rejected: ['A'] }]));
    const after = learnAudio(dests, index, { model, feedback: FB });
    assert.equal(after.feedback.rejected, 6);
    for (let i = 0; i < 6; i++) {
      assert.ok(pA(after, `mid-${i}`) < pA(before, `mid-${i}`) - 0.01,
        `${model}: mid-${i} ${pA(before, `mid-${i}`)} → ${pA(after, `mid-${i}`)}`);
      assert.ok(pA(after, `nearA-${i}`) < pA(before, `nearA-${i}`), `${model}: the rejected track itself`);
    }
    // And the members still define A: a clear A track stays A.
    assert.ok(pA(after, 'a0') > 0, `${model}: a0 still sounds like A`);
  }
});

test('a correction beats playlist membership', () => {
  const { index, dests } = twoPlaylists();
  // a0..a3 sit in A, but the listener rejected them for A and moved a4 to B.
  const log = new CorrectionLog([
    ...[0, 1, 2, 3].map(i => correction({ kind: 'reject', trackId: `a${i}`, playlistId: 'A', at: i })),
    correction({ kind: 'move', trackId: 'a4', fromPlaylistId: 'A', playlistId: 'B', at: 9 }),
  ]);
  const set = trainingSet(dests, index, { feedback: log });
  const A = set.classes.indexOf('A'), B = set.classes.indexOf('B');
  const inA = set.ids.filter((_, i) => set.Y[i].includes(A));
  for (const id of ['a0', 'a1', 'a2', 'a3', 'a4']) assert.ok(!inA.includes(id), `${id} is no longer an A example`);
  assert.ok(set.Y[set.ids.indexOf('a4')].includes(B), 'a4 is a B example now');
  assert.equal(set.counts[A], 7);
  assert.equal(set.counts[B], 13);
  assert.deepEqual(set.feedback, { accepted: 1, removed: 5, rejected: 5 });
  assert.deepEqual(set.neg.map(n => [n.id, n.c]), ['a0', 'a1', 'a2', 'a3', 'a4'].map(id => [id, A]));
});

test('rejections cannot flip a playlist: capped at half its members', () => {
  const { index, dests } = twoPlaylists();
  // Reject every A-ish and mid track for A: far more rejections than members.
  const FB = {};
  for (const id of index.keys()) if (!id.startsWith('a') && !id.startsWith('b')) FB[id] = { rejected: ['A'] };
  for (let i = 0; i < 12; i++) FB[`b${i}`] = { rejected: ['A'] };
  const l = learnAudio(dests, index, { model: 'prototype', feedback: FB });
  const before = learnAudio(dests, index, { model: 'prototype' });
  const stillA = ids => ids.filter(id => pA(l, id) > 0).length;
  const As = Array.from({ length: 12 }, (_, i) => `a${i}`);
  const was = As.filter(id => pA(before, id) > 0).length;
  assert.ok(stillA(As) >= was - 1, `members still sound like A (${stillA(As)} of 12, was ${was})`);
});

test('deterministic: the same verdicts in any order train the same model, bit for bit', () => {
  const { index, dests } = twoPlaylists();
  const entries = [
    correction({ kind: 'accept', trackId: 'nearA-0', playlistId: 'A', at: 1 }),
    correction({ kind: 'reject', trackId: 'mid-0', playlistId: 'A', at: 2 }),
    correction({ kind: 'reject', trackId: 'mid-1', playlistId: 'B', at: 3 }),
    correction({ kind: 'accept', trackId: 'nearA-1', playlistId: 'A', at: 4 }),
  ];
  const bytes = l => JSON.stringify([...l.model.W ?? []].concat([...l.model.b ?? []]));
  for (const model of ['prototype', 'logistic']) {
    const a = learnAudio(dests, index, { model, feedback: entries });
    const b = learnAudio(dests, index, { model, feedback: [entries[3], entries[1], entries[0], entries[2]] });
    const c = learnAudio(dests, index, { model, feedback: entries });
    assert.equal(bytes(a), bytes(b));
    assert.equal(bytes(a), bytes(c));
    assert.deepEqual(learnedScores('mid-3', a), learnedScores('mid-3', b));
  }
});

/* ---------- honesty ---------- */

test('LEAKAGE: model choice never trains on a verdict about its own held-out fold', () => {
  const { index, dests } = twoPlaylists();
  const set = trainingSet(dests, index);
  const { held: plain } = fitSet(set, { model: 'auto' });
  assert.ok(plain, 'big enough to hold some out');
  // fitSet's own split (the exported rule it uses), as id sets.
  const split = holdoutSplit(set, { share: LEARN_DEFAULTS.holdout });
  const val = new Set(split.val.map(i => set.ids[i])), train = new Set(split.train.map(i => set.ids[i]));
  assert.ok(val.size >= 2);
  // A rejection of every track for the playlist it is not in.
  const neg = set.ids.map((id, i) => ({ id, x: set.X[i], c: 1 - set.Y[i][0] }));
  assert.deepEqual(fitSet({ ...set, neg: neg.filter(n => val.has(n.id)) }, { model: 'auto' }).held, plain,
    'verdicts on the held-out fold changed model choice');
  assert.notDeepEqual(fitSet({ ...set, neg: neg.filter(n => train.has(n.id)) }, { model: 'auto' }).held, plain,
    'control: verdicts on training tracks do count');
  // crossValidate's test folds go through subset, which drops negatives about scored ids.
  const s = subset({ ...set, neg }, [0, 1, 2], new Set([set.ids[0]]));
  assert.equal(s.neg.length, neg.length - 1);
  assert.ok(s.neg.every(n => n.id !== set.ids[0]));
});

test('LEAKAGE CANARY: a verdict on a held-out track never reaches the learner that scores it', () => {
  // As E2's "never hears itself": every track sounds like nothing else (unique
  // random directions), so only leakage can place it. The listener has
  // accepted every track into its own playlist and rejected it everywhere
  // else, which is the most a verdict could leak.
  const LIB = fixture();
  const TARGETS = FAMILIES.map(f => `p-${f}`);
  const recs = LIB.all.map(t => {
    const r = rng([...t.id].reduce((h, c) => (h * 33 + c.charCodeAt(0)) >>> 0, 11));
    return record(t.id, Float32Array.from({ length: EMB_DIM }, () => r() - 0.5));
  });
  const home = new Map();
  for (const p of LIB.playlists) if (TARGETS.includes(p.id)) for (const t of p.tracks) home.set(t.id, p.id);
  const log = new CorrectionLog();
  let at = 0;
  for (const [t, p] of home) {
    log.add(correction({ kind: 'accept', trackId: t, playlistId: p, at: at++ }));
    for (const q of TARGETS) if (q !== p) log.add(correction({ kind: 'reject', trackId: t, playlistId: q, at: at++ }));
  }
  const soundOnly = { ...WEIGHTS, graph: 0, registrant: 0, minutes: 0, era: 0, albumType: 0, albumTracks: 0,
                      popularity: 0, audio: 0, learned: 1 };
  const run = audio => placementAccuracy(LIB, { audio, targets: new Set(TARGETS), weights: soundOnly });

  const none = run(recs);
  const honest = run({ records: recs, feedback: log });
  // A learner that ignores the fold it is given: what a leak would look like.
  const leaky = run({ records: recs, feedback: log, learn: args => trainLearner({ ...args, skip: null }) });
  assert.ok(leaky.withAudio.top1 > 0.9, `the canary recognises tracks whose verdicts it was shown (${leaky.withAudio.top1})`);
  assert.ok(honest.withAudio.top1 < 0.5, `honest folds stay near chance on noise (${honest.withAudio.top1})`);
  assert.ok(none.withAudio.top1 < 0.5);
});

test('LEAKAGE: accepts of tracks already filed, held out by the harness, change nothing at all', () => {
  // Accepting a track into the playlist it is already in is the commonest
  // verdict there is. In the harness, for training tracks it is a no-op and for
  // the held-out fold it must be dropped, so the run is identical to no feedback.
  const LIB = fixture();
  const recs = LIB.all.map(t => recordFor(t.id));
  const log = new CorrectionLog();
  let at = 0;
  for (const p of LIB.playlists) for (const t of p.tracks) log.add(correction({ kind: 'accept', trackId: t.id, playlistId: p.id, at: at++ }));
  const plain = placementAccuracy(LIB, { audio: recs, collect: true });
  assert.deepEqual(placementAccuracy(LIB, { audio: { records: recs, feedback: log }, collect: true }), plain);
});

/* ---------- the learning curve, reported ---------- */

test('phase 0 fixture: simulated feedback learning curve (reported)', t => {
  const F = JSON.parse(readFileSync(new URL('./fixtures/audio-learn-phase0.json', import.meta.url), 'utf8'));
  // A small, fast cut of the curve the PR reports (scripts/audio-learn/feedback-curve.mjs).
  const curve = feedbackCurve(F, { start: 5, rounds: [0, 150], folds: 3, model: 'prototype' });
  for (const p of curve) t.diagnostic(`${p.verdicts} verdicts (${p.accepts} accepts, ${p.rejects} rejects): ` +
    `top1 ${p.top1} top2 ${p.top2}; accepts-only ${p.acceptsOnly.top1}; rejects-only ${p.rejectsOnly.top1}`);
  assert.equal(curve[0].verdicts, 0);
  const last = curve[curve.length - 1];
  assert.ok(last.top1 > curve[0].top1, `feedback should improve top-1 (${curve[0].top1} → ${last.top1})`);
  assert.ok(last.rejectsOnly.top1 >= curve[0].top1 - 0.01, 'rejections alone must not make it worse');
});

/* ---------- helpers ---------- */

function record(id, emb) {
  return makeRecord({ id, isrc: 'GBXXX0000001', activations: new Float32Array(N_STYLES).fill(0.01),
                      embeddings: emb, patches: 1,
                      source: { kind: 'deezer-isrc', deezerId: 1, windows: [[0, 165000]], seconds: 10 },
                      mel: '1.0.0', at: 1 });
}
/** E2's family-sound records: tracks of one family sound alike. */
function recordFor(id) {
  const fam = id.split('-')[0];
  const fr = rng(1 + FAMILIES.indexOf(fam) * 7919), dir = Float32Array.from({ length: EMB_DIM }, () => fr() - 0.5);
  const r = rng([...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7));
  return record(id, Float32Array.from(dir, v => v + 0.6 * (r() - 0.5)));
}
