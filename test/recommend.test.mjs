import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compare, pairConfidence, sharedBasis, similarTracks, fitToPlaylist,
         SIMILARITY } from '../core/recommend/similarity.mjs';
import { libraryTracks, moreLikeThis, missingFromPlaylist, unfiled,
         underservedGenres, buildPlaylist } from '../core/recommend/suggest.mjs';
import { CONFIDENCE } from '../core/analysis/classify.mjs';
import { CorrectionLog, correction } from '../core/personal/corrections.mjs';
import { buildFixtureLibrary, NOW } from '../core/benchmark/playlists.mjs';
import { indexCaches, buildRegistry, profileLibrary, analysePlaylists, recommend } from '../core/engine.mjs';

/* ---------- the fixture library, profiled once ---------- */

function world() {
  const { lib, tags } = buildFixtureLibrary();
  const idx = indexCaches({ lastfm: tags, now: NOW });
  const profiles = profileLibrary(lib, idx, { registry: buildRegistry(idx.present), now: NOW });
  const analysis = analysePlaylists(lib, profiles, { now: NOW });
  return { lib, profiles, analysis };
}

const dna = (over = {}) => ({
  id: 'x', artistIds: ['a1'], basis: 'artist', primaryGenre: 'tech-house',
  genreConfidence: CONFIDENCE.LIKELY, genre: { 'tech-house': 0.6, house: 0.3, electronic: 0.1 },
  ...over,
});

/* ---------- confidence is capped by the weaker half ---------- */

test('a comparison never claims more confidence than its weaker half', () => {
  assert.equal(pairConfidence(CONFIDENCE.HIGH, CONFIDENCE.HIGH), CONFIDENCE.HIGH);
  assert.equal(pairConfidence(CONFIDENCE.HIGH, CONFIDENCE.AMBIGUOUS), CONFIDENCE.AMBIGUOUS);
  assert.equal(pairConfidence(CONFIDENCE.LIKELY, CONFIDENCE.INSUFFICIENT_DATA),
               CONFIDENCE.INSUFFICIENT_DATA);
  // An unknown band is treated as the weakest, never as the strongest.
  assert.equal(pairConfidence(CONFIDENCE.HIGH, undefined), CONFIDENCE.INSUFFICIENT_DATA);
});

/* ---------- the tautology guard, which is the point of this layer ---------- */

/*
 * Two tracks by one artist, neither with any evidence of its own, have
 * identical DNA by construction: both vectors came out of the same tag cloud.
 * v1's rank() cannot see this — the cosine reads 1.0 and the artist's whole
 * catalogue sorts to the top of every "more like this". These tests exist to
 * keep that from reappearing here.
 */

test('two artist-basis profiles for one artist are recognised as the same records twice', () => {
  const a = dna({ id: 't1' }), b = dna({ id: 't2' });
  assert.equal(sharedBasis(a, b), true);
  const rel = compare(a, b);
  // The raw similarity is reported honestly — it really is 1.0 — but what a
  // list is ordered by is discounted, and the reason is on the record.
  assert.equal(rel.score, 1);
  assert.equal(rel.rank, +(1 * SIMILARITY.SHARED_CLOUD_DISCOUNT).toFixed(4));
  assert.equal(rel.basis, 'same-artist-cloud');
});

test('a track-level answer is a real statement about the recording, not a shared cloud', () => {
  const a = dna({ id: 't1', basis: 'track' }), b = dna({ id: 't2', basis: 'artist' });
  assert.equal(sharedBasis(a, b), false);
  assert.equal(compare(a, b).rank, compare(a, b).score);
});

test('different artists are never a shared cloud however alike they are', () => {
  assert.equal(sharedBasis(dna({ artistIds: ['a1'] }), dna({ artistIds: ['a2'] })), false);
});

/* ---------- declining is a valid answer (§4.6) ---------- */

test('a seed the engine cannot classify produces no recommendations at all', () => {
  const out = similarTracks(dna({ genreConfidence: CONFIDENCE.INSUFFICIENT_DATA }), []);
  assert.equal(out.declined, 'INSUFFICIENT_DATA');
  assert.deepEqual(out.results, []);
});

