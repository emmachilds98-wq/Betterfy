import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audioQueue } from '../core/audio/queue.mjs';
import { RECORD_VERSION, MODEL, MISS, MISS_TTL_MS, makeMiss } from '../core/audio/record.mjs';
import { listeningWeights } from '../profile.mjs';

const MEL = 'mel-test-1';
const NOW = 1_800_000_000_000;

const trk = (id, artist = `a-${id}`) => ({ id, name: id, artists: [{ id: artist, name: artist }] });
const pl = (id, tracks) => ({ id, name: id, tracks });

// A stored record only needs the fields isCurrent() reads.
const current = id => ({ v: RECORD_VERSION, id, model: MODEL, mel: MEL, at: NOW, styles: [[0, 0.5]] });

/*
 * One fixture with something in every tier:
 *   played:   'hot' by an artist Spotify says is being played
 *   unfiled:  'loose' liked and in no playlist
 *   untagged: 'quiet' by an untagged artist, filed
 *   genre:    'g0'..'g5' in a genre playlist
 *   rest:     'm0' in a mood playlist (not a target)
 */
function fixture() {
  const hot = trk('hot', 'Hot Artist');
  const loose = trk('loose');
  const quiet = trk('quiet', 'Quiet Artist');
  const g = Array.from({ length: 6 }, (_, i) => trk(`g${i}`));
  const m0 = trk('m0');
  const lib = {
    liked: [loose, hot],
    playlists: [pl('p-genre', [...g, quiet, hot]), pl('p-mood', [m0])],
  };
  const listening = { weights: new Map([['Hot Artist', 3]]), recentlyActive: new Set(['Hot Artist']) };
  return { lib, listening, untaggedArtistIds: new Set(['Quiet Artist']), targets: ['p-genre'] };
}

test('orders played, unfiled liked, untagged artists, genre exemplars, then everything else', () => {
  const { lib, listening, untaggedArtistIds, targets } = fixture();
  const q = audioQueue(lib, { listening, untaggedArtistIds, targets, exemplarsPerPlaylist: 3, mel: MEL, now: NOW });
  // p-genre already has 'hot' and 'quiet' queued above, so one more exemplar.
  assert.deepEqual(q.slice(0, 4), ['hot', 'loose', 'quiet', 'g0']);
  assert.deepEqual(q.slice(4).sort(), ['g1', 'g2', 'g3', 'g4', 'g5', 'm0']);
  assert.equal(q.length, 10);
});

test('each id appears once even when it qualifies for several tiers', () => {
  const { lib, listening, untaggedArtistIds, targets } = fixture();
  // 'hot' is liked, played and in a playlist; add it to the other playlist and liked twice.
  lib.playlists[1].tracks.push(trk('hot', 'Hot Artist'));
  lib.liked.push(trk('hot', 'Hot Artist'));
  const q = audioQueue(lib, { listening, untaggedArtistIds, targets, mel: MEL, now: NOW });
  assert.equal(new Set(q).size, q.length);
  assert.equal(q.filter(id => id === 'hot').length, 1);
});

test('within a tier, most-listened artists come first, ties keep library order', () => {
  const lib = { liked: [trk('x', 'Low'), trk('y', 'High'), trk('z', 'Nobody'), trk('w', 'Nobody2')], playlists: [] };
  const listening = { weights: new Map([['Low', 0.2], ['High', 0.9]]), recentlyActive: new Set() };
  assert.deepEqual(audioQueue(lib, { listening, mel: MEL, now: NOW }), ['y', 'x', 'z', 'w']);
});

test('the library floor alone does not make a track "being played"', () => {
  // listeningWeights with no top/recent: every artist gets only the floor (<= 1).
  const a = trk('filed-a', 'Filed A'), b = trk('liked-b', 'Liked B');
  const lib = { liked: [b], playlists: [pl('p', [a, a, a])] };
  const weights = listeningWeights({ libraryArtists: ['Filed A', 'Filed A', 'Filed A', 'Liked B'] });
  const q = audioQueue(lib, { listening: { weights, recentlyActive: new Set() }, targets: [], mel: MEL, now: NOW });
  // The unfiled liked song outranks a heavily *filed* artist nobody is shown to play.
  assert.deepEqual(q, ['liked-b', 'filed-a']);
});

