import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STYLE_MAP, STYLE_LABELS, PARENT_MAP, styleConcept, styleHints, styleName, FALLBACK_RELIABILITY } from '../core/sources/audio-vocab.mjs';
import { GENRE_INDEX } from '../core/ontology/index.mjs';
import { N_STYLES } from '../core/audio/record.mjs';

test('every one of the 400 labels has an explicit entry, in model order', () => {
  assert.equal(STYLE_LABELS.length, N_STYLES);
  assert.equal(new Set(STYLE_LABELS).size, N_STYLES, 'no duplicate labels');
  // Pinned positions: if the order shifts, every stored record is misread.
  assert.equal(STYLE_LABELS[0], 'Blues---Boogie Woogie');
  assert.equal(STYLE_LABELS.indexOf('Electronic---Donk'), 54);
  assert.equal(STYLE_LABELS[399], 'Stage & Screen---Theme');
  for (const l of STYLE_LABELS) assert.ok(STYLE_MAP[l] === null || typeof STYLE_MAP[l] === 'string', l);
});

test('every mapped concept and parent exists in the ontology', () => {
  for (const [l, c] of Object.entries(STYLE_MAP)) if (c) assert.ok(GENRE_INDEX.has(c), `${l} -> ${c}`);
  for (const [g, c] of Object.entries(PARENT_MAP)) if (c) assert.ok(GENRE_INDEX.has(c), `${g} -> ${c}`);
  for (const l of STYLE_LABELS) assert.ok(l.split('---')[0] in PARENT_MAP, `parent of ${l}`);
});

test('the scene styles map to the scene concepts', () => {
  const want = {
    'Electronic---Donk': 'donk', 'Electronic---Bassline': 'bassline', 'Electronic---Speed Garage': 'uk-garage',
    'Electronic---UK Garage': 'uk-garage', 'Electronic---Jungle': 'jungle', 'Electronic---Grime': 'grime',
    'Hip Hop---Grime': 'grime', 'Electronic---Hard House': 'hard-house', 'Electronic---Juke': 'footwork',
  };
  for (const [l, c] of Object.entries(want)) assert.equal(styleConcept(l).concept, c, l);
});

test('the reviewed fixes over resolveConcept hold', () => {
  assert.equal(STYLE_MAP['Rock---Hardcore'], 'hardcore-punk');
  assert.equal(STYLE_MAP['Reggae---Lovers Rock'], 'reggae');
  assert.equal(STYLE_MAP['Electronic---Hi NRG'], 'disco');
  assert.equal(STYLE_MAP['Rock---Lo-Fi'], 'indie-rock');
});

test('null falls back to the parent at a discount; non-music falls back to nothing', () => {
  assert.deepEqual(styleConcept('Electronic---Experimental'), { label: 'Electronic---Experimental', concept: 'electronic', reliability: FALLBACK_RELIABILITY, via: 'parent' });
  assert.equal(styleConcept('Non-Music---Comedy').concept, null);
  assert.equal(styleConcept('not a label').via, 'none');
  assert.equal(styleConcept(54).concept, 'donk', 'class index works too');
});

test('styleHints names a record\'s styles and drops the unmappable', () => {
  const i = STYLE_LABELS.indexOf('Non-Music---Comedy');
  const h = styleHints([[54, 0.6], [i, 0.3]]);
  assert.deepEqual(h, [{ label: 'Electronic---Donk', name: 'Donk', p: 0.6, concept: 'donk', reliability: 1 }]);
  assert.equal(styleName('Electronic---Deep House'), 'Deep House');
});
