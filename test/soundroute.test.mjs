// S1 (docs/BUILD-7-PLAN.md): sound joins the blend, per situation.
//
// On File, a heard track leads with sound and the blend sits underneath. The
// Score run now measures, on the blend's own held-out folds and tracks:
//   (a) today      sound leads on heard tracks, the blend underneath
//   (b) blend      the blend alone
//   (c) three      tags + engine-with-similar-artists + sound, weights fitted per fold
//   (d) route      never-filed heard -> sound leads; filed heard -> blend
//       route3     never-filed heard -> sound leads; filed heard -> three-way
// and a family arm: when the family view is confident, the pick is kept inside
// that family. Gate, set before the run: +1 top-1 overall over (a), no more
// than 1 point lost on never-filed top-1 (nor on top-3 overall).
//
// Measured on fabricated libraries (fabricated sound, half the artists tagged):
//
//                 (a) today     (b) blend     (c) three     (d) route     route3        choice
//                 top1  top3    top1  top3    top1  top3    top1  top3    top1  top3
//   shaped 11     96.0  100     82.3  94.3    97.3  100     85.4  96.6    96.8  100     three (+1.3)
//     never-filed 96.9          88.5          98.4          96.9          96.9
//   shaped 5      95.7  99.8    83.5  95.8    96.2  100     86.0  97.5    95.8  100     none
//     never-filed 96.3          88.4          97.4          96.3          96.3
//   shaped 3      95.7  99.7    81.7  95.0    95.2  99.3    85.3  97.6    95.2  99.3    none
//     never-filed 95.5          83.5          95.5          95.5          95.5
//   sound-library 100   100     100   100     100   100     100   100     100   100     none (blend not on File)
//
// Family arm (narrowed on top of the arm in use): shaped 11 family confident
// on 90% of tracks, right 99%, top-1 97.3 -> 97.3, top-3 100 -> 98.9: not used;
// shaped 5 95.7 -> 95.7, top-3 99.8 -> 98.8; shaped 3 95.7 -> 95.7, 99.7 -> 98.8: not used.
//
// The fabricated sound here is much stronger than real sound (it separates
// families by construction), so sound leading wins on these and the gate keeps
// today's rule on two of three seeds. The owner's own run decides for her
// account: there the blend alone was 66% against 60% with sound leading.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { shapedLibrary } from './fixtures/shaped-library.mjs';
import { soundWithTempo, shapedHome } from './fixtures/tempo-sound.mjs';
import { soundLibrary } from './fixtures/sound-library.mjs';
import { placementAccuracy, foldOf } from '../core/validate/loo.mjs';
import { baselineAccuracy } from '../core/validate/baseline.mjs';
import { blendAccuracy, blendFromRun, routeAccuracy, routeBeats, routeChoice, familiesOf, ROUTE_GATE } from '../core/validate/blend.mjs';
import { blendThree, blendScores, THREE_GRID, ROUTES, routeMode, soundLeads } from '../core/intrinsic/blend.mjs';
import { familyConfident, narrowToFamily } from '../core/intrinsic/family.mjs';
import { SOUND_FIRST_WEIGHTS } from '../core/intrinsic/space.mjs';
import { routeLines } from '../web/screens/engine.mjs';
import { helperRows } from '../web/screens/helpers.mjs';

const r1 = x => (x == null ? null : Math.round(x * 1000) / 10);

/* ---------- the pieces ---------- */

test('blendThree: weights per side, a silent side drops out, ties by id', () => {
  const tag = [['a', 1], ['b', 0.5]], nat = [['b', 1], ['a', 0.2]], snd = [['c', 1], ['b', 0.9]];
  assert.deepEqual(blendThree(tag, nat, snd, [1, 0, 0]).map(x => x[0]).slice(0, 2), ['a', 'b']);
  assert.deepEqual(blendThree(tag, nat, snd, [0, 0, 1]).map(x => x[0]).slice(0, 2), ['c', 'b']);
  assert.equal(blendThree(tag, nat, snd, [0.3, 0.3, 0.4])[0][0], 'b', 'second or first everywhere wins the mix');
  // No sound: the same order as the two-way blend at the same tags:engine ratio.
  assert.deepEqual(blendThree(tag, nat, [], [0.2, 0.2, 0.6]).map(x => x[0]), blendScores(tag, nat, 0.5).map(x => x[0]));
  assert.deepEqual(blendThree([], [], [], [0.3, 0.3, 0.4]), []);
  assert.deepEqual(blendThree([['b', 1], ['a', 1]], [], [], [1, 0, 0]).map(x => x[0]), ['a', 'b']);
  assert.equal(THREE_GRID.length, 66);
  for (const w of THREE_GRID) assert.ok(Math.abs(w[0] + w[1] + w[2] - 1) < 1e-9);
});

