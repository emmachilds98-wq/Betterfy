import { test } from 'node:test';
import assert from 'node:assert/strict';

import { KEY_MIN_CONF as MATCH_MIN, keyOfRecord, keyFit, mixesWith, KEY_RANK_BONUS } from '../core/audio/match.mjs';
import { mixOrder, mixIndex, WEIGHTS } from '../core/audio/order.mjs';
import { dspSoundVM, keyShown, KEY_MIN_CONF as VIEW_MIN, DSP_UI_KEY } from '../web/audio/dsp-view.mjs';
import { makeRecord, N_STYLES, EMB_DIM } from '../core/audio/record.mjs';
import { soundChip } from '../web/ui/sound.mjs';

// A key shows, and counts for mixing, only when its confidence clears the bar
// measured on the Beatport held-out half (BUILD-5-PROGRESS.md, 2026-11-16).

const memLS = (o = {}) => ({ getItem: k => o[k] ?? null });

test('the chip bar and the mixing bar are one number, and not below the measured one', () => {
  assert.equal(VIEW_MIN, MATCH_MIN);
  assert.ok(VIEW_MIN >= 0.65);
});

test('the chip shows a key only at or above the bar; unsure tracks show no key', () => {
  const dsp = keyConf => ({ id: 'k', dsp: { bpm: 128, bpmConf: 0.9, key: 'A minor', camelot: '8A', keyConf } });
  const sure = dspSoundVM(dsp(VIEW_MIN), { show: false, bpm: true, key: true });
  assert.equal(sure.camelot, '8A');
  assert.equal(sure.keyConf, VIEW_MIN);
  const unsure = dspSoundVM(dsp(VIEW_MIN - 0.01), { show: false, bpm: true, key: true });
  assert.deepEqual(unsure, { bpm: 128, bpmConf: 0.9 }, 'tempo stays, the key is gone');
  assert.equal(dspSoundVM(dsp(0.4), { show: false, bpm: false, key: true }), null, 'an unsure key alone shows nothing');
  assert.doesNotMatch(soundChip(unsure), /8A|A minor/);
  assert.match(soundChip(sure), /8A|A minor/);
  // checking mode still lists every reading
  assert.equal(dspSoundVM(dsp(0.2), { show: true }).camelot, '8A');
});

test("key is on by default and the browser's '0' override switches it off", () => {
  assert.equal(keyShown(memLS()), true);
  assert.equal(keyShown(null), true);
  assert.equal(keyShown(memLS({ [DSP_UI_KEY]: '0' })), false);
  assert.equal(keyShown(memLS({ [DSP_UI_KEY]: '1' })), true);
  const rec = { id: 'x', dsp: { bpm: 128, bpmConf: 0.9, key: 'A minor', camelot: '8A', keyConf: 0.9 } };
  assert.equal(dspSoundVM(rec, { show: false, bpm: false, key: keyShown(memLS({ [DSP_UI_KEY]: '0' })) }), null);
});

test('keyOfRecord: only sure, well-formed Camelot codes; misses and unsure are null', () => {
  const r = (camelot, keyConf) => ({ id: 'a', dsp: { camelot, keyConf } });
  assert.equal(keyOfRecord(r('8a', MATCH_MIN)), '8A');
  assert.equal(keyOfRecord(r('12B', 1)), '12B');
  assert.equal(keyOfRecord(r('8A', MATCH_MIN - 0.001)), null);
  assert.equal(keyOfRecord(r('13A', 1)), null);
  assert.equal(keyOfRecord(r('Am', 1)), null);
  assert.equal(keyOfRecord({ id: 'm', miss: 'no-preview', dsp: { camelot: '8A', keyConf: 1 } }), null);
  assert.equal(keyOfRecord(null), null);
  assert.equal(keyOfRecord({ id: 'n', dsp: null }), null);
});

