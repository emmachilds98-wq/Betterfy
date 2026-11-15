import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalise, normalised, blendScores, BLEND_GRID } from '../core/intrinsic/blend.mjs';
import { blendAccuracy, blendFromRun, neverFiledIds, BEAT_MARGIN } from '../core/validate/blend.mjs';
import { placementAccuracy, foldOf } from '../core/validate/loo.mjs';
import { baselineAccuracy } from '../core/validate/baseline.mjs';
import { bridgeFrom, withBridge } from '../core/intrinsic/bridge.mjs';
import { buildSpace, placements } from '../core/intrinsic/space.mjs';

/*
 * docs/SMARTER-GENRES-PLAN.md phase 1: today's tag engine and the
 * account-native engine (with similar artists) blended per (track, playlist),
 * one weight fitted on held-out folds of the account's own filing.
 */

/* ---------- the blend itself ---------- */

test('normalise: each engine is scaled so its best is 1; nothing positive is nothing', () => {
  assert.deepEqual([...normalise([['a', 0.5], ['b', 0.25], ['c', 0]])], [['a', 1], ['b', 0.5]]);
  assert.deepEqual([...normalise([{ id: 'a', score: 2 }, { id: 'b', score: 1 }])], [['a', 1], ['b', 0.5]]);
  assert.deepEqual([...normalise([{ playlistId: 'a', score: 0.4 }])], [['a', 1]]);
  assert.equal(normalise([]).size, 0);
  assert.equal(normalise([['a', 0]]).size, 0);
  assert.equal(normalise(null).size, 0);
});

test('blendScores: w=1 is the tag order, w=0 the engine order, and between them a mix', () => {
  const tag = [['a', 0.9], ['b', 0.6], ['c', 0.1]];
  const nat = [['c', 0.5], ['b', 0.45], ['a', 0.05]];
  assert.deepEqual(blendScores(tag, nat, 1).map(x => x[0]), ['a', 'b', 'c']);
  assert.deepEqual(blendScores(tag, nat, 0).map(x => x[0]), ['c', 'b', 'a']);
  // b is second in both, and close to the top in both: the mix puts it first.
  assert.equal(blendScores(tag, nat, 0.5)[0][0], 'b');
});

test('blendScores: a side with nothing to say drops out, so an untagged track still gets picks', () => {
  const nat = [['c', 0.5], ['b', 0.25]];
  assert.deepEqual(blendScores([], nat, 0.9), [['c', 1], ['b', 0.5]]);
  assert.deepEqual(blendScores([['a', 0.3]], [], 0.1), [['a', 1]]);
  assert.deepEqual(blendScores([], [], 0.5), []);
});

test('blendScores: ties break by playlist id, so two runs agree', () => {
  assert.deepEqual(blendScores([['b', 1], ['a', 1]], [], 1).map(x => x[0]), ['a', 'b']);
});

test('normalised maps are used as they are, and give the same blend', () => {
  const tag = [['a', 0.9], ['b', 0.6]], nat = [['b', 0.5], ['a', 0.1]];
  for (const w of BLEND_GRID) assert.deepEqual(blendScores(normalised(tag), normalised(nat), w), blendScores(tag, nat, w));
});

/* ---------- the fit, on rows ---------- */

/** Rows where tags are right on the first 60 tracks and have nothing on the last
 *  40, which the engine gets right; the engine is wrong on the first 60. */
function splitRows() {
  const tagRows = [], natRows = [];
  for (let i = 0; i < 100; i++) {
    const id = `t${String(i).padStart(3, '0')}`, truth = [i % 2 ? 'A' : 'B'];
    const wrong = truth[0] === 'A' ? 'B' : 'A';
    if (i < 60) {
      tagRows.push({ id, scores: [[truth[0], 0.8], [wrong, 0.3]], truth });
      natRows.push({ id, scores: [[wrong, 0.42], [truth[0], 0.4]], truth });
    } else {
      tagRows.push({ id, scores: [], truth });
      natRows.push({ id, scores: [[truth[0], 0.5], [wrong, 0.2]], truth });
    }
  }
  return { tagRows, natRows };
}

test('blendAccuracy: where the engines are right about different tracks, the blend beats both', () => {
  const { tagRows, natRows } = splitRows();
  const nf = new Set(natRows.slice(60).map(r => r.id));
  const b = blendAccuracy(tagRows, natRows, { folds: 5, neverFiled: nf });
  assert.equal(b.scored, 100);
  assert.equal(b.tags.top1, 0.6);
  assert.equal(b.native.top1, 0.4);
  assert.equal(b.top1, 1, 'tags lead where they know, the engine fills where they have nothing');
  assert.ok(b.weight > 0 && b.weight <= 1);
  assert.equal(b.beatsTags, true);
  assert.equal(b.neverFiled.scored, 40);
  assert.equal(b.neverFiled.top1, 1);
  assert.equal(b.neverFiled.tags.top1, 0);
  assert.equal(Object.keys(b.foldWeights).length, new Set(natRows.map(r => foldOf(r.id, 5))).size);
});

