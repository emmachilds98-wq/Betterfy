// WP-E1: the audio component (core/intrinsic/audio.mjs).
//
// The first test is the one the build plan makes every engine package write
// first: with no audio, nothing changes. It runs the engine on a fixture
// library *before* the audio module is even loaded, then loads it, builds an
// empty audio layer, and checks every placement is byte-identical.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildSpace, placements, MIN_DEFINITION_TRACKS } from '../core/intrinsic/space.mjs';
import { serialiseSpace } from '../core/intrinsic/persist.mjs';
import { makeRecord, makeMiss, MISS, N_STYLES, EMB_DIM, MODEL } from '../core/audio/record.mjs';
import { resolveOrder } from '../bundler.mjs';

/* ---------- a fixture library (compact copy of test/intrinsic.test.mjs's) ----------
 * Four families, a bucket each, plus crossover buckets so the artist graph is
 * not empty, and over 50 tracks so the mirror predicate is live. */
const FAMILIES = ['tech', 'deep', 'jungle', 'ambient'];

function fixture() {
  const playlists = [], all = [];
  FAMILIES.forEach((fam, fi) => {
    const core = Array.from({ length: 6 }, (_, i) => ({ id: `${fam}-a${i}`, name: `${fam} artist ${i}` }));
    const letter = String.fromCharCode(65 + fi);
    const tracks = Array.from({ length: 15 }, (_, i) => {
      const orphan = i === 14, guest = i === 12 || i === 13;
      const a1 = orphan ? { id: `${fam}-o${i}a` } : guest ? { id: `${fam}-g${i}` } : core[i % 6];
      const a2 = orphan ? { id: `${fam}-o${i}b` } : core[(i + 2) % 6];
      const reg = orphan || i % 5 === 0 ? 'ZZAGG' : `GB${letter}${letter}${letter}`;
      const t = {
        id: `${fam}-t${i}`, name: `${fam} track ${i}`, artists: [a1, a2],
        albumId: `${fam}-al${i % 5}`, albumType: 'single', albumTracks: 2, trackNo: 1,
        released: '2020-03-01', duration_ms: 6 * 60000 + (i % 5) * 20000, explicit: false,
        isrc: `${reg}${20 + fi}${String(10000 + i).slice(0, 5)}`, popularity: 45 + (i % 5),
        added_at: new Date(Date.UTC(2025, fi, 1 + Math.floor(i / 5), 12, i % 5)).toISOString(),
      };
      all.push(t);
      return t;
    });
    playlists.push({ id: `p-${fam}`, name: fam, tracks });
  });
  const pick = (fam, from, to) => playlists.find(p => p.id === `p-${fam}`).tracks.slice(from, to);
  playlists.push({ id: 'p-favs', name: 'Favourites', tracks: [...pick('tech', 0, 5), ...pick('deep', 0, 5)] });
  playlists.push({ id: 'p-night', name: 'Late Night', tracks: [...pick('deep', 5, 9), ...pick('ambient', 0, 5)] });
  playlists.push({ id: 'p-bang', name: 'Bangers', tracks: [...pick('tech', 5, 9), ...pick('jungle', 0, 5)] });
  return { playlists, all };
}

const strip = o => JSON.parse(JSON.stringify(o));
/** The serialised space minus its build timestamp, the one field that is a clock, not the engine. */
const serial = (space, lib) => { const { builtAt, ...rest } = serialiseSpace(space, lib); return JSON.stringify(rest); };
const everyPlacement = (lib, space) =>
  JSON.stringify(lib.all.map(t => placements(t, space, { limit: Infinity, why: true })));

/* ---------- the baseline, taken before the audio module exists in this process ---------- */
const LIB = fixture();
const BEFORE = {
  space: serial(buildSpace(LIB), LIB),
  placements: everyPlacement(LIB, buildSpace(LIB)),
  targeted: everyPlacement(LIB, buildSpace(LIB, { targets: FAMILIES.map(f => `p-${f}`) })),
};

const { audioIndex, audioProfileOf, audioScores, buildAudioProfiles, profileWithout,
        MIN_AUDIO_MEMBERS, AUDIO_COMPONENT_VERSION } = await import('../core/intrinsic/audio.mjs');