test('candidates the engine cannot classify are never ranked', () => {
  const out = similarTracks(dna({ id: 'seed' }), [
    { id: 'c1', name: 'known', artists: [{ name: 'B' }], dna: dna({ id: 'c1', artistIds: ['b'] }) },
    { id: 'c2', name: 'unknown', artists: [{ name: 'C' }],
      dna: dna({ id: 'c2', artistIds: ['c'], genreConfidence: CONFIDENCE.INSUFFICIENT_DATA }) },
  ]);
  assert.deepEqual(out.results.map(r => r.id), ['c1']);
});

test('one artist cannot fill the list', () => {
  const many = Array.from({ length: 6 }, (_, i) => ({
    id: `c${i}`, name: `t${i}`, artists: [{ name: 'One Artist' }],
    dna: dna({ id: `c${i}`, artistIds: ['b'] }),
  }));
  const out = similarTracks(dna({ id: 'seed' }), many, { top: 10 });
  assert.equal(out.results.length, SIMILARITY.MAX_PER_ARTIST);
});

/* ---------- fitting a track to a playlist ---------- */

test('fitting needs both a matching centroid and the playlist\'s own axis', () => {
  const fp = { centroid: { 'tech-house': 0.6, house: 0.3, electronic: 0.1 }, coherence: 0.9,
               enoughToDescribe: true, primaryGenre: 'tech-house', confidentShare: 0.8 };
  // Sits inside tech-house and matches the centroid.
  assert.equal(fitToPlaylist(dna(), fp).fits, true);
  // Matches the centroid well enough — they share house and electronic — but
  // is not the kind of thing this bucket is for.
  const deep = dna({ primaryGenre: 'deep-house',
                     genre: { 'deep-house': 0.6, house: 0.3, electronic: 0.1 } });
  const fit = fitToPlaylist(deep, fp);
  assert.equal(fit.withinAxis, false);
  assert.equal(fit.fits, false);
});

test('a playlist too broad to have a centroid is not ranked against', () => {
  assert.equal(fitToPlaylist(dna(), { centroid: {}, enoughToDescribe: true }).reason, 'NO_CENTROID');
  assert.equal(fitToPlaylist(dna(), { centroid: { house: 1 }, enoughToDescribe: false }).reason,
               'TOO_FEW_PROFILED');
  assert.equal(fitToPlaylist(dna(), { centroid: { house: 1 }, enoughToDescribe: true, coherence: 0.1 }).reason,
               'PLAYLIST_TOO_BROAD');
});

/* ---------- §25 against the fixture library ---------- */

test('more like this stays in the seed\'s family and leaves its own artist out', () => {
  const { lib, profiles } = world();
  const tracks = libraryTracks(lib, profiles);
  const seed = [...tracks.values()].find(t => t.dna.primaryGenre === 'tech-house');
  const out = moreLikeThis(seed.id, { lib, profiles, tracks, top: 10 });

  assert.ok(out.results.length > 0, 'a well-evidenced tech house seed should match something');
  assert.ok(!out.results.some(r => r.artist === seed.artists[0].name),
    'the seed\'s own artist rests on the same tag cloud and says nothing new');
  for (const r of out.results)
    assert.ok(['tech-house', 'house', 'techno', 'deep-house'].includes(r.genre),
      `${r.genre} is not in the seed's family`);
  assert.ok(!out.results.some(r => r.genre === 'jungle'));
});

test('asking for the same artist back returns them, so the exclusion is a choice not a limit', () => {
  const { lib, profiles } = world();
  const tracks = libraryTracks(lib, profiles);
  const seed = [...tracks.values()].find(t => t.dna.primaryGenre === 'tech-house');
  // A wide enough window to see them: the discount sorts a shared-cloud match
  // below every real one, which is the whole point of it.
  const out = moreLikeThis(seed.id, { lib, profiles, tracks, top: 100, allowSameArtist: true });
  assert.ok(out.results.some(r => r.artist === seed.artists[0].name));
  // And they are still marked for what they are.
  assert.ok(out.results.filter(r => r.artist === seed.artists[0].name)
    .every(r => r.basis === 'same-artist-cloud'));
});

/*
 * The plan's worked example, from the other side. "Fabric September 2025" is
 * an event: a record of one night. It is not a bucket, so it is never offered
 * additions — however well the rest of the library matches it.
 */
