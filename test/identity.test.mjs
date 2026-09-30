import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trackIdentity, sameRecording, versionKind, isSameRecordingVersion,
         identityConfidence, linkConfidence, LINK_CONFIDENCE } from '../core/identity/track-identity.mjs';

/*
 * §5's one hard rule: never merge two tracks because their title and artist
 * strings match. Everything else here is about making a partial identity
 * usable rather than pretending it is complete.
 */

test('an identity is built from a plain library track, with nothing configured', () => {
  const id = trackIdentity({ id: 'sp1', name: 'Nightfall', artists: [{ id: 'a1', name: 'Someone' }], released: '2019-04-02' });
  assert.equal(id.spotifyId, 'sp1');
  assert.equal(id.baseTitle, 'nightfall');
  assert.equal(id.album.year, 2019);
  assert.equal(id.artists[0].primary, true);
  assert.ok(id.confidence > 0 && id.confidence < 1, 'a Spotify id alone is a floor, not a ceiling');
});

test('billing order decides which artist is primary, not following size', () => {
  const id = trackIdentity({ id: 'sp1', name: 'X', artists: [{ id: 'a1', name: 'Producer' }, { id: 'a2', name: 'Famous Guest' }] });
  assert.equal(id.artists[0].primary, true);
  assert.equal(id.artists[1].primary, false);
  assert.equal(id.artists[1].position, 1);
});

test('confidence rises as providers resolve the same recording', () => {
  const bare = trackIdentity({ id: 'sp1', name: 'X', artists: [] });
  const withIsrc = trackIdentity({ id: 'sp1', name: 'X', artists: [], isrc: 'GBAAA0000001' });
  const full = trackIdentity({ id: 'sp1', name: 'X', artists: [], isrc: 'GBAAA0000001' },
    { recordingMbid: 'mb-1', releaseMbid: 'mb-2', discogsReleaseId: 'dg-1' });
  assert.ok(withIsrc.confidence > bare.confidence);
  assert.ok(full.confidence > withIsrc.confidence);
  assert.ok(full.confidence <= 1);
});

test('a remix is a different record; a remaster is the same one', () => {
  assert.equal(versionKind('Track (Skrillex Remix)'), 'remix');
  assert.equal(versionKind('Track - Radio Edit'), 'edit');
  assert.equal(versionKind('Track - Live'), 'live');
  assert.equal(versionKind('Track (Instrumental)'), 'instrumental');
  // norm.mjs strips a remaster suffix as cosmetic before this ever sees it.
  assert.equal(versionKind('Track - 2011 Remaster'), null);
  assert.equal(versionKind('Track'), null);

  assert.ok(isSameRecordingVersion(null));
  assert.ok(isSameRecordingVersion('edit'), 'an edit is the same performance, differently cut');
  assert.ok(!isSameRecordingVersion('remix'), 'a remix is a different record by a different producer');
  assert.ok(!isSameRecordingVersion('live'));
});

test('two pressings of one recording are merged only on an identifier', () => {
  const a = trackIdentity({ id: 'sp1', name: 'Nightfall', artists: [{ id: 'a1', name: 'Someone' }], isrc: 'GBAAA0000001' });
  const b = trackIdentity({ id: 'sp2', name: 'Nightfall', artists: [{ id: 'a1', name: 'Someone' }], isrc: 'GBAAA0000001' });
  const m = sameRecording(a, b);
  assert.equal(m.same, true);
  assert.equal(m.via, 'isrc');
});

test('matching strings alone never merge — they are offered for review instead', () => {
  const a = trackIdentity({ id: 'sp1', name: 'Nightfall', artists: [{ id: 'a1', name: 'Someone' }] });
  const b = trackIdentity({ id: 'sp2', name: 'Nightfall', artists: [{ id: 'a9', name: 'Someone' }] });
  const m = sameRecording(a, b);
  assert.equal(m.same, false, 'this is exactly what §5 forbids');
  assert.equal(m.couldBe, true, 'but it is worth surfacing to a human');
});

test('a remix and its original are never the same recording', () => {
  const orig = trackIdentity({ id: 'sp1', name: 'Nightfall', artists: [{ id: 'a1', name: 'Someone' }] });
  const remix = trackIdentity({ id: 'sp2', name: 'Nightfall (Skrillex Remix)', artists: [{ id: 'a1', name: 'Someone' }] });
  const m = sameRecording(orig, remix);
  assert.equal(m.same, false);
  assert.ok(!m.couldBe, 'and not even a candidate');
});

test('how a provider was addressed is what decides identity confidence', () => {
  assert.ok(linkConfidence('isrc') > linkConfidence('name-autocorrect'));
  assert.ok(linkConfidence('mbid-recording') > linkConfidence('name-exact'));
  assert.ok(linkConfidence('name-exact') > linkConfidence('name-fuzzy'));
  assert.equal(linkConfidence('spotify-id'), 1);
  assert.equal(linkConfidence('something nobody declared'), 0.4, 'an unknown match is treated as weak');
  for (const v of Object.values(LINK_CONFIDENCE)) assert.ok(v > 0 && v <= 1);
});

test('missing and malformed input produce a valid, low-confidence identity rather than throwing', () => {
  for (const t of [{}, { id: null }, { id: 'x', artists: null }, { id: 'x', name: null, released: 'nonsense' }]) {
    const id = trackIdentity(t);
    assert.equal(typeof id.confidence, 'number');
    assert.ok(Array.isArray(id.artists));
    assert.equal(id.album.year, null);
  }
  assert.equal(identityConfidence({ artists: [] }), 0);
});
