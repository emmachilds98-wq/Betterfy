import { test } from 'node:test';
import assert from 'node:assert/strict';

import { uncoveredGenres, splitCandidates, artistGenre, trackGenre, playlistGenres, conceptLabel,
         MIN_GAP, GAPS_VERSION } from '../core/recommend/gaps.mjs';

/* Artists by genre, with Last.fm-shaped tag clouds: [[tag, count], …], strongest first. */
const TAGS = {
  bl: [['bassline', 100], ['uk garage', 60]],
  ukg: [['uk garage', 100], ['2 step', 70]],
  jun: [['jungle', 100], ['drum and bass', 80]],
  dnb: [['drum and bass', 100], ['liquid funk', 30]],
  donk: [['donk', 100], ['hard house', 50]],
  moody: [['british', 100], ['90s', 80], ['chill', 60]],      // no genre at all
  jazz: [['jazz', 100], ['bebop', 50]],
  folk: [['folk', 100], ['singer-songwriter', 80]],
};
const tagsOf = id => TAGS[id.split('-')[0]] ?? [];

let n = 0;
const tracks = (artist, k) => Array.from({ length: k }, () => ({ id: `t${n++}`, name: `Track ${n}`,
  artists: [{ id: `${artist}-${n % 3}`, name: `${artist} ${n % 3}` }] }));

test('labels read like playlist names', () => {
  assert.equal(conceptLabel('drum-and-bass'), 'Drum & Bass');
  assert.equal(conceptLabel('uk-garage'), 'UK Garage');
  assert.equal(conceptLabel('hard-house'), 'Hard House');
  assert.equal(conceptLabel('rnb'), 'R&B');
});

test('an artist\'s genre is their strongest tag the ontology reads as a genre, or nothing', () => {
  assert.equal(artistGenre(TAGS.bl), 'bassline');
  assert.equal(artistGenre(TAGS.moody), null, 'british, 90s and chill are not genres');
  assert.equal(artistGenre([]), null);
  // A correction appended at the end, at a high count, still leads.
  assert.equal(artistGenre([['jazz', 20], ['folk', 90]]), 'folk');
  // A featured artist with a genre stands in when the lead has none.
  assert.equal(trackGenre({ artists: [{ id: 'moody-1' }, { id: 'jun-1' }] }, tagsOf), 'jungle');
});

test('playlist names are read through the vocabulary, any spelling', () => {
  assert.ok(playlistGenres('D&B Rollers').includes('drum-and-bass'));
  assert.ok(playlistGenres('UKG').includes('uk-garage'));
  assert.deepEqual(playlistGenres('Sunday'), []);
});

test('a genre you have music in and no genre playlist for is proposed, at the level you would name it', () => {
  const liked = [...tracks('bl', 20), ...tracks('ukg', 4), ...tracks('dnb', 3)];
  const lib = { liked, playlists: [{ id: 'p-dnb', name: 'Drum & Bass', tracks: tracks('dnb', 30) }] };
  const out = uncoveredGenres({ lib, targets: ['p-dnb'], tagsOf });
  assert.equal(out.version, GAPS_VERSION);
  assert.deepEqual(out.gaps.map(g => g.label), ['Bassline'],
    'twenty bassline tracks are Bassline, not swallowed by UK Garage or Electronic');
  assert.equal(out.gaps[0].size, 20);
  assert.ok(out.covered.includes('drum-and-bass'));
});

test('a broader genre is proposed for what its specific ones leave over, if that is still enough', () => {
  const liked = [...tracks('bl', 15), ...tracks('ukg', 14)];
  const out = uncoveredGenres({ lib: { liked, playlists: [] }, targets: [], tagsOf });
  assert.deepEqual(out.gaps.map(g => [g.label, g.size]).sort(), [['Bassline', 15], ['UK Garage', 14]]);
});

test('a genre a playlist names is covered; one only under a broader playlist is offered, marked as such', () => {
  // Liked drum & bass with a "Drum & Bass" playlist: covered, nothing to propose.
  const lib0 = { liked: tracks('dnb', 20), playlists: [{ id: 'p', name: 'Drum & Bass', tracks: tracks('dnb', 10) }] };
  assert.deepEqual(uncoveredGenres({ lib: lib0, targets: ['p'], tagsOf }).gaps, []);
  // Twenty jungle tracks: "Drum & Bass" could take them, but they are a genre of their own.
  const lib = { liked: tracks('jun', 20), playlists: [{ id: 'p', name: 'Drum & Bass', tracks: tracks('dnb', 10) }] };
  const [g] = uncoveredGenres({ lib, targets: ['p'], tagsOf }).gaps;
  assert.deepEqual([g.label, g.within, g.withinLabel], ['Jungle', 'drum-and-bass', 'Drum & Bass']);
  // "Jungle" never covers drum & bass, which sits above it.
  const lib2 = { liked: tracks('dnb', 20), playlists: [{ id: 'p', name: 'Jungle', tracks: tracks('jun', 10) }] };
  const [h] = uncoveredGenres({ lib: lib2, targets: ['p'], tagsOf }).gaps;
  assert.deepEqual([h.label, h.within], ['Drum & Bass', null]);
});

