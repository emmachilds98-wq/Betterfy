// WP-D4: DSP per window into records, lazy top-up, and the hidden-by-default view.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyseOne, analyseSamples, fillDsp, WORKER_VERSION } from '../core/audio/worker.js';
import { makeRecord, MISS, N_STYLES, EMB_DIM, validRecord } from '../core/audio/record.mjs';
import { SAMPLE_RATE, MEL_VERSION } from '../core/audio/mel.mjs';
import { combineTempo, combineKey, combineLoudness, measureWindows, needsDsp, DSP_VERSION,
         DISAGREE_PENALTY, OCTAVE_PENALTY, SLOW_FOLD, PULSE_FOLD } from '../core/audio/dsp/combine.mjs';
import { dspSoundVM, dspShown, bpmShown, DSP_UI_DEFAULT, BPM_UI_DEFAULT, BPM_MIN_CONF, DSP_UI_KEY } from '../web/audio/dsp-view.mjs';
import { createAudioController } from '../web/audio/controller.mjs';
import { soundChip } from '../web/ui/sound.mjs';

const memLS = (o = {}) => ({ getItem: k => (k in o ? o[k] : null), setItem: (k, v) => { o[k] = String(v); } });

/** 10 s of clicks at `bpm`, starting `phase` seconds in. */
function clicks(bpm, secs = 10, phase = 0) {
  const x = new Float32Array(Math.round(secs * SAMPLE_RATE));
  const step = 60 / bpm;
  for (let t = phase; t < secs; t += step) {
    const i0 = Math.round(t * SAMPLE_RATE);
    for (let i = 0; i < 160 && i0 + i < x.length; i++) x[i0 + i] = 0.8 * Math.exp(-i / 30) * Math.sin(i * 1.3);
  }
  return x;
}
const tone = secs => Float32Array.from({ length: Math.round(secs * SAMPLE_RATE) }, (_, i) => 0.2 * Math.sin(i / 7));

const ear = { run: async (data, n) => { const a = new Float32Array(n * N_STYLES).fill(0.01); for (let p = 0; p < n; p++) a[p * N_STYLES + 3] = 0.7;
  return { activations: a, embeddings: new Float32Array(n * EMB_DIM).fill(0.05) }; } };
function deps(over = {}) {
  const seen = { dspArgs: null, lookups: 0, fetches: 0 };
  return {
    seen, now: () => 5000, ear,
    lookup: async () => { seen.lookups++; return { deezerId: 42, previewUrl: 'https://cdnt-preview.dzcdn.net/p.mp3', durationMs: 200000, readable: true }; },
    fetchPreview: async () => { seen.fetches++; return { buffers: [new ArrayBuffer(8), new ArrayBuffer(9)], windows: [[0, 165000], [157413, 165000]], total: 479827, sliced: false }; },
    decode: async buf => (buf.byteLength === 8 ? clicks(120) : clicks(120, 10, 0.21)),
    ...over,
  };
}
const track = { id: 'sp1', isrc: 'GBXXX0000001', durationMs: 199000 };

/* ------------------------------------------------------ byte-identical, flag off */

test('without a dsp dep the record is byte-identical to one built without DSP', async () => {
  const d = deps();
  const r = await analyseOne(d, track);
  assert.equal(r.record.dsp, null);
  const samples = new Float32Array(2 * 10 * SAMPLE_RATE);
  const again = await analyseSamples(d, { id: 'sp1', isrc: track.isrc, samples, source: r.record.source });
  const plain = await analyseSamples(d, { id: 'sp1', isrc: track.isrc, samples, parts: [samples], source: r.record.source });
  assert.equal(JSON.stringify(again.record), JSON.stringify(plain.record), 'parts change nothing when there is no DSP');
});

