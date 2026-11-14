import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scoresOf, softmax, fitTemperature, wilsonLower, fitCalibration, decide, evaluate, isotonic,
         calibrationReport, DEFAULTS, CALIBRATE_VERSION } from '../core/intrinsic/calibrate.mjs';
import { placementAccuracy } from '../core/validate/loo.mjs';

/* Deterministic pseudo-random, so the synthetic libraries are the same every run. */
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9 >>> 0) / 2 ** 32);
}

/**
 * Held-out rows over six playlists. A "clear" row has its true playlist well
 * ahead; a "muddy" one has two close leaders, only one of them right, at random.
 */
function rows(n, { clearShare = 0.4, seed = 7 } = {}) {
  const r = rng(seed), out = [];
  const P = ['a', 'b', 'c', 'd', 'e', 'f'];
  for (let i = 0; i < n; i++) {
    const truth = P[Math.floor(r() * P.length)];
    const clear = r() < clearShare;
    const other = P.filter(p => p !== truth)[Math.floor(r() * 5)];
    const scores = P.map(p => [p, 0.2 + r() * 0.05]);
    const set = (id, v) => { scores.find(x => x[0] === id)[1] = v; };
    if (clear) set(truth, 0.6 + r() * 0.1);
    else if (r() < 0.5) { set(truth, 0.4); set(other, 0.41); }
    else { set(truth, 0.41); set(other, 0.4); }
    out.push({ id: `t${i}`, scores: scoresOf(scores.map(([playlistId, score]) => ({ playlistId, score }))), truth: [truth] });
  }
  return out;
}

test('scores are sorted high to low and keep every destination', () => {
  const s = scoresOf([{ playlistId: 'x', score: 0.1 }, { playlistId: 'y', score: 0.3 }, { playlistId: 'z', score: NaN }]);
  assert.deepEqual(s, [['y', 0.3], ['x', 0.1]]);
});

test('softmax sums to one, keeps the order, and sharpens as T falls', () => {
  const s = [['a', 0.5], ['b', 0.4], ['c', 0.1]];
  for (const T of [0.01, 0.1, 1]) {
    const p = softmax(s, T);
    assert.ok(Math.abs(p.reduce((t, [, x]) => t + x, 0) - 1) < 1e-9);
    assert.deepEqual(p.map(([id]) => id), ['a', 'b', 'c']);
  }
  assert.ok(softmax(s, 0.01)[0][1] > softmax(s, 0.1)[0][1]);
  assert.ok(softmax(s, 0.1)[0][1] > softmax(s, 1)[0][1]);
});

test('the fitted temperature trusts scores that separate, and distrusts ones that do not', () => {
  const sharp = fitTemperature(rows(300, { clearShare: 1 }));
  const blunt = fitTemperature(rows(300, { clearShare: 0 }));
  assert.ok(sharp < blunt, `${sharp} should be below ${blunt}`);
});

test('the Wilson lower bound is below the raw rate, and closes on it with more evidence', () => {
  assert.ok(wilsonLower(9, 10) < 0.9 && wilsonLower(9, 10) > 0.6);
  assert.ok(wilsonLower(900, 1000) > wilsonLower(90, 100));
  assert.ok(wilsonLower(900, 1000) < 0.9);
  assert.equal(wilsonLower(0, 0), 0);
});

test('isotonic blocks never decrease, and ties stay together', () => {
  const b = isotonic([[0.1, 1], [0.2, 0], [0.3, 0], [0.3, 1], [0.9, 1], [0.95, 1], [0.5, 0]]);
  for (let i = 1; i < b.length; i++) assert.ok(b[i - 1].sum / b[i - 1].n <= b[i].sum / b[i].n);
  assert.equal(b.reduce((s, x) => s + x.n, 0), 7);
  assert.ok(!b.some(x => x.x > 0.3 && x.x < 0.3 + 1e-9 && x.n === 1), 'the two 0.3s are pooled');
});

test('coin-flips just above the line are not swept into confident by the easy tracks', () => {
  // 40 easy tracks at p≈1 (all right), 30 coin-flips at p≈0.58 (half right).
  // A plain "lowest threshold still averaging 90%" would take some coin-flips.
  const rowsMixed = [];
  for (let i = 0; i < 40; i++) rowsMixed.push({ id: `e${i}`, scores: [['a', 0.9], ['b', 0.2]], truth: ['a'] });
  for (let i = 0; i < 30; i++) rowsMixed.push({ id: `m${i}`, scores: [['a', 0.41], ['b', 0.40]], truth: [i % 2 ? 'a' : 'b'] });
  const cal = fitCalibration(rowsMixed);
  assert.ok(cal.tau != null);
  assert.equal(decide([['a', 0.41], ['b', 0.40]], cal).kind === 'confident', false);
  assert.equal(decide([['a', 0.9], ['b', 0.2]], cal).kind, 'confident');
});

