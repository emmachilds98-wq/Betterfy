// WP-E2: audio wired into the engine (core/intrinsic/space.mjs), the
// with/without harness (core/validate/loo.mjs) and the gate
// (core/validate/gate.mjs).
//
// First, as every engine package must: with no audio, nothing changes. Here
// "nothing" is held to main itself, not to this branch before the change: the
// fixture's whole engine output, version strings aside, hashes to what main
// produced before WP-E2 (test/fixtures/space-v4-golden.json). If an intended
// engine change ever moves it, regenerate that file from the new main with
// `engineSnapshot` in test/fixtures/engine-library.mjs, and say so in the PR.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { fixture, FAMILIES, engineSnapshot, unversioned } from './fixtures/engine-library.mjs';
import { buildSpace, placements, WEIGHTS, SPACE_VERSION, relativeSound } from '../core/intrinsic/space.mjs';
import { serialiseSpace } from '../core/intrinsic/persist.mjs';
import { placementAccuracy } from '../core/validate/loo.mjs';
import { audioGate, audioInUse, audioCalibration, GATE } from '../core/validate/gate.mjs';
import { audioIndex } from '../core/intrinsic/audio.mjs';
import { makeRecord, makeMiss, MISS, N_STYLES, EMB_DIM } from '../core/audio/record.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const GOLDEN = JSON.parse(readFileSync(new URL('./fixtures/space-v4-golden.json', import.meta.url), 'utf8'));
const LIB = fixture();
const TARGETS = FAMILIES.map(f => `p-${f}`);

/* ---------- synthetic sound: tracks of one family sound alike ---------- */

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5;
}
const familyDir = fam => { const r = rng(1 + FAMILIES.indexOf(fam) * 7919); return Float32Array.from({ length: EMB_DIM }, r); };
function embFor(id, { noise = 0.6, fam = id.split('-')[0] } = {}) {
  const dir = familyDir(fam);
  const r = rng([...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7));
  return Float32Array.from(dir, v => v + noise * r());
}
function recordFor(id, opts = {}) {
  const activations = new Float32Array(N_STYLES).fill(0.01);
  activations[(id.length * 13) % N_STYLES] = 0.8;
  return makeRecord({ id, isrc: 'GBXXX0000001', activations, embeddings: embFor(id, opts), patches: 1,
                      source: { kind: 'deezer-isrc', deezerId: 1, windows: [[0, 165000]], seconds: 10 },
                      mel: '1.0.0', at: 1000 });
}
const RECORDS = LIB.all.map(t => recordFor(t.id));

const everyPlacement = (space, opts = {}) => LIB.all.map(t => placements(t, space, { limit: Infinity, why: true, ...opts }));
const serial = space => { const { builtAt, ...rest } = serialiseSpace(space, LIB); return JSON.stringify(rest); };
const sha = s => createHash('sha256').update(s).digest('hex');

/* ---------- THE GUARD ---------- */

test('THE AUDIO GUARD: with no audio, the engine says exactly what main said', async () => {
  const s = JSON.stringify(await engineSnapshot(ROOT));
  assert.equal(s.length, GOLDEN.bytes, 'same size as main\'s output');
  assert.equal(sha(s), GOLDEN.sha256, 'same bytes as main\'s output');
});

test('THE AUDIO GUARD: audio null, empty, or only misses is the same as no audio', () => {
  const plain = buildSpace(LIB);
  const none = [null, undefined, [], new Map(), {},
                LIB.all.map(t => makeMiss({ id: t.id, reason: MISS.NO_PREVIEW, at: 0 })),
                { records: [] }, { index: new Map() }, { records: [], learn: () => () => new Map() }];
  for (const audio of none) {
    const space = buildSpace(LIB, { audio });
    assert.deepEqual(Object.keys(space), Object.keys(plain), 'no new keys on the space');
    assert.equal(serial(space), serial(plain));
    assert.equal(JSON.stringify(everyPlacement(space)), JSON.stringify(everyPlacement(plain)));
    assert.equal(JSON.stringify(everyPlacement(space, { useAudio: true })), JSON.stringify(everyPlacement(plain)),
      'even with useAudio, nothing heard means nothing changes');
  }
  const acc = placementAccuracy(LIB, { collect: true });
  assert.deepEqual(placementAccuracy(LIB, { audio: null, collect: true }), acc);
  assert.equal(acc.withAudio, undefined);
});

test('the version strings moved, and nothing else in the version-free output did', () => {
  assert.equal(SPACE_VERSION, '4.1.0');
  assert.equal(placements(LIB.all[0], buildSpace(LIB)).version, '4.1.0');
  assert.ok('audio' in WEIGHTS && 'learned' in WEIGHTS);
  assert.equal(unversioned({ version: 1, a: { version: 2, b: 3 } }).a.b, 3);
});

