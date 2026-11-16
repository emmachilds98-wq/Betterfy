// WP-C1: MAEST, the second ear (core/audio/maest.mjs), its index and Score
// arm (core/intrinsic/audio.mjs `ear`, core/validate/loo.mjs `arms`) and the
// rule that it changes nothing until it beats the first ear (gate.mjs earChoice).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { maestPatches, createMaestEar, hearMaest, fillMaest, needsMaest, pickMaestOutputs,
         MAEST_PATCH_FRAMES, MAEST_MEAN, MAEST_STD, MAEST_MIN_FRAMES, EMB_OUTPUT, ACT_OUTPUT, MAEST_FILE } from '../core/audio/maest.mjs';
import { makeRecord, makeEar, withEar, earCurrent, validRecord, unpackEmbedding, packEmbedding,
         N_STYLES, EMB_DIM, MAEST_DIM, MAEST_N_STYLES, MAEST_MODEL, CLAP_DIM } from '../core/audio/record.mjs';
import { N_BANDS, SAMPLE_RATE, HOP_SIZE } from '../core/audio/mel.mjs';
import { audioIndex, EARS } from '../core/intrinsic/audio.mjs';
import { buildSpace, placements, WEIGHTS } from '../core/intrinsic/space.mjs';
import { placementAccuracy } from '../core/validate/loo.mjs';
import { earChoice, audioGate, EAR_GATE, GATE } from '../core/validate/gate.mjs';
import { fixture, FAMILIES } from './fixtures/engine-library.mjs';

const LIB = fixture();
const TARGETS = FAMILIES.map(f => `p-${f}`);

function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5; }
const hash = (id, k = 7) => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, k);
const dirOf = (fam, dim, salt) => { const r = rng(1 + FAMILIES.indexOf(fam) * 7919 + salt); return Float32Array.from({ length: dim }, r); };
const embFor = (id, dim, noise, salt) => { const d = dirOf(id.split('-')[0], dim, salt), r = rng(hash(id, salt + 3)); return Float32Array.from(d, v => v + noise * r()); };
const cos = (a, b) => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] ** 2; y += b[i] ** 2; } return d / Math.sqrt(x * y); };

/** The first ear hears families badly (noisy); MAEST hears them well. */
function recordFor(id, { effNoise = 4, maest = true, maestNoise = 0.3 } = {}) {
  const activations = new Float32Array(N_STYLES).fill(0.01);
  activations[(id.length * 13) % N_STYLES] = 0.8;
  const rec = makeRecord({ id, isrc: 'GBXXX0000001', activations, embeddings: embFor(id, EMB_DIM, effNoise, 0), patches: 1,
                           source: { kind: 'deezer-isrc', deezerId: 1, windows: [[0, 165000]], seconds: 10 }, mel: '1.0.0', at: 1000 });
  if (!maest) return rec;
  const act = new Float32Array(MAEST_N_STYLES).fill(0.02); act[FAMILIES.indexOf(id.split('-')[0]) + 100] = 0.9;
  return withEar(rec, 'maest', makeEar('maest', { embedding: embFor(id, MAEST_DIM, maestNoise, 500), activations: act }));
}
const strip = r => { const { maest, clap, ...rest } = r; return { ...rest, v: 1 }; };

/* ---------- the input: same mel, MAEST's normalisation, 626-frame patches ---------- */

test('maestPatches: normalised as Essentia does, one patch per 10 s window', () => {
  const frames = 640, data = Float32Array.from({ length: frames * N_BANDS }, (_, i) => (i % 97) / 10);
  const p = maestPatches({ frames, data });
  assert.equal(p.patches, 1);
  assert.equal(p.data.length, MAEST_PATCH_FRAMES * N_BANDS);
  for (const i of [0, 5, 96 * 300 + 7, MAEST_PATCH_FRAMES * N_BANDS - 1])
    assert.ok(Math.abs(p.data[i] - (data[i] - MAEST_MEAN) / (2 * MAEST_STD)) < 1e-6);
  assert.equal(maestPatches({ frames: 626 + 625, data: new Float32Array(1251 * N_BANDS) }).patches, 2);
  // 10 s at 16 kHz is 625 frames by the mel's frame rule, so a window of ~10.3 s is one patch.
  assert.ok((10.3 * SAMPLE_RATE) / HOP_SIZE > MAEST_PATCH_FRAMES);
});

