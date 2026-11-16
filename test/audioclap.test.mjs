// WP-C2: CLAP in the page. The front end against the reference, text and audio
// in one space, filling records, and "off unless switched on".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

import { clapFeatures, fitClip, melFilters, clapEmbed, loadTextTable, rankPrompts, addClap, fillClap, needsClap,
         normalise, CLAP_FRAMES, CLAP_MELS, CLAP_SAMPLES, CLAP_SR, CLAP_MIN_SAMPLES, CLAP_MODEL_FILE } from '../core/audio/clap.mjs';
import { CLAP_DIM, CLAP_MODEL, makeRecord, validRecord, earCurrent, unpackEmbedding, packEmbedding,
         MISS, N_STYLES, EMB_DIM } from '../core/audio/record.mjs';
import { readTable } from '../core/audio/clap-search.mjs';
import { analyseOne } from '../core/audio/worker.js';
import { SAMPLE_RATE, MEL_VERSION } from '../core/audio/mel.mjs';
import { createAudioController } from '../web/audio/controller.mjs';
import { DEFAULT_DEEP_SETTINGS, readDeepSettings, deepListenAllowed } from '../web/audio/deep-settings.mjs';

const FIX = JSON.parse(readFileSync(new URL('./fixtures/clap-fixture.json', import.meta.url), 'utf8'));
const TABLE_JSON = JSON.parse(readFileSync(new URL('../docs/models/clap-text-table.json', import.meta.url), 'utf8'));
const TABLE = loadTextTable(TABLE_JSON);

/* ---------------------------------------------- the fixture signals, as export-audio-encoder.py makes them */

const SR = FIX.sr, N = SR * FIX.seconds;
function parkMiller(n, seed) {
  const o = new Float64Array(n); let x = seed;
  for (let i = 0; i < n; i++) { x = (x * 16807) % 2147483647; o[i] = x / 1073741823.5 - 1; }
  return o;
}
function kicks() {
  const o = new Float32Array(N), beat = 60 / 128, noise = parkMiller(N, 7);
  for (let i = 0; i < N; i++) {
    const t = i / SR, ph = t % beat, off = (t + beat / 2) % beat;
    const k = Math.sin(2 * Math.PI * (50 * ph + (100 / 30) * (1 - Math.exp(-30 * ph)))) * Math.exp(-8 * ph);
    o[i] = 0.8 * k + noise[i] * Math.exp(-60 * off) * 0.25;
  }
  return o;
}
function piano() {
  const y = new Float64Array(N), notes = [261.63, 329.63, 392.0, 523.25, 392.0, 329.63];
  for (let k = 0; k < FIX.seconds / 0.5; k++) {
    const f = notes[k % notes.length], s = Math.floor(k * 0.5 * SR);
    for (let i = s; i < N; i++) {
      const tt = i / SR - s / SR, env = Math.exp(-3 * tt) * (1 - Math.exp(-200 * tt));
      let v = 0;
      for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * f * h * tt) / h ** 1.5;
      y[i] += env * v;
    }
  }
  return Float32Array.from(y, v => 0.2 * v);
}
const SIGNALS = { kicks, piano };

/* ---------------------------------------------- the front end */

test('the front end matches transformers ClapFeatureExtractor to 0.01 dB on both fixture signals', () => {
  assert.equal(SR, CLAP_SR);
  for (const [name, make] of Object.entries(SIGNALS)) {
    const f = clapFeatures(make()), ref = FIX.signals[name];
    assert.equal(f.length, CLAP_FRAMES * CLAP_MELS);
    let worst = 0;
    FIX.framesKept.forEach((t, j) => { for (let m = 0; m < CLAP_MELS; m++) worst = Math.max(worst, Math.abs(f[t * CLAP_MELS + m] - ref.frames[j][m])); });
    for (let m = 0; m < CLAP_MELS; m++) {
      let s = 0;
      for (let t = 0; t < CLAP_FRAMES; t++) s += f[t * CLAP_MELS + m];
      worst = Math.max(worst, Math.abs(s / CLAP_FRAMES - ref.meanPerBand[m]));
    }
    assert.ok(worst < 0.01, `${name}: worst difference ${worst.toFixed(4)} dB`);
  }
});

test('mel filters: 64 Slaney triangles, none empty, none negative', () => {
  const fb = melFilters();
  assert.equal(fb.length, CLAP_MELS);
  for (const row of fb) { assert.ok(row.every(v => v >= 0)); assert.ok(row.some(v => v > 0)); }
});

