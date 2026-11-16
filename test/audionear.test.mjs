// Nearest members (docs/review/ENGINE-REVIEW.md layer 1): core/intrinsic/audio.mjs
// nearMix and `near` on the audio layer, the Score arm (loo.mjs 'near'), the
// rule that decides it (gate.mjs nearChoice), and the page's switch for it
// (web/audio/maest-run.mjs nearInUse / scoreArms).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeRecord, N_STYLES, EMB_DIM } from '../core/audio/record.mjs';
import { audioIndex, buildAudioProfiles, audioScores, nearMix, NEAR_DEFAULT } from '../core/intrinsic/audio.mjs';
import { buildSpace, placements } from '../core/intrinsic/space.mjs';
import { placementAccuracy } from '../core/validate/loo.mjs';
import { nearChoice, NEAR_GATE } from '../core/validate/gate.mjs';
import { scoreArms, nearInUse, nearScoreText, NEAR_SETTING } from '../web/audio/maest-run.mjs';
import { fixture, FAMILIES } from './fixtures/engine-library.mjs';

const LIB = fixture();
const TARGETS = FAMILIES.map(f => `p-${f}`);

function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5; }
const hash = id => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const dir = salt => { const r = rng(salt); return Float32Array.from({ length: EMB_DIM }, r); };
/** Each family holds two sounds: even-numbered tracks one, odd the other. */
const embFor = id => {
  const [fam, t] = id.split('-'), n = parseInt(t.slice(1), 10) || 0;
  const d = dir(1 + FAMILIES.indexOf(fam) * 7919 + (n % 2) * 104729), r = rng(hash(id));
  return Float32Array.from(d, v => v + 0.6 * r());
};
const rec = id => {
  const activations = new Float32Array(N_STYLES).fill(0.01); activations[3] = 0.5;
  return makeRecord({ id, isrc: 'GBXXX0000001', activations, embeddings: embFor(id), patches: 1,
                      source: { kind: 'deezer-isrc', deezerId: 1, windows: [[0, 165000]], seconds: 10 }, mel: '1.0.0', at: 1000 });
};
const RECORDS = LIB.all.map(t => rec(t.id));

test('nearMix: the centroid unchanged without near, else (1 - mix) centroid + mix mean of the top k', () => {
  assert.equal(nearMix(0.4, [0.9, 0.1], null), 0.4);
  assert.equal(nearMix(0.4, [0.9, 0.1], { k: 3, mix: 0 }), 0.4);
  assert.equal(nearMix(0.4, [], { k: 3, mix: 0.5 }), 0.4, 'no members to compare is the centroid');
  assert.ok(Math.abs(nearMix(0.4, [0.9, 0.1, 0.7, 0.2], { k: 2, mix: 0.5 }) - (0.2 + 0.5 * 0.8)) < 1e-12);
  assert.ok(Math.abs(nearMix(0.4, [0.9], { k: 3, mix: 0.5 }) - 0.65) < 1e-12, 'k caps at the members there are');
  assert.deepEqual(NEAR_DEFAULT, { k: 5, mix: 0.3 });
  assert.equal(NEAR_SETTING, NEAR_DEFAULT);
});

test('without near the audio layer and every score are exactly as before', () => {
  const index = audioIndex(RECORDS);
  const plain = buildAudioProfiles(buildSpace(LIB, { targets: TARGETS }), index);
  const off = buildAudioProfiles(buildSpace(LIB, { targets: TARGETS }), index, { near: { k: 3, mix: 0 } });
  assert.equal('near' in plain, false);
  assert.equal('near' in off, false, 'mix 0 is off');
  for (const t of LIB.all) assert.deepEqual(audioScores(t, off), audioScores(t, plain));
  const a = buildSpace(LIB, { targets: TARGETS, audio: RECORDS }), b = buildSpace(LIB, { targets: TARGETS, audio: { records: RECORDS } });
  for (const t of LIB.all.slice(0, 10))
    assert.deepEqual(placements(t, a, { useAudio: true, limit: 9 }), placements(t, b, { useAudio: true, limit: 9 }));
});

test('with near a track is scored against its playlist’s nearest members, never itself', () => {
  const index = audioIndex(RECORDS);
  const space = buildSpace(LIB, { targets: TARGETS });
  const near = buildAudioProfiles(space, index, { near: NEAR_DEFAULT });
  assert.deepEqual(near.near, NEAR_DEFAULT);
  const t = LIB.all[0];
  const loo = audioScores(t, near, { leaveOneOut: true });
  const plain = audioScores(t, buildAudioProfiles(space, index), { leaveOneOut: true });
  assert.notDeepEqual(loo, plain);
  // By hand for its own playlist: centroid without it, and its 5 closest others.
  const dest = [...space.destinations.values()].find(d => d.trackIds?.includes?.(t.id) || [...(d.trackIds ?? [])].includes(t.id));
  const me = index.get(t.id).emb, dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
  const others = [...near.profiles.get(dest.id).ids].filter(id => id !== t.id).map(id => index.get(id).emb);
  const sum = new Float64Array(EMB_DIM); for (const e of others) for (let i = 0; i < EMB_DIM; i++) sum[i] += e[i];
  const c = dot(me, sum) / Math.sqrt(dot(sum, sum));
  const top = others.map(e => dot(me, e)).sort((x, y) => y - x).slice(0, 5);
  assert.ok(Math.abs(loo.get(dest.id) - (0.7 * c + 0.3 * top.reduce((x, y) => x + y) / top.length)) < 1e-5);
});

