import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readTable, clapIndex, clapHeard, findPrompt, suggestPrompts, soundsLike, nameGroup,
  confirmName, confirmedName, normPrompt, CLAP_SEARCH,
} from '../core/audio/clap-search.mjs';
import { packEmbedding } from '../core/audio/record.mjs';
import { table, clapField, resetSeed, DIM } from './fixtures/clap-fixture.mjs';

// WP-C3: suggested names for "new genre?" groups and "sounds like" search,
// on fixture CLAP embeddings (test/fixtures/clap-fixture.mjs).

const T = readTable(table());

function library() {
  resetSeed();
  const recs = [];
  const add = (prefix, k, mix) => { for (let i = 0; i < k; i++) recs.push({ v: 1, id: `${prefix}${i}`, at: 1, clap: clapField(mix) }); };
  add('ph', 10, { phonk: 1 });
  add('jc', 10, { jersey: 1 });
  add('db', 20, { dnb: 1 });
  add('rl', 6, { dnb: 0.6, rolling: 0.8 });
  add('bl', 15, { bass: 1 });
  return recs;
}

test('no CLAP records: everything answers empty', () => {
  const plain = [{ v: 1, id: 'a', at: 1 }, { v: 1, id: 'b', at: 1, clap: null }, { v: 1, id: 'c', miss: 'NO_ISRC' }];
  for (const recs of [null, [], plain, new Map(plain.map(r => [r.id, r]))]) {
    const idx = clapIndex(recs, { dim: DIM });
    assert.equal(idx.size, 0);
    assert.equal(clapHeard(recs), 0);
    assert.equal(nameGroup(['a', 'b'], idx, T), null);
    assert.deepEqual(soundsLike('phonk', idx, T).results, []);
  }
  // And no table, no names, no search, no autocomplete.
  for (const bad of [null, {}, { dim: 4, prompts: [] }, { dim: DIM, prompts: [{ text: 'x', emb: { s: 1, q: '!!' } }] }])
    assert.equal(readTable(bad), null);
  const idx = clapIndex(library(), { dim: DIM });
  assert.equal(nameGroup(['ph0', 'ph1', 'ph2', 'ph3'], idx, null), null);
  assert.deepEqual(suggestPrompts('ph', null), []);
});

test('the table is read with its labels, kinds and every way of typing a prompt', () => {
  assert.equal(T.dim, DIM);
  assert.equal(T.prompts.length, 7);
  assert.deepEqual(T.prompts.map(p => p.label).slice(0, 3), ['phonk', 'jersey club', 'drum and bass']);
  assert.equal(T.prompts[5].label, 'dark rolling bassline', 'descriptions keep their words');
  for (const q of ['phonk', 'Phonk music', 'PHONK!']) assert.equal(findPrompt(q, T)?.label, 'phonk');
  for (const q of ['drum & bass', 'drum-and-bass', 'Drum and Bass music']) assert.equal(findPrompt(q, T)?.concept, 'drum-and-bass');
  assert.equal(findPrompt('dubstep', T), null);
  // A table without a template keeps the text as it is.
  assert.equal(readTable({ ...table(), template: undefined }).prompts[0].label, 'phonk music');
  assert.equal(normPrompt('  Dark,  Rolling Bassline! '), 'dark rolling bassline');
});

test('text and audio embeddings share a dimension, and a matching prompt ranks a track top-5', () => {
  const recs = library();
  const idx = clapIndex(recs, { dim: DIM });
  assert.equal(idx.size, recs.length);
  for (const v of idx.values()) assert.equal(v.length, T.dim);
  // For each fixture track, its own prompt is among the top 5 prompts.
  const own = { ph: 'phonk', jc: 'jersey club', db: 'drum and bass', bl: 'bassline', rl: 'dark rolling bassline' };
  for (const [id, v] of idx) {
    const ranked = T.prompts.map(p => [p.label, p.emb.reduce((s, x, i) => s + x * v[i], 0)]).sort((a, b) => b[1] - a[1]);
    assert.ok(ranked.slice(0, 5).some(([l]) => l === own[id.replace(/\d+$/, '')]), `${id}: ${ranked.map(r => r[0]).join(', ')}`);
  }
  // A record with a CLAP of another size is not read.
  const odd = { v: 1, id: 'odd', clap: { model: 'x', emb: packEmbedding(new Float32Array(8).fill(1)) } };
  assert.equal(clapIndex([odd], { dim: DIM }).size, 0);
  // A bare {s, q} is read too.
  assert.equal(clapIndex([{ v: 1, id: 'bare', clap: library()[0].clap.emb }], { dim: DIM }).size, 1);
});