test('fitClip: 10 s exactly; longer is cut from the middle; shorter is repeated whole, then zero-padded', () => {
  assert.equal(fitClip(new Float32Array(CLAP_SAMPLES)).length, CLAP_SAMPLES);
  const long = Float32Array.from({ length: CLAP_SAMPLES + 100 }, (_, i) => i);
  assert.equal(fitClip(long)[0], 50);
  const short = Float32Array.from({ length: 200000 }, (_, i) => i + 1);
  const f = fitClip(short);
  assert.equal(f.length, CLAP_SAMPLES);
  assert.equal(f[200000], 1, 'second copy starts again');
  assert.equal(f[400000], 0, 'only whole copies, then zeros');
  assert.equal(fitClip(new Float32Array(0)).length, CLAP_SAMPLES);
});

/* ---------------------------------------------- text and audio in one space */

test('text and audio embeddings share a dimension: the table, the fixture and the record contract', () => {
  assert.equal(TABLE_JSON.dim, CLAP_DIM);
  assert.ok(TABLE.prompts.length > 108);
  for (const p of TABLE.prompts) assert.equal(p.vec.length, CLAP_DIM);
  for (const s of Object.values(FIX.signals)) {
    assert.equal(unpackEmbedding(s.embInt8).length, CLAP_DIM);
    assert.ok(s.int8Cosine > 0.99, 'the shipped int8 encoder stays close to the float model');
  }
  assert.ok(readTable(TABLE_JSON), "WP-C3's reader accepts the shipped table");
  assert.throws(() => loadTextTable({ ...TABLE_JSON, dim: 768 }), /768-d/);
  assert.throws(() => loadTextTable({ ...TABLE_JSON, v: 9 }), /version/);
});

const KICK = ['pounding hard kick drum', 'four on the floor kick drum', 'warehouse techno with pounding kicks'];
const KEYS = ['solo piano', 'lush pad chords', 'plucked synth melody', 'classical music', 'jazzy chords'];

test('a fixture audio embedding ranks a matching prompt top-5, and not the other signal’s', () => {
  for (const which of ['embInt8', 'embFloat']) {
    const k = rankPrompts(FIX.signals.kicks[which], TABLE, { top: 5 }).map(p => p.text);
    const p = rankPrompts(FIX.signals.piano[which], TABLE, { top: 5 }).map(p => p.text);
    assert.ok(k.some(t => KICK.includes(t)), `kick drum top 5: ${k}`);
    assert.ok(p.some(t => KEYS.includes(t)), `piano top 5: ${p}`);
    assert.ok(!k.some(t => KEYS.includes(t)) && !p.some(t => KICK.includes(t)), 'each keeps to its own sound');
  }
  const g = rankPrompts(FIX.signals.kicks.embInt8, TABLE, { kind: 'genre', top: 3 });
  assert.ok(g.every(x => x.kind === 'genre' && x.concept));
  assert.ok(g[0].score >= g[2].score);
});

/* ---------------------------------------------- embedding a track */

const fakeEar = (calls = []) => ({ run: async (feats, n) => {
  calls.push(n);
  assert.equal(feats.length, n * CLAP_FRAMES * CLAP_MELS);
  const out = new Float32Array(n * CLAP_DIM);
  for (let i = 0; i < n; i++) out[i * CLAP_DIM + (calls.length % 3)] = 1;
  return out;
} });

test('clapEmbed: one clip per run, windows averaged and normalised, short windows left out', async () => {
  const calls = [];
  const field = await clapEmbed(fakeEar(calls), [new Float32Array(CLAP_SR * 10), new Float32Array(CLAP_SR * 10), new Float32Array(100)]);
  assert.deepEqual(calls, [1, 1], 'two runs of one clip each; the 100-sample window is skipped');
  assert.equal(field.model, CLAP_MODEL);
  const v = unpackEmbedding(field.emb);
  assert.equal(v.length, CLAP_DIM);
  assert.ok(Math.abs(Math.hypot(...v) - 1) < 0.01);
  assert.equal(await clapEmbed(fakeEar(), [new Float32Array(CLAP_MIN_SAMPLES - 1)]), null);
  assert.equal(await clapEmbed(fakeEar(), []), null);
  assert.equal(normalise(new Float32Array(3)).every(x => x === 0), true);
});

const styleEar = { run: async (data, n) => { const a = new Float32Array(n * N_STYLES).fill(0.01); for (let p = 0; p < n; p++) a[p * N_STYLES + 3] = 0.7;
  return { activations: a, embeddings: new Float32Array(n * EMB_DIM).fill(0.05) }; } };