test('donk is not swallowed by a House playlist', () => {
  const lib = { liked: [...tracks('donk', 15), ...tracks('folk', 15)],
                playlists: [{ id: 'p', name: 'House', tracks: tracks('dnb', 3) }] };
  const out = uncoveredGenres({ lib, targets: ['p'], tagsOf });
  assert.deepEqual(out.gaps.map(g => [g.label, g.withinLabel]), [['Folk', null], ['Donk', 'House']],
    'uncovered first, then the one a broader playlist could take');
});

test('only genre playlists cover anything, and tracks already in one are not a gap', () => {
  const donk = tracks('donk', 15);
  // In a playlist named "Donk" that is NOT one of the genre playlists: still a gap.
  const lib = { liked: [], playlists: [{ id: 'p', name: 'Donk', tracks: donk }] };
  assert.deepEqual(uncoveredGenres({ lib, targets: [], tagsOf }).gaps.map(g => g.label), ['Donk']);
  // Already in a genre playlist, whatever it is called: it has a home.
  const lib2 = { liked: [], playlists: [{ id: 'p', name: 'Bangers', tracks: donk }] };
  assert.deepEqual(uncoveredGenres({ lib: lib2, targets: ['p'], tagsOf }).gaps, []);
});

test('what you are playing comes first, among gaps and within one', () => {
  const lib = { liked: [...tracks('folk', 30), ...tracks('donk', 15)], playlists: [] };
  const active = new Set(['donk 0', 'donk 1', 'donk 2']);
  const out = uncoveredGenres({ lib, targets: [], tagsOf, active });
  assert.equal(out.gaps[0].label, 'Donk', 'fifteen tracks being played beat thirty that are not');
  assert.equal(out.gaps[0].played, 15);
});

test('too few tracks is not a gap, and untagged artists are counted, not guessed', () => {
  const lib = { liked: [...tracks('jazz', MIN_GAP - 1), ...tracks('moody', 40)], playlists: [] };
  const out = uncoveredGenres({ lib, targets: [], tagsOf });
  assert.deepEqual(out.gaps, []);
  assert.equal(out.untagged, 40);
});

test('the same code serves a completely different account', () => {
  // Nothing about the owner's scene: a folk and jazz listener with one genre playlist.
  const lib = { liked: [...tracks('folk', 25), ...tracks('jazz', 18)],
                playlists: [{ id: 'p-j', name: 'Jazz Standards', tracks: tracks('jazz', 12) }] };
  const out = uncoveredGenres({ lib, targets: ['p-j'], tagsOf });
  assert.deepEqual(out.gaps.map(g => g.label), ['Folk']);
});

/* ---------- splits ---------- */

test('a playlist holding two genres side by side is offered as a split', () => {
  const lib = { playlists: [{ id: 'p', name: 'Weekend', tracks: [...tracks('dnb', 14), ...tracks('donk', 12)] }] };
  const out = splitCandidates({ lib, targets: ['p'], tagsOf });
  assert.equal(out.splits.length, 1);
  assert.deepEqual(out.splits[0].parts.map(x => [x.label, x.size]).sort(), [['Donk', 12], ['Drum & Bass', 14]]);
  assert.equal(out.splits[0].nested, false);
});

test('one genre inside another splits as "it" and "the rest" — bassline out of UK garage', () => {
  const lib = { playlists: [{ id: 'p', name: 'Bass', tracks: [...tracks('ukg', 16), ...tracks('bl', 12)] }] };
  const s = splitCandidates({ lib, targets: ['p'], tagsOf }).splits[0];
  assert.ok(s, 'a sibling-only rule never sees this one');
  assert.equal(s.nested, true);
  const [outer, inner] = s.parts;
  assert.deepEqual([outer.label, outer.rest, outer.size], ['UK Garage', true, 16]);
  assert.deepEqual([inner.label, inner.rest, inner.size], ['Bassline', false, 12]);
  assert.equal(new Set([...outer.ids, ...inner.ids]).size, 28, 'the halves do not overlap');
});

test('a playlist that is one genre, or only a sliver of another, is left alone', () => {
  const one = { playlists: [{ id: 'p', name: 'DnB', tracks: [...tracks('dnb', 20), ...tracks('jun', 3)] }] };
  assert.deepEqual(splitCandidates({ lib: one, targets: ['p'], tagsOf }).splits, []);
  const small = { playlists: [{ id: 'p', name: 'Mixed', tracks: [...tracks('dnb', 6), ...tracks('donk', 6)] }] };
  assert.deepEqual(splitCandidates({ lib: small, targets: ['p'], tagsOf }).splits, [], 'too small to be worth splitting');
  // And only genre playlists are looked at.
  const notGenre = { playlists: [{ id: 'p', name: 'Weekend', tracks: [...tracks('dnb', 14), ...tracks('donk', 12)] }] };
  assert.deepEqual(splitCandidates({ lib: notGenre, targets: [], tagsOf }).splits, []);
});

test('the playlist\'s own name is noted, so the wording can say what is drifting in', () => {
  const lib = { playlists: [{ id: 'p', name: 'Jungle', tracks: [...tracks('jun', 15), ...tracks('donk', 11)] }] };
  const s = splitCandidates({ lib, targets: ['p'], tagsOf }).splits[0];
  assert.equal(s.named, 'jungle');
});
