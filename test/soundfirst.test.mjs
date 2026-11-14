import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fixture, FAMILIES } from './fixtures/engine-library.mjs';
import { buildSpace, placements, SOUND_FIRST_WEIGHTS, WEIGHTS } from '../core/intrinsic/space.mjs';
import { cooccurrence } from '../core/intrinsic/cooccurrence.mjs';
import { placementAccuracy } from '../core/validate/loo.mjs';
import { makeRecord, N_STYLES, EMB_DIM } from '../core/audio/record.mjs';

/*
 * Sound-first filing (the owner's call, 2026-11-14): what a track sounds like
 * decides where it goes; who you file together only breaks ties, and only
 * genre playlists teach who goes together, so a mood or event playlist cannot.
 */
const LIB = fixture();
const TARGETS = FAMILIES.map(f => `p-${f}`);

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5;
}
const familyDir = fam => { const r = rng(1 + FAMILIES.indexOf(fam) * 7919); return Float32Array.from({ length: EMB_DIM }, r); };
function recordFor(id, fam = id.split('-')[0]) {
  const dir = familyDir(fam), r = rng([...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7));
  const activations = new Float32Array(N_STYLES).fill(0.01);
  activations[(id.length * 13) % N_STYLES] = 0.8;
  return makeRecord({ id, isrc: 'GBXXX0000001', activations, embeddings: Float32Array.from(dir, v => v + 0.6 * r()),
                      patches: 1, source: { kind: 'deezer-isrc', deezerId: 1, windows: [[0, 165000]], seconds: 10 },
                      mel: '1.0.0', at: 1000 });
}

/* ---------- only genre playlists teach who goes together ---------- */

test('the artist graph can learn from chosen playlists only', () => {
  // tech and jungle artists meet only in "Bangers", a crossover playlist.
  const all = cooccurrence(LIB);
  const genreOnly = cooccurrence(LIB, { only: new Set(TARGETS) });
  const n = g => g.ppmi.get('tech-a0')?.size ?? 0;
  assert.ok(n(all) > n(genreOnly), 'a crossover playlist adds neighbours the genre playlists alone do not');
  assert.ok(genreOnly.playlists <= TARGETS.length);
  assert.ok(genreOnly.playlists < all.playlists);
});

test('a space built with genreGraph learns only from the genre playlists; without it, nothing changes', () => {
  const plain = buildSpace(LIB, { targets: TARGETS });
  const same = buildSpace(LIB, { targets: TARGETS, genreGraph: false });
  assert.equal(plain.graph.playlists, same.graph.playlists);
  const g = buildSpace(LIB, { targets: TARGETS, genreGraph: true });
  assert.ok(g.graph.playlists <= TARGETS.length);
  assert.ok(g.graph.playlists < plain.graph.playlists);
});

/* ---------- sound leads for a heard track ---------- */

test('a heard track is placed by its sound, even when its artists point somewhere else', () => {
  // Every track is heard as its own family, except one tech track that sounds like jungle.
  const odd = LIB.all.find(t => t.id === 'tech-t3');
  const records = LIB.all.map(t => recordFor(t.id, t.id === odd.id ? 'jungle' : t.id.split('-')[0]));
  const space = buildSpace(LIB, { targets: TARGETS, audio: records, genreGraph: true, skip: new Set([odd.id]) });
  const byArtists = placements(odd, space, { limit: 3 });
  const bySound = placements(odd, space, { limit: 3, soundFirst: true });
  assert.equal(byArtists.results[0].playlistId, 'p-tech', 'its artists say tech');
  assert.equal(bySound.results[0].playlistId, 'p-jungle', 'its sound says jungle, and sound leads');
  assert.ok('learned' in bySound.results[0].parts || 'audio' in bySound.results[0].parts);
});

test('sound-first is exactly useAudio with the sound-first weights, for a heard track', () => {
  const records = LIB.all.map(t => recordFor(t.id));
  const space = buildSpace(LIB, { targets: TARGETS, audio: records, genreGraph: true });
  const t = LIB.all[5];
  assert.deepEqual(placements(t, space, { limit: 5, soundFirst: true }),
                   placements(t, space, { limit: 5, useAudio: true, weights: SOUND_FIRST_WEIGHTS }));
});

test('an unheard track is scored exactly as before', () => {
  const records = LIB.all.filter((_, i) => i % 2).map(t => recordFor(t.id));
  const space = buildSpace(LIB, { targets: TARGETS, audio: records, genreGraph: true });
  const unheard = LIB.all.find((_, i) => i % 2 === 0);
  assert.deepEqual(placements(unheard, space, { limit: 5, soundFirst: true }), placements(unheard, space, { limit: 5 }));
});

test('sound-first weights let sound lead and keep artists as a tie-breaker', () => {
  const w = SOUND_FIRST_WEIGHTS;
  assert.ok(w.learned + w.audio > 3 * w.graph, 'sound carries far more weight than the artist graph');
  assert.ok(w.graph > 0, 'but who you file together still counts');
  for (const k of Object.keys(w)) assert.ok(k in WEIGHTS, `${k} is a component the engine knows`);
});

/* ---------- the Score run measures what ships ---------- */

test('the Score run can measure the shipped setup: genre-only graph and sound-first weights', () => {
  const records = LIB.all.map(t => recordFor(t.id));
  const base = placementAccuracy(LIB, { folds: 3, targets: TARGETS, audio: records });
  const shipped = placementAccuracy(LIB, { folds: 3, targets: TARGETS, audio: records,
                                           genreGraph: true, soundWeights: SOUND_FIRST_WEIGHTS });
  assert.ok(shipped.withAudio, 'the sound variant is reported');
  assert.equal(shipped.scored, base.scored, 'same tracks, so the two are comparable');
  assert.ok(Number.isFinite(shipped.withAudio.top1));
});

/* ---------- tracks heard after the space was built ---------- */

test('hearMore makes a track heard after the build scorable by sound, without retraining', async () => {
  const { hearMore } = await import('../core/intrinsic/space.mjs');
  const odd = LIB.all.find(t => t.id === 'tech-t3');
  const records = LIB.all.filter(t => t.id !== odd.id).map(t => recordFor(t.id));
  const space = buildSpace(LIB, { targets: TARGETS, audio: records, genreGraph: true, skip: new Set([odd.id]) });
  const before = placements(odd, space, { limit: 3, soundFirst: true });
  assert.ok(!before.results.some(r => r.heard), 'not heard yet: no sound on any row');
  const profiles = space.audio.profiles;

  assert.equal(hearMore(space, [recordFor(odd.id, 'jungle')]), 1);
  assert.equal(space.audio.profiles, profiles, 'the playlists’ sound is not rebuilt');
  const after = placements(odd, space, { limit: 3, soundFirst: true });
  assert.equal(after.results[0].playlistId, 'p-jungle', 'now heard, it is placed by how it sounds');
  assert.ok('learned' in after.results[0].parts, 'and the learner can read it too');

  assert.equal(hearMore(space, [recordFor(odd.id, 'tech')]), 0, 'a track already in the index is kept');
  assert.equal(hearMore(space, [{ id: 'x', miss: 'no-preview' }]), 0, 'a miss adds nothing');
  assert.equal(hearMore({}, records), 0, 'a space with no sound layer is left alone');
});