test('search ranks the library by a prompt, best first, and says when the text is not a prompt', () => {
  const idx = clapIndex(library(), { dim: DIM });
  const r = soundsLike('phonk', idx, T, { limit: 10 });
  assert.equal(r.prompt.label, 'phonk');
  assert.equal(r.heard, idx.size);
  assert.equal(r.results.length, 10);
  assert.ok(r.results.every(x => x.id.startsWith('ph')), r.results.map(x => x.id).join());
  for (let i = 1; i < r.results.length; i++) assert.ok(r.results[i - 1].score >= r.results[i].score);
  const dark = soundsLike('dark rolling bassline', idx, T, { limit: 6 });
  assert.ok(dark.results.filter(x => x.id.startsWith('rl')).length >= 5, dark.results.map(x => x.id).join());
  // By index too, and with exclusions.
  const byI = soundsLike(0, idx, T, { limit: 3, exclude: new Set(['ph0']) });
  assert.ok(!byI.results.some(x => x.id === 'ph0'));
  // Not a prompt: no results, and no prompt.
  assert.deepEqual(soundsLike('something else entirely', idx, T), { prompt: null, results: [], heard: idx.size });
  // Deterministic.
  assert.deepEqual(soundsLike('phonk', idx, T), soundsLike('phonk', idx, T));
});

test('autocomplete offers prompts by the start of their words, genres first', () => {
  assert.deepEqual(suggestPrompts('ph', T).map(p => p.label), ['phonk']);
  assert.deepEqual(suggestPrompts('bass', T).map(p => p.label), ['bassline', 'drum and bass', 'dark rolling bassline']);
  assert.deepEqual(suggestPrompts('roll', T).map(p => p.label), ['dark rolling bassline']);
  assert.deepEqual(suggestPrompts('hands up', T).map(p => p.label), ['euphoric hands-up vocal']);
  assert.deepEqual(suggestPrompts('', T), []);
  assert.deepEqual(suggestPrompts('zzz', T), []);
  assert.equal(suggestPrompts('m', T, { limit: 2 }).length, 0, 'the template word is not part of a label');
});

test('a group is named by its most distinctive genre, not the broad one that fits everything', () => {
  const idx = clapIndex(library(), { dim: DIM });
  const ph = nameGroup(['ph0', 'ph1', 'ph2', 'ph3', 'ph4', 'ph5', 'ph6', 'ph7'], idx, T);
  assert.equal(ph.name, 'phonk');
  assert.equal(ph.concept, 'phonk');
  assert.equal(ph.heard, 8);
  assert.ok(ph.alts.length <= CLAP_SEARCH.alts);
  assert.ok(!ph.alts.some(a => a.name === 'phonk'));
  assert.ok(ph.alts.every(a => a.lift > 0 && a.lift <= ph.lift), 'alternatives only when they too lift');
  const jc = nameGroup(Array.from({ length: 10 }, (_, i) => `jc${i}`), idx, T);
  assert.equal(jc.name, 'jersey club');
  // Without the library baseline the broad prompt would win for a mixed group;
  // with it, a group of rollers is drum and bass, and sounds "dark rolling".
  const rl = nameGroup(['rl0', 'rl1', 'rl2', 'rl3', 'rl4', 'rl5'], idx, T);
  assert.notEqual(rl.name, 'electronic');
  assert.equal(rl.sounds, 'dark rolling bassline');
});

test('too few tracks heard by CLAP, and the group stays unnamed', () => {
  const idx = clapIndex(library(), { dim: DIM });
  assert.equal(nameGroup(['ph0', 'ph1', 'ph2'], idx, T), null, 'three heard is below minHeard');
  const half = ['ph0', 'ph1', 'ph2', 'ph3', 'x1', 'x2', 'x3', 'x4', 'x5'];
  assert.equal(nameGroup(half, idx, T), null, 'four of nine is under half');
  assert.equal(nameGroup(half.slice(0, 8), idx, T)?.name, 'phonk', 'four of eight is half');
});

test('a confirmed name is kept per group and found again when the group changes a little', () => {
  const g = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
  let names = confirmName({}, g, '  Phonk  ', { at: 5 });
  const [key] = Object.keys(names);
  assert.deepEqual(names[key], { name: 'Phonk', ids: g, at: 5 });
  // Three filed elsewhere, two new: still the same group.
  const later = ['d', 'e', 'f', 'g', 'h', 'i', 'j', 'x', 'y'];
  assert.deepEqual(confirmedName(later, names), { key, name: 'Phonk', at: 5 });
  // A different group is not.
  assert.equal(confirmedName(['p', 'q', 'r', 's', 't', 'a'], names), null);
  // Renaming replaces the entry, keeping its key.
  names = confirmName(names, later, 'Drift phonk', { at: 9 });
  assert.equal(Object.keys(names).length, 1);
  assert.equal(names[key].name, 'Drift phonk');
  assert.equal(confirmedName(g, names).name, 'Drift phonk');
  // Nothing to confirm, nothing changes.
  assert.deepEqual(confirmName(names, g, '   '), names);
  assert.equal(confirmedName(g, null), null);
  // Ids are capped.
  const big = Array.from({ length: 500 }, (_, i) => `t${String(i).padStart(3, '0')}`);
  assert.equal(Object.values(confirmName({}, big, 'x'))[0].ids.length, CLAP_SEARCH.keepIds);
});
