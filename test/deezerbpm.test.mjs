// SOUND-ENGINE-PLAN T4: Deezer's own BPM as a second opinion.
// GTZAN is not in this checkout, so the >= 90% right bar is UNMEASURED; these tests are shaped
// like the plan's §2.4 numbers (76% agree overall, 84% at DSP confidence >= 0.3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lookup } from '../core/audio/fetch.mjs';
import { tempoOf, tempoShown, deezerAgreement, deezerBpmOf } from '../core/audio/match.mjs';
import { dspSoundVM } from '../web/audio/dsp-view.mjs';

const rec = (bpm, conf, dz, extra = {}) => ({ id: 'x', dsp: { bpm, bpmConf: conf, ...extra }, source: dz == null ? {} : { deezerBpm: dz } });
const hit = { id: 5, isrc: 'GBDUW0000059', duration: 200, readable: true, preview: 'https://p/x.mp3' };

test('lookup keeps Deezer bpm only when above 0', async () => {
  const j = o => async () => ({ ...hit, ...o });
  assert.equal((await lookup('GB-DUW-00-00059', { jsonp: j({ bpm: 128.4 }) })).deezerBpm, 128.4);
  assert.equal('deezerBpm' in (await lookup('GB-DUW-00-00059', { jsonp: j({ bpm: 0 }) })), false);
  assert.equal('deezerBpm' in (await lookup('GB-DUW-00-00059', { jsonp: j({}) })), false);
});

test('agreement within 2 BPM raises a 0.2 reading to sure', () => {
  assert.equal(tempoShown(rec(120, 0.2, null)).why, 'unsure');
  const s = tempoShown(rec(120, 0.2, 121));
  assert.equal(s.state, 'sure'); assert.equal(s.bpm, 120); assert.ok(s.conf >= 0.3);
  assert.equal(tempoShown(rec(120, 0.2, 124)).state, 'unknown', 'disagreement keeps the measured one: still unsure');
});

test('disagreement leaves a sure reading as measured', () => {
  const s = tempoShown(rec(120, 0.7, 90));
  assert.equal(s.state, 'sure'); assert.equal(s.bpm, 120); assert.equal(tempoOf(rec(120, 0.7, 90)).deezer, 'differ');
});

test('Deezer settles a flagged octave when it equals a candidate, else stays unknown', () => {
  const f = dz => rec(87, 0.6, dz, { octaveAmbiguous: true, bpmAlt: 174 });
  const a = tempoShown(f(174)); assert.equal(a.state, 'sure'); assert.equal(a.bpm, 174);
  const b = tempoShown(f(87)); assert.equal(b.bpm, 87);
  assert.equal(tempoShown(f(120)).why, 'octave');
  assert.equal(tempoShown(f(null)).why, 'octave');
});

test('never alone: no pulse or no audio stays unknown even with a Deezer BPM', () => {
  assert.equal(tempoShown(rec(120, 0.05, 120)).why, 'no-beat');
  assert.equal(tempoShown({ id: 'x', miss: 'NO_PREVIEW', source: { deezerBpm: 120 } }).why, 'no-audio');
  assert.equal(tempoShown({ id: 'x', dsp: null, source: { deezerBpm: 120 } }).state, 'unknown');
  assert.equal(deezerBpmOf({ source: { deezerBpm: 0 } }), null);
});

test('shaped like the plan: 76% agree; shown share rises >= 10 points on the 0.15-0.3 band', () => {
  const rows = [];
  for (let i = 0; i < 76; i++) rows.push(rec(120, i < 20 ? 0.2 : 0.6, 120 + (i % 3) - 1));
  for (let i = 0; i < 24; i++) rows.push(rec(120, i < 8 ? 0.2 : 0.6, 90));
  assert.equal(rows.filter(r => deezerAgreement(r) === 'agree').length, 76);
  const sure = rs => rs.filter(r => tempoShown(r).state === 'sure').length;
  const before = sure(rows.map(r => ({ ...r, source: {} })));
  assert.ok(sure(rows) - before >= 10, `${before} -> ${sure(rows)}`);
  assert.ok(rows.every(r => tempoShown(r).state !== 'sure' || tempoShown(r).bpm === 120));
});

test('the sound view model uses the second opinion', () => {
  const vm = dspSoundVM(rec(128, 0.2, 128), { show: false, bpm: true, key: false });
  assert.equal(vm.bpm, 128);
});