test('an event playlist is never offered additions', () => {
  const { lib, profiles, analysis } = world();
  assert.equal(analysis.classifications.get('p-event').type, 'EVENT');
  const out = missingFromPlaylist('p-event', { lib, profiles, ...analysis });
  assert.equal(out.declined, 'NOT_A_FILING_DESTINATION');
  assert.deepEqual(out.results, []);
});

test('a genre bucket is offered the tracks it is missing, and never the ones it has', () => {
  const { lib, profiles, analysis } = world();
  const already = new Set(lib.playlists.find(p => p.id === 'p-thfav').tracks.map(t => t.id));
  const out = missingFromPlaylist('p-thfav', { lib, profiles, ...analysis, top: 50 });

  assert.ok(out.results.length > 0);
  for (const r of out.results) {
    assert.ok(!already.has(r.id), 'suggested a track the playlist already has');
    assert.equal(r.genre, 'tech-house');
  }
});

test('a rejection is permanent — a track said no to is never offered for that playlist again', () => {
  const { lib, profiles, analysis } = world();
  const first = missingFromPlaylist('p-thfav', { lib, profiles, ...analysis, top: 50 });
  const victim = first.results[0].id;

  const log = new CorrectionLog().add(correction({ kind: 'reject', trackId: victim, playlistId: 'p-thfav' }));
  const after = missingFromPlaylist('p-thfav', { lib, profiles, ...analysis, corrections: log, top: 50 });
  assert.ok(!after.results.some(r => r.id === victim));
  // And only that one playlist — a rejection is about a placement, not a track.
  const elsewhere = missingFromPlaylist('p-th', { lib, profiles, ...analysis, corrections: log, top: 50 });
  assert.equal(elsewhere.declined, undefined);
});

test('liked tracks in no playlist are found, with a destination only when one fits', () => {
  const { lib, profiles, analysis } = world();
  // Two liked tracks: one already filed, one that never was.
  const filed = lib.playlists.find(p => p.id === 'p-th').tracks[0];
  const loose = { ...filed, id: 'loose-1', name: 'Loose TH' };
  const lib2 = { ...lib, liked: [filed, loose] };
  const profiles2 = profileLibrary(lib2, indexCaches({ lastfm: buildFixtureLibrary().tags, now: NOW }),
                                   { registry: buildRegistry({ lastfm: true }), now: NOW });

  const out = unfiled({ lib: lib2, profiles: profiles2, ...analysis });
  assert.deepEqual(out.results.map(r => r.id), ['loose-1'], 'a filed liked track is not unfiled');
  assert.ok(out.results[0].suggested, 'a tech house track should find the tech house bucket');
  assert.equal(out.results[0].suggested.playlist, 'p-th');
});

test('underserved genres declines rather than guessing when there is no listening history', () => {
  const { lib, profiles } = world();
  assert.equal(underservedGenres({ lib, profiles }).declined, 'NO_LISTENING_HISTORY');
  assert.equal(underservedGenres({ lib, profiles, listening: { recentlyActive: new Set() } }).declined,
               'NO_LISTENING_HISTORY');
});

test('underserved genres compares playing against filing, not filing against itself', () => {
  const { lib, profiles } = world();
  // The jungle pool is filed in two playlists; the sad pool is filed in one.
  // Play only the jungle artists and jungle should not read as underserved.
  const listening = { recentlyActive: new Set(['Jungle Artist 0', 'Jungle Artist 1', 'Jungle Artist 2']) };
  const out = underservedGenres({ lib, profiles, listening });
  assert.ok(out.results.length > 0);
  for (const r of out.results) assert.ok(r.played >= 3);
  // Nothing an unplayed artist accounts for appears at all.
  assert.ok(!out.results.some(r => r.concept === 'tech-house'));
});

/* ---------- the builder ---------- */

test('the builder ranks exact answers above tracks that merely sit under the target', () => {
  const { lib, profiles } = world();
  const out = buildPlaylist({ genre: 'house', size: 60 }, { lib, profiles });
  assert.ok(out.matched > 0);
  const firstGeneric = out.results.findIndex(r => !r.exact);
  const lastExact = out.results.map(r => r.exact).lastIndexOf(true);
  if (firstGeneric >= 0) assert.ok(lastExact < firstGeneric, 'an exact answer sorted below a broader one');
});