test('blendAccuracy: a tie between weights goes to the one nearest today\'s engine', () => {
  // Both engines always agree: every weight scores the same, so the fit must stay on tags.
  const rows = Array.from({ length: 30 }, (_, i) => ({ id: `x${i}`, scores: [['A', 0.9], ['B', 0.1]], truth: ['A'] }));
  const b = blendAccuracy(rows, rows, { folds: 5 });
  assert.equal(b.weight, 1);
  assert.ok(Object.values(b.foldWeights).every(w => w === 1));
  assert.equal(b.beatsTags, false, 'level with tags is not beating them');
});

test('blendAccuracy: the score is held out — a weight is never scored on the tracks it was fitted on', () => {
  // Fold 0's tracks want the engine, every other fold's want tags. Fitted on
  // the other folds, fold 0 gets tags' weight and so scores badly: the held-out
  // number must show that, where an in-sample fit would hide it.
  const tagRows = [], natRows = [];
  for (let i = 0; i < 200; i++) {
    const id = `f${i}`, truth = ['A'];
    const eng = foldOf(id, 5) === 0;
    tagRows.push({ id, scores: eng ? [['B', 0.9], ['A', 0.1]] : [['A', 0.9], ['B', 0.8]], truth });
    natRows.push({ id, scores: eng ? [['A', 0.9], ['B', 0.1]] : [['B', 0.9], ['A', 0.1]], truth });
  }
  const b = blendAccuracy(tagRows, natRows, { folds: 5 });
  const fold0 = tagRows.filter(r => foldOf(r.id, 5) === 0).length;
  assert.ok(b.top1 <= 1 - fold0 / 200 + 1e-9, `held-out top-1 ${b.top1} must not credit fold 0`);
});

test('blendAccuracy: beating tags needs a point of top-1 and top-3 not down by more than one', () => {
  assert.equal(BEAT_MARGIN, 0.01);
  assert.equal(blendAccuracy([], [{ id: 'a', scores: [], truth: ['A'] }]), null);
  assert.equal(blendAccuracy([{ id: 'a', scores: [], truth: ['A'] }], []), null);
});

/* ---------- the whole run, on a library ---------- */

const FAMS = ['jungle', 'garage', 'techno'];
function library() {
  const playlists = [];
  FAMS.forEach((fam, fi) => {
    const core = Array.from({ length: 5 }, (_, i) => ({ id: `${fam}Core${i}`.padEnd(22, 'x'), name: `${fam} core ${i}` }));
    const tracks = [];
    for (let i = 0; i < 16; i++) {
      const newcomer = i >= 12;
      tracks.push({
        id: `${fam}-t${i}`, name: `${fam} ${i}`,
        artists: newcomer ? [{ id: `${fam}New${i}`.padEnd(22, 'x'), name: `${fam} newcomer ${i}` }]
                          : [core[i % 5], core[(i + 1) % 5]],
        albumType: 'single', albumTracks: 2, trackNo: 1, released: '2021-01-01',
        duration_ms: 300000, explicit: false, popularity: 40,
        isrc: newcomer ? `ZZAGG${21 + fi}${String(10000 + i).slice(0, 5)}` : `GB${'ABC'[fi]}XX21${String(10000 + i).slice(0, 5)}`,
        added_at: '2025-01-01T00:00:00Z',
      });
    }
    playlists.push({ id: `p-${fam}`, name: fam, tracks });
  });
  playlists.push({ id: 'p-mix', name: 'Mix', tracks: playlists.flatMap(p => p.tracks.slice(0, 3)) });
  return { playlists, liked: [] };
}
const TARGETS = new Set(FAMS.map(f => `p-${f}`));
function rawFor(lib) {
  const raw = {};
  for (const p of lib.playlists.filter(p => p.id !== 'p-mix'))
    for (const t of p.tracks.filter(t => t.artists[0].id.includes('New')))
      raw[t.artists[0].id] = { deezerId: null, deezerAt: 1,
        deezer: Array.from({ length: 5 }, (_, i) => ({ id: 1000 + i, name: `${p.name} core ${i}` })) };
  return raw;
}
/** Tags for the core artists only: the crowd has never heard of the newcomers. */
function tagsFor(lib) {
  const tags = {};
  for (const p of lib.playlists) for (const t of p.tracks) for (const a of t.artists)
    if (a.id.includes('Core')) tags[a.id] = { tags: [[a.id.replace(/Core.*/, ''), 100], ['electronic', 50]] };
  return tags;
}

