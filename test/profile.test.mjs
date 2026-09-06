import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProfiles, findMisfiled, trackVec, applyIdf, cosine } from '../profile.mjs';

// findMisfiled is the "goes against the pattern of this playlist" check —
// shared between the Node pipeline and the browser build. These exercise it
// directly against a small synthetic library, rather than via a regex on
// bundled source, so a change to the actual decision would be caught here.

// Two vocabularies with no overlap, so cosine between them is exactly 0 and
// cosine within one is exactly 1 — the scores are then a fact about the
// fixture, not something to reverse-engineer from IDF arithmetic.
const HOUSE_TAGS = ['house', 'deep house', 'four to the floor'];
const JUNGLE_TAGS = ['jungle', 'breakbeat', 'amen break'];

const artistTags = (id, vocab) => [id, { name: id, tags: vocab.map(t => [t, 90]) }];

const trk = (id, artistId) => ({ id, name: id, artists: [{ id: artistId, name: artistId }] });

/** n tracks by n distinct artists, all sharing one vocabulary. */
function bucket(prefix, n, vocab) {
  const tags = {};
  const tracks = [];
  for (let i = 0; i < n; i++) {
    const a = `${prefix}-artist-${i}`;
    tags[a] = artistTags(a, vocab)[1];
    tracks.push(trk(`${prefix}-track-${i}`, a));
  }
  return { tags, tracks };
}

function fixture() {
  const house = bucket('house', 12, HOUSE_TAGS);
  const jungle = bucket('jungle', 12, JUNGLE_TAGS);
  const tags = { ...house.tags, ...jungle.tags };
  const lib = { playlists: [
    { id: 'p-house', name: 'House', tracks: house.tracks },
    { id: 'p-jungle', name: 'Jungle', tracks: jungle.tracks },
  ] };
  return { lib, tags };
}

const targets = new Set(['p-house', 'p-jungle']);
const axisOf = () => 'genre'; // both playlists on the same axis in these fixtures

test('a track whose tags match nothing about its own playlist, but everything about another, is flagged high-confidence', () => {
  const { lib, tags } = fixture();
  // Swap one House track for a jungle-tagged one, filed in House by mistake.
  const jungleArtist = 'jungle-artist-0';
  lib.playlists[0].tracks[0] = trk('misfit', jungleArtist);

  const { profiles, idf } = buildProfiles(lib, tags, targets, axisOf);
  const misfiled = findMisfiled(lib, tags, targets, profiles, idf, axisOf);

  const hit = misfiled.find(m => m.track.id === 'misfit');
  assert.ok(hit, 'the mismatched track is flagged');
  assert.equal(hit.playlistId, 'p-house', 'flagged against the playlist it is actually filed in');
  assert.equal(hit.suggest[0].id, 'p-jungle', 'and the suggestion is where it actually fits');
  assert.equal(hit.confidence, 'high', 'zero overlap with home, near-total overlap elsewhere is the clearest case there is');
});

test('a track is never flagged against a playlist on a different axis', () => {
  const { lib, tags } = fixture();
  const jungleArtist = 'jungle-artist-0';
  lib.playlists[0].tracks[0] = trk('misfit', jungleArtist);

  // House stays genre, Jungle is mood — a real mood/genre split, not a
  // vocabulary difference, so rank() must not compare across it.
  const axisSplit = id => (id === 'p-jungle' ? 'mood' : 'genre');
  const { profiles, idf } = buildProfiles(lib, tags, targets, axisSplit);
  const misfiled = findMisfiled(lib, tags, targets, profiles, idf, axisSplit);

  assert.equal(misfiled.find(m => m.track.id === 'misfit'), undefined,
    'no same-axis alternative exists, so nothing to flag it against');
});

