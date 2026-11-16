import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAudioController } from '../web/audio/controller.mjs';
import { needsBeatsFlagged, BEATS_VERSION, BEATS_FILL_PER_RUN, BEAT_MODEL_FILE } from '../core/audio/dsp/beats.mjs';
import { DSP_VERSION } from '../core/audio/dsp/combine.mjs';
import { deepListenAllowed, DEFAULT_DEEP_SETTINGS, DEEP_EARS } from '../web/audio/deep-settings.mjs';
import { readFileSync, existsSync } from 'node:fs';

// Beat This is an opt-in under Deep listen and runs only on tracks whose
// half/double time the DSP flagged (BUILD-5-PROGRESS.md, 2026-11-16).

const flagged = id => ({ id, isrc: 'GBXXX0000001', source: { deezerId: 7 },
  dsp: { v: DSP_VERSION, bpm: 87, bpmConf: 0.5, octaveAmbiguous: true, bpmAlt: 174 } });
const clear = id => ({ id, isrc: 'GBXXX0000001', source: { deezerId: 7 },
  dsp: { v: DSP_VERSION, bpm: 128, bpmConf: 0.9, octaveAmbiguous: false } });

function memStore(init = []) {
  const m = new Map(init.map(r => [r.id, r]));
  return { m, getAll: async () => new Map(m), put: async r => { m.set(r.id, r); }, count: async () => m.size };
}
const fakeDeps = () => ({
  lookup: async () => ({ deezerId: 7, previewUrl: 'u' }),
  fetchPreview: async () => ({ buffers: [new ArrayBuffer(8), new ArrayBuffer(8)] }),
  decode: async () => new Float32Array(16000),
  // a fixed DSP reading, so the test does not depend on the audio
  dsp: () => ({ v: DSP_VERSION, bpm: 87, bpmConf: 0.5, octaveAmbiguous: true, bpmAlt: 174 }),
  loadEar: async () => { throw new Error('no ear needed'); },
});

test('only tracks the DSP flagged as half/double-time unsure are due', () => {
  assert.equal(needsBeatsFlagged(flagged('a')), true);
  assert.equal(needsBeatsFlagged(clear('b')), false);
  assert.equal(needsBeatsFlagged({ ...flagged('c'), dsp: { ...flagged('c').dsp, beatsV: BEATS_VERSION } }), false, 'already listened to');
  assert.equal(needsBeatsFlagged({ id: 'm', miss: 'no-preview' }), false);
  assert.equal(needsBeatsFlagged(null), false);
});

test('the switch is off by default, needs Wi-Fi, and has no memory rule', () => {
  assert.equal(DEFAULT_DEEP_SETTINGS.beats, false);
  assert.ok(DEEP_EARS.includes('beats'));
  assert.equal(deepListenAllowed('beats', {}), 'off');
  assert.equal(deepListenAllowed('beats', { settings: { beats: true }, connection: { type: 'cellular' } }), 'metered');
  assert.equal(deepListenAllowed('beats', { settings: { beats: true }, connection: { type: 'wifi' }, deviceMemory: 1 }), 'ok');
});

test('controller: switch off, the model is never loaded and no record changes', async () => {
  const store = memStore([flagged('a'), clear('b')]);
  let loads = 0;
  const ctrl = createAudioController({ store, ...fakeDeps(), loadBeats: async () => { loads++; return { measure: async () => ({ bpm: 174, regularity: 1 }) }; },
    beatsOn: () => false });
  await ctrl.start([]);
  assert.equal(loads, 0);
  assert.equal(store.m.get('a').dsp.beatsV, undefined);
  assert.equal(store.m.get('a').dsp.bpm, 87);
});

test('controller: switch on, only flagged tracks are re-listened to, within the budget, and the level is settled', async () => {
  const ids = ['a', 'b', 'c'];
  const store = memStore([...ids.map(flagged), clear('z')]);
  let loads = 0, measured = 0;
  const ctrl = createAudioController({ store, ...fakeDeps(), beatsFillPerRun: 2, beatsOn: () => true,
    loadBeats: async () => { loads++; return { measure: async () => { measured++; return { bpm: 174, regularity: 0.9 }; } }; } });
  await ctrl.start([]);
  assert.equal(loads, 1);
  assert.equal(measured, 2, 'two this run');
  const done = ids.filter(id => store.m.get(id).dsp.beatsV === BEATS_VERSION);
  assert.equal(done.length, 2);
  for (const id of done) {
    const d = store.m.get(id).dsp;
    assert.equal(d.bpm, 174, 'Beat This heard double time');
    assert.equal(d.bpmAlt, 87);
    assert.equal(d.octaveAmbiguous, false);
    assert.equal(d.octaveBy, 'beats');
  }
  assert.equal(store.m.get('z').dsp.beatsV, undefined, 'a clear tempo is never sent to Beat This');
  await ctrl.start([]);
  assert.equal(ids.filter(id => store.m.get(id).dsp.beatsV === BEATS_VERSION).length, 3, 'the rest next run');
  assert.equal(measured, 3);
  assert.ok(BEATS_FILL_PER_RUN > 0);
});

test('controller: a tracker that fails changes nothing and is not retried in the same session', async () => {
  const store = memStore([flagged('a')]);
  let calls = 0;
  const ctrl = createAudioController({ store, ...fakeDeps(), beatsOn: () => true,
    loadBeats: async () => ({ measure: async () => { calls++; throw new Error('wasm died'); } }) });
  await ctrl.start([]);
  await ctrl.start([]);
  assert.equal(calls, 1);
  const d = store.m.get('a').dsp;
  assert.equal(d.bpm, 87);
  assert.equal(d.beatsV, undefined, 'a later session tries again');
});

test('controller: a model that will not load never fails the run', async () => {
  const store = memStore([flagged('a')]);
  const ctrl = createAudioController({ store, ...fakeDeps(), beatsOn: () => true, loadBeats: async () => { throw new Error('404'); } });
  const r = await ctrl.start([]);
  assert.equal(r.stopped, false);
  assert.equal(store.m.get('a').dsp.bpm, 87);
});

test('the model file is hosted next to the others, with its licence', () => {
  assert.ok(existsSync(new URL(`../docs/models/${BEAT_MODEL_FILE}`, import.meta.url)));
  assert.match(readFileSync(new URL('../docs/models/LICENSE-BEAT-THIS', import.meta.url), 'utf8'), /MIT/);
  assert.match(readFileSync(new URL('../docs/models/LICENSE', import.meta.url), 'utf8'), /beat-this-small0\.onnx/);
});
