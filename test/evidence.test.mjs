import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evidence, EvidenceSet, ENTITY_TYPES, FIELDS } from '../core/evidence/evidence.mjs';
import { normaliseValues, unknownConcepts, relativeStrength } from '../core/evidence/normalise.mjs';
import { evidenceWeight, agreementFactor, recencyFactor, SPECIFICITY } from '../core/evidence/weights.mjs';
import { ProviderRegistry, defineProvider } from '../core/sources/provider.mjs';

/*
 * §39: raw evidence is never destroyed and never overwritten. A frozen record
 * makes that a property of the code rather than a convention — this is the
 * test that it actually is frozen, including the nested provenance, which is
 * the part that would otherwise be quietly mutable.
 */

test('an evidence record is immutable, provenance included', () => {
  const e = evidence({ source: 's', entityType: 'artist', field: 'genre', rawValue: 'house',
                       concept: 'house', provenance: { matchedBy: 'name-exact' } });
  assert.ok(Object.isFrozen(e));
  assert.ok(Object.isFrozen(e.provenance));
  assert.throws(() => { 'use strict'; e.concept = 'techno'; });
});

test('an evidence record cannot claim a field or entity nobody declared', () => {
  assert.throws(() => evidence({ source: 's', entityType: 'nonsense', field: 'genre', rawValue: 'x' }), /entityType/);
  assert.throws(() => evidence({ source: 's', entityType: 'artist', field: 'nonsense', rawValue: 'x' }), /field/);
  assert.throws(() => evidence({ entityType: 'artist', field: 'genre', rawValue: 'x' }), /source/);
  for (const t of ENTITY_TYPES) assert.ok(typeof t === 'string');
  for (const f of FIELDS) assert.ok(typeof f === 'string');
});

test('confidences are clamped, so no adapter can accidentally claim certainty', () => {
  const e = evidence({ source: 's', entityType: 'artist', field: 'genre', rawValue: 'x',
                       sourceConfidence: 12, identityConfidence: -3 });
  assert.equal(e.sourceConfidence, 1);
  assert.equal(e.identityConfidence, 0);
  const bad = evidence({ source: 's', entityType: 'artist', field: 'genre', rawValue: 'x', sourceConfidence: NaN });
  assert.equal(bad.sourceConfidence, 0);
});

test('an EvidenceSet appends rather than replaces, but only counts the freshest copy', () => {
  const mk = at => evidence({ source: 'lastfm', entityType: 'artist', entityId: 'a1', field: 'genre',
                              rawValue: 'house', concept: 'house', retrievedAt: at });
  const set = new EvidenceSet({ spotifyId: 't1' }).add(mk(1000), mk(2000));
  assert.equal(set.records.length, 2, 'history is kept');
  assert.equal(set.current().length, 1, 'but a re-fetch must not double the vote');
  assert.equal(set.current()[0].retrievedAt, 2000);
});

test('an EvidenceSet round-trips through JSON with its records still frozen', () => {
  const set = new EvidenceSet({ spotifyId: 't1' }).add(
    evidence({ source: 's', entityType: 'artist', field: 'genre', rawValue: 'house', concept: 'house' }));
  const back = EvidenceSet.fromJSON(JSON.parse(JSON.stringify(set)));
  assert.equal(back.records.length, 1);
  assert.ok(Object.isFrozen(back.records[0]));
  assert.equal(back.records[0].concept, 'house');
});

test('normalisation drops collection cruft and keeps unfamiliar genres', () => {
  const recs = normaliseValues([['tech house', 100], ['seen live', 90], ['albums i own', 80], ['hard groove', 70]],
    { source: 'lastfm', entityType: 'artist', entityId: 'a1' });
  const raws = recs.map(r => r.rawValue);
  assert.ok(raws.includes('tech house'));
  assert.ok(!raws.includes('seen live'), 'that describes the tagger, not the music');
  assert.ok(!raws.includes('albums i own'));
  assert.ok(raws.includes('hard groove'), 'an unknown genre is retained as a candidate');
  assert.equal(recs.find(r => r.rawValue === 'hard groove').field, 'unknown');
});

test('provider counts are normalised against the strongest claim in their own list', () => {
  // Two providers on different scales must produce comparable shapes.
  const lastfm = normaliseValues([['house', 100], ['techno', 50]], { source: 'a', entityType: 'artist' });
  const discogs = normaliseValues([['house', 8], ['techno', 4]], { source: 'b', entityType: 'release' });
  assert.equal(lastfm[0].sourceConfidence, discogs[0].sourceConfidence);
  assert.equal(lastfm[1].sourceConfidence, discogs[1].sourceConfidence);
  assert.equal(relativeStrength(5, 0), 0.5, 'a missing scale is neither trusted nor discarded');
});

