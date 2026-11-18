import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TEMPO, tempoFit, tempoRangeOf, resolveOctave } from '../core/ontology/tempo.mjs';
import { GENRE_INDEX } from '../core/ontology/index.mjs';
import { nearest, playlistConcepts, genreMembership, filedNeighbours, tempoRelation, mixesWith } from '../core/audio/match.mjs';
import { identify, identifyAccuracy, genreLevel } from '../core/audio/identify.mjs';
import { audioIndex } from '../core/intrinsic/audio.mjs';
import { makeRecord, N_STYLES, EMB_DIM } from '../core/audio/record.mjs';
import { STYLE_LABELS } from '../core/sources/audio-vocab.mjs';

/* ---------- fixtures: records with chosen styles, sound and tempo ---------- */

const S = l => { const i = STYLE_LABELS.indexOf(`Electronic---${l}`); assert.ok(i >= 0, l); return i; };
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5;
}
const hash = s => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const dirOf = fam => { const r = rng(hash(fam)); return Float32Array.from({ length: EMB_DIM }, r); };

/** One record. `styles`: [[label, p], …] per patch (one entry = one patch, or pass `patches`). */
function rec(id, { fam = 'x', styles = [], patches = null, bpm = null, alt = null, conf = 0.8 } = {}) {
  const per = patches ?? [styles];
  const act = new Float32Array(per.length * N_STYLES).fill(0.001);
  per.forEach((st, p) => { for (const [l, v] of st) act[p * N_STYLES + S(l)] = v; });
  const d = dirOf(fam), r = rng(hash(id));
  const emb = new Float32Array(per.length * EMB_DIM);
  for (let p = 0; p < per.length; p++) for (let i = 0; i < EMB_DIM; i++) emb[p * EMB_DIM + i] = d[i] + 0.5 * r();
  const dsp = bpm ? { bpm, bpmConf: conf, octaveAmbiguous: !!alt, ...(alt ? { bpmAlt: alt } : {}) } : null;
  return makeRecord({ id, isrc: 'GBXXX0000001', activations: act, embeddings: emb, patches: per.length,
                      source: { kind: 'deezer-isrc', deezerId: 1, windows: [[0, 165000]], seconds: 10 },
                      mel: '1.0.0', dsp, at: 1000 });
}

/* ---------- tempo ---------- */

test('every genre in the tempo table is a real genre, and every genre has an answer', () => {
  for (const slug of Object.keys(TEMPO)) assert.ok(GENRE_INDEX.has(slug), slug);
  for (const slug of GENRE_INDEX.keys()) {
    const r = tempoRangeOf(slug);
    assert.ok(r === null || (r[0] < r[1] && r[0] > 40), slug);
  }
  assert.deepEqual(tempoRangeOf('donk'), TEMPO.donk);
});

test('tempo fits its genre straight, half and double time count for less, and rock says nothing', () => {
  assert.equal(tempoFit(172, 'jungle').fit, 1);
  assert.deepEqual(tempoFit(87, 'drum-and-bass'), { fit: 1, bpm: 174 }, 'DnB is written at 87 or 174: full credit (T1)');
  assert.equal(tempoFit(87, 'liquid-dnb').fit, 1, 'children inherit it');
  assert.equal(tempoFit(62, 'house').fit, 0.6, 'other genres keep the weaker octave credit');
  assert.equal(tempoFit(70, 'dubstep').fit, 1, 'dubstep is felt at half time: full credit');
  assert.equal(tempoFit(124, 'drum-and-bass').fit, 0);
  assert.equal(tempoFit(120, 'rock'), null);
  assert.equal(tempoFit(NaN, 'house'), null);
});

test('"87 or 174?" is settled by the genre it sounds like', () => {
  assert.deepEqual(resolveOctave(87, 174, [['drum-and-bass', 1]]), { bpm: 174, from: 'genre' });
  assert.deepEqual(resolveOctave(87, 174, [['hip-hop', 1]]), { bpm: 87, from: 'tracker' });
  assert.deepEqual(resolveOctave(87, null, [['drum-and-bass', 1]]), { bpm: 87, from: 'tracker' });
  assert.deepEqual(resolveOctave(87, 174, []), { bpm: 87, from: 'tracker' }, 'no genre, no change');
});

/* ---------- matching ---------- */

test('a playlist’s name says which genres it is, and a mood playlist says none', () => {
  assert.deepEqual(playlistConcepts('Drum & Bass'), ['drum-and-bass']);
  const jb = playlistConcepts('Jungle & Breaks');
  assert.ok(jb.includes('jungle') && jb.length === 2, JSON.stringify(jb));
  assert.deepEqual(playlistConcepts('Donk'), ['donk']);
  assert.deepEqual(playlistConcepts('Sunday'), []);
  assert.deepEqual(playlistConcepts('Late Night'), []);
});

