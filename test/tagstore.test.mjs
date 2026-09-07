import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeTagSources } from '../tagstore.mjs';

// Discogs is a fallback and a thin-answer supplement, never a second vote: it
// fills a total gap outright, adds to a thin answer without displacing it,
// and never touches an artist Last.fm already tagged well.

test('an artist Last.fm has nothing on is filled from Discogs', () => {
  const merged = mergeTagSources(
    { a1: { name: 'No Coverage', tags: [] } },
    { a1: { name: 'No Coverage', tags: [['jungle', 3]], source: 'discogs' } },
  );
  assert.deepEqual(merged.a1.tags, [['jungle', 3]]);
});

test('a well-tagged Last.fm artist is never touched by Discogs', () => {
  const merged = mergeTagSources(
    { a1: { name: 'Well Tagged', tags: [['house', 80], ['deep house', 70], ['electronic', 60]] } },
    { a1: { name: 'Well Tagged', tags: [['techno', 5]], source: 'discogs' } },
  );
  assert.deepEqual(merged.a1.tags, [['house', 80], ['deep house', 70], ['electronic', 60]],
    'three tags is enough to stand on its own — Discogs is not even consulted');
});

test('a thin Last.fm answer gets Discogs blended in behind it, not replaced', () => {
  const merged = mergeTagSources(
    { a1: { name: 'Barely Tagged', tags: [['house', 80]] } },
    { a1: { name: 'Barely Tagged', tags: [['deep house', 40], ['tech house', 20]], source: 'discogs' } },
  );
  assert.deepEqual(merged.a1.tags, [['house', 80], ['deep house', 40], ['tech house', 20]],
    'Last.fm\'s own tag still leads, Discogs only adds to it');
});

test('a thin answer never gets a Discogs tag it already has, duplicated', () => {
  const merged = mergeTagSources(
    { a1: { name: 'Barely Tagged', tags: [['house', 80]] } },
    { a1: { name: 'Barely Tagged', tags: [['house', 40], ['deep house', 20]], source: 'discogs' } },
  );
  assert.deepEqual(merged.a1.tags, [['house', 80], ['deep house', 20]]);
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

test('the input tables are not mutated', () => {
  const lastfm = { a1: { name: 'Barely Tagged', tags: [['house', 80]] } };
  const discogs = { a1: { name: 'Barely Tagged', tags: [['deep house', 40]], source: 'discogs' } };
  const beforeLastfm = JSON.stringify(lastfm), beforeDiscogs = JSON.stringify(discogs);
  mergeTagSources(lastfm, discogs);
  assert.equal(JSON.stringify(lastfm), beforeLastfm);
  assert.equal(JSON.stringify(discogs), beforeDiscogs);
});