test('Score arm "near": same folds and tracks, first ear untouched, with its own verdict and nearChoice', () => {
  const plain = placementAccuracy(LIB, { targets: TARGETS, audio: { records: RECORDS } });
  const acc = placementAccuracy(LIB, { targets: TARGETS, audio: { records: RECORDS, arms: ['near'] } });
  const { arms, nearChoice: nc, choice, ...w } = acc.withAudio;
  const { gate: _g, ...p } = plain.withAudio; const { gate: _h, ...q } = w;
  assert.deepEqual(q, p, 'the first ear’s numbers do not move');
  assert.ok(arms.near && arms.near.all === undefined);
  assert.equal(arms.near.analysed, plain.withAudio.analysed);
  assert.ok(arms.near.gate);
  assert.equal(choice.ear, 'effnet', 'near is never an ear');
  assert.equal(typeof nc.use, 'boolean');
  assert.match(nc.text, /nearest tracks/);
  // A prebuilt index has no records, and still gets the near arm.
  const idx = placementAccuracy(LIB, { targets: TARGETS, audio: { index: audioIndex(RECORDS), arms: ['near', 'maest'] } });
  assert.deepEqual(Object.keys(idx.withAudio.arms), ['near']);
});

test('nearChoice: used only when the arm passes the gate, gains 2 points overall, and loses nothing on never-filed', () => {
  const acc = (arm, base = { top1: 0.5, neverFiled: { top1: 0.3 } }) => ({ withAudio: { ...base, arms: { near: arm } } });
  const pass = { pass: true };
  assert.equal(nearChoice({ withAudio: { top1: 0.5 } }).reason, 'NO_ARM');
  assert.equal(nearChoice(acc({ top1: 0.6, neverFiled: { top1: 0.3 }, gate: { pass: null } })).reason, 'UNDECIDED');
  assert.equal(nearChoice(acc({ top1: 0.52, neverFiled: { top1: 0.3 }, gate: pass })).use, true, 'exactly the bar');
  assert.equal(nearChoice(acc({ top1: 0.519, neverFiled: { top1: 0.3 }, gate: pass })).use, false);
  assert.equal(nearChoice(acc({ top1: 0.6, neverFiled: { top1: 0.29 }, gate: pass })).use, false, 'a loss on never-filed');
  assert.equal(nearChoice(acc({ top1: 0.6, neverFiled: { top1: 0.3 }, gate: { pass: false } })).use, false);
  const c = nearChoice(acc({ top1: 0.55, neverFiled: { top1: 0.32 }, gate: pass }));
  assert.equal(c.use, true); assert.equal(c.lift, 0.05); assert.equal(c.neverFiled, 0.02);
  assert.match(c.text, /\+5 points overall, \+2 points on never-filed artists — used/);
  assert.equal(NEAR_GATE.minLift, 0.02);
});

test('page: Score asks for the near arm whenever something is heard; File uses it only when chosen, on the first ear', () => {
  assert.equal(scoreArms([]), null);
  assert.deepEqual(scoreArms([rec('tech-t0')]), ['near']);
  assert.equal(nearInUse(null), false);
  assert.equal(nearInUse({ ear: 'effnet', near: true }), true);
  assert.equal(nearInUse({ ear: 'effnet', near: true }, 'maest'), false);
  assert.equal(nearInUse({ ear: 'effnet' }), false);
  assert.equal(nearScoreText({ nearChoice: { text: 'x' } }), 'x');
  assert.equal(nearScoreText({}), '');
});

test('learnFiled: a tap files the track into the playlist’s artists, tag centroid and sound at once', async () => {
  const { learnFiled } = await import('../core/intrinsic/space.mjs');
  // Leave one track out of its playlist, then file it live.
  const t = LIB.all.find(x => x.id === 'tech-t3');
  const lib = { ...LIB, playlists: LIB.playlists.map(p => ({ ...p, tracks: p.tracks.filter(x => x.id !== t.id) })) };
  const space = buildSpace(lib, { targets: TARGETS, audio: RECORDS });
  const d = space.destinations.get('p-tech'), prof = space.audio.profiles.get('p-tech');
  const n0 = d.n, m0 = prof.members, before = audioScores(t, space).get('p-tech');
  assert.equal(d.trackIds.has(t.id), false);
  assert.equal(learnFiled(space, t, 'p-tech'), true);
  assert.equal(d.n, n0 + 1);
  assert.ok(d.trackIds.has(t.id));
  for (const a of t.artists) assert.ok(d.artists.has(a.id));
  assert.equal(prof.members, m0 + 1);
  assert.ok(prof.ids.has(t.id));
  assert.ok(audioScores(t, space).get('p-tech') > before, 'its own sound now pulls toward the playlist');
  assert.equal(learnFiled(space, t, 'p-tech'), false, 'filing twice changes nothing');
  assert.equal(learnFiled(space, t, 'p-nope'), false);
  assert.equal(learnFiled(null, t, 'p-tech'), false);
});
