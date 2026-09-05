import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parts, ownsAnyOf } from '../credits.mjs';

test('parts splits collaboration credits into individual artists', () => {
  assert.deepEqual(parts('Shy FX & T Power'), ['shy fx', 't power']);
  assert.deepEqual(parts('dwarde & Tim Reaper'), ['dwarde', 'tim reaper']);
  assert.deepEqual(parts('A vs B'), ['a', 'b']);
  assert.deepEqual(parts('A feat. B'), ['a', 'b']);
});

test('parts handles a solo artist as a single part', () => {
  assert.deepEqual(parts('Chase & Status'), ['chase', 'status']);
  assert.deepEqual(parts('Solo Artist'), ['solo artist']);
});

test('ownsAnyOf matches the whole credit first, so a band name with "&" in it is not split incorrectly', () => {
  const owned = new Set(['chase status']); // norm() collapses "&" to a space
  assert.equal(ownsAnyOf('Chase & Status', owned), true);
});

test('ownsAnyOf matches when only one half of a collaboration is owned', () => {
  const owned = new Set(['tim reaper']);
  assert.equal(ownsAnyOf('dwarde & Tim Reaper', owned), true);
  assert.equal(ownsAnyOf('Someone Else & Another Person', owned), false);
});

test('ownsAnyOf is false for an empty owned set', () => {
  assert.equal(ownsAnyOf('Any Artist', new Set()), false);
});