test('routeMode: unheard is always the blend; heard follows the route and the situation', () => {
  assert.equal(routeMode('today', { fresh: true, led: false }), 'blend');
  assert.equal(routeMode('route', { fresh: false, led: false }), 'blend');
  assert.equal(routeMode('today', { fresh: false, led: true }), 'sound');
  assert.equal(routeMode('route', { fresh: true, led: true }), 'sound');
  assert.equal(routeMode('route', { fresh: false, led: true }), 'blend');
  assert.equal(routeMode('route3', { fresh: false, led: true }), 'three');
  assert.equal(routeMode('three', { fresh: true, led: true }), 'three');
  assert.equal(routeMode('nonsense', { fresh: true, led: true }), 'sound', 'unknown: today');
  assert.deepEqual(Object.keys(ROUTES), ['today', 'blend', 'three', 'route', 'route3']);
});

test('soundLeads: sound\'s two, then the blend\'s, then the rest of sound\'s, no repeats', () => {
  assert.deepEqual(soundLeads(['s1', 's2', 's3'], ['b1', 's1', 'b2'], 3), ['s1', 's2', 'b1']);
  assert.deepEqual(soundLeads(['s1', 's2', 's3'], ['s2'], 3), ['s1', 's2', 's3']);
  assert.deepEqual(soundLeads(['s1'], [], 3), ['s1']);
});

test('the gate: a point of top-1, and no more than a point lost on never-filed or top-3', () => {
  const today = { top1: 0.60, top3: 0.86, neverFiled: { top1: 0.63 } };
  assert.deepEqual(ROUTE_GATE, { top1: 0.01, loss: 0.01 });
  assert.equal(routeBeats({ top1: 0.61, top3: 0.86, neverFiled: { top1: 0.63 } }, today), true);
  assert.equal(routeBeats({ top1: 0.609, top3: 0.86, neverFiled: { top1: 0.63 } }, today), false, 'short of a point');
  assert.equal(routeBeats({ top1: 0.66, top3: 0.89, neverFiled: { top1: 0.58 } }, today), false, 'never-filed down 5');
  assert.equal(routeBeats({ top1: 0.66, top3: 0.89, neverFiled: { top1: 0.62 } }, today), true, 'down exactly 1 is allowed');
  assert.equal(routeBeats({ top1: 0.66, top3: 0.84, neverFiled: { top1: 0.63 } }, today), false, 'top-3 down 2');
  assert.equal(routeBeats({ top1: null }, today), false);
  // The owner's paste: blend 66/89 (never-filed 58), sound leading 60/86 (63).
  // The blend alone fails on never-filed; routing never-filed to sound keeps them.
  const arms = { today, blend: { top1: 0.66, top3: 0.89, neverFiled: { top1: 0.58 } },
                 route: { top1: 0.655, top3: 0.885, neverFiled: { top1: 0.63 } },
                 three: { top1: 0.64, top3: 0.88, neverFiled: { top1: 0.62 } } };
  assert.equal(routeChoice(arms), 'route');
  assert.equal(routeChoice({ today, blend: arms.blend }), null);
  assert.equal(routeChoice({ today, three: arms.three, route3: { ...arms.three } }), 'three', 'a tie goes to the simpler');
});

test('family: confident only past the family threshold; narrowing keeps the order, never empties', () => {
  const families = new Map([['a', 'dnb'], ['b', 'dnb'], ['c', 'house']]);
  const cal = { T: 0.1, tau: 0.9, pmin: 0.05 };
  assert.equal(familyConfident([['a', 1], ['b', 0.95], ['c', 0.2]], families, 0.1, cal), 'dnb');
  assert.equal(familyConfident([['a', 1], ['c', 0.98], ['b', 0.2]], families, 0.1, cal), null, 'two families close');
  assert.equal(familyConfident([['a', 1]], families, 0.1, null), null);
  assert.deepEqual(narrowToFamily(['c', 'a', 'b'], 'dnb', families), ['a', 'b']);
  assert.deepEqual(narrowToFamily(['c'], 'dnb', families), ['c']);
  assert.deepEqual(narrowToFamily(['c', 'a'], null, families), ['c', 'a']);
});