/* ---------- synthetic records ---------- */

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5;
}
/** A direction per family, so tracks of one family sound alike. */
function familyDir(fam) {
  const r = rng(1 + FAMILIES.indexOf(fam) * 7919);
  return Float32Array.from({ length: EMB_DIM }, r);
}
function embFor(trackId, { noise = 0.6 } = {}) {
  const fam = trackId.split('-')[0];
  const dir = familyDir(fam);
  const r = rng([...trackId].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7));
  return Float32Array.from(dir, v => v + noise * r());
}
function recordFor(id, { emb = embFor(id), at = 1000, mel = '1.0.0' } = {}) {
  const activations = new Float32Array(N_STYLES).fill(0.01);
  activations[(id.length * 13) % N_STYLES] = 0.8;
  return makeRecord({ id, isrc: 'GBXXX0000001', activations, embeddings: emb, patches: 1,
                      source: { kind: 'deezer-isrc', deezerId: 1, windows: [[0, 165000]], seconds: 10 }, mel, at });
}
const norm = v => Math.sqrt(v.reduce((s, x) => s + x * x, 0));
const cos = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i]; return d / (norm(a) * norm(b)); };

/* ---------- THE GUARD ---------- */

test('THE AUDIO GUARD: with no audio, buildSpace and placements are byte-identical', () => {
  const index = audioIndex([]);
  assert.equal(index.size, 0);

  const space = buildSpace(LIB);
  const audio = buildAudioProfiles(space, index);
  assert.equal(audio.size, 0);
  assert.equal(audio.profiles.size, 0, 'no records means no profile is even computed');

  // Reading the space must not have changed it…
  assert.equal(serial(space, LIB), BEFORE.space);
  // …and nothing the engine says has moved, with or without the empty layer attached.
  assert.equal(everyPlacement(LIB, space), BEFORE.placements);
  assert.equal(everyPlacement(LIB, { ...space, audio }), BEFORE.placements);
  assert.equal(everyPlacement(LIB, buildSpace(LIB, { targets: FAMILIES.map(f => `p-${f}`) })), BEFORE.targeted);

  for (const t of LIB.all) {
    assert.equal(audioScores(t, { ...space, audio }), null, `${t.id}: no audio means no score at all`);
    assert.equal(audioScores(t, space), null, 'a space without an audio layer scores null');
  }
});

test('building a real audio layer reads the space and never writes to it', () => {
  const index = audioIndex(LIB.all.map(t => recordFor(t.id)));
  const space = buildSpace(LIB);
  const audio = buildAudioProfiles(space, index);
  assert.ok(audio.size > 0, 'the fixture must actually exercise the layer');
  assert.equal(serial(space, LIB), BEFORE.space);
  assert.equal(everyPlacement(LIB, space), BEFORE.placements);
});

test('a track with no record scores null even when every playlist has a sound', () => {
  const heard = LIB.all.filter(t => !t.id.startsWith('jungle'));
  const index = audioIndex(heard.map(t => recordFor(t.id)));
  const audio = buildAudioProfiles(buildSpace(LIB), index);
  for (const t of LIB.all.filter(t => t.id.startsWith('jungle'))) {
    assert.equal(audioScores(t, { audio }), null);
  }
});

/* ---------- index ---------- */

test('audioIndex keeps valid, current, non-miss records, unit-normalised', () => {
  const good = recordFor('deep-t1');
  const recs = [
    good,
    makeMiss({ id: 'deep-t2', reason: MISS.NO_PREVIEW, at: 0 }),
    null, 42, 'x', {}, { v: 1, id: 'a', styles: [[999, 0.5]] },
    { ...recordFor('deep-t3'), model: 'some-other-backbone' },
    recordFor('deep-t4', { emb: new Float32Array(EMB_DIM) }),          // silence: no direction
  ];
  const idx = audioIndex(recs);
  assert.deepEqual([...idx.keys()], ['deep-t1']);
  const row = idx.get('deep-t1');
  assert.ok(row.emb instanceof Float32Array);
  assert.equal(row.emb.length, EMB_DIM);
  assert.ok(Math.abs(norm(row.emb) - 1) < 1e-5, 'unit length');
  assert.ok(cos(row.emb, embFor('deep-t1')) > 0.999, 'same direction as what the model heard');
  assert.equal(row.styles, good.styles);
  assert.equal(row.rec, good);
  assert.equal(good.model, MODEL);
});

test('audioIndex accepts arrays, Maps and id-keyed objects, and never throws', () => {
  const a = recordFor('tech-t0'), b = recordFor('tech-t1');
  assert.equal(audioIndex([a, b]).size, 2);
  assert.equal(audioIndex(new Map([[a.id, a], [b.id, b]])).size, 2);
  assert.equal(audioIndex({ [a.id]: a, [b.id]: b }).size, 2);
  for (const junk of [null, undefined, 0, 'nope', {}, [], [null], { x: { v: 1 } }]) {
    assert.equal(audioIndex(junk).size, 0);
  }
});

