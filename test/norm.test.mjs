import { test } from 'node:test';
import assert from 'node:assert/strict';
import { norm, versionOf, baseTitle, trackKey, dedupe } from '../norm.mjs';

test('norm strips remaster tags, feat. credits and punctuation', () => {
  assert.equal(norm('Song Title (feat. Someone) - 2011 Remaster'), 'song title');
  assert.equal(norm("Don't Stop"), 'dont stop');
  assert.equal(norm('  Extra   Spaces '), 'extra spaces');
});

test('norm is case-insensitive and handles nullish input', () => {
  assert.equal(norm('LOUD Title'), 'loud title');
  assert.equal(norm(undefined), '');
  assert.equal(norm(null), '');
});

test('versionOf keeps remixes, VIPs and live cuts distinct', () => {
  assert.equal(versionOf('Track Name - Original Mix'), 'original mix');
  assert.equal(versionOf('Track Name (Someone Remix)'), 'someone remix');
  assert.equal(versionOf('Track Name (VIP)'), 'vip');
  assert.equal(versionOf('Track Name - Live'), 'live');
  assert.equal(versionOf('Plain Track Name'), '');
});

test('baseTitle drops the version suffix but keeps the rest', () => {
  assert.equal(baseTitle('Track Name (Someone Remix)'), 'track name');
  assert.equal(baseTitle('Track Name'), 'track name');
});

test('trackKey treats a remix and its original as different records', () => {
  const original = { artists: [{ name: 'Artist' }], name: 'Track Name' };
  const remix = { artists: [{ name: 'Artist' }], name: 'Track Name (Someone Remix)' };
  assert.notEqual(trackKey(original), trackKey(remix));
});

test('trackKey treats a remaster and a feat. credit variant as the same record', () => {
  const a = { artists: [{ name: 'Artist' }], name: 'Track Name - 2011 Remaster' };
  const b = { artists: [{ name: 'Artist' }], name: 'Track Name (feat. Someone Else)' };
  assert.equal(trackKey(a), trackKey(b));
});

test('dedupe collapses cosmetic duplicates, preferring the earliest release', () => {
  const tracks = [
    { id: '1', artists: [{ name: 'Artist' }], name: 'Track', released: '2015-01-01' },
    { id: '2', artists: [{ name: 'Artist' }], name: 'Track - Remaster', released: '1999-01-01' },
    { id: '3', artists: [{ name: 'Artist' }], name: 'Track (Someone Remix)', released: '2015-01-01' },
  ];
  const out = dedupe(tracks);
  assert.equal(out.length, 2, 'the remix stays separate from the original');
  const original = out.find(t => t.id !== '3');
  assert.equal(original.id, '2', 'the earliest release of the same recording wins');
});

test('dedupe skips tracks with no id', () => {
  const tracks = [{ artists: [{ name: 'Artist' }], name: 'Track' }];
  assert.deepEqual(dedupe(tracks), []);
});
