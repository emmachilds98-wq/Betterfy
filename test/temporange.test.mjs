// E3 (docs/BUILD-7-PLAN.md): a tempo range per playlist, learned from the
// heard members, and a bounded penalty for a track far outside it.
//
// Measured with and without on the same held-out tracks (placementAccuracy,
// sound path, `tempoRange` off / on), on fabricated sound with fabricated
// tempos (test/fixtures/tempo-sound.mjs, whose assumptions were fixed before
// measuring), over the three shaped seeds and the typical and large accounts.
// Bar, set before the run: +1 point top-1 overall, or +3 tracks on the five
// weakest playlists, and no family loses a track.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shapedLibrary } from './fixtures/shaped-library.mjs';
import { makeAccount } from './fixtures/accounts.mjs';
import { soundWithTempo, shapedHome, accountHome } from './fixtures/tempo-sound.mjs';
import { soundLibrary } from './fixtures/sound-library.mjs';
import { placementAccuracy } from '../core/validate/loo.mjs';
import { buildSpace, placements } from '../core/intrinsic/space.mjs';
import { tempoRange, tempoPenalty, profileTempoRange, MAX_PENALTY, RANGE_MIN_MEMBERS } from '../core/intrinsic/tempo.mjs';

/* ---------- the range ---------- */

const around = (c, n, step = 0.5) => Array.from({ length: n }, (_, i) => c + (i - (n - 1) / 2) * step);

test('a tight playlist learns its range; 87 and 174 count as the same place', () => {
  const r = tempoRange(around(174, 20));
  assert.ok(r && r.lo > 168 && r.hi < 180 && r.iqr <= 10, JSON.stringify(r));
  // Half of the readings come out an octave low: same range, still read at 174.
  const mixed = around(174, 20).map((b, i) => (i % 2 ? b / 2 : b));
  const m = tempoRange(mixed);
  assert.ok(m && Math.abs(m.center - 174) < 4 && m.lo > 165 && m.hi < 182, JSON.stringify(m));
  // And the other octave: a house playlist read at 63 and 126 is a 126 playlist.
  const h = tempoRange(around(126, 16).map((b, i) => (i % 3 === 0 ? b / 2 : b)));
  assert.ok(h && Math.abs(h.center - 126) < 4, JSON.stringify(h));
});

test('a range across the octave seam is not split (126-134 folded at 128)', () => {
  const r = tempoRange(around(130, 20, 0.4).map((b, i) => (i % 2 ? b / 2 : b)));
  assert.ok(r && r.lo > 124 && r.hi < 136, JSON.stringify(r));
});

test('fewer than 12 heard members, or a wide spread, gets no range', () => {
  assert.equal(RANGE_MIN_MEMBERS, 12);
  assert.equal(tempoRange(around(174, 11)), null);
  assert.ok(tempoRange(around(174, 12)));
  assert.equal(tempoRange(around(140, 40, 3)), null, 'a 120-bpm spread is not a range');
  assert.equal(tempoRange([]), null);
  assert.equal(tempoRange(null), null);
  // Garbage readings are ignored rather than counted.
  assert.equal(tempoRange([...around(174, 11), NaN, 0, -3]), null);
});

test('only confident readings teach a playlist (bpmConf >= 0.3)', () => {
  const idx = new Map(), ids = new Set();
  for (let i = 0; i < 20; i++) {
    const id = 't' + i;
    ids.add(id);
    idx.set(id, { rec: { dsp: { bpm: 174 + (i % 3), bpmConf: i < 8 ? 0.9 : 0.1 } } });
  }
  assert.equal(profileTempoRange({ ids }, idx), null, 'only 8 confident readings');
  idx.set('t8', { rec: { dsp: { bpm: 174, bpmConf: 0.31 } } });
  idx.set('t9', { rec: { dsp: { bpm: 174, bpmConf: 0.3 } } });
  idx.set('t10', { rec: { dsp: { bpm: 175, bpmConf: 0.5 } } });
  idx.set('t11', { rec: { dsp: { bpm: 175, bpmConf: 0.5 } } });
  assert.ok(profileTempoRange({ ids }, idx), 'twelve confident readings');
});

/* ---------- the penalty ---------- */