/* ---------- display-only until the gate passes ---------- */

test('with audio but without useAudio, sound is shown on each row and changes nothing else', () => {
  const plain = everyPlacement(buildSpace(LIB));
  const heard = everyPlacement(buildSpace(LIB, { audio: RECORDS }));
  assert.equal(heard.length, plain.length);
  let shown = 0;
  heard.forEach((out, i) => {
    const want = plain[i];
    assert.equal(out.band, want.band);
    assert.equal(out.margin, want.margin);
    assert.equal(out.results.length, want.results.length);
    out.results.forEach((r, j) => {
      const { heard: h, ...rest } = r;
      assert.deepEqual(rest, want.results[j], 'score, order, parts and why are untouched');
      assert.ok(!('audio' in r.parts) && !('learned' in r.parts));
      if (h) { shown++; assert.ok(h.audio === null || Number.isFinite(h.audio)); assert.equal(h.learned, null); }
    });
  });
  assert.ok(shown > 0, 'the fixture must actually show some sound');
});

test('an unheard track gets no heard key, even in a space with sound', () => {
  const heardOnly = RECORDS.filter(r => !r.id.startsWith('jungle'));
  const space = buildSpace(LIB, { audio: heardOnly });
  for (const t of LIB.all.filter(t => t.id.startsWith('jungle'))) {
    const out = placements(t, space, { limit: Infinity, useAudio: true });
    assert.equal(JSON.stringify(out), JSON.stringify(placements(t, buildSpace(LIB), { limit: Infinity })));
  }
});

test('with useAudio, sound enters parts and can move the answer toward how it sounds', () => {
  // A jungle track whose artists say "jungle" but which sounds exactly like ambient.
  const odd = LIB.all.find(t => t.id === 'jungle-t3');
  const recs = RECORDS.map(r => (r.id === odd.id ? recordFor(odd.id, { fam: 'ambient', noise: 0.05 }) : r));
  const space = buildSpace(LIB, { audio: recs, targets: TARGETS });
  const off = placements(odd, space, { limit: Infinity });
  const on = placements(odd, space, { limit: Infinity, useAudio: true, weights: { ...WEIGHTS, audio: 50 } });
  assert.equal(off.results[0].playlistId, 'p-jungle');
  assert.equal(on.results[0].playlistId, 'p-ambient', 'a heavy enough sound weight follows the sound');
  assert.ok(on.results.every(r => 'audio' in r.parts));
  assert.equal(on.results[0].parts.audio, 1, 'the closest-sounding playlist is 1 on the relative scale');
});

/* ---------- relativeSound ---------- */

test('relativeSound: 0 to 1 across judged destinations, the mean for unjudged, null when nothing ranks', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const out = relativeSound(new Map([['a', 0.9], ['b', 0.8], ['c', null]]), ids);
  assert.deepEqual([...out], [['a', 1], ['b', 0], ['c', 0.5], ['d', 0.5]]);
  assert.equal(relativeSound(null, ids), null);
  assert.equal(relativeSound(new Map([['a', 0.9]]), ids), null, 'one judged destination ranks nothing');
  assert.equal(relativeSound(new Map([['a', 0.9], ['b', 0.9]]), ids), null, 'no spread ranks nothing');
  assert.equal(relativeSound(new Map([['a', 0.9], ['b', NaN], ['c', null]]), ids), null);
});

/* ---------- the learner hook ---------- */

test('a learner is trained per space without the held-out fold, and its scores are gated like audio', () => {
  const seen = [];
  const learn = ({ index, profiles, minMembers }) => {
    const train = new Set();
    for (const p of profiles.values()) for (const id of p.ids) train.add(id);
    seen.push(train);
    assert.ok(index.size > 0 && minMembers >= 1);
    // A toy "learner": certain of the track's own family playlist.
    return { learnedScores: t => new Map([...profiles.keys()].map(pid => [pid, pid === `p-${t.id.split('-')[0]}` ? 0.9 : 0.1 / 6])) };
  };
  const skip = new Set(['deep-t1', 'tech-t2']);
  const space = buildSpace(LIB, { audio: { records: RECORDS, learn }, skip });
  assert.equal(seen.length, 1);
  for (const id of skip) assert.ok(!seen[0].has(id), `${id} must not train the learner that scores it`);
  assert.equal(typeof space.learned, 'function');

  const t = LIB.all.find(x => x.id === 'deep-t1');
  const off = placements(t, space, { limit: Infinity });
  assert.ok(off.results.every(r => !('learned' in r.parts)));
  const deep = off.results.find(r => r.playlistId === 'p-deep');
  assert.equal(deep.heard.learned, 0.9, 'shown');
  const on = placements(t, space, { limit: Infinity, useAudio: true });
  assert.equal(on.results.find(r => r.playlistId === 'p-deep').parts.learned, 1);

  // A bare function works as a learner too, and a learner that returns nothing is ignored.
  assert.equal(typeof buildSpace(LIB, { audio: { records: RECORDS, learn: () => () => null } }).learned, 'function');
  assert.equal(buildSpace(LIB, { audio: { records: RECORDS, learn: () => null } }).learned, undefined);
});