test('maestPatches: a short window repeats its own start; under 5 s it is skipped', () => {
  const frames = 400, data = Float32Array.from({ length: frames * N_BANDS }, (_, i) => Math.floor(i / N_BANDS));
  const p = maestPatches({ frames, data });
  assert.equal(p.patches, 1);
  const at = f => p.data[f * N_BANDS] * 2 * MAEST_STD + MAEST_MEAN;
  assert.ok(Math.abs(at(399) - 399) < 1e-3 && Math.abs(at(400) - 0) < 1e-3 && Math.abs(at(625) - 225) < 1e-3);
  assert.equal(maestPatches({ frames: MAEST_MIN_FRAMES - 1, data: new Float32Array((MAEST_MIN_FRAMES - 1) * N_BANDS) }).patches, 0);
  assert.equal(maestPatches({ frames: 0, data: new Float32Array(0) }).patches, 0);
});

/* ---------- the ear, with a fake session ---------- */

function fakeOrt({ tokens = 560, names = [ACT_OUTPUT, EMB_OUTPUT] } = {}) {
  const runs = [];
  class Tensor { constructor(type, data, dims) { Object.assign(this, { type, data, dims }); } }
  return { runs, Tensor, InferenceSession: { create: async () => ({
    inputNames: ['melspectrogram'], outputNames: names,
    run: async feeds => {
      const x = feeds.melspectrogram; runs.push(x.dims);
      const mean = x.data.reduce((s, v) => s + v, 0) / x.data.length;
      const act = new Float32Array(MAEST_N_STYLES).fill(0.1); act[3] = 0.5 + Math.max(-0.4, Math.min(0.4, mean / 10));
      const tok = new Float32Array(tokens * MAEST_DIM);
      for (let t = 0; t < tokens; t++) for (let k = 0; k < MAEST_DIM; k++) tok[t * MAEST_DIM + k] = (k === 0 ? t : 1) + mean;
      return { [names[0]]: { data: act }, [names[1]]: { data: tok } };
    },
    release: async () => {},
  }) } };
}

test('createMaestEar: one run per patch, embedding is the mean over tokens and patches', async () => {
  const ort = fakeOrt({ tokens: 4 });
  const ear = await createMaestEar({ ort, modelUrl: 'x' });
  const size = MAEST_PATCH_FRAMES * N_BANDS;
  const data = new Float32Array(2 * size); data.fill(1, 0, size); data.fill(3, size);
  const out = await ear.run(data, 2);
  assert.deepEqual(ort.runs, [[1, MAEST_PATCH_FRAMES, N_BANDS], [1, MAEST_PATCH_FRAMES, N_BANDS]]);
  assert.equal(out.embedding.length, MAEST_DIM);
  assert.ok(Math.abs(out.embedding[0] - (1.5 + 2)) < 1e-5, 'token mean (0..3 → 1.5) plus the patch mean (1, 3 → 2)');
  assert.ok(Math.abs(out.embedding[5] - 3) < 1e-5);
  await assert.rejects(ear.run(new Float32Array(10), 1));
  await assert.rejects(ear.run(new Float32Array(0), 0));
});

test('outputs are found by name, or by shape when renamed', () => {
  const act = new Float32Array(MAEST_N_STYLES), tok = new Float32Array(3 * MAEST_DIM);
  assert.equal(pickMaestOutputs({ [ACT_OUTPUT]: { data: act }, [EMB_OUTPUT]: { data: tok } }).tokens, tok);
  const r = pickMaestOutputs({ a: { data: tok }, b: { data: act } });
  assert.equal(r.act, act); assert.equal(r.tokens, tok);
  assert.throws(() => pickMaestOutputs({ a: { data: act } }));
  assert.throws(() => pickMaestOutputs({ a: { data: new Float32Array(401) }, b: { data: tok } }));
});