test('the penalty is zero in range, grows outside, and never passes its cap', () => {
  const range = { lo: 170, hi: 176 };
  assert.equal(tempoPenalty(173, range), 0);
  assert.equal(tempoPenalty(86.5, range), 0, 'half time is the same place');
  assert.equal(tempoPenalty(178, range), 0, 'inside the mixing tolerance');
  const near = tempoPenalty(190, range), far = tempoPenalty(128, range), farther = tempoPenalty(100, range);
  assert.ok(near > 0 && far >= near && farther >= 0);
  assert.ok(far > 0.5 * MAX_PENALTY, `128 against 174 costs ${far}`);
  for (const b of [1, 20, 60, 90, 100, 128, 150, 200, 260, 400, 900]) {
    const p = tempoPenalty(b, range);
    assert.ok(p >= 0 && p <= MAX_PENALTY, `${b}: ${p}`);
  }
  assert.equal(tempoPenalty(128, null), 0, 'no range, no penalty');
  assert.equal(tempoPenalty(NaN, range), 0);
});

test('placements: off by default; on, only a far track in a tight playlist moves, and only down', () => {
  const { lib, records } = soundLibrary({ kinds: ['inside'] });
  // x is 174, y and z are 140; the 'inside' tracks sound like x.
  for (const rec of records) {
    const bpm = rec.id.startsWith('x') || rec.id.startsWith('in') ? 174 : 140;
    rec.dsp = { bpm: bpm + (rec.id.length % 3), bpmConf: 0.8 };
  }
  const space = buildSpace(lib, { targets: ['p-x', 'p-y', 'p-z'], audio: { records, learn: false }, genreGraph: true });
  const track = lib.liked.find(t => t.id.startsWith('in'));
  const base = placements(track, space, { useAudio: true }).results;
  assert.equal(base.every(r => r.tempoPenalty === undefined), true);
  const on = placements(track, space, { useAudio: true, tempoRange: true }).results;
  const by = new Map(base.map(r => [r.playlistId, r.score]));
  for (const r of on) assert.ok(r.score <= by.get(r.playlistId) + 1e-9, 'never raises a score');
  assert.equal(on.find(r => r.playlistId === 'p-x').tempoPenalty, undefined, 'its own tempo: untouched');
  assert.ok(on.find(r => r.playlistId === 'p-y').tempoPenalty > 0, '174 in a 140 playlist is far outside it');
  // A track with no confident tempo is untouched everywhere.
  const rec = records.find(r => r.id === track.id);
  rec.dsp = { bpm: 140, bpmConf: 0.1 };
  const sp2 = buildSpace(lib, { targets: ['p-x', 'p-y', 'p-z'], audio: { records, learn: false }, genreGraph: true });
  assert.deepEqual(placements(track, sp2, { useAudio: true, tempoRange: true }).results,
                   placements(track, sp2, { useAudio: true }).results);
});

/* ---------- the measurement ---------- */

function famOfShaped(lib, pid) { return 'f' + (lib.playlists.findIndex(p => p.id === pid) % 5); }

function measure(name, lib, records, targets, famOf) {
  const o = { genreGraph: true, targets: targets ? new Set(targets) : undefined, audio: { records, learn: false }, limit: 600, collect: true };
  const off = placementAccuracy(lib, o).withAudio, on = placementAccuracy(lib, { ...o, tempoRange: true }).withAudio;
  const hit = r => r.truth.includes(r.scores[0]?.[0]);
  const A = new Map(off.rows.map(r => [r.id, r])), B = new Map(on.rows.map(r => [r.id, r]));
  const per = new Map(), fam = new Map();
  let hitsOff = 0, hitsOn = 0;
  for (const [id, a] of A) {
    const b = B.get(id), h0 = hit(a) ? 1 : 0, h1 = hit(b) ? 1 : 0;
    hitsOff += h0; hitsOn += h1;
    for (const pid of a.truth) {
      const k = name + ':' + pid, p = per.get(k) ?? { n: 0, off: 0, on: 0 };
      p.n++; p.off += h0; p.on += h1; per.set(k, p);
    }
    const f = name + ':' + famOf(a.truth[0]), fr = fam.get(f) ?? { off: 0, on: 0 };
    fr.off += h0; fr.on += h1; fam.set(f, fr);
  }
  return { name, n: A.size, hitsOff, hitsOn, per, fam };
}

