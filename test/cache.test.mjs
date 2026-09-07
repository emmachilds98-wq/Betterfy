import { test } from 'node:test';
import assert from 'node:assert/strict';
import { worthReasking, REASK_TAG_FLOOR, REASK_AFTER_MS } from '../cache.mjs';

// worthReasking() decides whether a cached Last.fm/Discogs answer should be
// fetched again — the fix for an empty or thin answer being written down as a
// permanent verdict. A transient failure is always retried; a genuine answer
// is only retried once it is both thin and old.

test('no cached entry at all is always worth asking', () => {
  assert.equal(worthReasking(undefined), true);
  assert.equal(worthReasking(null), true);
});

test('an errored fetch is always retried, however recent', () => {
  assert.equal(worthReasking({ tags: [], error: 'timeout', checkedAt: Date.now() }), true);
});

test('a well-tagged answer is never re-asked, however old', () => {
  const tags = Array.from({ length: REASK_TAG_FLOOR }, (_, i) => [`tag${i}`, 90]);
  assert.equal(worthReasking({ tags, checkedAt: 0 }), false, 'at the floor, and ancient, still stands');
  assert.equal(worthReasking({ tags: [...tags, ['extra', 50]], checkedAt: Date.now() }), false);
});

test('a thin answer is not re-asked until it is actually stale', () => {
  const thin = { tags: [['jungle', 90]], checkedAt: Date.now() };
  assert.equal(worthReasking(thin), false, 'thin, but just answered — no upside to asking again yet');
});

test('a thin answer becomes worth re-asking once it is stale', () => {
  const thin = { tags: [['jungle', 90]], checkedAt: Date.now() - REASK_AFTER_MS - 1000 };
  assert.equal(worthReasking(thin), true);
});

test('an entry with no checkedAt at all is treated as old enough to retry', () => {
  // Cache files written before this existed have no checkedAt on any entry —
  // upgrading should not permanently freeze every pre-existing thin answer.
  assert.equal(worthReasking({ tags: [['jungle', 90]] }), true);
});

test('a zero-tag answer is exactly as thin as a one-tag one', () => {
  assert.equal(worthReasking({ tags: [], checkedAt: 0 }), true);
});

test('a custom floor and staleness window are honoured', () => {
  const entry = { tags: [['a', 1], ['b', 1]], checkedAt: Date.now() - 1000 };
  assert.equal(worthReasking(entry, { floor: 2 }), false, 'two tags now meets a floor of two');
  assert.equal(worthReasking(entry, { floor: 5, staleMs: 500 }), true, 'below a floor of five, and past a 500ms window');
});
