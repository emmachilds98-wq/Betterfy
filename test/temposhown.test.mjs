// SOUND-ENGINE-PLAN T2 (one BPM everywhere) and T3 (one sure BPM, or "BPM unknown").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldIntoRange, displayTempo, tempoShown, TEMPO_UNKNOWN_TEXT } from '../core/audio/match.mjs';
import { identify } from '../core/audio/identify.mjs';
import { dspSoundVM } from '../web/audio/dsp-view.mjs';
import { soundChip } from '../web/ui/sound.mjs';
import { mixBpmOf, mixTempoCtx } from '../web/screens/shuffle.mjs';
import { STYLE_LABELS } from '../core/sources/audio-vocab.mjs';
import { makeRecord, N_STYLES, EMB_DIM } from '../core/audio/record.mjs';

const rec = (bpm, bpmConf = 0.8, extra = {}) => ({ id: 'x', dsp: { bpm, bpmConf, ...extra } });
const flagged = (bpm, alt, conf = 0.8) => rec(bpm, conf, { octaveAmbiguous: true, bpmAlt: alt });
const OFF = { show: false, bpm: true, key: false };

test('foldIntoRange: x2 or x1/2 only, nothing forced', () => {
  assert.equal(foldIntoRange(87, [160, 180]), 174);
  assert.equal(foldIntoRange(174, [80, 105]), 87);
  assert.equal(foldIntoRange(128, [115, 130]), 128);
  assert.equal(foldIntoRange(116, [160, 180]), null, '3:2 is not folded');
  assert.equal(foldIntoRange(0, [1, 2]), null);
});

test('displayTempo: a DnB track reads 174, never 87; house and techno are not moved', () => {
  assert.equal(displayTempo(rec(87), { genres: ['drum-and-bass'] }).bpm, 174);
  assert.equal(displayTempo(rec(87), { genres: ['liquid-dnb', 'drum-and-bass'] }).from, 'genre');
  assert.equal(displayTempo(rec(174), { genres: ['hip-hop'] }).bpm, 87);
  assert.equal(displayTempo(rec(126), { genres: ['house'] }).bpm, 126);
  assert.equal(displayTempo(rec(126), { genres: ['house'] }).from, 'measured');
  assert.equal(displayTempo(rec(140), { genres: ['techno'] }).bpm, 140);
  assert.equal(displayTempo(rec(87), { genres: ['rock'] }).bpm, 87, 'no tempo row: as measured');
  assert.equal(displayTempo(rec(87), {}).bpm, 87);
  assert.equal(displayTempo(null), null);
});

test('displayTempo: the playlist range comes before the genre table', () => {
  // A hip-hop playlist this listener keeps at trap tempo (140): the playlist wins over hip-hop's 80-105.
  assert.equal(displayTempo(rec(140), { playlistRange: { lo: 136, hi: 144 }, genres: ['hip-hop'] }).bpm, 140);
  assert.equal(displayTempo(rec(70), { playlistRange: { lo: 136, hi: 144 }, genres: ['hip-hop'] }).from, 'playlist');
  assert.equal(displayTempo(rec(70), { playlistRange: [136, 144] }).bpm, 140);
});

test('displayTempo: a flagged reading is settled by a range, else left unsettled', () => {
  const d = displayTempo(flagged(87, 174), { genres: ['drum-and-bass'] });
  assert.deepEqual([d.bpm, d.settled], [174, true]);
  const u = displayTempo(flagged(87, 174), {});
  assert.deepEqual([u.bpm, u.settled, u.alt], [87, false, 174]);
});