const tone = secs => Float32Array.from({ length: Math.round(secs * SAMPLE_RATE) }, (_, i) => 0.2 * Math.sin(i / 7));
function deps(over = {}) {
  const seen = { lookups: 0, decoded48: 0 };
  return {
    seen, now: () => 5000, ear: styleEar,
    lookup: async () => { seen.lookups++; return { deezerId: 42, previewUrl: 'https://cdnt-preview.dzcdn.net/p.mp3', durationMs: 200000, readable: true }; },
    fetchPreview: async () => ({ buffers: [new ArrayBuffer(8), new ArrayBuffer(9)], windows: [[0, 165000], [157413, 165000]], total: 479827, sliced: false }),
    decode: async () => tone(10),
    ...over,
  };
}
const clapDep = (seen, over = {}) => ({
  decode: async buf => { seen.decoded48++; assert.ok(buf.byteLength > 0, 'a copy, not a detached buffer'); return new Float32Array(CLAP_SR * 10); },
  embed: windows => clapEmbed(fakeEar(), windows),
  ...over,
});
const track = { id: 'sp1', isrc: 'GBXXX0000001', durationMs: 199000 };

test('byte-identical without CLAP: no deps.clap means the same record as before', async () => {
  const a = await analyseOne(deps(), track);
  const b = await analyseOne(deps(), track);
  assert.equal(a.record.clap, null);
  assert.equal(JSON.stringify(a.record), JSON.stringify(b.record));
});

test('with deps.clap the same pass adds a valid, current clap ear and leaves the rest alone', async () => {
  const plain = (await analyseOne(deps(), track)).record;
  const d = deps(); d.clap = clapDep(d.seen);
  const r = (await analyseOne(d, track)).record;
  assert.equal(d.seen.decoded48, 2);
  assert.ok(validRecord(r) && earCurrent(r, 'clap'));
  const { clap, v, ...rest } = r, { clap: none, v: v0, ...before } = plain;
  assert.equal(none, null);
  assert.deepEqual(rest, before);
});

test('CLAP failing, decode or embed, never fails the track', async () => {
  for (const over of [{ decode: async () => { throw new Error('no 48k'); } }, { embed: async () => { throw new Error('boom'); } },
                      { embed: async () => null }]) {
    const d = deps(); d.clap = clapDep(d.seen, over);
    const r = await analyseOne(d, track);
    assert.ok(r.record && validRecord(r.record));
    assert.equal(r.record.clap, null);
  }
  const rec = (await analyseOne(deps(), track)).record;
  assert.equal(await addClap(null, rec, [new Float32Array(1)]), rec);
});

function oldRecord(id = 'sp1', deezerId = 42) {
  const n = 2, a = new Float32Array(n * N_STYLES).fill(0.01); a[3] = 0.7;
  return makeRecord({ id, isrc: 'I' + id, activations: a, embeddings: new Float32Array(n * EMB_DIM).fill(0.05), patches: n,
                      source: { kind: 'deezer-isrc', deezerId, windows: [[0, 1]], seconds: 20 }, mel: MEL_VERSION, at: 1 });
}

test('needsClap: absent or older clap needs hearing; misses never do', () => {
  assert.equal(needsClap(oldRecord()), true);
  assert.equal(needsClap({ ...oldRecord(), clap: { model: 'older-clap', emb: packEmbedding(new Float32Array(CLAP_DIM).fill(0.1)) } }), true);
  assert.equal(needsClap({ id: 'm', miss: MISS.NO_PREVIEW }), false);
  assert.equal(needsClap(null), false);
});

test('fillClap adds clap to an old record without running the listening model or touching anything else', async () => {
  const rec = oldRecord();
  const d = deps({ ear: { run: async () => { throw new Error('the listening model must not run'); } } });
  d.clap = clapDep(d.seen);
  const r = await fillClap(d, rec);
  assert.ok(earCurrent(r.record, 'clap') && validRecord(r.record));
  const { clap, v, ...rest } = r.record, { clap: c0, v: v0, ...before } = rec;
  assert.deepEqual(rest, before);
});

test('fillClap: different recording, nothing heard, no clap dep, misses: skipped; network errors: failed', async () => {
  const withClap = (over = {}, c = {}) => { const d = deps(over); d.clap = clapDep(d.seen, c); return d; };
  assert.deepEqual(await fillClap(withClap(), oldRecord('sp1', 7)), { skip: 'different-recording' });
  assert.deepEqual(await fillClap(withClap({}, { embed: async () => null }), oldRecord()), { skip: 'nothing-heard' });
  assert.deepEqual(await fillClap(deps(), oldRecord()), { skip: 'no-clap' });
  assert.deepEqual(await fillClap(withClap(), { id: 'm', miss: MISS.NO_PREVIEW }), { skip: 'not-a-record' });
  assert.deepEqual(await fillClap(withClap({ lookup: async () => ({ miss: MISS.NO_PREVIEW }) }), oldRecord()), { skip: MISS.NO_PREVIEW });
  assert.equal((await fillClap(withClap({ fetchPreview: async () => ({ miss: MISS.FAILED, detail: '403' }) }), oldRecord())).failed.stage, 'download');
  assert.equal((await fillClap(withClap({}, { embed: async () => { throw new Error('x'); } }), oldRecord())).failed.stage, 'clap');
});