test('hearMaest: each window on its own, weighted by patches, into a valid maest field', async () => {
  const seen = [];
  const ear = { run: async (data, patches) => { seen.push(patches);
    const a = new Float32Array(MAEST_N_STYLES).fill(0.01); a[seen.length === 1 ? 7 : 9] = 0.9;
    return { activations: a, embedding: Float32Array.from({ length: MAEST_DIM }, (_, k) => (k === 0 ? seen.length : 0.5)) }; } };
  const tone = n => Float32Array.from({ length: n }, (_, i) => Math.sin(i / 7) * 0.3);
  const f = await hearMaest(ear, [tone(Math.round(10.3 * SAMPLE_RATE)), tone(Math.round(10.3 * SAMPLE_RATE))]);
  assert.deepEqual(seen, [1, 1], 'never across the join');
  assert.equal(f.model, MAEST_MODEL);
  assert.equal(unpackEmbedding(f.emb).length, MAEST_DIM);
  assert.deepEqual(f.styles.slice(0, 2).map(s => s[0]).sort(), [7, 9]);
  assert.equal(await hearMaest(ear, [tone(1000)]), null, 'too short to judge is no answer, not a zero one');
  assert.equal(await hearMaest(ear, []), null);
});

/* ---------- topping up a stored record ---------- */

function fillDeps({ lookup, ...over } = {}) {
  const tone = Float32Array.from({ length: Math.round(10.3 * SAMPLE_RATE) }, (_, i) => Math.sin(i / 5) * 0.2);
  return {
    lookup: lookup ?? (async () => ({ deezerId: 1, previewUrl: 'https://cdn/x?hdnea=exp' })),
    fetchPreview: async () => ({ buffers: [new ArrayBuffer(8), new ArrayBuffer(8)], windows: [[0, 8], [100, 8]] }),
    decode: async () => tone,
    maest: { run: async () => { const a = new Float32Array(MAEST_N_STYLES).fill(0.01); a[2] = 0.8; return { activations: a, embedding: Float32Array.from({ length: MAEST_DIM }, (_, k) => Math.cos(k)) }; } },
    ...over,
  };
}

test('fillMaest adds the second ear and leaves the first ear exactly as it was', async () => {
  const base = strip(recordFor('tech-t0', { maest: false }));
  assert.ok(needsMaest(base));
  const r = await fillMaest(fillDeps(), base);
  assert.ok(r.record, JSON.stringify(r));
  for (const k of ['id', 'isrc', 'model', 'mel', 'at', 'styles', 'sections', 'emb', 'heads', 'dsp', 'source']) assert.deepEqual(r.record[k], base[k], k);
  assert.ok(earCurrent(r.record, 'maest') && validRecord(r.record) && !needsMaest(r.record));
  assert.ok(!JSON.stringify(r.record).includes('hdnea'), 'the preview URL is never kept');
  assert.deepEqual(await fillMaest(fillDeps(), r.record), { skip: 'current' });
});

test('fillMaest: ISRC or nothing, same recording only, failures are not answers', async () => {
  const base = strip(recordFor('tech-t1', { maest: false }));
  assert.deepEqual(await fillMaest({ ...fillDeps(), maest: null }, base), { skip: 'no-maest' });
  assert.deepEqual(await fillMaest(fillDeps(), { ...base, isrc: null }), { skip: 'not-a-record' });
  assert.deepEqual(await fillMaest(fillDeps(), { id: 'x', v: 2, miss: 'NO_PREVIEW' }), { skip: 'not-a-record' });
  assert.deepEqual(await fillMaest(fillDeps({ lookup: async () => ({ deezerId: 2, previewUrl: 'u' }) }), base), { skip: 'different-recording' });
  assert.deepEqual(await fillMaest(fillDeps({ lookup: async () => ({ miss: 'NOT_ON_DEEZER' }) }), base), { skip: 'NOT_ON_DEEZER' });
  assert.equal((await fillMaest(fillDeps({ lookup: async () => { throw new Error('jsonp'); } }), base)).failed.stage, 'lookup');
  assert.equal((await fillMaest(fillDeps({ fetchPreview: async () => { throw new Error('net'); } }), base)).failed.stage, 'download');
  assert.equal((await fillMaest(fillDeps({ decode: async () => { throw new Error('bad mp3'); } }), base)).failed.stage, 'decode');
  assert.equal((await fillMaest(fillDeps({ maest: { run: async () => { throw new Error('oom'); } } }), base)).failed.stage, 'infer');
  assert.deepEqual(await fillMaest(fillDeps({ decode: async () => new Float32Array(100) }), base), { skip: 'too-short' });
});