test('a top-artist weight above the floor counts as played without recentlyActive', () => {
  const lib = { liked: [trk('l')], playlists: [pl('p', [trk('t', 'Long Term Fave')])] };
  const weights = listeningWeights({ topWindows: [{ weight: 1.5, items: ['Long Term Fave'] }], libraryArtists: ['Long Term Fave'] });
  assert.deepEqual(audioQueue(lib, { listening: weights, targets: [], mel: MEL, now: NOW }), ['t', 'l']);
});

test('ids with a current record or an unexpired miss are skipped', () => {
  const { lib, listening, untaggedArtistIds, targets } = fixture();
  const store = new Map([['hot', current('hot')], ['loose', makeMiss({ id: 'loose', reason: MISS.NOT_ON_DEEZER, at: NOW - 1000 })]]);
  const q = audioQueue(lib, { listening, untaggedArtistIds, targets, store, mel: MEL, now: NOW });
  assert.ok(!q.includes('hot') && !q.includes('loose'));
  assert.equal(q[0], 'quiet');
});

test('the store may be a plain object', () => {
  const { lib, listening, targets } = fixture();
  const q = audioQueue(lib, { listening, targets, store: { hot: current('hot') }, mel: MEL, now: NOW });
  assert.ok(!q.includes('hot'));
});

test('stale records are queued again: old model, old mel, old record version, expired miss', () => {
  const { lib, listening, untaggedArtistIds, targets } = fixture();
  const store = new Map([
    ['hot', { ...current('hot'), model: 'some-older-model' }],
    ['loose', makeMiss({ id: 'loose', reason: MISS.NO_PREVIEW, at: NOW - MISS_TTL_MS - 1 })],
    ['quiet', { ...current('quiet'), mel: 'mel-old' }],
    ['g0', { ...current('g0'), v: RECORD_VERSION - 1 }],
  ]);
  const q = audioQueue(lib, { listening, untaggedArtistIds, targets, store, exemplarsPerPlaylist: 3, mel: MEL, now: NOW });
  // Stale ones keep their natural tier, not pushed to the back.
  assert.deepEqual(q.slice(0, 4), ['hot', 'loose', 'quiet', 'g0']);
});

test('without a mel version, a record of the current model counts as current', () => {
  const { lib, listening, targets } = fixture();
  const store = new Map([['hot', { ...current('hot'), mel: 'anything' }]]);
  assert.ok(!audioQueue(lib, { listening, targets, store, now: NOW }).includes('hot'));
});

test('budget truncates in priority order', () => {
  const { lib, listening, untaggedArtistIds, targets } = fixture();
  const opts = { listening, untaggedArtistIds, targets, exemplarsPerPlaylist: 3, mel: MEL, now: NOW };
  const full = audioQueue(lib, opts);
  for (const budget of [0, 1, 3, 5, 100]) assert.deepEqual(audioQueue(lib, { ...opts, budget }), full.slice(0, budget));
});

test('budget counts only ids queued, not ones skipped as current', () => {
  const { lib, listening, untaggedArtistIds, targets } = fixture();
  const store = new Map([['hot', current('hot')]]);
  const q = audioQueue(lib, { listening, untaggedArtistIds, targets, store, budget: 2, mel: MEL, now: NOW });
  assert.deepEqual(q, ['loose', 'quiet']);
});

