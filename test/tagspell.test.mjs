import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonTag, trackVec, tagGate, gateTags } from '../profile.mjs';
import { resolveConcept, validateOntology } from '../core/ontology/index.mjs';

// One genre used to be several dimensions, letter for letter: "dnb" and "drum
// and bass" shared nothing, so two drum and bass artists tagged differently
// looked unrelated. These pin the merge, and pin that it stays a merge of
// *spellings* rather than a broadening that would erase real distinctions.

test('every common spelling of drum and bass is one tag', () => {
  for (const t of ['dnb', 'DnB', 'd&b', 'D & B', 'drum & bass', 'drum n bass', "drum'n'bass", 'drum and bass', 'Drum-and-Bass'])
    assert.equal(canonTag(t), 'drum and bass', t);
  assert.equal(canonTag('deep dnb'), 'deep drum and bass', 'abbreviations inside longer tags too');
  assert.equal(canonTag('liquid funk'), 'liquid drum and bass');
});

test('UK garage and 2-step spellings merge, and stay apart from each other', () => {
  for (const t of ['ukg', 'UKG', 'uk-garage', 'uk garage']) assert.equal(canonTag(t), 'uk garage', t);
  for (const t of ['2-step', '2step', '2 step', 'two step']) assert.equal(canonTag(t), '2 step', t);
});

test('the donk family is one tag', () => {
  for (const t of ['donk', 'Donk House', 'scouse house', 'bouncy house', 'UK bounce'])
    assert.equal(canonTag(t), 'donk', t);
});

test('it merges spellings, never meanings', () => {
  // Each of these is a distinction the tag engine is good at. Folding them
  // into a parent would be tidier and worse.
  for (const t of ['rave', 'trip hop', 'new wave', 'garage', 'speed garage', 'jungle', 'hardcore', 'liquid'])
    assert.equal(canonTag(t), t, `${t} must keep its own dimension`);
  assert.equal(canonTag("don't"), "don't", 'an apostrophe is not an "and"');
});

test('two artists spelling a genre differently now share a dimension', () => {
  const tags = { a: { tags: [['dnb', 100]] }, b: { tags: [['drum and bass', 100]] } };
  const va = trackVec({ artists: [{ id: 'a' }] }, tags), vb = trackVec({ artists: [{ id: 'b' }] }, tags);
  assert.deepEqual([...va.keys()], ['drum and bass']);
  assert.deepEqual([...va.keys()], [...vb.keys()]);
});

test('an artist tagged with two spellings of one genre is not counted twice', () => {
  const tags = { a: { tags: [['dnb', 60], ['drum and bass', 100], ['jungle', 50]] } };
  const v = trackVec({ artists: [{ id: 'a' }] }, tags);
  // Relative to jungle (50), drum and bass must weigh 100 — the stronger of the
  // two spellings — not 160, their sum.
  assert.equal(v.get('drum and bass') / v.get('jungle'), 2, 'max, not sum');
});

test('the tag gate counts merged spellings, so a scene split across names survives it', () => {
  // One artist each: three tags too rare to trust apart, one tag on three artists together.
  const tags = { a: { tags: [['scouse house', 100]] }, b: { tags: [['uk bounce', 100]] }, c: { tags: [['donk', 100]] } };
  const gate = tagGate(tags, 2);
  assert.ok(gate.has('donk'));
  const kept = gateTags(tags, gate);
  for (const id of ['a', 'b', 'c']) assert.equal(kept[id].tags.length, 1, `${id} keeps its tag`);
});

test('the ontology now places the scene genres it used to drop', () => {
  const genre = t => { const c = resolveConcept(t); return c.facet === 'genre' ? c.concept : null; };
  assert.equal(genre('donk'), 'donk');
  assert.equal(genre('scouse house'), 'donk', 'no longer collapsed into plain house');
  assert.equal(genre('bouncy house'), 'donk');
  assert.equal(genre('hard house'), 'hard-house');
  assert.equal(genre('makina'), 'makina');
  assert.equal(genre('jersey club'), 'jersey-club');
  assert.equal(genre('juke'), 'footwork');
  assert.equal(genre('drift phonk'), 'phonk');
  assert.equal(genre('rollers'), 'drum-and-bass');
  assert.equal(genre("drum'n'bass"), 'drum-and-bass');
  // Left out on purpose: bare "bounce" is New Orleans hip hop as often as donk.
  assert.equal(genre('bounce'), null);
  assert.deepEqual(validateOntology().errors, []);
});