/* ---------- the index: which ear ---------- */

test('audioIndex: the first ear by default, untouched by a maest field', () => {
  const withM = LIB.all.map(t => recordFor(t.id));
  const without = withM.map(strip);
  const a = audioIndex(withM), b = audioIndex(without);
  assert.deepEqual([...a.keys()], [...b.keys()]);
  for (const [id, row] of a) { assert.deepEqual(row.emb, b.get(id).emb); assert.deepEqual(row.styles, b.get(id).styles); }
  assert.deepEqual(audioIndex(withM, { ear: 'effnet' }).get('tech-t0').emb, a.get('tech-t0').emb);
  assert.deepEqual(EARS, ['effnet', 'maest', 'both']);
  assert.throws(() => audioIndex(withM, { ear: 'clap' }));
});

test('audioIndex: maest and both hold only tracks with a current second ear, in their own space', () => {
  const recs = LIB.all.map((t, i) => recordFor(t.id, { maest: i % 2 === 0 }));
  const stale = recs.map(r => (r.maest ? { ...r, maest: { ...r.maest, model: 'discogs-maest-old' } } : r));
  const m = audioIndex(recs, { ear: 'maest' }), both = audioIndex(recs, { ear: 'both' });
  assert.equal(m.size, Math.ceil(recs.length / 2));
  assert.equal(audioIndex(stale, { ear: 'maest' }).size, 0, 'a stale second ear is not heard');
  assert.equal(audioIndex(stale).size, recs.length, 'and the first ear still is');
  const row = m.get('tech-t0'), brow = both.get('tech-t0');
  assert.equal(row.emb.length, MAEST_DIM);
  assert.equal(brow.emb.length, EMB_DIM + MAEST_DIM);
  assert.deepEqual(row.styles, recs[0].maest.styles, 'its own style guesses');
  // both = the two unit halves joined: the cosine on it is the mean of the two ears' cosines.
  const e0 = audioIndex(recs).get('tech-t0').emb, e1 = audioIndex(recs).get('tech-t2').emb;
  const want = (cos(e0, e1) + cos(row.emb, m.get('tech-t2').emb)) / 2;
  assert.ok(Math.abs(cos(brow.emb, both.get('tech-t2').emb) - want) < 1e-5);
});

/* ---------- the guard: MAEST changes nothing until chosen ---------- */

test('THE MAEST GUARD: records carrying a maest field place exactly as records without one', () => {
  const withM = LIB.all.map(t => recordFor(t.id, { effNoise: 0.6 }));
  const without = withM.map(strip);
  for (const useAudio of [false, true]) {
    const a = buildSpace(LIB, { audio: withM, targets: TARGETS }), b = buildSpace(LIB, { audio: without, targets: TARGETS });
    const run = s => JSON.stringify(LIB.all.map(t => placements(t, s, { limit: Infinity, why: true, useAudio })));
    assert.equal(run(a), run(b));
  }
  const accA = placementAccuracy(LIB, { audio: withM, collect: true });
  const accB = placementAccuracy(LIB, { audio: without, collect: true });
  assert.deepEqual(accA, accB, 'no arms asked for: the Score run is key for key the same');
  assert.equal(accA.withAudio.arms, undefined);
  assert.equal(accA.withAudio.choice, undefined);
});

test('THE MAEST GUARD: with arms, the headline and the first ear are unchanged', () => {
  const recs = LIB.all.map(t => recordFor(t.id));
  const plain = placementAccuracy(LIB, { audio: recs, collect: true });
  const acc = placementAccuracy(LIB, { audio: { records: recs, arms: ['maest', 'both'] }, collect: true });
  const { arms, choice, ...first } = acc.withAudio;
  assert.deepEqual({ ...acc, withAudio: first }, plain, 'arms add keys under withAudio and move nothing');
  assert.deepEqual(Object.keys(arms), ['maest', 'both']);
});

/* ---------- the third arm ---------- */