test('keyFit: same, adjacent (wraps 12 to 1), relative; everything else clashes; unknown claims nothing', () => {
  assert.equal(keyFit('8A', '8A'), 'same');
  assert.equal(keyFit('8A', '8B'), 'relative');
  assert.equal(keyFit('8A', '9A'), 'adjacent');
  assert.equal(keyFit('1A', '12A'), 'adjacent');
  assert.equal(keyFit('8A', '9B'), 'clash');
  assert.equal(keyFit('8A', '10A'), 'clash');
  assert.equal(keyFit(null, '8A'), null);
  assert.equal(keyFit('8A', undefined), null);
});

/* ---------- mixing ---------- */

const hash = s => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
function emb(id, base) {
  let s = hash(id) || 1;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5;
  return Float32Array.from({ length: EMB_DIM }, (_, i) => (i === base ? 1 : 0) + 0.02 * rnd());
}
function rec(id, { bpm = 124, camelot = null, keyConf = 0.9, e = 0 }) {
  return makeRecord({ id, isrc: 'GBXXX0000001', activations: new Float32Array(N_STYLES).fill(0.001), embeddings: emb(id, e),
    patches: 1, source: { kind: 'deezer-isrc', deezerId: 1, windows: [[0, 165000]], seconds: 10 }, mel: '1.0.0',
    dsp: { bpm, bpmConf: 0.8, octaveAmbiguous: false, ...(camelot ? { key: 'x', camelot, keyConf } : {}) }, at: 1000 });
}

test('mixes with: with sure keys a clash drops below a fit; unsure keys change nothing', () => {
  const rows = [['q', '8A'], ['near-clash', '3B'], ['fit', '9A'], ['plain', null]];
  const records = new Map(rows.map(([id, c]) => [id, rec(id, { camelot: c })]));
  const withKeys = mixesWith('q', mixIndex(records), { k: 5 });
  assert.equal(withKeys.length, 3);
  const fit = withKeys.find(m => m.id === 'fit'), clash = withKeys.find(m => m.id === 'near-clash'), none = withKeys.find(m => m.id === 'plain');
  assert.equal(fit.keyFit, 'adjacent');
  assert.equal(fit.key, '9A');
  assert.equal(clash.keyFit, 'clash');
  assert.equal(none.key, undefined, 'no sure key on that track, so no key claim');
  assert.ok(withKeys.indexOf(fit) < withKeys.indexOf(clash), 'a fit ranks above a clash');

  // Unsure keys are ignored entirely: identical to a library with no keys at all.
  const unsure = new Map(rows.map(([id, c]) => [id, rec(id, { camelot: c, keyConf: MATCH_MIN - 0.1 })]));
  const bare = new Map(rows.map(([id]) => [id, rec(id, {})]));
  assert.deepEqual(mixesWith('q', mixIndex(unsure), { k: 5 }), mixesWith('q', mixIndex(bare), { k: 5 }));
  assert.ok(KEY_RANK_BONUS > 0);
});

test('DJ order: unsure keys change nothing; sure keys never add clashes', () => {
  assert.ok(WEIGHTS.key > 0);
  const keys = ['1A', '8B', '1A', '8B', '1A', '8B', '1A', '8B', '1A', '8B'];
  const tracks = keys.map((_, i) => ({ id: `t${i}`, name: `T${i}`, artists: [{ name: `A${i}` }] }));
  const build = (conf, withKey = true) => mixIndex(new Map(keys.map((c, i) => [`t${i}`, rec(`t${i}`, withKey ? { camelot: c, keyConf: conf } : {})])));
  const clashes = o => o.order.slice(1).filter((t, i) => keyFit(keys[Number(o.order[i].id.slice(1))], keys[Number(t.id.slice(1))]) === 'clash').length;
  const sure = mixOrder(tracks, build(0.9), { seed: 3 });
  const unsure = mixOrder(tracks, build(MATCH_MIN - 0.2), { seed: 3 });
  const none = mixOrder(tracks, build(0, false), { seed: 3 });
  assert.deepEqual(unsure.order.map(t => t.id), none.order.map(t => t.id), 'unsure keys do not move the order');
  assert.ok(clashes(sure) <= clashes(none), `sure keys never add clashes (${clashes(sure)} vs ${clashes(none)})`);
  assert.equal(sure.order.length, 10);
});