test('audioIndex: the newer of two records for one id wins; mel filters when given', () => {
  const old = recordFor('tech-t0', { emb: embFor('ambient-t0'), at: 1 });
  const fresh = recordFor('tech-t0', { at: 2 });
  assert.equal(audioIndex([old, fresh]).get('tech-t0').rec, fresh);
  assert.equal(audioIndex([fresh, old]).get('tech-t0').rec, fresh);
  assert.equal(audioIndex([fresh], { mel: '1.0.0' }).size, 1);
  assert.equal(audioIndex([fresh], { mel: '2.0.0' }).size, 0, 'a record from another front end is stale');
});

/* ---------- profiles ---------- */

test('audioProfileOf is the renormalised mean of unit embeddings over analysed members', () => {
  const ids = ['deep-t0', 'deep-t1', 'deep-t2', 'deep-t3'];
  const idx = audioIndex(ids.slice(0, 3).map(id => recordFor(id)));   // t3 never analysed
  const prof = audioProfileOf([...ids, 'deep-t0'], idx);                 // and t0 filed twice
  assert.equal(prof.members, 3, 'distinct analysed members only');
  assert.deepEqual([...prof.ids].sort(), ids.slice(0, 3));

  const want = new Float64Array(EMB_DIM);
  for (const id of ids.slice(0, 3)) idx.get(id).emb.forEach((v, i) => { want[i] += v; });
  assert.ok(prof.centroid instanceof Float32Array);
  assert.ok(Math.abs(norm(prof.centroid) - 1) < 1e-5);
  assert.ok(cos(prof.centroid, want) > 0.999999);

  // Track objects work as well as ids; skip removes members.
  const objs = audioProfileOf(ids.map(id => ({ id })), idx, { skip: new Set(['deep-t1']) });
  assert.equal(objs.members, 2);
});

test('audioProfileOf is null when nothing in the playlist has been heard', () => {
  const idx = audioIndex([recordFor('tech-t0')]);
  assert.equal(audioProfileOf(['deep-t0', 'deep-t1'], idx), null);
  assert.equal(audioProfileOf([], idx), null);
  assert.equal(audioProfileOf(['tech-t0'], new Map()), null);
  assert.equal(audioProfileOf(null, idx), null);
});

test('buildAudioProfiles accepts a space, its destinations Map, or raw playlists', () => {
  const idx = audioIndex(LIB.all.map(t => recordFor(t.id)));
  const space = buildSpace(LIB);
  const a = buildAudioProfiles(space, idx);
  const b = buildAudioProfiles(space.destinations, idx);
  const c = buildAudioProfiles(LIB.playlists, idx);
  assert.deepEqual([...a.profiles.keys()].sort(), [...space.destinations.keys()].sort());
  assert.deepEqual([...b.profiles.keys()].sort(), [...a.profiles.keys()].sort());
  for (const [id, p] of a.profiles) assert.equal(c.profiles.get(id).members, p.members);
  assert.equal(a.version, AUDIO_COMPONENT_VERSION);
});