test('Score arms: same folds and tracks, each ear tallied and given its own verdict', () => {
  const recs = LIB.all.map(t => recordFor(t.id, { effNoise: 1e4 })); // the first ear hears only noise
  const weights = { ...WEIGHTS, graph: 0, registrant: 0, minutes: 0, era: 0, albumType: 0, albumTracks: 0, popularity: 0, audio: 1 };
  const acc = placementAccuracy(LIB, { audio: { records: recs, arms: ['maest', 'both', 'maest', 'effnet'], learn: false },
                                       targets: new Set(TARGETS), weights, collect: true });
  const w = acc.withAudio, m = w.arms.maest, b = w.arms.both;
  assert.deepEqual(Object.keys(w.arms), ['maest', 'both'], 'deduplicated; the first ear is not an arm');
  for (const arm of [m, b]) {
    assert.equal(arm.scored, acc.scored);
    assert.equal(arm.neverFiled.scored, acc.neverFiled.scored);
    assert.equal(arm.heard, acc.scored);
    assert.equal(arm.analysed, recs.length);
    assert.deepEqual(arm.rows.map(r => r.id), acc.rows.map(r => r.id));
    assert.ok(arm.gate && 'pass' in arm.gate);
  }
  // The fixture's first ear is noise and MAEST is clean, so the arm sees it.
  assert.ok(m.top1 > w.top1 + 0.2, `maest ${m.top1} vs first ear ${w.top1}`);
  assert.ok(b.top1 >= w.top1, `both ${b.top1} vs first ear ${w.top1}`);
  assert.equal(w.choice.ear, 'effnet', 'the fixture is too small for any verdict, so the first ear stays');
  assert.equal(w.choice.reason, 'ARMS_UNDECIDED');
});

test('Score arms: none heard by the second ear is undecided, never chosen', () => {
  const recs = LIB.all.map(t => recordFor(t.id, { maest: false }));
  const acc = placementAccuracy(LIB, { audio: { records: recs, arms: ['maest'] } });
  assert.equal(acc.withAudio.arms.maest.heard, 0);
  assert.equal(acc.withAudio.arms.maest.gate.reason, 'NOTHING_HEARD');
  assert.equal(acc.withAudio.choice.ear, 'effnet');
});

test('Score arms need records: a prebuilt index alone has no second ear to read', () => {
  const recs = LIB.all.map(t => recordFor(t.id));
  const acc = placementAccuracy(LIB, { audio: { index: audioIndex(recs), arms: ['maest'] } });
  assert.equal(acc.withAudio.arms, undefined);
});

/* ---------- earChoice: the rule, on synthetic runs ---------- */

const tal = (top1, nf) => ({ scored: 200, top1, top3: top1, neverFiled: { scored: 40, top1: nf, top3: nf } });
function run({ first, maest = null, both = null }) {
  const acc = { scored: 200, top1: 0.6, neverFiled: { scored: 40, top1: 0.3 } };
  const arm = ([t1, nf]) => ({ ...tal(t1, nf), heard: 150, heardNeverFiled: 30 });
  const w = arm(first);
  acc.withAudio = w;
  w.gate = audioGate(acc);
  if (maest || both) w.arms = {};
  for (const [k, v] of [['maest', maest], ['both', both]]) if (v) { w.arms[k] = arm(v); w.arms[k].gate = audioGate({ ...acc, withAudio: w.arms[k] }); }
  return acc;
}

test('earChoice: without arms it is the first ear and its own verdict, as before', () => {
  const acc = run({ first: [0.62, 0.40] });
  const c = earChoice(acc);
  assert.equal(c.ear, 'effnet');
  assert.equal(c.reason, 'NO_ARMS');
  assert.deepEqual(c.gate, acc.withAudio.gate);
  assert.equal(earChoice({}).ear, 'effnet');
  assert.equal(earChoice(null).gate, null);
});

