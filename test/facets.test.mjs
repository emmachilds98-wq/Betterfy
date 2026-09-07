import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tagFacet, axisVec, facetMix, trackVec, applyIdf, cosine,
         buildProfiles, findMisfiled } from '../profile.mjs';

/*
 * Last.fm hands back one flat cloud per artist with no type on any of it, and
 * every tag in it used to count equally as evidence of what a track sounds
 * like. "chill", "90s", "party" and "british" are not evidence of that, and in
 * a library where two different genre buckets happen to share them they were
 * enough to make a track look at home in the wrong one.
 *
 * tagFacet() sorts the cloud; the per-axis weights decide how much each kind
 * counts for the question actually being asked.
 */

test('a tag is sorted by what kind of thing it is', () => {
  assert.equal(tagFacet('deep house'), 'genre');
  assert.equal(tagFacet('drum and bass'), 'genre');
  assert.equal(tagFacet('chill'), 'mood');
  assert.equal(tagFacet('melancholic'), 'mood');
  assert.equal(tagFacet('90s'), 'era');
  assert.equal(tagFacet('1994'), 'era');
  assert.equal(tagFacet('old school'), 'era');
  assert.equal(tagFacet('workout'), 'occasion');
  assert.equal(tagFacet('christmas'), 'occasion');
  assert.equal(tagFacet('british'), 'descriptor');
  assert.equal(tagFacet('female vocalists'), 'descriptor');
});

test('only the whole tag is ever matched, so a genre named after a mood stays a genre', () => {
  // The same lesson the playlist-name rules learned: unbounded "chill" also
  // matches inside "chillstep", "hype" inside "hyperpop".
  for (const g of ['chillstep', 'chillwave', 'hyperpop', 'happy hardcore', 'sad boy rap',
                   'dark techno', 'classic rock', 'old school hip hop', 'summer house'])
    assert.equal(tagFacet(g), 'genre', `${g} is a genre`);
});

test('punctuation and case do not change the answer', () => {
  assert.equal(tagFacet('Feel-Good'), 'mood');
  assert.equal(tagFacet('OLD_SCHOOL'), 'era');
  assert.equal(tagFacet('  Road   Trip '), 'occasion');
});

test('anything unrecognised falls through to genre, never to noise', () => {
  // Being wrong toward genre costs the status quo; being wrong away from it
  // throws away real signal. So the default has to be genre.
  assert.equal(tagFacet('hardgroove'), 'genre');
  assert.equal(tagFacet('shoegaze'), 'genre');
  assert.equal(tagFacet('nyc ballroom'), 'genre');
});

const oneArtist = tags => ({ id: 't', name: 't', artists: [{ id: 'a', name: 'a' }] });
const tagged = list => ({ a: { name: 'a', tags: list.map(t => [t, 100]) } });

test('asked about genre, a mood tag counts for a fraction of what a genre tag does', () => {
  const tags = tagged(['house', 'chill']);
  const v = axisVec(oneArtist(), tags, 'genre');
  assert.ok(v.get('chill') < v.get('house') * 0.25,
    `"chill" should barely register against "house" (got ${v.get('chill')} vs ${v.get('house')})`);
});

test('asked about mood, the same two tags swap places', () => {
  const tags = tagged(['house', 'chill']);
  const v = axisVec(oneArtist(), tags, 'mood');
  assert.ok(v.get('chill') > v.get('house'), 'feel leads, but sound is still there underneath');
  assert.ok(v.get('house') > 0, 'an artist with no mood tags at all must still score on what it has');
});

test('with no axis in play it is exactly the old flat vector', () => {
  const tags = tagged(['house', 'chill', '90s']);
  assert.deepEqual([...axisVec(oneArtist(), tags, null)], [...trackVec(oneArtist(), tags)]);
  assert.deepEqual([...axisVec(oneArtist(), tags, 'event')], [...trackVec(oneArtist(), tags)],
    'an axis that receives no suggestions is never re-weighted either');
});

test('nothing is ever dropped to zero, so a thin tag set still scores', () => {
  const tags = tagged(['chill', 'party', '90s', 'british']);   // not one genre tag
  const v = axisVec(oneArtist(), tags, 'genre');
  assert.equal(v.size, 4, 'every tag survives, just quietly');
  assert.ok([...v.values()].every(x => x > 0));
});