test('tempos that beatmatch: same, half or double, within 6%', () => {
  assert.equal(tempoRelation(174, 172).rel, 'same');
  assert.equal(tempoRelation(174, 87).rel, 'double');
  assert.equal(tempoRelation(87, 174).rel, 'half');
  assert.equal(tempoRelation(128, 140), null);
});

test('nearest finds the same-sounding tracks; mixesWith keeps only the ones you can beatmatch', () => {
  const recs = [
    rec('a', { fam: 'dnb', bpm: 174 }), rec('b', { fam: 'dnb', bpm: 172 }), rec('c', { fam: 'dnb', bpm: 87 }),
    rec('d', { fam: 'dnb', bpm: 140 }), rec('e', { fam: 'house', bpm: 124 }), rec('f', { fam: 'dnb', bpm: 175, conf: 0.1 }),
  ];
  const index = audioIndex(recs);
  const near = nearest(index.get('a').emb, index, { k: 3, exclude: new Set(['a']) });
  assert.equal(near.length, 3);
  assert.ok(near.every(n => n.id !== 'e'), 'the house track sounds least like it');
  const mix = mixesWith('a', index);
  assert.deepEqual(mix.map(m => [m.id, m.rel]).sort(), [['b', 'same'], ['c', 'double']],
    '140 is no mix, and a reading too unsure to trust is left out');
  assert.deepEqual(mixesWith('a', index, { bpm: 87 }).map(m => m.id).sort(), ['b', 'c'], 'a settled tempo can be passed in');
});

/* ---------- identify ---------- */

test('the model alone: drum & bass, and jungle when jungle holds most of it, at its tempo', () => {
  const r = identify(rec('t', { styles: [['Jungle', 0.5], ['Drum n Bass', 0.4]], bpm: 172 }));
  assert.equal(r.genre.slug, 'drum-and-bass');
  assert.equal(r.genre.name, 'Drum & Bass');
  assert.deepEqual(r.path.map(p => p.slug), ['drum-and-bass', 'jungle']);
  assert.equal(r.sub.slug, 'jungle');
  assert.equal(r.bpm.value, 172);
  assert.ok(r.why.some(w => /172 BPM fits/.test(w)));
});

test('your library knows the scene: sounds like your Donk playlist, so donk, whatever the model calls it', () => {
  const record = rec('t', { styles: [['Hard House', 0.6], ['Techno', 0.2]], bpm: 150 });
  const alone = identify(record);
  assert.deepEqual(alone.path.map(p => p.slug), ['house', 'hard-house']);
  const neighbours = Array.from({ length: 8 }, (_, i) => ({ id: `n${i}`, sim: 0.8, playlists: ['p-donk'], concepts: ['donk'] }));
  const r = identify(record, { neighbours, playlistName: id => (id === 'p-donk' ? 'Donk' : id) });
  assert.deepEqual(r.path.map(p => p.slug), ['house', 'hard-house', 'donk']);
  assert.ok(r.support.library > 0.9 && r.support.model > 0.5);
  assert.match(r.why[0], /8 of the 8 tracks it sounds most like, mostly in Donk, are House/);
});

test('a confident tempo marks down a genre it cannot be: 172 BPM is not breakbeat', () => {
  const styles = [['Breakbeat', 0.5], ['Jungle', 0.45]];
  assert.equal(identify(rec('t', { styles })).genre.slug, 'breakbeat', 'without tempo, the model’s top style');
  assert.equal(identify(rec('t', { styles, bpm: 172 })).genre.slug, 'drum-and-bass');
  assert.equal(identify(rec('t', { styles, bpm: 172, conf: 0.1 })).genre.slug, 'breakbeat', 'an unsure tempo checks nothing');
});

test('a half-time reading is put right by the genre it sounds like', () => {
  const r = identify(rec('t', { styles: [['Drum n Bass', 0.7]], bpm: 87, alt: 174 }));
  assert.deepEqual([r.bpm.value, r.bpm.from], [174, 'genre']);
});

test('T1: a DnB track read at 87 with no flag is not marked down, and shows 174', () => {
  const styles = [['Drum n Bass', 0.45], ['Hip Hop', 0.4]];
  const r = identify(rec('t', { styles, bpm: 87 }));
  assert.equal(r.genre.slug, 'drum-and-bass');
  assert.equal(r.bpm.value, 174);
  assert.equal(r.bpm.fit, 1);
  const hh = identify(rec('h', { styles: [['Hip Hop', 0.7]], bpm: 87 }));
  assert.equal(hh.genre.slug, 'hip-hop');
  assert.equal(hh.bpm.value, 87, 'a straight hip-hop reading is left alone');
});