test('earChoice: the second ear wins only by passing the gate and beating the first ear by 2 points', () => {
  assert.equal(EAR_GATE.minLiftOverFirst, 0.02);
  let c = earChoice(run({ first: [0.62, 0.40], maest: [0.63, 0.42] }));
  assert.equal(c.ear, 'maest', 'exactly at the bar');
  assert.equal(c.gate.pass, true);
  assert.equal(c.reason, 'SECOND_EAR');
  assert.deepEqual(c.vsFirst.maest, { lift: 0.02, overall: 0.01, passes: true, beats: true });
  c = earChoice(run({ first: [0.62, 0.40], maest: [0.63, 0.41] }));
  assert.equal(c.ear, 'effnet', 'one point better is a tie, not a 90 MB win');
  assert.equal(c.reason, 'FIRST_EAR_KEPT');
  c = earChoice(run({ first: [0.62, 0.40], maest: [0.61, 0.50] }));
  assert.equal(c.ear, 'effnet', 'any loss overall against the first ear keeps the first ear');
  c = earChoice(run({ first: [0.58, 0.30], maest: [0.64, 0.45] }));
  assert.equal(c.ear, 'maest', 'it may win where the first ear failed its own gate');
  assert.equal(c.gate.pass, true);
  c = earChoice(run({ first: [0.62, 0.40], maest: [0.59, 0.45] }));
  assert.equal(c.ear, 'effnet', 'a second ear that fails the gate itself is never chosen');
});

test('earChoice: between arms the larger never-filed lift wins, and maest wins a tie', () => {
  assert.equal(earChoice(run({ first: [0.62, 0.40], maest: [0.63, 0.43], both: [0.64, 0.46] })).ear, 'both');
  assert.equal(earChoice(run({ first: [0.62, 0.40], maest: [0.63, 0.46], both: [0.64, 0.46] })).ear, 'maest');
});

test('earChoice: an arm with too little heard is undecided, and the first ear stays', () => {
  const acc = run({ first: [0.62, 0.40], maest: [0.70, 0.60] });
  acc.withAudio.arms.maest.heardNeverFiled = GATE.minHeardNeverFiled - 1;
  acc.withAudio.arms.maest.gate = audioGate({ ...acc, withAudio: acc.withAudio.arms.maest });
  const c = earChoice(acc);
  assert.equal(c.ear, 'effnet');
  assert.equal(c.reason, 'ARMS_UNDECIDED');
  assert.equal(c.vsFirst.maest.passes, null);
});

test('the shipped model file is the one maest.mjs names', async () => {
  const { statSync } = await import('node:fs');
  const st = statSync(new URL(`../docs/models/${MAEST_FILE}`, import.meta.url));
  assert.ok(st.size > 80e6 && st.size < 100e6, `under GitHub's 100 MB limit: ${st.size}`);
});

/* ---------- the page's laptop run (web/audio/maest-run.mjs) ---------- */

const { createMaestRunner, createWorkerMaest, maestStatusText, MAEST_PER_RUN } = await import('../web/audio/maest-run.mjs');

function memStore(recs) {
  const m = new Map(recs.map(r => [r.id, r]));
  return { m, getAll: async () => new Map(m), put: async r => { m.set(r.id, r); return true; } };
}

test('runner: tops up stored records oldest first, a few per run, and releases the model', async () => {
  const recs = LIB.all.slice(0, 6).map((t, i) => ({ ...strip(recordFor(t.id, { maest: false })), at: 100 - i }));
  const store = memStore([...recs, { v: 2, id: 'gone', miss: 'NO_PREVIEW', at: 0, model: 'x' }]);
  let loads = 0, released = 0;
  const views = [];
  const run = createMaestRunner({ ...fillDeps(), store, perRun: 4, onChange: v => views.push(v),
    loadMaest: async () => { loads++; return { ...fillDeps().maest, release: () => { released++; } }; } });
  const r = await run.start();
  assert.deepEqual(r, { done: 4, stopped: false });
  assert.equal(loads, 1); assert.equal(released, 1, 'the model is dropped when the run ends');
  const filled = [...store.m.values()].filter(x => earCurrent(x, 'maest')).map(x => x.id);
  assert.deepEqual(filled.sort(), recs.slice(2).map(x => x.id).sort(), 'the oldest four');
  assert.equal(run.vm().heard, 4); assert.equal(run.vm().waiting, 2);
  assert.ok(views.some(v => v.state === 'running'));
  await run.start();
  assert.equal([...store.m.values()].filter(x => earCurrent(x, 'maest')).length, 6);
  const again = await run.start();
  assert.deepEqual(again, { done: 0, stopped: false }); assert.equal(loads, 2, 'nothing to do loads no model');
  assert.equal(MAEST_PER_RUN, 50);
});