/* ---------- the routing, on rows shaped like the owner's account ---------- */

/** Filed artists: tags and the engine right, sound wrong. Never filed: only sound right. */
function ownerShaped(n = 300) {
  const tagRows = [], natRows = [], sndRows = [], nf = new Set(), led = new Set();
  for (let i = 0; i < n; i++) {
    const id = 't' + i, fresh = i % 3 === 0;
    if (fresh) nf.add(id);
    if (i % 10) led.add(id);
    const truth = ['A'];
    tagRows.push({ id, truth, scores: fresh ? [['B', 1], ['A', 0.3]] : [['A', 1], ['B', 0.6]] });
    natRows.push({ id, truth, scores: fresh ? [['C', 1], ['A', 0.2]] : [['A', 1], ['C', 0.5]] });
    sndRows.push({ id, truth, scores: fresh ? [['A', 1], ['B', 0.9]] : [['C', 1], ['B', 0.95], ['A', 0.1]] });
  }
  return { tagRows, natRows, sndRows, nf, led };
}

test('routeAccuracy: on owner-shaped rows, routing by situation wins and is chosen', () => {
  const { tagRows, natRows, sndRows, nf, led } = ownerShaped();
  const b = blendAccuracy(tagRows, natRows, { neverFiled: nf });
  const r = routeAccuracy(tagRows, natRows, sndRows, { neverFiled: nf, led, blendFoldWeights: b.foldWeights });
  // Today's: filed heard tracks lose their first pick to sound.
  assert.ok(r.arms.route.top1 > r.arms.today.top1 + 0.01, `${r.arms.route.top1} vs ${r.arms.today.top1}`);
  assert.ok(r.arms.route.neverFiled.top1 >= r.arms.today.neverFiled.top1);
  assert.ok(r.arms.blend.neverFiled.top1 < r.arms.today.neverFiled.top1 - 0.01, 'the blend alone loses never-filed');
  assert.ok(['route', 'route3'].includes(r.choice), r.choice);
  assert.equal(r.use, true);
  assert.equal(r.scored, 300);
  assert.equal(r.heard, led.size);
  // Not heard: every arm is the blend.
  const off = routeAccuracy(tagRows, natRows, sndRows, { neverFiled: nf, led: new Set(), blendFoldWeights: b.foldWeights });
  for (const k of ['blend', 'three', 'route', 'route3']) assert.deepEqual(off.arms[k], off.arms.today, k);
  assert.equal(off.choice, null);
  // File not running the blend: measured, never used.
  const notOn = routeAccuracy(tagRows, natRows, sndRows, { neverFiled: nf, led, blendFoldWeights: b.foldWeights, blendOnFile: false });
  assert.equal(notOn.choice, null);
  assert.equal(notOn.use, false);
  assert.equal(notOn.family.use, false);
  assert.equal(routeAccuracy(tagRows, natRows, [], { led, blendFoldWeights: b.foldWeights }), null);
});

test('routeAccuracy: the three-way weight for fold f never sees fold f', () => {
  const { tagRows, natRows, sndRows, nf, led } = ownerShaped();
  const b = blendAccuracy(tagRows, natRows, { neverFiled: nf });
  const a = routeAccuracy(tagRows, natRows, sndRows, { neverFiled: nf, led, blendFoldWeights: b.foldWeights });
  // Reverse fold 0's sound rankings: fold 0's weights are chosen on the other folds, so they don't move.
  const flipped = sndRows.map(r => (foldOf(r.id) !== 0 ? r
    : { ...r, scores: r.scores.map(([id], j, all) => [all[all.length - 1 - j][0], r.scores[j][1]]) }));
  const again = routeAccuracy(tagRows, natRows, flipped, { neverFiled: nf, led, blendFoldWeights: b.foldWeights });
  assert.deepEqual(again.foldWeights[0], a.foldWeights[0]);
  assert.ok(Object.keys(a.foldWeights).length > 1);
});

/* ---------- measured on the fixtures (the table at the top) ---------- */