test('a correction outranks the evidence, in both directions', () => {
  const { lib, profiles } = world();
  const tracks = libraryTracks(lib, profiles);
  const jungle = [...tracks.values()].find(t => t.dna.primaryGenre === 'jungle');

  const plain = buildPlaylist({ genre: 'tech-house', size: 100 }, { lib, profiles, tracks });
  assert.ok(!plain.results.some(r => r.id === jungle.id));

  const log = new CorrectionLog().add(correction({ kind: 'genre', trackId: jungle.id, value: 'tech-house' }));
  const corrected = buildPlaylist({ genre: 'tech-house', size: 100 },
                                  { lib, profiles, tracks, corrections: log });
  const row = corrected.results.find(r => r.id === jungle.id);
  assert.ok(row, 'the listener said what this track is and was ignored');
  assert.equal(row.basis, 'correction');
  assert.equal(corrected.results[0].id, jungle.id, 'a correction should sort above every inference');
});

test('the builder refuses a target it was not given', () => {
  assert.equal(buildPlaylist({}, {}).declined, 'NO_TARGET');
});

/* ---------- the boundary this layer is not allowed to cross ---------- */

/*
 * §21's misfile detection reads the same similarity numbers as everything
 * above and turns them into "this track is in the wrong place". That is the
 * one output that can lose somebody their filing, and the fit sweep still
 * reports four of fifteen thresholds as uncontradicted rather than validated
 * (npm run benchmark:fit). Until the benchmark is real, this layer proposes
 * additions and nothing else — this test is what says so out loud.
 */
test('nothing in the recommend layer produces a move or a removal', () => {
  const src = ['core/recommend/similarity.mjs', 'core/recommend/suggest.mjs']
    .map(f => readFileSync(f, 'utf8'))
    .map(s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''))
    .join('\n');
  for (const banned of ['misfile', 'removeFrom', 'moveTo', 'shouldMove'])
    assert.ok(!src.includes(banned), `${banned} belongs to §21, which is deliberately not built`);
});

/* ---------- the front door ---------- */

test('recommend() binds one library pass and answers all four questions from it', () => {
  const { lib, profiles, analysis } = world();
  const r = recommend(lib, profiles, analysis);
  const seed = [...r.tracks.values()].find(t => t.dna.primaryGenre === 'tech-house');

  assert.ok(r.moreLikeThis(seed.id).results.length > 0);
  assert.equal(r.missingFromPlaylist('p-event').declined, 'NOT_A_FILING_DESTINATION');
  assert.ok(Array.isArray(r.unfiled().results));
  assert.equal(r.underservedGenres().declined, 'NO_LISTENING_HISTORY');
  assert.ok(r.buildPlaylist({ genre: 'house' }).matched > 0);
});

/*
 * A stray and a track already filed in three other buckets score identically
 * — they are the same music — but they are not the same suggestion. One says
 * "you lost this"; the other says "this could also live here". Without the
 * count they are indistinguishable in the output, and the first gets buried
 * under the second in any library where cross-filing is normal.
 */
test('a suggestion says whether the track is filed anywhere else', () => {
  const { lib, profiles, analysis } = world();
  const out = missingFromPlaylist('p-thfav', { lib, profiles, ...analysis, top: 50 });
  for (const r of out.results) assert.equal(typeof r.filedIn, 'number');
  // Every tech house track in this fixture also lives in the full Tech House
  // playlist, so none of these is a stray — and the report says so rather
  // than leaving it to be inferred.
  assert.equal(out.strays, 0);
  assert.ok(out.results.every(r => r.filedIn > 0));
});

test('a track in no playlist at all is reported as a stray', () => {
  const { lib, profiles, analysis } = world();
  const th = lib.playlists.find(p => p.id === 'p-th');
  const stray = { ...th.tracks[0], id: 'stray-1', name: 'Stray TH' };
  const lib2 = { ...lib, liked: [stray] };
  const { tags } = buildFixtureLibrary();
  const profiles2 = profileLibrary(lib2, indexCaches({ lastfm: tags, now: NOW }),
                                   { registry: buildRegistry({ lastfm: true }), now: NOW });
  const out = missingFromPlaylist('p-thfav', { lib: lib2, profiles: profiles2, ...analysis, top: 50 });
  const row = out.results.find(r => r.id === 'stray-1');
  assert.ok(row, 'a stray that fits the bucket should be suggested for it');
  assert.equal(row.filedIn, 0);
  assert.equal(out.strays, 1);
});
