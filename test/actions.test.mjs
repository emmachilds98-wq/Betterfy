import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moveInArray } from '../actions.mjs';

// moveInArray must match Spotify's documented reorder semantics for a single
// item (range_length=1), since undo-remove uses it to simulate playlist state
// locally instead of re-fetching the playlist after every reinsertion.

test('moving the first item to the end matches Spotify\'s own example', () => {
  // "To reorder the first item to the last position in a playlist with 10
  // items, set range_start to 0, and insert_before to 10."
  const arr = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  assert.deepEqual(moveInArray(arr, 0, 10), [1, 2, 3, 4, 5, 6, 7, 8, 9, 0]);
});

test('moving an item forward within the array', () => {
  assert.deepEqual(moveInArray(['a', 'b', 'c', 'd'], 0, 3), ['b', 'c', 'a', 'd']);
});

test('moving an item backward within the array', () => {
  assert.deepEqual(moveInArray(['a', 'b', 'c', 'd'], 3, 1), ['a', 'd', 'b', 'c']);
});

test('moving an item back to its original neighbourhood is a no-op on order', () => {
  assert.deepEqual(moveInArray(['a', 'b', 'c'], 2, 0), ['c', 'a', 'b']);
});
