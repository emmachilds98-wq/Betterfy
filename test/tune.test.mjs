// Engine › Tune sweep (BUILD-6 T1). Runs on a synthetic non-owner account
// (test/fixtures/accounts.mjs) with synthetic heard records: no real data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeAccount } from './fixtures/accounts.mjs';
import { makeRecord, N_STYLES, EMB_DIM } from '../core/audio/record.mjs';
import { SOUND_FIRST_WEIGHTS } from '../core/intrinsic/space.mjs';
import { tuneSweep, mergeTune, tuneOverrides, cleanOverrides, soundFirstFor, identifyOptsFor, misfitOptsFor,
         tuneLines, tuneBlock, TUNE_GROUPS } from '../core/validate/tune.mjs';

function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5; }
const hash = str => [...str].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
/** One embedding direction per playlist, noise per track: tracks of a playlist sound alike. */
function recordsFor(lib, noise = 0.6) {
  const out = [], seen = new Set();
  lib.playlists.forEach((p, pi) => {
    const dir = Float32Array.from({ length: EMB_DIM }, rng(1 + pi * 7919));
    for (const t of p.tracks) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      const r = rng(hash(t.id));
      const activations = new Float32Array(N_STYLES).fill(0.01);
      activations[(pi * 13) % N_STYLES] = 0.8;
      out.push(makeRecord({ id: t.id, isrc: 'GBXXX0000001', activations, embeddings: Float32Array.from(dir, v => v + noise * r()),
        patches: 1, source: { kind: 'deezer-isrc', deezerId: 1, windows: [[0, 165000]], seconds: 10 }, mel: '1.0.0', at: 1000 }));
    }
  });
  return out;
}

test('without listening nothing is swept and nothing is stored (empty, small, typical accounts)', () => {
  for (const kind of ['empty', 'small', 'typical']) {
    const r = tuneSweep(makeAccount(kind), { audio: null, folds: 3, limit: 100 });
    assert.equal(r.rows.length, 0);
    assert.equal(r.skipped.length, TUNE_GROUPS.length);
    assert.deepEqual(tuneOverrides(r), {});
    assert.ok(tuneBlock(r).includes('not swept'));
  }
});

test('too few heard tracks: "not enough data yet", never a guess', () => {
  const lib = makeAccount('typical');
  const r = tuneSweep(lib, { audio: recordsFor(lib).slice(0, 5), folds: 3, limit: 100 });
  assert.equal(r.rows.length, 0);
  assert.match(r.skipped[0].why, /not enough data yet/);
  assert.deepEqual(tuneOverrides(r), {});
});

test('a sweep on a typical account: rows carry current, best, delta; only passing rows become overrides', { timeout: 120000 }, () => {
  const lib = makeAccount('typical');
  const r = tuneSweep(lib, { audio: recordsFor(lib), folds: 3, limit: 120, groups: ['ident', 'misfit'] });
  assert.ok(r.rows.length >= 4, 'identify and Tidy rows are produced');
  for (const row of r.rows) {
    assert.ok(row.grid.some(x => x.value === row.current), 'the grid includes the shipped value');
    assert.ok(row.grid.some(x => x.value === row.best));
    assert.equal(typeof row.delta, 'string');
    if (row.pass) assert.notEqual(row.best, row.current);
  }
  const o = tuneOverrides(r);
  for (const [g, vals] of Object.entries(o)) {
    for (const k of Object.keys(vals)) assert.ok(r.rows.find(x => x.group === g && x.key === k).pass, 'an override exists only for a row that cleared its bar');
  }
  assert.ok(tuneLines(r).length >= r.rows.length);
  assert.ok(tuneBlock(r).startsWith('Betterfy tune sweep'));
});

test('the sound-first group sweeps placement and merges per group', { timeout: 120000 }, () => {
  const lib = makeAccount('typical');
  const a = tuneSweep(lib, { audio: recordsFor(lib), folds: 3, limit: 60, groups: ['sound'] });
  const m = mergeTune([a, null]);
  assert.equal(m.rows.length, a.rows.length);
  for (const row of a.rows) assert.equal(row.current, SOUND_FIRST_WEIGHTS[row.key]);
});

test('stored overrides are cleaned to known constants and grid values, then shaped per consumer', () => {
  const dirty = { sound: { audio: 2.0, nope: 5, learned: 99 }, ident: { library: 2.2, specific: 0.5 }, misfit: { sure: 0.8 }, evil: { x: 1 } };
  const c = cleanOverrides(dirty);
  assert.deepEqual(c, { sound: { audio: 2.0 }, ident: { library: 2.2 }, misfit: { sure: 0.8 } });
  assert.deepEqual(soundFirstFor(c), { audio: 2.0 });
  assert.equal(identifyOptsFor(c).weights.library, 2.2);
  assert.equal(misfitOptsFor(c).sure, 0.8);
  assert.equal(soundFirstFor({}), null);
  assert.equal(identifyOptsFor(null), null);
  assert.equal(misfitOptsFor({}), null);
});
