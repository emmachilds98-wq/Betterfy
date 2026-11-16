import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pairKey, pairScore, fitThreshold, fitPair, pairCandidates, pairPick, pairOrder, pairsImpact,
         fitPairs, pairsLine, PAIR_GATE } from '../core/intrinsic/pairs.mjs';

const DIM = 16;
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 2 ** 32 - 0.5; };
}
const unit = v => { const n = Math.hypot(...v); return Float32Array.from(v, x => x / n); };
/** A heard track near direction `dir` (0..DIM-1), with noise `noise`. */
function emb(r, dir, noise) { return unit(Array.from({ length: DIM }, (_, i) => (i === dir ? 1 : 0) + noise * r())); }

/** Two playlists, A ("jungle") around one direction, B ("rollers") around a
 *  nearby one; `noise` sets how hard they are to tell apart. */
function pairLib({ nA = 30, nB = 30, noise = 0.3, seed = 5, apart = true } = {}) {
  const r = rng(seed), index = new Map();
  const mk = (p, n, dir) => Array.from({ length: n }, (_, i) => {
    const id = `${p}${i}`;
    index.set(id, { emb: emb(r, apart ? dir : 0, noise) });
    return { id, artists: [{ id: `ar-${p}${i}` }] };
  });
  const lib = { playlists: [{ id: 'A', name: 'Jungle', tracks: mk('a', nA, 0) },
                           { id: 'B', name: 'Rollers', tracks: mk('b', nB, 1) }] };
  return { lib, index };
}

test('a pair key is the same either way round', () => {
  assert.equal(pairKey('x', 'y'), pairKey('y', 'x'));
});

test('the threshold splits the two sides', () => {
  const tau = fitThreshold([[-0.5, false], [-0.2, false], [0.1, true], [0.4, true]]);
  assert.ok(tau > -0.2 && tau < 0.1, String(tau));
  assert.ok(Number.isFinite(fitThreshold([[0.2, true], [0.3, true]])));
  assert.equal(fitThreshold([]), null);
});

test('a pair that sounds apart is told apart on held-out tracks, and used', () => {
  const { lib, index } = pairLib();
  const row = fitPair(lib, index, 'A', 'B');
  assert.equal(row.n, 60);
  assert.ok(row.checked.accuracy >= PAIR_GATE.minAccuracy, JSON.stringify(row.checked));
  assert.equal(row.use, true);
  assert.equal(row.tauBy.length, 2);
});

test('a pair that sounds the same is not used, and says why', () => {
  const { lib, index } = pairLib({ apart: false, noise: 0.5 });
  const row = fitPair(lib, index, 'A', 'B');
  assert.equal(row.use, false);
  assert.match(row.why, /held-out two-way \d+%/);
});

test('too few heard tracks: not fitted', () => {
  const { lib, index } = pairLib({ nA: 6, nB: 6 });
  const row = fitPair(lib, index, 'A', 'B');
  assert.equal(row.use, false);
  assert.equal(row.checked, null);
  assert.match(row.why, /heard/);
});

test('candidates are the pairs held-out rows confuse, then the "can\'t tell apart" list, in scope and together only', () => {
  const rows = [
    { id: '1', scores: [['A', 0.5], ['B', 0.4]], truth: ['B'] },
    { id: '2', scores: [['B', 0.5], ['A', 0.4]], truth: ['A'] },
    { id: '3', scores: [['A', 0.5], ['B', 0.4]], truth: ['A'] },          // right: not a confusion
    { id: '4', scores: [['C', 0.5], ['D', 0.4]], truth: ['D'] },          // only once
    { id: '5', scores: [['A', 0.5], ['X', 0.4]], truth: ['X'] },
    { id: '6', scores: [['A', 0.5], ['X', 0.4]], truth: ['X'] },
  ];
  const c = pairCandidates(rows, [{ a: { id: 'C' }, b: { id: 'E' }, verdict: 'indistinguishable' },
                                  { a: { id: 'C' }, b: { id: 'F' }, verdict: 'view' }],
    { inScope: id => id !== 'X', together: (a, b) => !(a === 'A' && b === 'E') });
  assert.deepEqual(c.map(p => p.key), ['A|B', 'C|E']);
  assert.equal(c[0].misses, 2);
});

test('a used pair puts the one the track sounds like first; otherwise the order is kept', () => {
  const { lib, index } = pairLib();
  const fit = { rows: [fitPair(lib, index, 'A', 'B')] };
  // b3 sounds like B: B goes first whichever way the picks came in.
  assert.equal(pairPick('b3', 'A', 'B', fit, index, lib), 'B');
  assert.deepEqual(pairOrder('b3', ['A', 'B', 'Z'], fit, index, lib), { picks: ['B', 'A', 'Z'], swapped: true });
  assert.deepEqual(pairOrder('b3', ['B', 'A'], fit, index, lib), { picks: ['B', 'A'], swapped: false });
  // Not heard, or the pair not in use: untouched.
  assert.deepEqual(pairOrder('nope', ['A', 'B'], fit, index, lib).swapped, false);
  const off = { rows: [{ ...fit.rows[0], use: false }] };
  assert.equal(pairPick('b3', 'A', 'B', off, index, lib), null);
});

test('impact: re-ordering by a good pair raises top-1 on rows the engine confused, and is used', () => {
  const { lib, index } = pairLib();
  // The engine ranks A first for every track: right for A's, wrong for B's.
  const rows = [...lib.playlists[0].tracks.map(t => ({ id: t.id, scores: [['A', 0.5], ['B', 0.49]], truth: ['A'] })),
                ...lib.playlists[1].tracks.map(t => ({ id: t.id, scores: [['A', 0.5], ['B', 0.49]], truth: ['B'] }))];
  const fit = fitPairs(lib, index, rows, []);
  assert.equal(fit.rows.length, 1);
  assert.equal(fit.rows[0].use, true);
  assert.ok(fit.impact.after > fit.impact.before, JSON.stringify(fit.impact));
  assert.equal(fit.use, true);
  assert.match(pairsLine(fit, id => ({ A: 'Jungle', B: 'Rollers' })[id]),
    /^Pair checks: 1 of 1 confusable pairs told apart by sound\. Jungle vs Rollers \(right \d+% of \d+ held out\)\. Top-1 with them \d+% vs 50% without/);
});

test('impact that would lower top-1 switches every pair off', () => {
  const { lib, index } = pairLib();
  const fit = { rows: [fitPair(lib, index, 'A', 'B')] };
  // Truth inverted against the sound: re-ordering by sound makes it worse.
  const rows = [...lib.playlists[0].tracks.map(t => ({ id: t.id, scores: [['B', 0.5], ['A', 0.4]], truth: ['B'] }))];
  const imp = pairsImpact(rows, fit, index, lib);
  assert.ok(imp.after < imp.before);
  assert.equal(imp.use, false);
});

test('pairScore is null without members on a side', () => {
  assert.equal(pairScore(new Float32Array(DIM), [], [['x', new Float32Array(DIM)]]), null);
});