test('confident is earned: clear tracks get it, a coin-flip pile never does', () => {
  const cal = fitCalibration(rows(400));
  assert.equal(cal.version, CALIBRATE_VERSION);
  assert.ok(cal.tau != null, 'the clear tracks should earn a confident threshold');
  const flips = fitCalibration(rows(400, { clearShare: 0 }));
  assert.equal(flips.tau, null, 'a pile where the leader is right half the time must never be called confident');
});

test('decide: confident names one, choose names a short list, unsure names nothing', () => {
  const cal = fitCalibration(rows(400));
  assert.equal(decide([['a', 0.7], ['b', 0.22], ['c', 0.21]], cal).kind, 'confident');
  const muddy = decide([['a', 0.41], ['b', 0.40], ['c', 0.22], ['d', 0.21]], cal);
  assert.equal(muddy.kind, 'choose');
  assert.ok(muddy.playlists.length >= 2 && muddy.playlists.length <= DEFAULTS.maxChoices);
  assert.deepEqual(muddy.playlists.slice(0, 2), ['a', 'b']);
  const flat = decide([['a', 0.3], ['b', 0.3], ['c', 0.3], ['d', 0.3], ['e', 0.3]], cal);
  assert.equal(flat.kind, 'unsure');
  assert.deepEqual(decide([], cal), { kind: 'unsure', playlists: [], p: 0 });
  assert.equal(decide([['a', 1]], null).kind, 'unsure', 'no calibration, no claims');
});

test('the checked numbers come from tracks the thresholds never saw, and hold', () => {
  const rep = calibrationReport(rows(600));
  assert.equal(rep.checked.n, 600);
  assert.ok(rep.checked.confidentN >= DEFAULTS.minConfident);
  assert.ok(rep.checked.confidentRight >= DEFAULTS.target - 0.03, JSON.stringify(rep.checked));
  assert.equal(rep.holds, true);
  // Every track lands in exactly one of the three answers.
  const shares = rep.checked.confidentShare + rep.checked.chooseShare + rep.checked.unsureShare;
  assert.ok(Math.abs(shares - 1) < 0.001);
  // The short lists hold the answer about as often as conformal promises.
  assert.ok(rep.checked.chooseContains >= 0.8, JSON.stringify(rep.checked));
});

test('too few tracks to vouch for anything says so, rather than passing or failing', () => {
  const rep = calibrationReport(rows(20));
  assert.equal(rep.holds, null);
  const none = calibrationReport([]);
  assert.equal(none.checked.n, 0);
  assert.equal(none.cal.tau, null);
});

test('evaluate counts each answer once', () => {
  const cal = fitCalibration(rows(400));
  const e = evaluate(rows(100, { seed: 3 }), cal);
  assert.equal(e.n, e.confident.n + e.choose.n + e.unsure.n);
  assert.ok(e.confident.right <= e.confident.n && e.choose.contains <= e.choose.n);
});

/* ---------- collected by the harness ---------- */

test('collecting rows changes none of the harness\'s own numbers', () => {
  const lib = { playlists: ['x', 'y', 'z'].map((f, fi) => ({
    id: `p-${f}`, name: f,
    tracks: Array.from({ length: 10 }, (_, i) => ({
      id: `${f}${i}`, artists: [{ id: `${f}a${i % 3}`, name: `${f} ${i % 3}` }],
      albumType: 'single', albumTracks: 2, released: '2020-01-01', duration_ms: 300000,
      isrc: `GB${'XYZ'[fi]}AA20${String(10000 + i).slice(0, 5)}`,
    })),
  })) };
  lib.playlists.push({ id: 'p-mix', name: 'Mix', tracks: lib.playlists.flatMap(p => p.tracks.slice(0, 3)) });
  const plain = placementAccuracy(lib, { folds: 3 });
  const kept = placementAccuracy(lib, { folds: 3, collect: true });
  const { rows: got, ...rest } = kept;
  assert.deepEqual(rest, plain);
  assert.equal(got.length, plain.scored);
  for (const r of got) {
    assert.ok(r.scores.length >= 3, 'every destination is ranked, not just the top three');
    assert.ok(r.truth.length >= 1);
    for (let i = 1; i < r.scores.length; i++) assert.ok(r.scores[i - 1][1] >= r.scores[i][1]);
  }
});