test('runner: stops after the track in flight; skips are not retried this session; failures are', async () => {
  const recs = LIB.all.slice(0, 5).map((t, i) => ({ ...strip(recordFor(t.id, { maest: false })), at: i }));
  const store = memStore(recs);
  let calls = 0, ctrl = null;
  const deps = fillDeps({ lookup: async isrc => { calls++; if (calls === 2) ctrl.stop(); return { deezerId: 1, previewUrl: 'u' }; } });
  ctrl = createMaestRunner({ ...deps, store, loadMaest: async () => deps.maest });
  const r = await ctrl.start();
  assert.deepEqual(r, { done: 2, stopped: true });
  assert.equal(ctrl.vm().state, 'paused');

  const store2 = memStore(recs.map(strip));
  let n = 0;
  const deps2 = fillDeps({ lookup: async () => (++n === 1 ? { deezerId: 99, previewUrl: 'u' } : n === 2 ? { miss: 'FAILED' } : { deezerId: 1, previewUrl: 'u' }) });
  const c2 = createMaestRunner({ ...deps2, store: store2, loadMaest: async () => deps2.maest });
  await c2.start();
  assert.equal(c2.vm().failed, 1);
  assert.equal(c2.vm().heard, 3);
  n = 10; await c2.start();
  assert.equal(c2.vm().heard, 4, 'the failed one is tried again, the different recording is not');
  assert.equal(c2.vm().waiting, 0);
});

test('runner: the answer goes on the record as stored now, so a CLAP or DSP top-up meanwhile is kept', async () => {
  const recs = LIB.all.slice(0, 3).map((t, i) => ({ ...strip(recordFor(t.id, { maest: false })), at: i }));
  const store = memStore(recs);
  store.get = async id => store.m.get(id) ?? null;
  const clap = makeEar('clap', { embedding: Float32Array.from({ length: CLAP_DIM }, (_, k) => Math.sin(k + 1)) });
  const deps = fillDeps({ lookup: async isrc => {
    // While the second ear works on a track, a listening run adds CLAP to the first
    // record and hears the second as another recording.
    const [a, b] = recs;
    store.m.set(a.id, withEar(store.m.get(a.id), 'clap', clap));
    store.m.set(b.id, { ...store.m.get(b.id), source: { ...b.source, deezerId: 2 } });
    return { deezerId: 1, previewUrl: 'u' };
  } });
  const run = createMaestRunner({ ...deps, store, loadMaest: async () => deps.maest });
  await run.start();
  const [a, b, c] = recs.map(r => store.m.get(r.id));
  assert.ok(earCurrent(a, 'maest') && earCurrent(a, 'clap'), 'both ears on the first record');
  assert.ok(!earCurrent(b, 'maest'), 'a record re-heard as another recording is left alone');
  assert.equal(b.source.deezerId, 2);
  assert.ok(earCurrent(c, 'maest'));
  assert.equal(run.vm().heard, 2); assert.equal(run.vm().failed, 0);
  // A store without get() keeps the run's own copy, as before.
  const plain = memStore([strip(recordFor('tech-t0', { maest: false }))]);
  await createMaestRunner({ ...fillDeps(), store: plain, loadMaest: async () => fillDeps().maest }).start();
  assert.ok(earCurrent(plain.m.get('tech-t0'), 'maest'));
});

test('runner: a model that will not load pauses with a reason and stores nothing', async () => {
  const store = memStore([strip(recordFor('tech-t0', { maest: false }))]);
  const c = createMaestRunner({ ...fillDeps(), store, loadMaest: async () => { throw new Error('out of memory'); } });
  assert.deepEqual(await c.start(), { done: 0, stopped: true });
  assert.match(c.vm().reason, /out of memory/);
  assert.ok(!earCurrent(store.m.get('tech-t0'), 'maest'));
  assert.match(maestStatusText(c.vm()), /stopped: couldn’t load/);
});

