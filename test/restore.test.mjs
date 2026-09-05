// planRestore works out how to put removed tracks back at the indexes they
// came from. Spotify's reorder indexes are read against the list *before* the
// item is lifted out, which is easy to get off by one — and getting it wrong
// silently reshuffles a hand-ordered playlist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planRestore } from '../actions.mjs';

/** Apply a plan's moves the way Spotify's reorder endpoint would. */
function applyMoves(order, moves) {
  const out = [...order];
  for (const m of moves) {
    const [item] = out.splice(m.from, 1);
    out.splice(m.insertBefore > m.from ? m.insertBefore - 1 : m.insertBefore, 0, item);
  }
  return out;
}

test('a track removed from the middle goes back to its index', () => {
  const plan = planRestore(['a', 'b', 'd', 'e'], { c: [2] });
  assert.deepEqual(plan.ids, ['c']);
  assert.deepEqual(plan.order, ['a', 'b', 'c', 'd', 'e']);
  // The simulated order must match what Spotify actually does with the moves.
  assert.deepEqual(applyMoves(['a', 'b', 'd', 'e', 'c'], plan.moves), plan.order);
});

test('several tracks come back to their own indexes', () => {
  const plan = planRestore(['b', 'd'], { a: [0], c: [2], e: [4] });
  assert.deepEqual(plan.order, ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(applyMoves(['b', 'd', 'a', 'c', 'e'], plan.moves), plan.order);
});

test('a track that was in the playlist twice comes back twice', () => {
  const plan = planRestore(['x', 'y'], { dup: [0, 3] });
  assert.deepEqual(plan.ids, ['dup', 'dup'], 'one copy re-added per recorded position');
  assert.deepEqual(plan.order, ['dup', 'x', 'y', 'dup']);
  assert.deepEqual(applyMoves(['x', 'y', 'dup', 'dup'], plan.moves), plan.order);
});

test('a track removed from the end needs no move at all', () => {
  const plan = planRestore(['a', 'b'], { c: [2] });
  assert.deepEqual(plan.moves, [], 'it is already where the re-add put it');
  assert.deepEqual(plan.order, ['a', 'b', 'c']);
});

test('a target past the end of a shrunken playlist clamps to the end', () => {
  const plan = planRestore(['a'], { z: [99] });
  assert.deepEqual(plan.order, ['a', 'z']);
  assert.deepEqual(applyMoves(['a', 'z'], plan.moves), plan.order);
});

test('restoring into an empty playlist works', () => {
  const plan = planRestore([], { a: [0], b: [1] });
  assert.deepEqual(plan.order, ['a', 'b']);
  assert.deepEqual(applyMoves(['a', 'b'], plan.moves), plan.order);
});

test('no positions means nothing to do', () => {
  const plan = planRestore(['a', 'b'], {});
  assert.deepEqual(plan, { ids: [], moves: [], order: ['a', 'b'] });
  assert.deepEqual(planRestore(['a'], undefined).ids, []);
});

test('every move index stays inside the list', () => {
  const plan = planRestore(['b', 'd', 'f'], { a: [0], c: [2], e: [4], g: [6] });
  const len = 3 + 4;
  for (const m of plan.moves) {
    assert.ok(m.from >= 0 && m.from < len, `from ${m.from} in range`);
    assert.ok(m.insertBefore >= 0 && m.insertBefore <= len, `insertBefore ${m.insertBefore} in range`);
  }
  assert.deepEqual(plan.order, ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  assert.deepEqual(applyMoves(['b', 'd', 'f', 'a', 'c', 'e', 'g'], plan.moves), plan.order);
});