test('exemplars are capped per genre playlist, round-robin, spread through each playlist', () => {
  const big = Array.from({ length: 40 }, (_, i) => trk(`b${i}`));
  const small = Array.from({ length: 3 }, (_, i) => trk(`s${i}`));
  const lib = { liked: [], playlists: [pl('p-big', big), pl('p-small', small), pl('p-mood', [trk('m')])] };
  const q = audioQueue(lib, { targets: ['p-big', 'p-small'], exemplarsPerPlaylist: 4, filedIds: libIds(lib), mel: MEL, now: NOW });
  // Tier 4 is the first 4 + 3 ids: alternating, big spaced every 10 tracks.
  assert.deepEqual(q.slice(0, 7), ['b0', 's0', 'b10', 's1', 'b20', 's2', 'b30']);
  // Everything is still queued eventually, once.
  assert.equal(q.length, 44);
  assert.equal(new Set(q).size, 44);
});

test('the default exemplar cap is 20, and already-heard tracks count toward it', () => {
  const big = Array.from({ length: 50 }, (_, i) => trk(`b${i}`));
  // A second playlist so p-big is not most of the library (that would make it a mirror).
  const other = Array.from({ length: 50 }, (_, i) => trk(`o${i}`));
  const lib = { liked: [], playlists: [pl('p-big', big), pl('p-other', other)] };
  const store = new Map(big.slice(0, 15).map(t => [t.id, current(t.id)]));
  const opts = { targets: ['p-big'], store, mel: MEL, now: NOW };
  // 15 heard: 5 more exemplars, then the rest in library order.
  const q = audioQueue(lib, opts);
  assert.equal(q.length, 85);
  assert.deepEqual(q.slice(0, 5), ['b15', 'b22', 'b29', 'b36', 'b43']);
  // Nothing heard: 20 exemplars evenly through 50 tracks.
  const q2 = audioQueue(lib, { ...opts, store: null });
  assert.deepEqual(q2.slice(0, 3), ['b0', 'b2', 'b5']);
});

test('only genre playlists get exemplars; without targets every non-mirror playlist does', () => {
  const lib = { liked: [], playlists: [pl('p-genre', [trk('g0'), trk('g1')]), pl('p-mood', [trk('m0'), trk('m1')])] };
  const withTargets = audioQueue(lib, { targets: ['p-genre'], exemplarsPerPlaylist: 1, mel: MEL, now: NOW });
  assert.equal(withTargets[0], 'g0');
  assert.deepEqual(withTargets.slice(1), ['g1', 'm0', 'm1']);
  const without = audioQueue(lib, { exemplarsPerPlaylist: 1, mel: MEL, now: NOW });
  assert.deepEqual(without.slice(0, 2), ['g0', 'm0']);
});

test('a mirror playlist neither counts as filing nor gets exemplars', () => {
  const liked = [trk('l0'), trk('l1')];
  const lib = { liked, playlists: [pl('all-songs', [...liked, trk('x')]), pl('p-genre', [trk('g0')])] };
  const isMirror = p => p.id === 'all-songs';
  const q = audioQueue(lib, { isMirror, exemplarsPerPlaylist: 5, mel: MEL, now: NOW });
  // Liked songs only in the mirror are still unfiled; tracks only in the mirror are not in the library.
  assert.deepEqual(q, ['l0', 'l1', 'g0']);
});

test('local files and id-less tracks are never queued; empty input is an empty queue', () => {
  const lib = { liked: [{ id: null, name: 'x' }, { id: 'loc', is_local: true, artists: [] }, trk('ok')], playlists: [] };
  assert.deepEqual(audioQueue(lib, { mel: MEL, now: NOW }), ['ok']);
  assert.deepEqual(audioQueue({}, {}), []);
  assert.deepEqual(audioQueue(null), []);
});

test('pure: the inputs are not modified', () => {
  const { lib, listening, untaggedArtistIds, targets } = fixture();
  const before = JSON.stringify(lib);
  const store = new Map([['hot', current('hot')]]);
  audioQueue(lib, { listening, untaggedArtistIds, targets, store, mel: MEL, now: NOW });
  assert.equal(JSON.stringify(lib), before);
  assert.equal(store.size, 1);
});

function libIds(lib) {
  return new Set(lib.playlists.flatMap(p => p.tracks.map(t => t.id)));
}