function measure(lib, targets, records, bridge) {
  const tags = {};
  lib.playlists.forEach((p, i) => p.tracks.forEach((t, j) => { if (j % 2) tags[t.artists[0].id] = { tags: [[`scene${i % 5}`, 100], [`g${i}`, 60]] }; }));
  const common = { folds: 5, targets: new Set(targets), bridge, collect: true, genreGraph: true, limit: 600,
                   audio: { records, learn: false }, soundWeights: SOUND_FIRST_WEIGHTS };
  const mine = placementAccuracy(lib, common);
  const base = baselineAccuracy(lib, tags, common);
  return blendFromRun(lib, { base, mine, folds: 5, targets: common.targets });
}
const row = r => [r.choice, ...['today', 'blend', 'three', 'route', 'route3'].map(k => [r1(r.arms[k].top1), r1(r.arms[k].top3), r1(r.arms[k].neverFiled.top1)]),
                  r1(r.family.arm.top1), r1(r.family.arm.top3), r.family.use];

test('S1 measured on the shaped seeds and the sound library: the table at the top', { timeout: 300000 }, () => {
  const got = {};
  for (const seed of [11, 5, 3]) {
    const lib = shapedLibrary({ seed });
    got['shaped' + seed] = row(measure(lib, lib.targets, soundWithTempo(lib, shapedHome(lib)), lib.bridge).route);
  }
  const s = soundLibrary();
  const sb = measure(s.lib, s.targets, s.records, null);
  got.soundlib = row(sb.route);
  assert.equal(sb.route.blendOnFile, false, 'no similar artists: File does not run the blend');
  assert.deepEqual(got, {
    shaped11: ['three', [96, 100, 96.9], [82.3, 94.3, 88.5], [97.3, 100, 98.4], [85.4, 96.6, 96.9], [96.8, 100, 96.9], 97.3, 98.9, false],
    shaped5: [null, [95.7, 99.8, 96.3], [83.5, 95.8, 88.4], [96.2, 100, 97.4], [86, 97.5, 96.3], [95.8, 100, 96.3], 95.7, 98.8, false],
    shaped3: [null, [95.7, 99.7, 95.5], [81.7, 95, 83.5], [95.2, 99.3, 95.5], [85.3, 97.6, 95.5], [95.2, 99.3, 95.5], 95.7, 98.8, false],
    soundlib: [null, [100, 100, null], [100, 100, null], [100, 100, null], [100, 100, null], [100, 100, null], 100, 100, false],
  }, 'the measured result moved: re-measure and update the table above\n' + JSON.stringify(got));
});

test('families come from the genre playlists\' names; mirrors and other playlists are left out', () => {
  const lib = { playlists: [{ id: 'p1', name: 'Jungle', tracks: [] }, { id: 'p2', name: 'Drum & Bass', tracks: [] },
                            { id: 'p3', name: 'Deep House', tracks: [] }, { id: 'p4', name: 'Sunday', tracks: [] }] };
  const f = familiesOf(lib, ['p1', 'p2', 'p3']);
  assert.equal(f.size, 3);
  assert.equal(f.get('p1'), f.get('p2'));
  assert.notEqual(f.get('p1'), f.get('p3'));
});

/* ---------- the Score report and "What's helping your picks" ---------- */

test('Score lines: every arm, the verdict, the family arm; nothing before a run', () => {
  const { tagRows, natRows, sndRows, nf, led } = ownerShaped();
  const b = blendAccuracy(tagRows, natRows, { neverFiled: nf });
  const route = routeAccuracy(tagRows, natRows, sndRows, { neverFiled: nf, led, blendFoldWeights: b.foldWeights });
  const pc = x => (x == null ? '—' : Math.round(x * 100) + '%');
  const lines = routeLines({ blend: { route } }, pc);
  assert.match(lines[0], /^Sound and the blend on the same 300 tracks \(270 sound could place\):$/);
  assert.match(lines[1], /^ {2}Sound leads on heard tracks \(today’s File\): top-1 \d+%, top-3 \d+%; never-filed \d+% \/ \d+%$/);
  assert.equal(lines.filter(l => l.startsWith('  ')).length, 5);
  assert.match(lines.find(l => l.startsWith('Sound and the blend: ')), /beats sound leading by \+\d+(\.\d)? points — File uses it$/);
  assert.match(lines.at(-1), /^Family narrowing: family confident on/);
  assert.deepEqual(routeLines({}, pc), []);
  assert.match(routeLines({ blend: { route: { ...route, choice: null, use: false } } }, pc).find(l => l.startsWith('Sound and the blend: ')),
               /File unchanged$/);
});