test('key stays hidden by default; tempo shows alone above its measured confidence', () => {
  assert.equal(DSP_UI_DEFAULT, false);
  assert.equal(BPM_UI_DEFAULT, true);
  assert.equal(bpmShown(memLS()), true);
  assert.equal(bpmShown(memLS({ [DSP_UI_KEY]: '0' })), false, "'0' hides tempo too");
  const rec = { id: 'x', dsp: { v: DSP_VERSION, bpm: 128.2, bpmConf: 0.9, key: 'A minor', camelot: '8A', keyConf: 0.8 } };
  assert.deepEqual(dspSoundVM(rec, { show: false, bpm: true }), { bpm: 128, bpmConf: 0.9 }, 'no key by default');
  assert.equal(dspSoundVM({ id: 'y', dsp: { bpm: 120, bpmConf: BPM_MIN_CONF - 0.01 } }, { show: false, bpm: true }), null, 'below the measured bar');
  assert.deepEqual(dspSoundVM({ id: 'z', dsp: { bpm: 87, bpmConf: 0.5, octaveAmbiguous: true, bpmAlt: 174, key: 'C major', keyConf: 0.9 } }, { show: false, bpm: true }),
    { bpm: 87, bpmConf: 0.5, bpmAlt: 174 });
  for (const r of [null, undefined, { id: 'm', miss: MISS.NO_PREVIEW }, { id: 'n', dsp: null }])
    assert.equal(soundChip(dspSoundVM(r, { show: false, bpm: true })), '', 'no data, no markup');
});

test('the full BPM/key display is off by default and renders nothing, with or without records', () => {
  assert.equal(DSP_UI_DEFAULT, false);
  assert.equal(dspShown(memLS()), false);
  assert.equal(dspShown(null), false);
  assert.equal(dspShown({ getItem() { throw new Error('private mode'); } }), false);
  const rec = { id: 'x', dsp: { v: DSP_VERSION, bpm: 128, bpmConf: 0.9, key: 'A minor', camelot: '8A', keyConf: 0.8 } };
  assert.equal(dspSoundVM(rec, { show: dspShown(memLS()), bpm: false }), null);
  for (const r of [null, undefined, { id: 'm', miss: MISS.NO_PREVIEW }, { id: 'n', dsp: null }, rec])
    assert.equal(soundChip(dspSoundVM(r, { show: false, bpm: false })), '', 'no data, no markup');
  assert.equal(dspShown(memLS({ [DSP_UI_KEY]: '1' })), true, 'a per-browser override turns it on for checking');
  assert.equal(dspShown(memLS({ [DSP_UI_KEY]: '0' })), false);
});

test('when shown, the view model carries BPM, key, Camelot and confidence, and the octave partner only when unsure', () => {
  const show = { show: true };
  assert.deepEqual(dspSoundVM({ id: 'a', dsp: { bpm: 127.6, bpmConf: 0.8, octaveAmbiguous: false, bpmAlt: 64, key: 'A minor', camelot: '8A', keyConf: 0.6, energy: 0.7 } }, show),
    { bpm: 128, bpmConf: 0.8, key: 'A minor', camelot: '8A', keyConf: 0.6 }, 'energy stays hidden, bpmAlt only when ambiguous');
  assert.deepEqual(dspSoundVM({ id: 'b', dsp: { bpm: 87, bpmConf: 0.5, octaveAmbiguous: true, bpmAlt: 174 } }, show),
    { bpm: 87, bpmConf: 0.5, bpmAlt: 174 });
  assert.equal(dspSoundVM({ id: 'c', dsp: { bpm: 120, bpmConf: 0.05, key: 'C major', camelot: '8B', keyConf: 0.01 } }, show), null, 'too unsure to show');
  assert.equal(dspSoundVM({ id: 'd', dsp: { loudness: -9, energy: 0.6 } }, show), null);
  assert.equal(dspSoundVM({ id: 'e', miss: MISS.NOT_ON_DEEZER, dsp: { bpm: 120, bpmConf: 1 } }, show), null);
});

/* ------------------------------------------------------ combining two windows */

const T = (bpm, confidence, extra = {}) => ({ bpm, confidence, alternates: [], octaveAmbiguous: false, ...extra });

test('tempo: two windows within ±1 BPM agree on a confidence-weighted mean', () => {
  const c = combineTempo([T(127.8, 0.6), T(128.4, 0.9)]);
  assert.equal(c.agree, true);
  assert.ok(Math.abs(c.bpm - 128.2) < 0.05, String(c.bpm));
  assert.equal(c.bpmConf, 0.9);
  assert.equal(c.octaveAmbiguous, false);
});