test('an inferred suffix match is discounted against an exact one', () => {
  const [exact] = normaliseValues([['techno', 100]], { source: 'a', entityType: 'artist' });
  const [inferred] = normaliseValues([['dark techno', 100]], { source: 'a', entityType: 'artist' });
  assert.equal(exact.concept, inferred.concept);
  assert.ok(inferred.sourceConfidence < exact.sourceConfidence, 'the inference is ours, not the provider\'s');
  assert.equal(inferred.provenance.resolvedVia, 'suffix');
});

test('unknown concepts are tallied for the review queue', () => {
  const recs = [
    ...normaliseValues([['schranz', 100]], { source: 'lastfm', entityType: 'artist' }),
    ...normaliseValues([['schranz', 100]], { source: 'discogs', entityType: 'release' }),
    ...normaliseValues([['hard groove', 100]], { source: 'lastfm', entityType: 'artist' }),
  ];
  const u = unknownConcepts(recs);
  assert.equal(u[0].raw, 'schranz');
  assert.equal(u[0].count, 2);
  assert.deepEqual(u[0].sources.sort(), ['discogs', 'lastfm']);
});

test('malformed and empty provider input produces no evidence rather than throwing', () => {
  for (const input of [null, undefined, [], [null], ['not a pair'], [[null, 1]], [['', 5]]])
    assert.deepEqual(normaliseValues(input, { source: 'a', entityType: 'artist' }), []);
});

test('a track-level statement outweighs an artist-level one, all else equal', () => {
  const base = { source: 's', sourceConfidence: 1, identityConfidence: 1, retrievedAt: Date.now() };
  const asArtist = evidenceWeight({ ...base, entityType: 'artist' });
  const asTrack = evidenceWeight({ ...base, entityType: 'track' });
  assert.ok(asTrack > asArtist * 2, 'this gap is what stops a diverse artist flattening every track');
  assert.ok(SPECIFICITY.track > SPECIFICITY.release);
  assert.ok(SPECIFICITY.release > SPECIFICITY.artist);
});

test('a weakly-matched identity discounts everything the provider said', () => {
  const base = { source: 's', entityType: 'artist', sourceConfidence: 1, retrievedAt: Date.now() };
  assert.ok(evidenceWeight({ ...base, identityConfidence: 1 }) > evidenceWeight({ ...base, identityConfidence: 0.55 }));
  assert.equal(evidenceWeight({ ...base, identityConfidence: 0 }), 0);
  assert.equal(evidenceWeight(null), 0);
});

test('agreement is worth a lot for the second source and little after', () => {
  assert.equal(agreementFactor(1), 1);
  assert.ok(agreementFactor(2) > agreementFactor(1));
  assert.ok(agreementFactor(3) > agreementFactor(2));
  assert.ok(agreementFactor(4) - agreementFactor(3) < agreementFactor(2) - agreementFactor(1));
  assert.equal(agreementFactor(0), 1, 'never below one');
});

test('age discounts gently and never to nothing', () => {
  const now = Date.now();
  assert.equal(recencyFactor(now, now), 1);
  const old = recencyFactor(now - 10 * 365 * 86400000, now);
  assert.ok(old > 0.69 && old < 1, `expected a gentle floored decay, got ${old}`);
});

test('a registry answers reliability and independence without the classifier naming a provider', () => {
  const a = defineProvider({ id: 'a', reliability: 0.9, independenceGroup: 'crowd', capabilities: ['genre'] });
  const b = defineProvider({ id: 'b', reliability: 0.5, independenceGroup: 'crowd', capabilities: ['genre'] });
  const reg = new ProviderRegistry([a, b]);
  assert.equal(reg.reliabilityOf('a'), 0.9);
  assert.equal(reg.reliabilityOf('unregistered'), 0.5, 'an unknown source is trusted at half');
  assert.equal(reg.independenceOf('a'), reg.independenceOf('b'), 'two endpoints of one crowd are not independent');
  assert.equal(reg.independenceOf('unregistered'), 'unregistered');
  assert.deepEqual(reg.providing('genre').map(p => p.id), ['a', 'b']);
  assert.ok(reg.versions().a);
});

test('a provider cannot declare a capability nobody defined', () => {
  assert.throws(() => defineProvider({ id: 'x', capabilities: ['telepathy'] }), /capability/);
});