/* ---------------------------------------------- the controller and the switch */

function memStore(init = []) {
  const m = new Map(init.map(r => [r.id, r]));
  return { m, getAll: async () => new Map(m), put: async r => { m.set(r.id, r); }, count: async () => m.size };
}

test('the CLAP switch is on by default, and unticked means not allowed to download', () => {
  assert.equal(DEFAULT_DEEP_SETTINGS.clap, true);
  assert.equal(readDeepSettings({ getItem: () => null }).clap, true);
  assert.equal(deepListenAllowed('clap', { settings: { clap: false }, connection: { type: 'wifi' } }), 'off');
  assert.equal(deepListenAllowed('clap', { settings: { clap: true }, connection: { type: 'wifi' } }), 'ok');
  assert.equal(deepListenAllowed('clap', { settings: { clap: true }, connection: { type: 'cellular' } }), 'metered');
});

test('controller: with CLAP off its model is never loaded and records come out exactly as before', async () => {
  const s1 = memStore(), s2 = memStore([oldRecord('a')]);
  let loads = 0;
  await createAudioController({ store: s1, ...deps(), dsp: null, loadEar: async () => ({ ear: styleEar }) }).start([track]);
  await createAudioController({ store: s2, ...deps(), dsp: null, loadEar: async () => ({ ear: styleEar }),
    loadClap: async () => { loads++; return clapDep({ decoded48: 0 }); }, clapOn: () => false }).start([track]);
  assert.equal(loads, 0);
  assert.equal(JSON.stringify(s1.m.get('sp1')), JSON.stringify(s2.m.get('sp1')));
  assert.equal(s2.m.get('a').clap, null, 'no top-up while off');
});

test('controller: with CLAP on, new records get clap in the pass and old ones are topped up, within the budget', async () => {
  const store = memStore(['a', 'b', 'c'].map(id => oldRecord(id)));
  const d = deps();
  let loads = 0;
  const ctrl = createAudioController({ store, ...d, dsp: null, clapFillPerRun: 2, loadEar: async () => ({ ear: styleEar }),
    loadClap: async () => { loads++; return clapDep(d.seen); }, clapOn: () => true });
  await ctrl.start([track]);
  assert.equal(loads, 1);
  assert.ok(earCurrent(store.m.get('sp1'), 'clap'));
  assert.equal(['a', 'b', 'c'].filter(id => earCurrent(store.m.get(id), 'clap')).length, 2);
  await ctrl.start([]);
  assert.equal(loads, 1, 'loaded once');
  assert.ok(['a', 'b', 'c'].every(id => earCurrent(store.m.get(id), 'clap')));
});

test('controller: a CLAP model that fails to load leaves listening working', async () => {
  const store = memStore();
  const ctrl = createAudioController({ store, ...deps(), dsp: null, loadEar: async () => ({ ear: styleEar }),
    loadClap: async () => { throw new Error('offline'); }, clapOn: () => true });
  await ctrl.start([track]);
  assert.ok(validRecord(store.m.get('sp1')));
  assert.equal(store.m.get('sp1').clap, null);
  assert.equal(ctrl.vm().state, 'done');
});

/* ---------------------------------------------- the real encoder (optional) */

// Runs only with BETTERFY_MODEL_DIR pointing at docs/models (or a copy) and onnxruntime-node installed.
test('the shipped int8 encoder, end to end from samples, matches the reference (optional)',
  { skip: !(process.env.BETTERFY_MODEL_DIR && existsSync(`${process.env.BETTERFY_MODEL_DIR}/${CLAP_MODEL_FILE}`)) && 'set BETTERFY_MODEL_DIR to run' }, async () => {
  const ort = await import('onnxruntime-node');
  const { createClapEar } = await import('../core/audio/clap.mjs');
  const ear = await createClapEar({ ort, modelUrl: `${process.env.BETTERFY_MODEL_DIR}/${CLAP_MODEL_FILE}`, sessionOptions: {} });
  const field = await clapEmbed(ear, [kicks()]);
  const a = unpackEmbedding(field.emb), b = unpackEmbedding(FIX.signals.kicks.embFloat);
  let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  assert.ok(d / Math.hypot(...a) / Math.hypot(...b) > 0.99);
});