test('E3 measured: with and without the tempo range, same held-out tracks', { timeout: 300000 }, () => {
  const runs = [];
  for (const seed of [11, 5, 3]) {
    const lib = shapedLibrary({ seed });
    runs.push(measure('shaped' + seed, lib, soundWithTempo(lib, shapedHome(lib)), lib.targets, pid => famOfShaped(lib, pid)));
  }
  for (const kind of ['typical', 'large']) {
    const lib = makeAccount(kind);
    runs.push(measure(kind, lib, soundWithTempo(lib, accountHome()), null, pid => pid));
  }
  const n = runs.reduce((s, r) => s + r.n, 0);
  const off = runs.reduce((s, r) => s + r.hitsOff, 0), on = runs.reduce((s, r) => s + r.hitsOn, 0);
  // The five weakest playlists (lowest top-1 without the range, at least 8 tracks), pooled over the runs.
  const pls = runs.flatMap(r => [...r.per.entries()]).filter(([, p]) => p.n >= 8)
    .sort((a, b) => a[1].off / a[1].n - b[1].off / b[1].n).slice(0, 5);
  const weakGain = pls.reduce((s, [, p]) => s + p.on - p.off, 0);
  const famLoss = runs.flatMap(r => [...r.fam.entries()]).filter(([, f]) => f.on < f.off);
  const overall = (on - off) / n * 100;
  const passes = (overall >= 1 || weakGain >= 3) && famLoss.length === 0;
  for (const r of runs) console.log(`E3 ${r.name}: top-1 ${(r.hitsOff / r.n * 100).toFixed(1)}% -> ${(r.hitsOn / r.n * 100).toFixed(1)}% (${r.n} tracks)`);
  console.log(`E3 overall: ${(off / n * 100).toFixed(1)}% -> ${(on / n * 100).toFixed(1)}% (${overall >= 0 ? '+' : ''}${overall.toFixed(2)} points); weakest five: ${weakGain >= 0 ? '+' : ''}${weakGain} tracks; families losing: ${famLoss.length}; bar met: ${passes}`);
  assert.equal(passes, false, 'the measured result moved: re-measure, then decide whether the range goes on (core/intrinsic/space.mjs placements default)');
});

/* ---------- where it shows: Library's playlist sheet and the Score run ---------- */

import { tempoRangeAccuracy } from '../core/validate/temporange.mjs';
import { tempoRangeLine } from '../web/screens/engine.mjs';
import { profileRow } from '../web/ui/sound.mjs';

test('Library says most of the playlist is 170-176 BPM, only when the range is tight', () => {
  const html = profileRow({ heard: 20, members: 24, bpm: [166, 178], tempo: [170, 176] });
  assert.match(html, /most of this playlist is 170–176 BPM/);
  assert.match(html, /most is 170–176/);
  assert.doesNotMatch(profileRow({ heard: 20, members: 24, bpm: [100, 170] }), /most is/);
});

test('the Score run reports the measured delta, and says when it is not applied', () => {
  const pc = x => Math.round(x * 100) + '%';
  assert.equal(tempoRangeLine(null, pc), null);
  assert.match(tempoRangeLine({ off: 0.7, on: 0.7, scored: 300, points: 0, weakest: 1, pass: false }, pc),
    /^Tempo range: top-1 70% -> 70% on 300 heard tracks \(\+0 points; weakest five playlists \+1 tracks\) — not ahead, shown in Library only$/);
  assert.match(tempoRangeLine({ off: 0.7, on: 0.72, scored: 300, points: 2, weakest: 4, pass: true }, pc), /ahead on this library, not applied yet$/);
});

test('tempoRangeAccuracy: counts for one library, nothing without sound', { timeout: 120000 }, () => {
  const lib = shapedLibrary({ seed: 11 });
  assert.equal(tempoRangeAccuracy(lib, {}), null);
  const r = tempoRangeAccuracy(lib, { genreGraph: true, targets: new Set(lib.targets), limit: 200,
    audio: { records: soundWithTempo(lib, shapedHome(lib)), learn: false } });
  assert.equal(r.scored, 200);
  assert.ok(r.off > 0.4 && r.on > 0.4 && typeof r.pass === 'boolean', JSON.stringify(r));
});