test('placementAccuracy trains one learner per fold, never on that fold', () => {
  const trained = [];
  const learn = ({ profiles }) => {
    const ids = new Set(); for (const p of profiles.values()) for (const id of p.ids) ids.add(id);
    trained.push(ids);
    return () => null;
  };
  const acc = placementAccuracy(LIB, { audio: { records: RECORDS, learn }, folds: 5 });
  assert.equal(trained.length, 5);
  assert.equal(acc.withAudio.learner, true);
  // Every scored track is absent from exactly the one learner whose fold it was scored in.
  const absent = new Map();
  for (const ids of trained) for (const t of LIB.all) if (!ids.has(t.id)) absent.set(t.id, (absent.get(t.id) ?? 0) + 1);
  for (const t of LIB.all) assert.ok(absent.get(t.id) >= 1, `${t.id} was held out of some learner`);
});

/* ---------- the with/without harness ---------- */

test('with/without: same folds, same tracks; headline unchanged, sound reported beside it', () => {
  const plain = placementAccuracy(LIB, { collect: true });
  const acc = placementAccuracy(LIB, { audio: RECORDS, collect: true });
  const { withAudio, ...head } = acc;
  assert.deepEqual(head, plain, 'the headline numbers are not moved by passing audio');

  assert.equal(withAudio.scored, acc.scored);
  assert.equal(withAudio.neverFiled.scored, acc.neverFiled.scored, 'the never-filed subset is the same tracks');
  assert.equal(withAudio.heard, acc.scored, 'every fixture track was heard');
  assert.equal(withAudio.analysed, RECORDS.length);
  assert.ok(withAudio.judged > 0, 'sound had a say');
  assert.equal(withAudio.rows.length, acc.rows.length);
  assert.deepEqual(withAudio.rows.map(r => r.id), acc.rows.map(r => r.id), 'same tracks, same order');
  assert.deepEqual(withAudio.weights, { audio: WEIGHTS.audio, learned: WEIGHTS.learned });
  assert.ok(withAudio.gate && 'pass' in withAudio.gate, 'the verdict travels with the run');

  // The families sound distinct, so sound should help the never-filed tracks
  // (here the orphans: their artists appear nowhere else) and not hurt overall.
  assert.ok(withAudio.top1 >= acc.top1, `overall ${withAudio.top1} vs ${acc.top1}`);
  assert.ok(withAudio.neverFiled.top1 > acc.neverFiled.top1,
    `never-filed ${withAudio.neverFiled.top1} vs ${acc.neverFiled.top1}`);
});

test('with/without: a held-out track never hears itself', () => {
  // Every track sounds like nothing else in the library: unique random
  // directions. If a track's own embedding leaked into the centroid it is
  // scored against, its own playlists would win far more often than chance.
  const recs = LIB.all.map(t => {
    const r = rng([...t.id].reduce((h, c) => (h * 33 + c.charCodeAt(0)) >>> 0, 11));
    return makeRecord({ id: t.id, isrc: 'GBXXX0000001', activations: new Float32Array(N_STYLES).fill(0.01),
                        embeddings: Float32Array.from({ length: EMB_DIM }, r), patches: 1,
                        source: { kind: 'deezer-isrc', deezerId: 1, windows: [[0, 165000]], seconds: 10 },
                        mel: '1.0.0', at: 1 });
  });
  const acc = placementAccuracy(LIB, { audio: recs, targets: new Set(TARGETS),
                                       weights: { ...WEIGHTS, graph: 0, registrant: 0, minutes: 0, era: 0,
                                                  albumType: 0, albumTracks: 0, popularity: 0, audio: 1 } });
  const leaky = placementAccuracy(LIB, { audio: recs, targets: new Set(TARGETS), leaky: true,
                                         weights: { ...WEIGHTS, graph: 0, registrant: 0, minutes: 0, era: 0,
                                                    albumType: 0, albumTracks: 0, popularity: 0, audio: 1 } });
  assert.ok(leaky.withAudio.top1 > 0.9, `the leaky canary recognises tracks it was shown (${leaky.withAudio.top1})`);
  assert.ok(acc.withAudio.top1 < 0.5, `honest folds stay near chance on noise (${acc.withAudio.top1})`);
});