test('tempoShown: sure, or unknown with a reason (T3)', () => {
  assert.deepEqual(tempoShown(rec(87), { genres: ['drum-and-bass'] }), { state: 'sure', bpm: 174, from: 'genre', conf: 0.8 });
  assert.equal(tempoShown(rec(128, 0.29)).why, 'unsure', 'the 0.15-0.3 band is unknown, not "about"');
  assert.equal(tempoShown(rec(128, 0.1)).why, 'no-beat');
  assert.equal(tempoShown({ id: 'x', dsp: {} }).why, 'no-beat');
  assert.equal(tempoShown(null).why, 'no-audio');
  assert.equal(tempoShown({ id: 'x', miss: 'NO_PREVIEW' }).why, 'no-audio');
  assert.equal(tempoShown(flagged(87, 174)).why, 'octave');
  assert.equal(tempoShown(flagged(87, 174), { genres: ['drum-and-bass'] }).state, 'sure');
  for (const w of ['no-audio', 'no-beat', 'octave', 'unsure']) assert.ok(TEMPO_UNKNOWN_TEXT[w]);
});

test('the Beatport-shaped numbers: DnB in range up, house and techno untouched', () => {
  // 40 DnB readings shaped like the plan's: 20 at 85-90, 19 at 170-180, 1 at 116 (3:2, not foldable).
  const dnb = [...Array(20).fill(87), ...Array(19).fill(174), 116];
  const inRange = bpms => bpms.filter(b => b >= 160 && b <= 180).length;
  const folded = dnb.map(b => displayTempo(rec(b), { genres: ['drum-and-bass'] }).bpm);
  assert.equal(inRange(dnb), 19);
  assert.equal(inRange(folded), 39);
  const hh = [...Array(142)].map((_, i) => 120 + (i % 20));
  assert.equal(hh.filter(b => displayTempo(rec(b), { genres: ['house'] }).bpm !== b).length, 0, 'house readings do not move');
  assert.equal(hh.filter(b => displayTempo(rec(b), { genres: ['techno'] }).bpm !== b).length, 0, 'techno readings do not move');
});

test('every surface shows the same BPM for the same track (no raw reading)', () => {
  const r = rec(87, 0.8);
  const ctx = { genres: ['drum-and-bass'] };
  // sound card
  const vm = dspSoundVM(r, { ...OFF, ctx });
  assert.equal(vm.bpm, 174);
  assert.match(soundChip(vm), /174/);
  // Shuffle / DJ order row, from its playlist's name
  assert.equal(mixBpmOf(new Map([['x', { rec: r }]]), 'x', mixTempoCtx({ name: 'Drum & Bass' })), 174);
  // an unsure octave: unknown on the card, null in the mix, no "87/174" pair anywhere
  const f = flagged(87, 174);
  const u = dspSoundVM(f, OFF);
  assert.deepEqual(u, { bpmUnknown: 'octave' });
  assert.match(soundChip(u), /BPM unknown/);
  assert.equal(soundChip(u).includes('87'), false);
  assert.equal(mixBpmOf(new Map([['x', { rec: f }]]), 'x', {}), null);
  // below the bar: unknown, with its reason; tempo switched off: nothing
  assert.deepEqual(dspSoundVM(rec(120, 0.2), OFF), { bpmUnknown: 'unsure' });
  assert.equal(dspSoundVM(rec(120, 0.2), { show: false, bpm: false, key: false }), null);
});

test('identify: the BPM to show is folded into the genre it names', () => {
  const S = l => STYLE_LABELS.indexOf(`Electronic---${l}`);
  const act = new Float32Array(N_STYLES).fill(0.001); act[S('Drum n Bass')] = 0.9;
  const emb = new Float32Array(EMB_DIM).fill(0.05);
  const r = makeRecord({ id: 'x', isrc: 'GBXXX0000001', activations: act, embeddings: emb, patches: 1,
    source: { kind: 'deezer-isrc', deezerId: 1, windows: [[0, 165000]], seconds: 10 }, mel: '1.0.0',
    dsp: { bpm: 87, bpmConf: 0.8 }, at: 1000 });
  const id = identify(r, {});
  assert.equal(id.genre.slug, 'drum-and-bass');
  assert.equal(id.bpm.shown, 174);
  assert.equal(id.bpm.settled, true);
});