test('two genres in one clip are named as a blend', () => {
  const r = identify(rec('t', { patches: [[['Drum n Bass', 0.7]], [['Drum n Bass', 0.7]], [['House', 0.7]], [['House', 0.7]]] }));
  assert.deepEqual(r.blend?.slice().sort(), ['Drum & Bass', 'House']);
});

test('sources that disagree everywhere name no genre; a miss names nothing', () => {
  const r = identify(rec('t', { styles: [['House', 0.2], ['Techno', 0.2], ['Drum n Bass', 0.2], ['Dubstep', 0.2], ['UK Garage', 0.2]] }));
  assert.equal(r.genre, null);
  assert.equal(identify({ id: 'x', miss: 'no-preview' }), null);
  assert.equal(identify(null), null);
});

test('genreLevel: electronic’s children are genres; elsewhere the root is', () => {
  assert.equal(genreLevel('donk'), 'house');
  assert.equal(genreLevel('jungle'), 'drum-and-bass');
  assert.equal(genreLevel('drill'), 'hip-hop');
  assert.equal(genreLevel('electronic'), 'electronic');
  assert.equal(genreLevel('nope'), null);
});

/* ---------- measured on filed tracks ---------- */

test('identifyAccuracy: the library’s votes name the scene genre the model alone cannot', () => {
  const fams = { donk: ['Hard House', 150], dnb: ['Drum n Bass', 174], deep: ['Deep House', 120] };
  const lib = { playlists: [] }, recs = [];
  for (const [fam, [style, bpm]] of Object.entries(fams)) {
    const tracks = Array.from({ length: 10 }, (_, i) => ({ id: `${fam}-${i}`, name: `${fam} ${i}`, artists: [{ id: `${fam}-a${i}` }] }));
    lib.playlists.push({ id: `p-${fam}`, name: { donk: 'Donk', dnb: 'Drum & Bass', deep: 'Deep House' }[fam], tracks });
    for (const t of tracks) recs.push(rec(t.id, { fam, styles: [[style, 0.6]], bpm }));
  }
  lib.playlists.push({ id: 'p-sun', name: 'Sunday', tracks: [lib.playlists[0].tracks[0], lib.playlists[1].tracks[0]] });
  const membership = genreMembership(lib, { targets: ['p-donk', 'p-dnb', 'p-deep'] });
  assert.ok(!membership.playlists.has('p-sun'), 'only genre playlists vote');
  const index = audioIndex(recs);
  const near = filedNeighbours('donk-0', index, membership, { k: 5 });
  assert.ok(near.every(n => n.concepts.includes('donk')));

  const acc = identifyAccuracy({ index, membership, k: 5 });
  assert.equal(acc.scored, 30);
  assert.equal(acc.genre, 1);
  assert.equal(acc.specific, 1);
  assert.ok(acc.modelOnly.specific < acc.specific, 'the model alone says hard house for donk');
  assert.equal(acc.modelOnly.genre, 1, 'but it does get the genre');
  assert.equal(acc.tempo, 1);
  assert.deepEqual(acc.byGenre.map(g => g.slug).sort(), ['drum-and-bass', 'house'], 'donk and deep house both count under House');
});

/* ---------- tempo in filing ---------- */

test('filing by sound counts tempo: the share of a playlist you could beatmatch with, sound path only', async () => {
  const { fixture, FAMILIES } = await import('./fixtures/engine-library.mjs');
  const { buildSpace, placements } = await import('../core/intrinsic/space.mjs');
  const LIB = fixture();
  const bpmOf = { tech: 128, deep: 122, jungle: 172, ambient: 90 };
  const records = LIB.all.map(t => rec(t.id, { fam: t.id.split('-')[0], bpm: bpmOf[t.id.split('-')[0]] }));
  const space = buildSpace(LIB, { targets: FAMILIES.map(f => `p-${f}`), audio: records, genreGraph: true });
  const track = LIB.all.find(t => t.id === 'jungle-t3');
  const plain = placements(track, space, { limit: Infinity });
  assert.ok(plain.results.every(r => !('bpm' in r.parts)), 'without sound, tempo is not used: unchanged');
  const heard = placements(track, space, { limit: Infinity, soundFirst: true });
  const by = Object.fromEntries(heard.results.map(r => [r.playlistId, r.parts.bpm]));
  assert.equal(by['p-jungle'], 1, 'every heard jungle track mixes with it');
  assert.equal(by['p-tech'], 0);
  assert.equal(by['p-ambient'], 0.5, '90 is half of 172 within 6%: half credit');
});