test('the index is accepted prebuilt, and a run with records but none heard is NOTHING_HEARD', () => {
  const a = placementAccuracy(LIB, { audio: RECORDS });
  const b = placementAccuracy(LIB, { audio: { index: audioIndex(RECORDS) } });
  assert.deepEqual(b, a);
  const none = placementAccuracy(LIB, { audio: [makeMiss({ id: 'tech-t0', reason: MISS.NO_ISRC, at: 0 })] });
  assert.equal(none.withAudio.heard, 0);
  assert.equal(none.withAudio.top1, none.top1);
  assert.equal(none.withAudio.gate.pass, null);
  assert.equal(none.withAudio.gate.reason, 'NOTHING_HEARD');
});

test('both halves go through calibrate.mjs', () => {
  const acc = placementAccuracy(LIB, { audio: RECORDS, collect: true });
  const cal = audioCalibration(acc);
  assert.ok(cal.without?.checked, 'without sound');
  assert.ok(cal.withAudio?.checked, 'with sound');
  assert.equal(cal.without.checked.n, cal.withAudio.checked.n, 'checked on the same tracks');
  assert.deepEqual(audioCalibration(placementAccuracy(LIB, {})), { without: null, withAudio: null });
});

/* ---------- the gate ---------- */

/** A run result with just what the gate reads. Rates as fractions. */
function run({ top1 = 0.6, nf = 40, nfTop1 = 0.2, wTop1 = top1, wNfTop1 = nfTop1, heard = 100, heardNf = 30 } = {}) {
  return { top1, neverFiled: { scored: nf, top1: nfTop1, top3: null },
           withAudio: { top1: wTop1, neverFiled: { scored: nf, top1: wNfTop1, top3: null }, heard, heardNeverFiled: heardNf } };
}

test('gate: passes at +5 points on never-filed with no loss overall, exactly at the bar too', () => {
  const g = audioGate(run({ nfTop1: 0.2, wNfTop1: 0.25 }));
  assert.equal(g.pass, true);
  assert.equal(g.reason, 'PASS');
  assert.equal(g.lift, 0.05);
  assert.equal(g.overall, 0);
  assert.equal(audioInUse(g), true);
  assert.equal(audioGate(run({ nfTop1: 0.3125, wNfTop1: 0.4, wTop1: 0.61 })).pass, true);
});

test('gate: fails on less than +5 points, and on any loss overall however big the lift', () => {
  const small = audioGate(run({ nfTop1: 0.2, wNfTop1: 0.2499 }));
  assert.equal(small.pass, false);
  assert.equal(small.reason, 'NOT_ENOUGH_LIFT');
  assert.equal(audioInUse(small), false);

  const costly = audioGate(run({ nfTop1: 0.2, wNfTop1: 0.6, top1: 0.6, wTop1: 0.5999 }));
  assert.equal(costly.pass, false);
  assert.equal(costly.reason, 'COSTS_OVERALL');
  assert.match(costly.text, /display-only/);

  assert.equal(audioGate(run({ nfTop1: 0.3, wNfTop1: 0.2 })).reason, 'NOT_ENOUGH_LIFT', 'a negative lift fails');
});

test('gate: undecided (null) when there is too little to judge, and never in use', () => {
  const cases = [
    [null, 'NOT_RUN'],
    [{ top1: 0.5, neverFiled: { scored: 50, top1: 0.1 } }, 'NOT_RUN'],
    [run({ heard: 0 }), 'NOTHING_HEARD'],
    [run({ nf: GATE.minNeverFiled - 1, wNfTop1: 0.9 }), 'TOO_FEW_NEVER_FILED'],
    [run({ heardNf: GATE.minHeardNeverFiled - 1, wNfTop1: 0.9 }), 'TOO_FEW_HEARD'],
  ];
  for (const [acc, reason] of cases) {
    const g = audioGate(acc);
    assert.equal(g.pass, null, reason);
    assert.equal(g.reason, reason);
    assert.equal(audioInUse(g), false);
    assert.equal(typeof g.text, 'string');
  }
  assert.equal(audioInUse(undefined), false);
  assert.equal(audioInUse({ pass: 'yes' }), false, 'only a real pass counts');
});

test('gate: the bar can be read from the verdict and overridden for a sweep', () => {
  const g = audioGate(run({ nfTop1: 0.2, wNfTop1: 0.23 }), { minLift: 0.02 });
  assert.equal(g.pass, true);
  assert.equal(g.bar.minLift, 0.02);
  assert.equal(audioGate(run()).bar.minLift, 0.05);
});

test('gate on the fixture: undecided, because 4 never-filed tracks cannot show a 5-point lift', () => {
  const acc = placementAccuracy(LIB, { audio: RECORDS });
  assert.equal(acc.neverFiled.scored, 4);
  assert.equal(acc.withAudio.gate.reason, 'TOO_FEW_NEVER_FILED');
  assert.equal(audioInUse(acc.withAudio.gate), false);
});
