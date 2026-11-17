import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

import { keySpec, KS_BINS, KS_Q_LO } from '../core/audio/dsp/keyspec.mjs';
import { CLASS_CAMELOT, blendKey, withKeyNet, keyNetFields, keepKeyNet, needsKeyNet, centreCrop,
         KEYNET_VERSION, KEYNET_SURE_P, KEYNET_MODEL_FILE } from '../core/audio/dsp/keynet.mjs';
import { KEY_MIN_CONF } from '../core/audio/match.mjs';
import { KEY_MIN_CONF as VIEW_KEY_MIN_CONF } from '../web/audio/dsp-view.mjs';
import { DSP_VERSION } from '../core/audio/dsp/combine.mjs';
import { BEATS_VERSION } from '../core/audio/dsp/beats.mjs';
import { createAudioController } from '../web/audio/controller.mjs';

// Key v4 (BUILD-5-PROGRESS.md "Key v4"): a learned key model blended with v3.

const SR = 16000;
const tone = (hz, s = 10) => Float32Array.from({ length: s * SR }, (_, i) => 0.3 * Math.sin(2 * Math.PI * hz * i / SR));
/** A log-probability vector sure of one class. */
const sureOf = (cls, p = 0.9) => Float32Array.from({ length: 24 }, (_, i) => Math.log(i === cls ? p : (1 - p) / 23));
const flat = () => new Float64Array(24).fill(Math.log(1 / 24));

test('classes map to Camelot: 0 is C major (8B), 21 is A minor (8A)', () => {
  assert.equal(CLASS_CAMELOT.length, 24);
  assert.equal(CLASS_CAMELOT[0], '8B');
  assert.equal(CLASS_CAMELOT[21], '8A');
  assert.equal(new Set(CLASS_CAMELOT).size, 24);
});

test('keySpec: quarter-tone grid tied to A440, standardised, ~10 frames a second', () => {
  const s = keySpec([tone(261.63), tone(261.63)]);
  assert.equal(s.bins, KS_BINS);
  assert.ok(s.frames >= 180 && s.frames <= 200, `frames ${s.frames}`);
  const avg = new Float64Array(KS_BINS);
  for (let f = 0; f < s.frames; f++) for (let b = 0; b < KS_BINS; b++) avg[b] += s.data[f * KS_BINS + b];
  const peak = avg.indexOf(Math.max(...avg));
  assert.ok(Math.abs(440 * 2 ** ((KS_Q_LO + peak) / 24) - 261.63) < 1, 'middle C lands on its band');
  let m = 0; for (const v of s.data) m += v;
  assert.ok(Math.abs(m / s.data.length) < 1e-3);
  assert.equal(keySpec([new Float32Array(100)]), null, 'too short');
  assert.equal(keySpec([new Float32Array(SR * 2)]), null, 'silence');
  assert.equal(centreCrop(s).length, s.frames * 105);
});

test('blendKey: the sure bar lands exactly on KEY_MIN_CONF, so every consumer keeps one threshold', () => {
  assert.equal(KEY_MIN_CONF, VIEW_KEY_MIN_CONF);
  const sure = blendKey(sureOf(21, 0.95), flat());
  assert.equal(sure.camelot, '8A');
  assert.equal(sure.key, 'A minor');
  assert.ok(sure.keyConf >= KEY_MIN_CONF);
  // A blended best probability of exactly KEYNET_SURE_P maps to KEY_MIN_CONF.
  const at = blendKey(sureOf(0, KEYNET_SURE_P), flat(), 0);
  assert.ok(Math.abs(at.keyConf - KEY_MIN_CONF) < 0.002, `${at.keyConf}`);
  const unsure = blendKey(sureOf(0, 0.2), flat(), 0);
  assert.ok(unsure.keyConf < KEY_MIN_CONF);
  // The v3 side moves the answer when the model is torn.
  const torn = Float32Array.from({ length: 24 }, (_, i) => Math.log(i === 0 || i === 7 ? 0.4 : 0.2 / 22));
  const v3 = Float64Array.from({ length: 24 }, (_, i) => Math.log(i === 7 ? 0.9 : 0.1 / 23));
  assert.equal(blendKey(torn, v3).camelot, CLASS_CAMELOT[7]);
});

test('withKeyNet: replaces the key, keeps v3 as keyV3 and everything else; a failing model changes nothing', async () => {
  const base = () => ({ v: DSP_VERSION, bpm: 124, bpmConf: 0.8, key: 'C major', camelot: '8B', keyConf: 0.3, loudness: -8 });
  const net = { logp: async () => sureOf(21) };
  const d = await withKeyNet(base, net)([tone(220), tone(220)]);
  assert.equal(d.camelot, '8A');
  assert.equal(d.keyNetV, KEYNET_VERSION);
  assert.equal(d.keyV3, '8B');
  assert.equal(d.keyV3Conf, 0.3);
  assert.equal(d.bpm, 124);
  assert.equal(d.loudness, -8);
  const broken = await withKeyNet(base, { logp: async () => { throw new Error('wasm'); } })([tone(220)]);
  assert.deepEqual(broken, base());
  assert.deepEqual(await withKeyNet(base, { logp: async () => null })([tone(220)]), base());
  assert.deepEqual(await withKeyNet(base, null)([tone(220)]), base());
  // Re-running v4 on a v4 reading keeps the original v3 answer.
  const again = await keyNetFields(net, [tone(220)], d);
  assert.equal(again.keyV3, '8B');
});