test('tempo: half/double time across windows keeps the more confident, lowers confidence, flags it', () => {
  const c = combineTempo([T(87, 0.5), T(174.2, 0.8)]);
  assert.equal(c.bpm, 174.2);
  assert.equal(c.bpmAlt, 87);
  assert.equal(c.octaveAmbiguous, true);
  assert.equal(c.agree, false);
  assert.equal(c.bpmConf, +(0.8 * OCTAVE_PENALTY).toFixed(3));
});

test('tempo: any other disagreement keeps the more confident and lowers confidence', () => {
  const c = combineTempo([T(120, 0.7), T(133, 0.4)]);
  assert.deepEqual(c, { bpm: 120, bpmConf: +(0.7 * DISAGREE_PENALTY).toFixed(3), octaveAmbiguous: false, agree: false });
});

test("tempo: D1's own octave ambiguity is kept, with its partner", () => {
  const amb = T(85, 0.6, { octaveAmbiguous: true, alternates: [{ bpm: 170, score: 0.9 }] });
  assert.deepEqual(combineTempo([amb]), { bpm: 85, bpmConf: 0.6, octaveAmbiguous: true, bpmAlt: 170, agree: null });
  const both = combineTempo([amb, T(85.4, 0.7)]);
  assert.equal(both.octaveAmbiguous, true, 'agreeing windows do not wash out the ambiguity');
  assert.equal(both.bpmAlt, 170);
});

test('tempo: a slow reading with a steady dance pulse is taken at double time; faster ones are left alone', () => {
  assert.equal(SLOW_FOLD, 74);
  assert.equal(PULSE_FOLD, 0.38);
  const P = { pulse: 0.5 };
  assert.equal(combineTempo([T(64, 0.8, P), T(64.2, 0.6, P)]).bpm, 128.2);
  assert.deepEqual(combineTempo([T(70, 0.7, P)]), { bpm: 140, bpmConf: 0.7, octaveAmbiguous: false, agree: null });
  // Flagged half/double time keeps the slow reading as the alternate.
  const amb = combineTempo([T(65, 0.6, { ...P, octaveAmbiguous: true, alternates: [{ bpm: 130, score: 0.8 }] })]);
  assert.equal(amb.bpm, 130); assert.equal(amb.bpmAlt, 65); assert.equal(amb.octaveAmbiguous, true);
  // At or above the fold, and where ×2 would pass 200, nothing moves.
  assert.equal(combineTempo([T(74, 0.7, P)]).bpm, 74);
  assert.equal(combineTempo([T(87, 0.7, P)]).bpm, 87);
  assert.equal(combineTempo([T(174, 0.7, P)]).bpm, 174);
});

test('tempo: the fold is gated on the pulse: a ballad or swung jazz at 66 stays 66', () => {
  assert.equal(combineTempo([T(66, 0.7, { pulse: 0.25 })]).bpm, 66);
  assert.equal(combineTempo([T(66, 0.7)]).bpm, 66, 'no pulse measured: no fold');
  // Only windows that heard this tempo count: a pulsing window at 120 does not move a 66.
  assert.equal(combineTempo([T(66, 0.9, { pulse: 0.2 }), T(120, 0.3, { pulse: 0.6 })]).bpm, 66);
  // Mean of the agreeing windows.
  assert.equal(combineTempo([T(66, 0.9, { pulse: 0.3 }), T(66.4, 0.5, { pulse: 0.5 })]).bpm, 132.3);
  // Options: no fold at all, or the ungated fold the measurements compare against.
  assert.equal(combineTempo([T(66, 0.7, { pulse: 0.9 })], { slowFold: 0 }).bpm, 66);
  assert.equal(combineTempo([T(66, 0.7, { pulse: 0.1 })], { pulseFold: -Infinity }).bpm, 132);
});

test('tempo: no beat in either window gives nothing; one good window is used alone', () => {
  assert.equal(combineTempo([T(null, 0), T(null, 0)]), null);
  assert.equal(combineTempo([]), null);
  assert.deepEqual(combineTempo([T(null, 0), T(140, 0.7)]), { bpm: 140, bpmConf: 0.7, octaveAmbiguous: false, agree: null });
});

