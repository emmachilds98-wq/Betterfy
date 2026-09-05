// Collaboration credits are the hole discovery would otherwise fall through:
// a seed artist re-entering the results as one half of a duo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parts, ownsAnyOf } from '../credits.mjs';
import { norm } from '../norm.mjs';

test('parts splits every separator a credit uses', () => {
  assert.deepEqual(parts('Shy FX & T Power'), ['shy fx', 't power']);
  assert.deepEqual(parts('dwarde x Tim Reaper'), ['dwarde', 'tim reaper']);
  assert.deepEqual(parts('Skream vs. Benga'), ['skream', 'benga']);
  assert.deepEqual(parts('Fabio + Grooverider'), ['fabio', 'grooverider']);
  assert.deepEqual(parts('Goldie feat. KRS-One'), ['goldie', 'krs one']);
  assert.deepEqual(parts('Sasha pres. Emerson'), ['sasha', 'emerson']);
});

test('parts leaves a single name alone', () => {
  assert.deepEqual(parts('Burial'), ['burial']);
});

test('parts survives empty input', () => {
  assert.deepEqual(parts(null), []);
  assert.deepEqual(parts(''), []);
});

test('ownsAnyOf catches an owned artist hiding inside a collaboration', () => {
  const owned = new Set(['tim reaper']);
  assert.equal(ownsAnyOf('dwarde & Tim Reaper', owned), true);
  assert.equal(ownsAnyOf('Sully & Rider Shafique', owned), false);
});

test('ownsAnyOf matches the whole credit before splitting it', () => {
  // A band whose own name contains a separator must not be missed just
  // because neither half is owned on its own. The owned set always holds
  // normalised names, so the separator is already gone from the key.
  const owned = new Set([norm('Chase & Status')]);
  assert.equal(ownsAnyOf('Chase & Status', owned), true);
  assert.equal(ownsAnyOf('Chase', owned), false, 'half a band name is not the band');
});

test('ownsAnyOf is false for an unrelated artist', () => {
  assert.equal(ownsAnyOf('Burial', new Set(['tim reaper'])), false);
});