test('needsKeyNet and keepKeyNet', () => {
  assert.equal(needsKeyNet({ id: 'a', dsp: { v: DSP_VERSION, bpm: 120 } }), true);
  assert.equal(needsKeyNet({ id: 'a', dsp: { keyNetV: KEYNET_VERSION } }), false);
  assert.equal(needsKeyNet({ id: 'a', miss: 'no-preview' }), false);
  assert.equal(needsKeyNet({ id: 'a' }), false, 'no dsp yet: the dsp top-up comes first');
  const old = { bpm: 87, camelot: '8A', key: 'A minor', keyConf: 0.9, keyNetV: KEYNET_VERSION, keyV3: '8B', keyV3Conf: 0.3 };
  const fresh = { bpm: 174, beatsV: BEATS_VERSION, camelot: '8B', key: 'C major', keyConf: 0.3, keyAgree: true };
  const kept = keepKeyNet(old, fresh);
  assert.equal(kept.bpm, 174);
  assert.equal(kept.beatsV, BEATS_VERSION);
  assert.equal(kept.camelot, '8A');
  assert.equal(kept.keyNetV, KEYNET_VERSION);
  assert.equal('keyAgree' in kept, false);
  assert.equal(keepKeyNet({ bpm: 1 }, fresh), fresh, 'nothing to keep');
});

function memStore(init = []) {
  const m = new Map(init.map(r => [r.id, r]));
  return { m, getAll: async () => new Map(m), put: async r => { m.set(r.id, r); }, count: async () => m.size };
}
const heard = (id, extra = {}) => ({ id, isrc: 'GBXXX0000001', source: { deezerId: 7 },
  dsp: { v: DSP_VERSION, bpm: 174, bpmConf: 0.7, key: 'C major', camelot: '8B', keyConf: 0.2, beatsV: BEATS_VERSION, ...extra } });
const fakeDeps = () => ({
  lookup: async () => ({ deezerId: 7, previewUrl: 'u' }),
  fetchPreview: async () => ({ buffers: [new ArrayBuffer(8), new ArrayBuffer(8)] }),
  decode: async () => tone(220, 10),
  dsp: () => ({ v: DSP_VERSION, bpm: 87, bpmConf: 0.5, key: 'C major', camelot: '8B', keyConf: 0.2 }),
  loadEar: async () => { throw new Error('no ear needed'); },
});

test('controller: on by default, heard records get v4 within the budget, and only the key changes', async () => {
  const store = memStore(['a', 'b', 'c'].map(id => heard(id)));
  let loads = 0, runs = 0;
  const ctrl = createAudioController({ store, ...fakeDeps(), keyNetFillPerRun: 2,
    loadKeyNet: async () => { loads++; return { logp: async () => { runs++; return sureOf(21); } }; } });
  await ctrl.start([]);
  assert.equal(loads, 1);
  assert.equal(runs, 2);
  const done = [...store.m.values()].filter(r => r.dsp.keyNetV === KEYNET_VERSION);
  assert.equal(done.length, 2);
  for (const r of done) {
    assert.equal(r.dsp.camelot, '8A');
    assert.equal(r.dsp.bpm, 174, 'tempo kept (the dsp is not re-measured)');
    assert.equal(r.dsp.beatsV, BEATS_VERSION, 'Beat This kept');
    assert.equal(r.dsp.keyV3, '8B');
  }
  await ctrl.start([]);
  assert.equal([...store.m.values()].filter(r => r.dsp.keyNetV === KEYNET_VERSION).length, 3, 'the rest next run');
});

test('controller: switched off, never loaded; a model that will not load never fails the run and is not retried', async () => {
  const store = memStore([heard('a')]);
  let loads = 0;
  const off = createAudioController({ store, ...fakeDeps(), keyNetOn: () => false, loadKeyNet: async () => { loads++; return { logp: async () => sureOf(0) }; } });
  await off.start([]);
  assert.equal(loads, 0);
  const bad = createAudioController({ store, ...fakeDeps(), loadKeyNet: async () => { loads++; throw new Error('404'); } });
  const r = await bad.start([]);
  assert.equal(r.stopped, false);
  await bad.start([]);
  assert.equal(loads, 1);
  assert.equal(store.m.get('a').dsp.keyNetV, undefined);
});

test('the model is hosted next to the others, with its licence', () => {
  assert.ok(existsSync(new URL(`../docs/models/${KEYNET_MODEL_FILE}`, import.meta.url)));
  assert.match(readFileSync(new URL('../docs/models/LICENSE-KEYNET', import.meta.url), 'utf8'), /CC BY-SA 4\.0/);
  assert.match(readFileSync(new URL('../docs/models/LICENSE', import.meta.url), 'utf8'), /keynet-v4\.onnx/);
});