test('"What\'s helping your picks": a row once a Score run measured it, saying which way File places heard tracks', () => {
  const base = { audio: { on: true } };
  assert.equal(helperRows(base).find(r => r.id === 'soundroute'), undefined, 'before any run: no row');
  const on = helperRows({ ...base, soundRoute: { use: true, choice: 'route', today: { top1: 0.6 }, chosen: { top1: 0.655 }, family: { use: false } } })
    .find(r => r.id === 'soundroute');
  assert.equal(on.status, 'On');
  assert.match(on.did, /sound for artists you haven’t filed yet, tags and your filing for the rest, right first time 66% against 60%/);
  const off = helperRows({ ...base, soundRoute: { use: false, today: { top1: 0.6 }, family: { use: false } } }).find(r => r.id === 'soundroute');
  assert.equal(off.status, 'On · sound leads');
  assert.equal(helperRows({ audio: { on: false }, soundRoute: { use: true } }).find(r => r.id === 'soundroute'), undefined);
});

/* ---------- File: filePicks follows the route, and is today's without one ---------- */

const SLOTS = readFileSync(new URL('../web/app/soundslots.js', import.meta.url), 'utf8');
const FILE_PICKS = SLOTS.slice(SLOTS.indexOf('function filePicks('), SLOTS.indexOf('/* Package 5'));

function filePicksWith(ctx) {
  const c = vm.createContext({ filePairOrder: (t, p) => p, ...ctx });
  vm.runInContext(FILE_PICKS + '\nthis.filePicks = filePicks;', c);
  return c.filePicks;
}
const S = [{ id: 's1', via: 'sound' }, { id: 's2', via: 'sound' }, { id: 's3', via: 'sound' }];
const B = [{ id: 'b1', via: 'blend' }, { id: 'b2', via: 'blend' }, { id: 'b3', via: 'blend' }];
const T3 = [{ id: 'x1', via: 'blend' }, { id: 'x2', via: 'blend' }];
const ids = p => p.map(x => x.id);

test('filePicks: no route stored is today\'s order exactly; each mode picks its way', () => {
  const common = { blendPicks: () => B, soundPicks: () => S, blendThreePicks: () => T3 };
  // No route functions at all (the old page), and a route that says sound: today's.
  assert.deepEqual(ids(filePicksWith(common)({ id: 't' })), ['s1', 's2', 'b1']);
  assert.deepEqual(ids(filePicksWith({ ...common, fileRouteMode: () => 'sound', fileFamilyNarrow: (t, p) => p })({ id: 't' })), ['s1', 's2', 'b1']);
  assert.deepEqual(ids(filePicksWith({ ...common, fileRouteMode: () => 'blend' })({ id: 't' })), ['b1', 'b2', 'b3']);
  assert.deepEqual(ids(filePicksWith({ ...common, fileRouteMode: () => 'three' })({ id: 't' })), ['x1', 'x2']);
  // Three-way can't be made (no sound scores yet): sound leads, as today.
  assert.deepEqual(ids(filePicksWith({ ...common, blendThreePicks: () => [], fileRouteMode: () => 'three' })({ id: 't' })), ['s1', 's2', 'b1']);
  // Blend chosen but nothing from it: sound's picks rather than none.
  assert.deepEqual(ids(filePicksWith({ ...common, blendPicks: () => [], fileRouteMode: () => 'blend' })({ id: 't' })), ['s1', 's2', 's3']);
  // Not heard: the blend, whatever the route says.
  let asked = false;
  assert.deepEqual(ids(filePicksWith({ ...common, soundPicks: () => [], fileRouteMode: () => { asked = true; return 'three'; } })({ id: 't' })), ['b1', 'b2', 'b3']);
  assert.equal(asked, false);
  // The family narrowing sees the routed picks last.
  assert.deepEqual(ids(filePicksWith({ ...common, fileRouteMode: () => 'blend', fileFamilyNarrow: (t, p) => p.slice(1) })({ id: 't' })), ['b2', 'b3']);
});