test('the audio floor is the engine floor, restated without an import cycle', () => {
  assert.equal(MIN_AUDIO_MEMBERS, MIN_DEFINITION_TRACKS,
    'audio.mjs restates MIN_DEFINITION_TRACKS rather than importing it; the two must not drift');
  // Why it is restated: WP-E2 makes space.mjs import audio.mjs, and the bundler
  // refuses cycles. Prove the planned wiring stays buildable.
  const read = f => {
    const src = readFileSync(f, 'utf8');
    return f.endsWith('core/intrinsic/space.mjs')
      ? `import { audioScores } from './audio.mjs';\n${src}` : src;
  };
  assert.doesNotThrow(() => resolveOrder(['core/intrinsic/space.mjs'], { read }));
  const src = readFileSync('core/intrinsic/audio.mjs', 'utf8');
  assert.ok(!/from\s+['"]\.\/space\.mjs['"]/.test(src), 'audio.mjs must not import space.mjs');
});

/* ---------- scores ---------- */

test('audioScores: cosine to each centroid, and the right family sounds nearest', () => {
  const idx = audioIndex(LIB.all.map(t => recordFor(t.id)));
  const space = buildSpace(LIB, { targets: FAMILIES.map(f => `p-${f}`) });
  const audio = buildAudioProfiles(space, idx);
  for (const fam of FAMILIES) {
    const t = LIB.all.find(x => x.id === `${fam}-t3`);
    const s = audioScores(t, { audio });
    assert.ok(s instanceof Map);
    for (const [d, v] of s) {
      assert.ok(Number.isFinite(v) && v >= -1 && v <= 1);
      const want = cos(idx.get(t.id).emb, audio.profiles.get(d).centroid);
      assert.ok(Math.abs(v - want) < 1e-5, `${d}: score is the plain cosine`);
    }
    const best = [...s].sort((a, b) => b[1] - a[1])[0][0];
    assert.equal(best, `p-${fam}`);
  }
  // The audio object itself works in place of a space.
  assert.deepEqual(audioScores('deep-t3', audio), audioScores('deep-t3', { audio }));
});

test('a destination with too few analysed members scores null, never 0', () => {
  // Deep: only four tracks heard, one short of the floor. Everything else fully heard.
  const heard = LIB.all.filter(t => !t.id.startsWith('deep') || ['deep-t0', 'deep-t1', 'deep-t2', 'deep-t3'].includes(t.id));
  const idx = audioIndex(heard.map(t => recordFor(t.id)));
  const audio = buildAudioProfiles(buildSpace(LIB, { targets: FAMILIES.map(f => `p-${f}`) }), idx);
  assert.equal(audio.profiles.get('p-deep').members, MIN_AUDIO_MEMBERS - 1);
  const s = audioScores('tech-t3', { audio });
  assert.strictEqual(s.get('p-deep'), null);
  assert.ok(Number.isFinite(s.get('p-tech')));
  assert.equal(audio.size, 3, 'size counts only the destinations that can judge');
  // A lower floor, when a caller asks for one, lets it judge.
  assert.ok(Number.isFinite(audioScores('tech-t3', { audio }, { minMembers: 4 }).get('p-deep')));
});

/* ---------- leave-one-out ---------- */

test('profileWithout matches a rebuild without that member', () => {
  const ids = LIB.playlists.find(p => p.id === 'p-jungle').tracks.map(t => t.id);
  const idx = audioIndex(ids.map(id => recordFor(id)));
  const full = audioProfileOf(ids, idx);
  const loo = profileWithout(full, 'jungle-t4', idx);
  const rebuilt = audioProfileOf(ids.filter(id => id !== 'jungle-t4'), idx);
  assert.equal(loo.members, rebuilt.members);
  assert.deepEqual([...loo.ids].sort(), [...rebuilt.ids].sort());
  for (let i = 0; i < EMB_DIM; i++) assert.ok(Math.abs(loo.centroid[i] - rebuilt.centroid[i]) < 1e-6);
  assert.ok(full.ids.has('jungle-t4'), 'the original profile is not mutated');

  assert.equal(profileWithout(full, 'tech-t0', idx), full, 'a non-member leaves the profile as it is');
  const single = audioProfileOf(['jungle-t0'], idx);
  assert.equal(profileWithout(single, 'jungle-t0', idx), null, 'removing the only member leaves nothing');
});

test('leaveOneOut: a member is scored against its playlist with itself removed', () => {
  const idx = audioIndex(LIB.all.map(t => recordFor(t.id)));
  const audio = buildAudioProfiles(buildSpace(LIB), idx);
  const t = 'tech-t2';
  const inSample = audioScores(t, { audio });
  const honest = audioScores(t, { audio }, { leaveOneOut: true });

  // Its own playlists drop (it was voting for itself); every other playlist is untouched.
  for (const [d, prof] of audio.profiles) {
    if (prof.ids.has(t)) assert.ok(honest.get(d) < inSample.get(d), `${d}: self-vote removed`);
    else assert.equal(honest.get(d), inSample.get(d));
  }
  const want = cos(idx.get(t).emb, profileWithout(audio.profiles.get('p-tech'), t, idx).centroid);
  assert.ok(Math.abs(honest.get('p-tech') - want) < 1e-5);

  // A playlist exactly at the floor falls below it once the track is removed.
  const five = ['tech-t0', 'tech-t1', 'tech-t2', 'tech-t3', 'tech-t4'];
  const small = buildAudioProfiles([{ id: 'p-five', tracks: five.map(id => ({ id })) }], idx);
  assert.ok(Number.isFinite(audioScores(t, small).get('p-five')));
  assert.strictEqual(audioScores(t, small, { leaveOneOut: true }).get('p-five'), null);
});

test('fold-level leave-out: a space built with skip gives profiles without those tracks', () => {
  const idx = audioIndex(LIB.all.map(t => recordFor(t.id)));
  const skip = new Set(['tech-t1', 'deep-t2']);
  const audio = buildAudioProfiles(buildSpace(LIB, { skip }), idx);
  for (const p of audio.profiles.values()) for (const id of skip) assert.ok(!p.ids.has(id));
  const raw = buildAudioProfiles(LIB.playlists, idx, { skip });
  for (const p of raw.profiles.values()) for (const id of skip) assert.ok(!p.ids.has(id));
  // Scoring a skipped track against those profiles is honest by construction.
  assert.ok(audioScores('tech-t1', { audio }) instanceof Map);
});

test('the guard placements are untouched by every test above', () => {
  // Belt and braces: nothing in this file leaked state into the engine.
  assert.equal(everyPlacement(LIB, buildSpace(LIB)), BEFORE.placements);
  assert.deepEqual(strip(buildSpace(LIB).targets), null);
});