const K = (camelot, key, confidence) => ({ key, camelot, confidence });
test('key: same key agrees; different keys keep the more confident, lowered, with the other noted', () => {
  assert.deepEqual(combineKey([K('8A', 'A minor', 0.4), K('8A', 'A minor', 0.6)]), { key: 'A minor', camelot: '8A', keyConf: 0.6, agree: true });
  assert.deepEqual(combineKey([K('8A', 'A minor', 0.4), K('8B', 'C major', 0.6)]),
    { key: 'C major', camelot: '8B', keyConf: +(0.6 * DISAGREE_PENALTY).toFixed(3), agree: false, keyAlt: '8A' });
  assert.equal(combineKey([{ key: null, camelot: null, confidence: 0 }]), null);
  assert.deepEqual(combineKey([{ key: null, camelot: null, confidence: 0 }, K('5A', 'C minor', 0.3)]), { key: 'C minor', camelot: '5A', keyConf: 0.3, agree: null });
});

test('loudness: averaged in power, energy averaged', () => {
  const c = combineLoudness([{ loudness: -10, energy: 0.6 }, { loudness: -20, energy: 0.2 }]);
  assert.equal(c.loudness, +(10 * Math.log10((0.1 + 0.01) / 2)).toFixed(2));
  assert.equal(c.energy, 0.4);
  assert.equal(combineLoudness([null]), null);
});

test('measureWindows runs each estimator per window, on real click tracks', () => {
  const d = measureWindows([clicks(120), clicks(120, 10, 0.21)]);
  assert.equal(d.v, DSP_VERSION);
  assert.equal(d.windows, 2);
  assert.ok(Math.abs(d.bpm - 120) <= 1, `bpm ${d.bpm}`);
  assert.equal(d.bpmAgree, true);
  assert.ok(Number.isFinite(d.loudness) && Number.isFinite(d.energy));
  const one = measureWindows([clicks(140)]);
  assert.ok(Math.abs(one.bpm - 140) <= 1, `bpm ${one.bpm}`);
  assert.equal(one.windows, 1);
  assert.equal(one.bpmAgree, undefined);
});

test('per window beats the join: the cut between windows does not reach the tempo estimate', () => {
  const seen = [];
  measureWindows([clicks(120), clicks(120, 10, 0.21)], { tempo: w => { seen.push(w.length); return T(120, 0.8); }, key: () => null, loudness: () => null });
  assert.deepEqual(seen, [10 * SAMPLE_RATE, 10 * SAMPLE_RATE], 'each window measured alone, never the 20 s join');
});

test('one estimator throwing leaves only its own fields out', () => {
  const boom = () => { throw new Error('x'); };
  const d = measureWindows([tone(10)], { tempo: boom, key: () => K('8A', 'A minor', 0.5), loudness: () => ({ loudness: -12, energy: 0.5 }) });
  assert.equal(d.bpm, undefined);
  assert.equal(d.camelot, '8A');
  assert.equal(d.loudness, -12);
  assert.equal(measureWindows([tone(10)], { tempo: boom, key: boom, loudness: boom }), null);
  assert.equal(measureWindows([]), null);
  assert.equal(measureWindows(null), null);
});

test('needsDsp: absent or older dsp needs measuring; misses never do', () => {
  assert.equal(needsDsp({ id: 'a', dsp: null }), true);
  assert.equal(needsDsp({ id: 'a', dsp: { v: 'old', bpm: 120 } }), true);
  assert.equal(needsDsp({ id: 'a', dsp: { v: DSP_VERSION } }), false);
  assert.equal(needsDsp({ id: 'a', miss: MISS.NO_PREVIEW }), false);
  assert.equal(needsDsp(null), false);
});

/* ------------------------------------------------------ the worker */

test('WORKER_VERSION is bumped for per-window DSP', () => assert.equal(WORKER_VERSION, '1.1.0'));

test('worker: dsp gets the decoded windows separately and lands in a valid record', async () => {
  const d = deps({ dsp: parts => { d.seen.dspArgs = parts.map(p => p.length); return measureWindows(parts); } });
  const r = await analyseOne(d, track);
  assert.ok(validRecord(r.record));
  assert.deepEqual(d.seen.dspArgs, [10 * SAMPLE_RATE, 10 * SAMPLE_RATE]);
  assert.ok(Math.abs(r.record.dsp.bpm - 120) <= 1);
  assert.equal(r.record.dsp.v, DSP_VERSION);
  assert.equal(r.record.mel, MEL_VERSION);
});