test('a playlist outside targets is never treated as a home to misfile from', () => {
  const { lib, tags } = fixture();
  const jungleArtist = 'jungle-artist-0';
  lib.playlists[0].tracks[0] = trk('misfit', jungleArtist);

  // Only Jungle is a filing destination this time; House (holding the
  // mismatched track) is excluded, as a tiny or non-target playlist would be.
  const onlyJungle = new Set(['p-jungle']);
  const { profiles, idf } = buildProfiles(lib, tags, onlyJungle, axisOf);
  const misfiled = findMisfiled(lib, tags, onlyJungle, profiles, idf, axisOf);

  assert.equal(misfiled.length, 0, 'House was never modelled as a destination, so it is never checked as a source either');
});

test('a track with too little tag signal is never flagged, however badly it would score', () => {
  const { lib, tags } = fixture();
  // One tag only — trackVec would carry a single entry, below the v.size >= 3
  // floor that keeps a near-untagged track from generating a confident-looking
  // false positive.
  tags['thin-artist'] = { name: 'thin-artist', tags: [['jungle', 90]] };
  lib.playlists[0].tracks[0] = trk('thin', 'thin-artist');

  const { profiles, idf } = buildProfiles(lib, tags, targets, axisOf);
  const misfiled = findMisfiled(lib, tags, targets, profiles, idf, axisOf);

  assert.equal(misfiled.find(m => m.track.id === 'thin'), undefined, 'one tag is not enough signal to trust');
});

test('an ordinary track that merely leans toward another genre is not flagged as noise', () => {
  const { lib, tags } = fixture();
  // A House track tagged with a blend of both vocabularies — closer to home
  // than to Jungle, so this is normal library overlap, not a misfile.
  tags['blend-artist'] = { name: 'blend-artist',
    tags: [...HOUSE_TAGS.map(t => [t, 90]), ...JUNGLE_TAGS.map(t => [t, 20])] };
  lib.playlists[0].tracks[0] = trk('blend', 'blend-artist');

  const { profiles, idf } = buildProfiles(lib, tags, targets, axisOf);
  const misfiled = findMisfiled(lib, tags, targets, profiles, idf, axisOf);

  assert.equal(misfiled.find(m => m.track.id === 'blend'), undefined,
    'still fits its own playlist best, so the margin test correctly lets it through');
});

test('high-confidence outranks a milder mismatch in the sorted result', () => {
  const { lib, tags } = fixture();
  // A clean swap (zero overlap with home) alongside a mild one (some overlap
  // with home, so a smaller margin) — both should be flagged, but the clean
  // one first.
  lib.playlists[0].tracks[0] = trk('clean-swap', 'jungle-artist-0');
  tags['mild-artist'] = { name: 'mild-artist',
    tags: [...HOUSE_TAGS.slice(0, 1).map(t => [t, 15]), ...JUNGLE_TAGS.map(t => [t, 90])] };
  lib.playlists[0].tracks[1] = trk('mild-swap', 'mild-artist');

  const { profiles, idf } = buildProfiles(lib, tags, targets, axisOf);
  const misfiled = findMisfiled(lib, tags, targets, profiles, idf, axisOf);
  const ids = misfiled.map(m => m.track.id);

  assert.ok(ids.includes('clean-swap') && ids.includes('mild-swap'), 'both are flagged');
  assert.ok(ids.indexOf('clean-swap') < ids.indexOf('mild-swap'),
    'the total mismatch is a more confident call than the partial one, and sorts first');
});

test('a home playlist with no profile at all (nothing tagged) is skipped, not thrown on', () => {
  const lib = { playlists: [
    { id: 'p-empty', name: 'Untagged', tracks: [trk('t1', 'nobody')] },
    ...fixture().lib.playlists,
  ] };
  const tags = { ...fixture().tags }; // 'nobody' has no entry at all
  const { profiles, idf } = buildProfiles(lib, tags, new Set(['p-empty', ...targets]), axisOf);

  assert.doesNotThrow(() => findMisfiled(lib, tags, new Set(['p-empty', ...targets]), profiles, idf, axisOf));
});