test('facetMix says what a playlist is actually made of', () => {
  const tags = { a: { tags: [['house', 100], ['techno', 100]] },
                 b: { tags: [['chill', 100], ['mellow', 100]] } };
  const tracks = [{ id: '1', artists: [{ id: 'a' }] }, { id: '2', artists: [{ id: 'b' }] }];
  const mix = facetMix(tracks, tags);
  assert.equal(mix.tracks, 2);
  assert.ok(Math.abs(mix.genre - 0.5) < 1e-9);
  assert.ok(Math.abs(mix.mood - 0.5) < 1e-9);
  assert.equal(mix.era, 0);
});

test('a playlist whose artists carry no tags at all reports nothing rather than guessing', () => {
  const mix = facetMix([{ id: '1', artists: [{ id: 'unknown' }] }], {});
  assert.equal(mix.tracks, 0);
  assert.equal(mix.genre, 0);
});

/* ---- what it is actually for ---- */

const HOUSE = ['house', 'deep house', 'four to the floor'];
const JUNGLE = ['jungle', 'breakbeat', 'amen break'];
// Tags both buckets share that say nothing about either one's sound: a feel,
// a decade, a night out, a passport.
const SHARED = ['chill', '90s', 'party', 'british'];

function library() {
  const tags = {}, playlists = [];
  for (const [id, name, vocab] of [['p-house', 'House', HOUSE], ['p-jungle', 'Jungle', JUNGLE]]) {
    const tracks = [];
    for (let i = 0; i < 12; i++) {
      const a = `${id}-a${i}`;
      tags[a] = { name: a, tags: [...vocab, ...SHARED].map(t => [t, 90]) };
      tracks.push({ id: `${id}-t${i}`, name: `${id}-t${i}`, artists: [{ id: a, name: a }] });
    }
    playlists.push({ id, name, tracks });
  }
  // One jungle track filed in House by mistake.
  playlists[0].tracks[0] = { id: 'misfit', name: 'misfit', artists: [{ id: 'p-jungle-a0', name: 'p-jungle-a0' }] };
  return { lib: { playlists }, tags };
}

const targets = new Set(['p-house', 'p-jungle']);
const genre = () => 'genre';

test('a misfile that a shared mood and decade used to hide is now the clearest case there is', () => {
  // Measured on this fixture: reading every tag as genre evidence scored the
  // jungle track 0.499 "at home" in House — purely because both buckets are
  // tagged chill / 90s / party / british — for a margin of 2.0 and the lowest
  // confidence band. Weighing the genre tags properly puts it at 0.085.
  const { lib, tags } = library();
  const { profiles, idf } = buildProfiles(lib, tags, targets, genre);
  const hit = findMisfiled(lib, tags, targets, profiles, idf, genre).find(m => m.track.id === 'misfit');

  assert.ok(hit, 'the jungle track in the house playlist is flagged');
  assert.equal(hit.suggest[0].id, 'p-jungle');
  assert.equal(hit.confidence, 'high');
  assert.ok(hit.ownScore < 0.12, `it should look nothing like home (got ${hit.ownScore})`);
});

test('on the mood axis those same shared tags are the ones that carry', () => {
  // Mirror image, and the reason the weights are per-axis rather than one
  // global cleanup: read as mood playlists, these two buckets are largely the
  // same playlist, so the jungle track mostly belongs where it is. It goes
  // from 0.085 at home and the top confidence band to 0.62 and the bottom one
  // — the same track, the same tags, a different question.
  const { lib, tags } = library();
  const mood = () => 'mood';
  const { profiles, idf } = buildProfiles(lib, tags, targets, mood);
  const hit = findMisfiled(lib, tags, targets, profiles, idf, mood).find(m => m.track.id === 'misfit');
  assert.ok(!hit || (hit.ownScore > 0.5 && hit.confidence === 'low'),
    `nothing like the clear-cut case it is on the genre axis (got ${hit && hit.ownScore})`);
});

test('a track is scored against its home the same way it is scored against the alternatives', () => {
  // Both halves of the misfile margin have to come off one scale, or the
  // number being compared is meaningless.
  const { lib, tags } = library();
  const { profiles, idf } = buildProfiles(lib, tags, targets, genre);
  const hit = findMisfiled(lib, tags, targets, profiles, idf, genre).find(m => m.track.id === 'misfit');
  const v = applyIdf(axisVec(lib.playlists[0].tracks[0], tags, 'genre'), idf);
  assert.ok(Math.abs(cosine(v, profiles.get('p-house').vec) - hit.ownScore) < 1e-9);
  assert.ok(Math.abs(cosine(v, profiles.get('p-jungle').vec) - hit.suggest[0].score) < 1e-9);
});
