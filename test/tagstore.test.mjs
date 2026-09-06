import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeTagSources } from '../tagstore.mjs';

// Discogs is a fallback, not a second vote: it only ever fills an artist
// Last.fm came back empty on, and never touches one Last.fm already tagged.

test('an artist Last.fm has nothing on is filled from Discogs', () => {
  const merged = mergeTagSources(
    { a1: { name: 'No Coverage', tags: [] } },
    { a1: { name: 'No Coverage', tags: [['jungle', 3]], source: 'discogs' } },
  );
  assert.deepEqual(merged.a1.tags, [['jungle', 3]]);
});

test('a real Last.fm tag is never overridden by Discogs', () => {
  const merged = mergeTagSources(
    { a1: { name: 'Well Tagged', tags: [['house', 80]] } },
    { a1: { name: 'Well Tagged', tags: [['deep house', 5]], source: 'discogs' } },
  );
  assert.deepEqual(merged.a1.tags, [['house', 80]], 'Last.fm still wins outright');
});

test('an artist with nothing from either source stays empty, not dropped', () => {
  const merged = mergeTagSources(
    { a1: { name: 'Nobody Knows', tags: [] } },
    { a1: { name: 'Nobody Knows', tags: [], source: 'discogs' } },
  );
  assert.deepEqual(merged.a1.tags, []);
});

test('an artist absent from the Discogs cache entirely is left as Last.fm had it', () => {
  const merged = mergeTagSources({ a1: { name: 'X', tags: [] } }, {});
  assert.deepEqual(merged.a1, { name: 'X', tags: [] });
});
