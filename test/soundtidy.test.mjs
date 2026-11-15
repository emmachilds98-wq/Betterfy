import { test } from 'node:test';
import assert from 'node:assert/strict';

import { genreMembership } from '../core/audio/match.mjs';
import { soundMisfits, misfitAccuracy, soundMisfitsFor, neighbourShares, judge, MISFIT } from '../core/audio/misfit.mjs';
import { audioIndex } from '../core/intrinsic/audio.mjs';
import { makeRecord, N_STYLES, EMB_DIM } from '../core/audio/record.mjs';
import { STYLE_LABELS } from '../core/sources/audio-vocab.mjs';

/* ---------- fixtures: three genre playlists, each with its own sound ---------- */

const S = l => { const i = STYLE_LABELS.indexOf(`Electronic---${l}`); assert.ok(i >= 0, l); return i; };
function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5; }
const hash = s => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const dirOf = fam => { const r = rng(hash(fam)); return Float32Array.from({ length: EMB_DIM }, r); };

function rec(id, fam, style, bpm) {
  const act = new Float32Array(N_STYLES).fill(0.001);
  act[S(style)] = 0.7;
  const d = dirOf(fam), r = rng(hash(id));
  const emb = Float32Array.from({ length: EMB_DIM }, (_, i) => d[i] + 0.5 * r());
  return makeRecord({ id, isrc: 'GBXXX0000001', activations: act, embeddings: emb, patches: 1,
                      source: { kind: 'deezer-isrc', deezerId: 1, windows: [[0, 165000]], seconds: 10 },
                      mel: '1.0.0', dsp: { bpm, bpmConf: 0.8, octaveAmbiguous: false }, at: 1000 });
}

const GENRES = { house: ['House', 'House', 124], jungle: ['Jungle', 'Jungle', 172], techno: ['Techno', 'Techno', 132] };

/** 10 tracks per playlist, plus `extra` = [[id, family, playlistName], …] planted where they don't belong. */
function library(extra = []) {
  const playlists = [], records = [];
  for (const [fam, [name, style, bpm]] of Object.entries(GENRES)) {
    const tracks = [];
    for (let i = 0; i < 10; i++) { const id = `${fam}${i}`; tracks.push({ id }); records.push(rec(id, fam, style, bpm)); }
    playlists.push({ id: `pl-${fam}`, name, tracks });
  }
  for (const [id, fam, plName] of extra) {
    const [, style, bpm] = GENRES[fam];
    records.push(rec(id, fam, style, bpm));
    playlists.find(p => p.name === plName).tracks.push({ id });
  }
  // A mood playlist: not a genre playlist, so it never votes.
  playlists.push({ id: 'pl-sunday', name: 'Sunday', tracks: [{ id: 'house0' }, { id: 'jungle0' }] });
  return { lib: { playlists, liked: [] }, records };
}
const targets = ['pl-house', 'pl-jungle', 'pl-techno'];

test('a jungle track sitting in House is flagged, sent to Jungle, and named by its sound', () => {
  const { lib, records } = library([['stray', 'jungle', 'House']]);
  const index = audioIndex(records), membership = genreMembership(lib, { targets });
  const rows = soundMisfits({ index, membership });
  assert.equal(rows.length, 1, JSON.stringify(rows.map(r => r.id)));
  const r = rows[0];
  assert.equal(r.id, 'stray');
  assert.equal(r.from, 'pl-house');
  assert.equal(r.to, 'pl-jungle');
  assert.equal(r.band, 'sure');
  assert.equal(r.idBacks, true);
  assert.match(r.sound, /jungle/i);
  assert.equal(r.bpm, 172);
  assert.match(r.why[0], /of the 12 tracks it sounds most like are in Jungle/);
});

test('correctly filed tracks are left alone, and a library with nothing heard says nothing', () => {
  const { lib, records } = library();
  const index = audioIndex(records), membership = genreMembership(lib, { targets });
  assert.deepEqual(soundMisfits({ index, membership }), []);
  assert.deepEqual(soundMisfits({ index: new Map(), membership }), []);
  assert.deepEqual(soundMisfitsFor(lib, [], { targets }).rows, []);
  assert.equal(soundMisfitsFor(lib, null, { targets }).accuracy, null);
});