test('baselineAccuracy: collect keeps each ranking, and changes nothing else', () => {
  const lib = library(), tags = tagsFor(lib);
  const plain = baselineAccuracy(lib, tags, { folds: 4, targets: TARGETS });
  const kept = baselineAccuracy(lib, tags, { folds: 4, targets: TARGETS, collect: true });
  assert.equal('rows' in plain, false, 'without collect the result is key for key what it was');
  const { rows, ...rest } = kept;
  assert.deepEqual(rest, plain);
  assert.equal(rows.length, plain.scored);
  for (const r of rows) assert.ok(Array.isArray(r.scores) && Array.isArray(r.truth) && r.truth.length);
});

test('blendFromRun: the same tracks, folds and never-filed subset the harness reported', () => {
  const lib = library(), tags = tagsFor(lib), bridge = bridgeFrom(rawFor(lib), lib);
  const common = { folds: 4, targets: TARGETS, collect: true };
  const mine = placementAccuracy(lib, { ...common, bridge });
  const base = baselineAccuracy(lib, tags, common);
  const b = blendFromRun(lib, { base, mine, folds: 4, targets: TARGETS });
  assert.equal(b.withBridge, true);
  assert.equal(b.scored, mine.scored);
  // The two engines' own numbers, recomputed from the rows, are the harness's.
  assert.equal(b.tags.top1, base.top1);
  assert.equal(b.native.top1, mine.withBridge.top1);
  assert.equal(b.neverFiled.scored, mine.neverFiled.scored, 'never-filed worked out exactly as placementAccuracy does');
  assert.equal(b.neverFiled.native.top1, mine.withBridge.neverFiled.top1);
  // Newcomers have no tags; similar artists place them. Together beats tags alone.
  assert.ok(b.neverFiled.top1 > b.neverFiled.tags.top1);
  assert.ok(b.top1 >= base.top1, `blend ${b.top1} vs tags ${base.top1}`);
  assert.ok(BLEND_GRID.includes(b.weight));
});

test('blendFromRun: no tags, or no rows collected, is no blend', () => {
  const lib = library();
  const mine = placementAccuracy(lib, { folds: 4, targets: TARGETS, collect: true });
  assert.equal(blendFromRun(lib, { base: null, mine, folds: 4, targets: TARGETS }), null);
  const base = baselineAccuracy(lib, tagsFor(lib), { folds: 4, targets: TARGETS });
  assert.equal(blendFromRun(lib, { base, mine, folds: 4, targets: TARGETS }), null);
  // Without a bridge it blends with the engine alone, and says so.
  const b = blendFromRun(lib, { base: baselineAccuracy(lib, tagsFor(lib), { folds: 4, targets: TARGETS, collect: true }),
                                mine, folds: 4, targets: TARGETS });
  assert.equal(b.withBridge, false);
});

test('neverFiledIds: an artist filed only in the held-out fold counts as never filed', () => {
  const lib = library();
  const ids = lib.playlists.filter(p => TARGETS.has(p.id)).flatMap(p => p.tracks.map(t => t.id));
  const nf = neverFiledIds(lib, ids, { folds: 4, targets: TARGETS });
  for (const id of nf) assert.match(id, /-t1[2-5]$/, 'only the one-off newcomers');
  assert.ok(nf.size >= 1);
});

/* ---------- the space the File screen blends with ---------- */

test('withBridge: the same keys buildSpace adds, on a copy; nothing to add leaves the space as it was', () => {
  const lib = library(), bridge = bridgeFrom(rawFor(lib), lib);
  const plain = buildSpace(lib, { targets: TARGETS });
  const built = buildSpace(lib, { targets: TARGETS, bridge });
  const added = withBridge(plain, bridge);
  assert.notEqual(added, plain);
  assert.equal('bridge' in plain, false, 'the shared space is not touched');
  assert.deepEqual([...added.bridge], [...built.bridge]);
  assert.deepEqual([...added.artistHomes.keys()].sort(), [...built.artistHomes.keys()].sort());
  const t = lib.playlists[0].tracks[13];
  assert.deepEqual(placements(t, added, { limit: Infinity }).results, placements(t, built, { limit: Infinity }).results);
  assert.equal(withBridge(plain, null), plain);
  assert.equal(withBridge(plain, { neighbours: {} }), plain);
});
