// The identity functions decide whether two entries are the same record.
// Get them wrong and the tool merges a VIP with its original — and if a copy
// is then removed, the action log cannot bring the other version back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { norm, versionOf, baseTitle, trackKey, dedupe } from '../norm.mjs';

test('norm strips cosmetic release noise', () => {
  assert.equal(norm('Windowlicker - 2012 Remaster'), 'windowlicker');
  assert.equal(norm('Windowlicker (Remastered)'), 'windowlicker');
  assert.equal(norm('Windowlicker - Digital Remaster'), 'windowlicker');
  assert.equal(norm('Original Nuttah (feat. UK Apache)'), 'original nuttah');
  assert.equal(norm('Original Nuttah ft. UK Apache'), 'original nuttah');
  assert.equal(norm("Don't Stop"), 'dont stop');
  assert.equal(norm('LFO — LFO'), 'lfo lfo');
});

test('norm is case- and punctuation-insensitive', () => {
  assert.equal(norm('Chase & Status'), norm('chase   &   status'));
  assert.equal(norm('R.I.P.'), 'r i p');
});

test('norm handles missing input', () => {
  assert.equal(norm(null), '');
  assert.equal(norm(undefined), '');
  assert.equal(norm(''), '');
});

test('versionOf keeps distinct cuts apart', () => {
  assert.equal(versionOf('Bad Habit (VIP)'), 'vip');
  assert.equal(versionOf('Bad Habit - Extended Mix'), 'extended mix');
  assert.equal(versionOf('Bad Habit (Tim Reaper Remix)'), 'tim reaper remix');
  assert.equal(versionOf('Bad Habit - Live'), 'live');
  assert.equal(versionOf('Bad Habit'), '');
  // A remaster is packaging, not a different record.
  assert.equal(versionOf('Bad Habit - 2012 Remaster'), '');
});

test('baseTitle drops the version but keeps the song', () => {
  assert.equal(baseTitle('Bad Habit (VIP)'), 'bad habit');
  assert.equal(baseTitle('Bad Habit - Extended Mix'), 'bad habit');
  assert.equal(baseTitle('Bad Habit'), 'bad habit');
});

const tr = (artist, name, extra = {}) => ({ artists: [{ name: artist }], name, ...extra });

test('trackKey merges re-releases but never merges versions', () => {
  const original = tr('Shy FX', 'Original Nuttah');
  const remaster = tr('Shy FX', 'Original Nuttah - 2012 Remaster');
  const feat = tr('Shy FX', 'Original Nuttah (feat. UK Apache)');
  const vip = tr('Shy FX', 'Original Nuttah (VIP)');

  assert.equal(trackKey(original), trackKey(remaster), 'a remaster is the same record');
  assert.equal(trackKey(original), trackKey(feat), 'a feat. credit is the same record');
  assert.notEqual(trackKey(original), trackKey(vip), 'a VIP is a different record');
});

test('trackKey separates the same title by different artists', () => {
  assert.notEqual(trackKey(tr('Burial', 'Archangel')), trackKey(tr('Someone Else', 'Archangel')));
});

test('dedupe keeps one copy per record, preferring the earliest release', () => {
  const rows = [
    { id: 'b', name: 'Original Nuttah', artists: [{ name: 'Shy FX' }], released: '2012-01-01' },
    { id: 'a', name: 'Original Nuttah - 2012 Remaster', artists: [{ name: 'Shy FX' }], released: '1994-01-01' },
    { id: 'c', name: 'Original Nuttah (VIP)', artists: [{ name: 'Shy FX' }], released: '2015-01-01' },
  ];
  const out = dedupe(rows);
  assert.equal(out.length, 2, 'the VIP survives alongside the original');
  assert.equal(out.find(t => !t.name.includes('VIP')).id, 'a', 'the 1994 pressing wins');
});

test('dedupe skips entries with no id', () => {
  assert.deepEqual(dedupe([{ name: 'x', artists: [] }, null]), []);
});