test('a track in two genre playlists is deliberate: never flagged', () => {
  const { lib, records } = library([['stray', 'jungle', 'House']]);
  lib.playlists.find(p => p.name === 'Techno').tracks.push({ id: 'stray' });
  const rows = soundMisfits({ index: audioIndex(records), membership: genreMembership(lib, { targets }) });
  assert.deepEqual(rows, []);
});

test('a destination with too few heard members is not offered', () => {
  const { lib, records } = library([['stray', 'jungle', 'House']]);
  // Hear only three of Jungle's tracks.
  const keep = records.filter(r => !/^jungle[3-9]$/.test(r.id));
  const rows = soundMisfits({ index: audioIndex(keep), membership: genreMembership(lib, { targets }) });
  assert.ok(!rows.some(r => r.to === 'pl-jungle'), JSON.stringify(rows));
});

test('"not that playlist" keeps a track from being offered there again', () => {
  const { lib, records } = library([['stray', 'jungle', 'House']]);
  const fb = { stray: { skips: 0, lastSkip: null, rejected: ['pl-jungle'] } };
  assert.equal(soundMisfitsFor(lib, records, { targets, measure: false }).rows.length, 1);
  assert.equal(soundMisfitsFor(lib, { records, feedback: fb }, { targets, measure: false }).rows.length, 0);
});

test('when the sound ID places it in its own playlist’s genre, it is not flagged', () => {
  const membership = { playlists: new Map([['a', { name: 'House', concepts: ['house'] }], ['b', { name: 'Jungle', concepts: ['jungle'] }]]),
                       of: new Map() };
  const heard = new Map([['a', 10], ['b', 10]]);
  const shares = new Map([['a', 0.05], ['b', 0.9]]);
  const house = { genre: { slug: 'house', name: 'House' }, path: [{ slug: 'house' }] };
  const jungle = { genre: { slug: 'drum-and-bass', name: 'Drum & Bass' }, path: [{ slug: 'drum-and-bass' }, { slug: 'jungle' }] };
  assert.equal(judge({ current: ['a'], shares, heard, membership, id: house }), null);
  assert.equal(judge({ current: ['a'], shares, heard, membership, id: jungle }).band, 'sure');
  // No ID at all: neighbours alone can make it "sure".
  assert.equal(judge({ current: ['a'], shares, heard, membership, id: null }).band, 'sure');
  // Its own playlist holds a fair share of the sound-alikes: it fits.
  assert.equal(judge({ current: ['a'], shares: new Map([['a', 0.3], ['b', 0.7]]), heard, membership }), null);
});

test('shares are weighted by similarity squared and split across a neighbour’s playlists', () => {
  const s = neighbourShares([{ sim: 1, playlists: ['a'] }, { sim: 1, playlists: ['a', 'b'] }, { sim: 0, playlists: ['c'] }]);
  assert.equal(s.get('a'), 0.75);
  assert.equal(s.get('b'), 0.25);
  assert.equal(s.has('c'), false);
  assert.equal(MISFIT.curMax < MISFIT.likely, true);
});

test('measured on held-out tracks: planted misplacements are caught and sent home, few false alarms', () => {
  const { lib, records } = library();
  const acc = misfitAccuracy({ index: audioIndex(records), membership: genreMembership(lib, { targets }) });
  assert.equal(acc.scored, 30);
  assert.ok(acc.caught >= 0.9, JSON.stringify(acc));
  assert.ok(acc.falseAlarm <= 0.05, JSON.stringify(acc));
  assert.ok(acc.sure.precision >= 0.9, JSON.stringify(acc));
  // Deterministic: the same library measures the same.
  assert.deepEqual(misfitAccuracy({ index: audioIndex(records), membership: genreMembership(lib, { targets }) }), acc);
});

test('nothing to measure with fewer than two judgeable playlists', () => {
  const { lib, records } = library();
  const acc = misfitAccuracy({ index: audioIndex(records.filter(r => r.id.startsWith('house'))),
                               membership: genreMembership(lib, { targets }) });
  assert.equal(acc, null);
});
