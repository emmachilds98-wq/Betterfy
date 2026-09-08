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

/* ---------- more than two sources: each only ever tops up what came before it ---------- */

test('a chain of sources fills a total gap outright from the first one with anything at all', () => {
  const lastfm = { a1: { tags: [] } };
  const musicbrainz = { a1: { tags: [] } };
  // Enough tags to clear THIN_TAG_FLOOR, so this is a real "stand on its
  // own" answer, not one more source down the chain could still add to.
  const discogs = { a1: { tags: [['jungle', 3], ['breakbeat', 2], ['amen break', 1]] } };
  const spotify = { a1: { tags: [['drum and bass', 60]] } };
  const merged = mergeTagSources(lastfm, musicbrainz, discogs, spotify);
  assert.deepEqual(merged.a1.tags, [['jungle', 3], ['breakbeat', 2], ['amen break', 1]],
    'Discogs is enough on its own — Spotify\'s tag never appears');
});

test('a thin answer from the second source in the chain still blends in a third', () => {
  const lastfm = { a1: { tags: [['jungle', 90]] } };       // thin: 1 tag
  const musicbrainz = { a1: { tags: [] } };                 // nothing at all
  const discogs = { a1: { tags: [['breakbeat', 40], ['jungle', 30]] } };
  const merged = mergeTagSources(lastfm, musicbrainz, discogs);
  assert.deepEqual(merged.a1.tags, [['jungle', 90], ['breakbeat', 40]],
    'Discogs blends in what Last.fm didn\'t have; the duplicate "jungle" is never added twice');
});

test('once any prior source clears the thin floor, later sources are never even consulted', () => {
  const lastfm = { a1: { tags: [] } };
  const musicbrainz = { a1: { tags: [['jungle', 80], ['breakbeat', 60], ['amen break', 40]] } }; // 3 tags — enough
  const discogs = { a1: { tags: [['drum and bass', 90]] } };
  const merged = mergeTagSources(lastfm, musicbrainz, discogs);
  assert.deepEqual(merged.a1.tags, [['jungle', 80], ['breakbeat', 60], ['amen break', 40]],
    'MusicBrainz alone is enough — Discogs\'s tag never appears');
});

test('a single source behaves exactly like a plain copy', () => {
  const only = { a1: { name: 'Solo', tags: [['house', 90]] } };
  assert.deepEqual(mergeTagSources(only), only);
});

test('an artist missing from every source but the first is left exactly as the first had it', () => {
  const lastfm = { a1: { tags: [['house', 90]] }, a2: { tags: [] } };
  const discogs = { a1: { tags: [['deep house', 5]] } }; // says nothing about a2 at all
  const merged = mergeTagSources(lastfm, discogs);
  assert.deepEqual(merged.a2, { tags: [] });
});
