// Smart "Fill this playlist" (docs/archive/BUILD-6-PLAN.md F2, M4): the ranking and its
// gate, Fill recall@10. Synthetic, deterministic fixtures only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fillModel, fillRank, fillRecall, fillGate, FILL } from '../core/recommend/fill.mjs';
import { foldOf } from '../core/validate/loo.mjs';
import { makeAccount } from './fixtures/accounts.mjs';
import { shapedLibrary } from './fixtures/shaped-library.mjs';
import { soundRecord } from './fixtures/sound-library.mjs';

const TAGS = JSON.parse(readFileSync(new URL('../docs/tags.json', import.meta.url), 'utf8'));

function rng(seed) { let s = seed; return () => (s = (s * 16807) % 2147483647) / 2147483647; }

/** Four "scenes", each a playlist of 30 tracks from its own 8 artists, plus a liked pile of unfiled tracks. */
function sceneLibrary({ seed = 7 } = {}) {
  const r = rng(seed);
  let n = 0;
  const track = (artist, year) => ({ id: 't' + String(++n).padStart(4, '0'), name: 'Track ' + n,
    artists: [{ id: artist, name: artist.toUpperCase() }], duration_ms: 200000 + Math.floor(r() * 60000),
    album: { album_type: 'album', release_date: String(year) }, external_ids: { isrc: 'QZ' + String(n).padStart(10, '0') } });
  const scenes = ['jungle', 'house', 'techno', 'ambient'];
  const playlists = scenes.map((s, i) => ({ id: 'pl-' + s, name: s, tracks: Array.from({ length: 30 }, () =>
    track(`${s}-${Math.floor(r() * 8)}`, 1995 + i * 7)) }));
  // A crossover playlist so the artist graph has edges.
  playlists.push({ id: 'pl-mix', name: 'Mix', tracks: [...playlists[0].tracks.slice(0, 6), ...playlists[1].tracks.slice(0, 6)] });
  const liked = Array.from({ length: 80 }, (_, k) => track(`${scenes[k % 4]}-${Math.floor(r() * 12)}`, 2000));
  return { playlists, liked };
}

test('Fill recall@10 on a library with real structure clears the bar, far above random', () => {
  const m = fillRecall(sceneLibrary());
  assert.ok(m.playlists >= 4, 'every 10+ track playlist is measured');
  assert.ok(m.recall >= FILL.bar, `recall ${m.recall}`);
  assert.ok(m.random < 0.2 && m.recall > 3 * m.random, `random ${m.random}`);
  assert.equal(m.pass, true);
  assert.deepEqual(fillRecall(sceneLibrary()), m, 'deterministic');
});

test('with no tags and nothing heard it ranks by the artist graph, and says why', () => {
  const lib = sceneLibrary();
  const model = fillModel(lib);
  const cands = lib.liked;
  const r = fillRank(model, 'pl-jungle', cands, { limit: 10 });
  assert.equal(r.declined, null);
  assert.deepEqual(r.used.sort(), ['graph', 'shape']);
  assert.equal(r.results.length, 10);
  const jungle = new Set(lib.playlists[0].tracks.flatMap(t => t.artists.map(a => a.id)));
  assert.ok(r.results.slice(0, 5).every(x => cands.find(t => t.id === x.id).artists.some(a => jungle.has(a.id))));
  assert.match(r.results[0].why, /^\d+ by JUNGLE-\d here$/);
  assert.equal(fillRank(model, 'nope', cands).declined, 'NO_DEFINITION');
  // Members of the playlist are never offered back to it.
  assert.equal(fillRank(model, 'pl-jungle', lib.playlists[0].tracks).results.length, 0);
});

test('no data means no change: empty tags and empty audio rank exactly as none', () => {
  const lib = sceneLibrary();
  const base = fillRank(fillModel(lib), 'pl-house', lib.liked);
  assert.deepEqual(fillRank(fillModel(lib, { tags: {} }), 'pl-house', lib.liked), base);
  assert.deepEqual(fillRank(fillModel(lib, { audio: [] }), 'pl-house', lib.liked), base);
  assert.deepEqual(fillRecall(lib, { tags: {}, audio: [] }), fillRecall(lib));
});