test('worker: dsp absent, returning null, or throwing never fails the track', async () => {
  for (const dsp of [undefined, () => null, () => { throw new Error('dsp blew up'); }]) {
    const r = await analyseOne(deps(dsp ? { dsp } : {}), track);
    assert.ok(r.record && validRecord(r.record));
    assert.equal(r.record.dsp, null);
  }
});

test('worker: analyseSamples without parts measures the samples it has as one window', async () => {
  let got = null;
  await analyseSamples({ ear, now: () => 1, dsp: p => { got = p.length; return null; } },
    { id: 'z', isrc: 'I', samples: tone(5), source: {} });
  assert.equal(got, 1);
});

/* ------------------------------------------------------ lazy fill */

function oldRecord(id = 'sp1', deezerId = 42) {
  const n = 2;
  const a = new Float32Array(n * N_STYLES).fill(0.01); a[3] = 0.7;
  return makeRecord({ id, isrc: 'I' + id, activations: a, embeddings: new Float32Array(n * EMB_DIM).fill(0.05), patches: n,
                      source: { kind: 'deezer-isrc', deezerId, windows: [[0, 1]], seconds: 20 }, mel: MEL_VERSION, at: 1 });
}

test('fillDsp adds dsp to an old record without touching anything else, and never runs the model', async () => {
  const rec = oldRecord();
  const d = deps({ dsp: measureWindows, ear: { run: async () => { throw new Error('the model must not run'); } } });
  const r = await fillDsp(d, rec);
  assert.ok(r.record);
  const { dsp, ...rest } = r.record;
  const { dsp: was, ...before } = rec;
  assert.equal(was, null);
  assert.deepEqual(rest, before, 'embedding, styles, sections, versions all unchanged');
  assert.ok(Math.abs(dsp.bpm - 120) <= 1);
  assert.ok(validRecord(r.record));
});

test('fillDsp: different recording, nothing measured, no dsp dep, misses: skipped; network errors: failed', async () => {
  assert.deepEqual(await fillDsp(deps({ dsp: measureWindows }), oldRecord('sp1', 7)), { skip: 'different-recording' });
  assert.deepEqual(await fillDsp(deps({ dsp: () => null }), oldRecord()), { skip: 'nothing-measured' });
  assert.deepEqual(await fillDsp(deps(), oldRecord()), { skip: 'no-dsp' });
  assert.deepEqual(await fillDsp(deps({ dsp: measureWindows }), { id: 'm', miss: MISS.NO_PREVIEW }), { skip: 'not-a-record' });
  assert.deepEqual(await fillDsp(deps({ dsp: measureWindows, lookup: async () => ({ miss: MISS.NO_PREVIEW }) }), oldRecord()), { skip: MISS.NO_PREVIEW });
  const f = await fillDsp(deps({ dsp: measureWindows, fetchPreview: async () => ({ miss: MISS.FAILED, detail: '403' }) }), oldRecord());
  assert.equal(f.failed.stage, 'download');
});

function memStore(init = []) {
  const m = new Map(init.map(r => [r.id, r]));
  return { m, getAll: async () => new Map(m), put: async r => { m.set(r.id, r); }, count: async () => m.size };
}

test('controller: stored records without dsp are topped up after the queue, even when nothing is left to hear', async () => {
  const store = memStore([oldRecord('a'), oldRecord('b'), { ...oldRecord('c'), dsp: { v: DSP_VERSION, bpm: 99, bpmConf: 1 } },
                          { id: 'm', v: 1, miss: MISS.NO_PREVIEW }]);
  const d = deps();
  const ctrl = createAudioController({ store, ...d, loadEar: async () => { throw new Error('no model needed'); } });
  assert.deepEqual(await ctrl.start([]), { done: 0, stopped: false });
  assert.equal(d.seen.lookups, 2, 'only the two records missing dsp');
  assert.ok(Math.abs(store.m.get('a').dsp.bpm - 120) <= 1);
  assert.equal(store.m.get('c').dsp.bpm, 99, 'current dsp untouched');
  assert.equal(ctrl.vm().state, 'done');
  await ctrl.start([]);
  assert.equal(d.seen.lookups, 2, 'nothing left to top up');
});

