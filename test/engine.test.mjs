import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indexCaches, buildRegistry, buildEvidence, profileTrack, profileLibrary, libraryReport } from '../core/engine.mjs';
import { CONFIDENCE } from '../core/analysis/classify.mjs';

/*
 * The engine end to end, from the shape snapshot.mjs writes and the caches v1
 * already keeps. No network, and deliberately no new data: the point of this
 * layer is that an existing library gets profiles out of caches it already
 * has, which is what makes the benchmark comparison a comparison of engines
 * rather than of how much was fetched.
 */

const LIB = {
  playlists: [
    { id: 'p1', name: 'Tech House', tracks: [
      { id: 't1', name: 'Pressure', artists: [{ id: 'a1', name: 'Producer One' }], released: '2021-06-01' },
      { id: 't2', name: 'Pressure', artists: [{ id: 'a1', name: 'Producer One' }], released: '2021-06-01' }, // same track, filed twice
    ] },
    { id: 'p2', name: 'Jungle', tracks: [
      { id: 't3', name: 'Rollers', artists: [{ id: 'a2', name: 'Jungle Artist' }], released: '1996-01-01' },
    ] },
  ],
  liked: [
    { id: 't4', name: 'Untitled', artists: [{ id: 'a3', name: 'Nobody Has Tagged This' }] },
  ],
};

const CACHES = {
  lastfm: {
    a1: { tags: [['tech house', 100], ['house', 60]], checkedAt: Date.now() },
    a2: { tags: [['jungle', 100], ['drum and bass', 80]], checkedAt: Date.now() },
    a3: { tags: [], checkedAt: Date.now() },
  },
  discogs: {
    a1: { tags: [['tech house', 9], ['minimal house', 2]], checkedAt: Date.now() },
  },
};

test('an existing library profiles from the caches it already has, with no new fetches', () => {
  const idx = indexCaches(CACHES);
  const reg = buildRegistry(idx.present);
  const profiles = profileLibrary(LIB, idx, { registry: reg });

  assert.equal(profiles.size, 4, 'one profile per distinct track, not per placement');
  assert.equal(profiles.get('t1').profile.genre.primary, 'tech-house');
  assert.equal(profiles.get('t3').profile.genre.primary, 'jungle');
  assert.equal(profiles.get('t4').profile.genre.primary, null);
  assert.equal(profiles.get('t4').profile.genre.confidence, CONFIDENCE.INSUFFICIENT_DATA);
});

test('a registry describes what this listener actually has', () => {
  assert.deepEqual(buildRegistry({}).ids, ['spotify'], 'Spotify is the only non-optional provider');
  assert.deepEqual(buildRegistry({ lastfm: true, discogs: true }).ids.sort(),
    ['discogs', 'lastfm', 'spotify']);
});

test('a missing provider lowers confidence rather than breaking classification', () => {
  const track = LIB.playlists[0].tracks[0];
  const withBoth = profileTrack(track, indexCaches(CACHES), { registry: buildRegistry(indexCaches(CACHES).present) });
  const lastfmOnly = profileTrack(track, indexCaches({ lastfm: CACHES.lastfm }),
    { registry: buildRegistry({ lastfm: true }) });

  assert.equal(withBoth.profile.genre.primary, lastfmOnly.profile.genre.primary, 'the answer survives');
  assert.ok(withBoth.profile.confidence.coverage > lastfmOnly.profile.confidence.coverage);
  assert.ok(withBoth.profile.genre.score > lastfmOnly.profile.genre.score, 'corroboration is what is lost');
});

test('a listener with nothing configured at all still gets a valid profile', () => {
  const idx = indexCaches({});
  const { profile, dna } = profileTrack(LIB.playlists[0].tracks[0], idx, { registry: buildRegistry({}) });
  assert.equal(profile.genre.primary, null);
  assert.equal(profile.genre.confidence, CONFIDENCE.INSUFFICIENT_DATA);
  assert.equal(profile.era.primary, '2020s', 'a release date needs no third party');
  assert.equal(dna.id, 't1');
});

test('track-level tags outrank the artist cloud without anything else changing', () => {
  const idx = indexCaches(CACHES);
  const reg = buildRegistry(idx.present);
  const track = LIB.playlists[1].tracks[0];
  const trackTags = { t3: { tags: [['ambient', 100], ['downtempo', 70]], checkedAt: Date.now() } };

  assert.equal(profileTrack(track, idx, { registry: reg }).profile.genre.primary, 'jungle');
  const deeper = profileTrack(track, idx, { registry: reg, trackTags }).profile;
  assert.equal(deeper.genre.primary, 'ambient');
  assert.ok(deeper.genre.secondary.includes('jungle') || deeper.genre.secondary.includes('drum-and-bass'),
    'the artist evidence is outweighed, not discarded');
});

test('evidence is assembled from every source that has something, at its own specificity', () => {
  const idx = indexCaches(CACHES);
  const set = buildEvidence(LIB.playlists[0].tracks[0], idx, {
    trackTags: { t1: { tags: [['tech house', 100]], checkedAt: Date.now() } },
  });
  const levels = new Set(set.records.map(r => r.entityType));
  assert.ok(levels.has('track'));
  assert.ok(levels.has('artist'));
  assert.ok(set.sources.includes('lastfm'));
  assert.ok(set.sources.includes('discogs'));
  assert.ok(set.sources.includes('spotify'));
});

test('a library report says what it covered and what it could not place', () => {
  const idx = indexCaches({ lastfm: { ...CACHES.lastfm, a3: { tags: [['schranz', 100]], checkedAt: Date.now() } } });
  const report = libraryReport(profileLibrary(LIB, idx, { registry: buildRegistry(idx.present) }));
  assert.equal(report.tracks, 4);
  assert.ok(report.coverage > 0 && report.coverage < 1);
  assert.ok(Object.values(report.bands).reduce((a, b) => a + b, 0) === report.tracks);
  assert.ok(report.unknownConcepts.some(u => u.raw === 'schranz'),
    'unmapped concepts are the input to growing the ontology');
});

test('a malformed or empty library does not throw', () => {
  const idx = indexCaches({});
  for (const lib of [{}, { playlists: null }, { playlists: [{ tracks: null }], liked: null }])
    assert.equal(profileLibrary(lib, idx).size, 0);
  assert.equal(libraryReport(new Map()).tracks, 0);
});