test('worker proxy: init first, buffers transferred, errors and crashes surface', async () => {
  const posted = [];
  const listeners = {};
  const worker = { postMessage: (m, t) => { posted.push([m, t]); queueMicrotask(() => listeners.message?.({ data: m.op === 'boom' ? { id: m.id, ok: false, error: 'bad' } : { id: m.id, ok: true, result: m.op === 'maest' ? { patches: m.patches } : {} } })); },
                   addEventListener: (k, f) => { listeners[k] = f; }, terminate: () => { posted.push(['terminated']); } };
  const w = createWorkerMaest(worker, { modelUrl: 'models/x.onnx' });
  const data = new Float32Array(4);
  assert.deepEqual(await w.run(data, 1), { patches: 1 });
  assert.equal(posted[0][0].op, 'init');
  assert.equal(posted[1][1][0], data.buffer, 'transferred, not copied');
  w.release();
  assert.deepEqual(posted.at(-1), ['terminated']);
});

test('status text', () => {
  assert.equal(maestStatusText(null), '');
  assert.equal(maestStatusText({ state: 'done', heard: 1, waiting: 0 }), '1 track heard by the second ear.');
  assert.equal(maestStatusText({ state: 'done', heard: 1200, waiting: 3 }), '1,200 tracks heard by the second ear, 3 still to go.');
  assert.match(maestStatusText({ state: 'running', done: 2, total: 50 }), /2 of 50/);
});

/* ---------- what the page reads ---------- */

const { chosenEar, scoreArms, maestScoreText } = await import('../web/audio/maest-run.mjs');
const { hearMore } = await import('../core/intrinsic/space.mjs');

test('chosenEar: only a passed Score verdict for a second ear, with records that have it', () => {
  const recs = LIB.all.map(t => recordFor(t.id));
  const none = recs.map(strip);
  const pass = { ear: 'maest', gate: { pass: true } };
  assert.equal(chosenEar(pass, recs), 'maest');
  assert.equal(chosenEar({ ear: 'both', gate: { pass: true } }, new Map(recs.map(r => [r.id, r]))), 'both');
  assert.equal(chosenEar(pass, none), 'effnet', 'no second-ear records, nothing to place with');
  assert.equal(chosenEar({ ear: 'maest', gate: { pass: null } }, recs), 'effnet');
  assert.equal(chosenEar({ ear: 'effnet', gate: { pass: true } }, recs), 'effnet');
  assert.equal(chosenEar(null, recs), 'effnet', 'switching Deep listen on changes nothing by itself');
  assert.deepEqual(scoreArms(recs), ['maest', 'both', 'near']);
  assert.deepEqual(scoreArms(none), ['near'], 'nearest tracks are scored on the first ear alone');
  assert.equal(scoreArms([]), null);
  assert.equal(scoreArms(null), null);
});

test('a second-ear space hears more from the same ear, and a first-ear space is unchanged', () => {
  const recs = LIB.all.map(t => recordFor(t.id));
  const first = buildSpace(LIB, { audio: recs.slice(0, 40), targets: TARGETS });
  assert.equal('ear' in first.audio, false, 'a first-ear layer has no new key');
  hearMore(first, recs.slice(40));
  assert.equal(first.audio.index.get(recs[45].id).emb.length, EMB_DIM);
  const m = buildSpace(LIB, { audio: { records: recs.slice(0, 40), ear: 'maest' }, targets: TARGETS });
  assert.equal(m.audio.ear, 'maest');
  assert.ok(hearMore(m, recs.slice(40)) > 0);
  assert.equal(m.audio.index.get(recs[45].id).emb.length, MAEST_DIM);
  assert.equal(hearMore(m, recs.slice(40).map(strip)), 0, 'records without the second ear add nothing');
});

test('maestScoreText', () => {
  assert.equal(maestScoreText(null), '');
  assert.equal(maestScoreText({ top1: 0.5 }), '');
  const w = { top1: 0.6, neverFiled: { top1: 0.3 }, arms: { maest: { top1: 0.62, neverFiled: { top1: 0.4 }, heard: 120 }, both: { top1: 0.63, neverFiled: { top1: 0.38 } } },
              choice: { ear: 'maest', reason: 'SECOND_EAR' } };
  assert.equal(maestScoreText(w), 'Second ear (MAEST): top-1 62%, never-filed 40%, 120 heard; both ears: top-1 63%, never-filed 38%; first ear: top-1 60%, never-filed 30%. Placing with: the second ear (SECOND_EAR)');
});