test('controller: new records get dsp; dsp: null turns DSP and the top-up off; the budget caps a run', async () => {
  const s1 = memStore();
  const c1 = createAudioController({ store: s1, ...deps(), loadEar: async () => ({ ear }) });
  await c1.start([track]);
  assert.ok(Math.abs(s1.m.get('sp1').dsp.bpm - 120) <= 1);

  const s2 = memStore([oldRecord('a')]);
  const d2 = deps();
  const c2 = createAudioController({ store: s2, ...d2, dsp: null, loadEar: async () => ({ ear }) });
  await c2.start([track]);
  assert.equal(s2.m.get('sp1').dsp, null);
  assert.equal(s2.m.get('a').dsp, null);
  assert.equal(d2.seen.lookups, 1, 'no top-up lookups');

  const s3 = memStore(['a', 'b', 'c', 'd'].map(id => oldRecord(id)));
  const d3 = deps();
  const c3 = createAudioController({ store: s3, ...d3, dspFillPerRun: 3, loadEar: async () => ({ ear }) });
  await c3.start([]);
  assert.equal(d3.seen.lookups, 3);
});

test('controller: stop during the top-up finishes the record in flight and pauses', async () => {
  const store = memStore(['a', 'b', 'c'].map(id => oldRecord(id)));
  const d = deps();
  let ctrl;
  const lookup = d.lookup;
  d.lookup = async (...a) => { const r = await lookup(...a); if (d.seen.lookups === 1) ctrl.stop(); return r; };
  ctrl = createAudioController({ store, ...d, loadEar: async () => ({ ear }) });
  const res = await ctrl.start([]);
  assert.equal(res.stopped, true);
  assert.equal(ctrl.vm().state, 'paused');
  assert.equal(d.seen.lookups, 1);
  assert.ok(store.m.get('a').dsp, 'the one in flight was stored');
  assert.equal(store.m.get('b').dsp, null);
});

/* ------------------------------------------------------ the sound chip */

test('soundChip: nothing to show, no markup', () => {
  for (const vm of [null, undefined, {}, { bpm: 0 }, { bpm: NaN }, { key: '' }, { voice: null }, 'x'])
    assert.equal(soundChip(vm), '', JSON.stringify(vm));
});

test('soundChip: BPM and key with Camelot, confidence in the title', () => {
  const h = soundChip({ bpm: 174, bpmConf: 0.82, key: 'A minor', camelot: '8A', keyConf: 0.66 });
  assert.match(h, /^<span class="snd">/);
  assert.match(h, /174 <span class="snd-unit">BPM<\/span>/);
  assert.match(h, /title="174 BPM · confidence 82%"/);
  assert.match(h, /8A <span class="snd-sub">A minor<\/span>/);
  assert.match(h, /title="A minor · Camelot 8A · confidence 66%"/);
  assert.doesNotMatch(h, /snd-unsure/);
  assert.doesNotMatch(h, /energy/, 'no energy in the view model, none drawn');
});

test('soundChip: half/double time unsure reads 87/174; low confidence is marked unsure', () => {
  const h = soundChip({ bpm: 174, bpmAlt: 87, bpmConf: 0.4 });
  assert.match(h, /87\/174 <span class="snd-unit">BPM<\/span>/);
  assert.match(h, /half\/double time is unsure \(87 or 174\)/);
  assert.match(h, /class="snd-bpm snd-unsure"/);
  assert.match(h, /<span class="snd-q">\?<\/span>/);
});

test('soundChip: energy bars and voice when given; text is escaped', () => {
  const h = soundChip({ energy: 0.62, voice: 'vocal', key: '<b>' });
  assert.equal((h.match(/<i class="on"><\/i>/g) ?? []).length, 3);
  assert.equal((h.match(/<i><\/i>/g) ?? []).length, 2);
  assert.match(h, /vocal/);
  assert.match(h, /&lt;b&gt;/);
  assert.doesNotMatch(h, /<b>/);
});

test('record → view model → chip, end to end, only when shown', async () => {
  const d = deps({ dsp: measureWindows });
  const { record } = await analyseOne(d, track);
  assert.equal(soundChip(dspSoundVM(record, { show: false, bpm: false })), '');
  const h = soundChip(dspSoundVM(record, { show: true }));
  assert.match(h, /12\d <span class="snd-unit">BPM/);
});