test('the hidden fold never reaches the model it is measured against', () => {
  const lib = sceneLibrary();
  const hidden = new Set(lib.playlists.flatMap(p => p.tracks).map(t => t.id).filter(id => foldOf(id, 5) === 0));
  const model = fillModel(lib, { skip: hidden });
  for (const d of model.space.destinations.values()) for (const id of hidden) assert.ok(!d.trackIds.has(id));
});

test('tags carry it where the graph has nothing (each artist filed once)', () => {
  const lib = makeAccount('typical');
  const without = fillRecall(lib), withTags = fillRecall(lib, { tags: TAGS });
  assert.ok(withTags.recall > without.recall, `${withTags.recall} vs ${without.recall}`);
  assert.ok(withTags.used['graph+shape+tag'] > 0);
});

test('sound alone can fill a playlist: heard tracks, no tags, no shared artists', () => {
  // Three playlists that differ only in how they sound; every track by its own artist.
  let n = 0;
  const records = [];
  const mk = (dir, k) => Array.from({ length: k }, () => {
    const id = 's' + String(++n).padStart(4, '0');
    records.push(soundRecord(id, { mix: { [dir]: 3 }, noise: 1 }));
    return { id, name: id, artists: [{ id: 'solo-' + n, name: 'Solo ' + n }] };
  });
  const lib = { playlists: [{ id: 'X', name: 'X', tracks: mk('x', 25) }, { id: 'Y', name: 'Y', tracks: mk('y', 25) },
                            { id: 'Z', name: 'Z', tracks: mk('z', 25) }], liked: mk('n', 30) };
  const deaf = fillRecall(lib), heard = fillRecall(lib, { audio: records });
  assert.ok(heard.recall >= FILL.bar, `heard ${heard.recall}`);
  assert.ok(heard.recall > deaf.recall + 0.2, `deaf ${deaf.recall}`);
  assert.ok(Object.keys(heard.used).every(k => k.includes('sound')));
  const r = fillRank(fillModel(lib, { audio: records }), 'X', lib.liked.concat(lib.playlists[1].tracks), { limit: 3 });
  assert.ok(r.results.every(x => Number.isFinite(x.parts.sound)));
});

test('the gate: off until measured, off under 40%, on at or above it, forced only by the flag', () => {
  assert.deepEqual(fillGate(null), { on: false, measured: false, recall: null });
  assert.equal(fillGate({ recall: 0.39 }).on, false);
  assert.equal(fillGate({ recall: 0.39 }).measured, true);
  assert.equal(fillGate({ recall: 0.4 }).on, true);
  assert.equal(fillGate({ recall: 0.1 }, { force: true }).on, true);
  assert.equal(fillGate(null, { force: true }).forced, true);
});

test('Fill recall@10 on the committed non-owner fixtures (BUILD-6 M5)', () => {
  // `small` has no playlist of 10+, so nothing to measure; the others are reported.
  assert.equal(fillRecall(makeAccount('small'), { tags: TAGS }).playlists, 0);
  assert.equal(fillRecall(makeAccount('empty')).recall, null);
  const typical = fillRecall(makeAccount('typical'), { tags: TAGS });
  assert.ok(typical.recall >= FILL.bar, `typical ${typical.recall}`);
  const shaped = fillRecall(shapedLibrary());
  assert.ok(shaped.recall >= FILL.bar, `shaped ${shaped.recall}`);
  // `large` repeats each genre in 3-4 playlists built from the same artist pool, so a
  // playlist's hidden tracks are indistinguishable from its siblings': it stays under
  // the bar (the feature would stay off there), but far above random.
  const large = fillRecall(makeAccount('large'), { tags: TAGS });
  assert.ok(large.recall > 5 * large.random, `large ${large.recall} vs ${large.random}`);
});
