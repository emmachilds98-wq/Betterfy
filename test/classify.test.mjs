import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EvidenceSet } from '../core/evidence/evidence.mjs';
import { trackIdentity } from '../core/identity/track-identity.mjs';
import { ProviderRegistry } from '../core/sources/provider.mjs';
import { LASTFM, toEvidence as lastfm, extractTags, tagParams } from '../core/sources/lastfm.mjs';
import { DISCOGS, toEvidence as discogs, extractStyles } from '../core/sources/discogs.mjs';
import { SPOTIFY, toEvidence as spotify } from '../core/sources/spotify.mjs';
import { MUSICBRAINZ, extractRecordingFromIsrc } from '../core/sources/musicbrainz.mjs';
import { SHARED_TABLE, cacheToEvidence, normaliseScale, SCALES } from '../core/sources/legacy.mjs';
import { classifyGenre, classifyFlatFacet, CONFIDENCE, leaderShare } from '../core/analysis/classify.mjs';
import { musicProfile, musicDNA, dnaSimilarity } from '../core/analysis/music-dna.mjs';

const REG = new ProviderRegistry([SPOTIFY, LASTFM, DISCOGS, SHARED_TABLE, MUSICBRAINZ]);
const TRACK = { id: 't1', name: 'Nightfall', artists: [{ id: 'a1', name: 'Someone' }], released: '2019-01-01' };
const lfm = tags => ({ toptags: { tag: tags.map(([name, count]) => ({ name, count })) } });
const dgs = styles => ({ results: styles.map(s => ({ style: [].concat(s) })) });

const setOf = (...records) => new EvidenceSet(trackIdentity(TRACK)).add(...records);
const genreOf = set => classifyGenre(set, { registry: REG });

/* ---------- adapters ---------- */

test('Last.fm tag extraction handles every shape the API actually returns', () => {
  assert.deepEqual(extractTags(lfm([['house', 100]])), [['house', 100]]);
  // A single tag comes back as a bare object, not an array.
  assert.deepEqual(extractTags({ toptags: { tag: { name: 'House', count: 40 } } }), [['house', 40]]);
  // Below the count floor, and the malformed cases.
  assert.deepEqual(extractTags(lfm([['house', 3]])), []);
  for (const junk of [null, {}, { toptags: null }, { toptags: { tag: null } }, { error: 6, message: 'not found' }])
    assert.deepEqual(extractTags(junk), [], JSON.stringify(junk));
});

test('a Last.fm request is addressed by mbid when there is one, and says which in the evidence', () => {
  assert.equal(tagParams({ entityType: 'artist', artist: 'A', mbid: 'mb-1', apiKey: 'K' }).mbid, 'mb-1');
  assert.equal(tagParams({ entityType: 'artist', artist: 'A', mbid: 'mb-1', apiKey: 'K' }).autocorrect, undefined);
  assert.equal(tagParams({ entityType: 'artist', artist: 'A', apiKey: 'K' }).autocorrect, '1');

  const byName = lastfm(lfm([['house', 100]]), { entityType: 'artist', entityId: 'a1' })[0];
  const byMbid = lastfm(lfm([['house', 100]]), { entityType: 'artist', entityId: 'a1', matchedBy: 'mbid-artist' })[0];
  assert.ok(byMbid.identityConfidence > byName.identityConfidence,
    'autocorrect can land on a same-named act; an mbid cannot');
});

test('Discogs styles and genres are tallied across releases', () => {
  const { styles, genres, years } = extractStyles(dgs([['Tech House', 'House'], 'Tech House']));
  assert.deepEqual(styles, [['tech house', 2], ['house', 1]]);
  assert.deepEqual(genres, []);
  assert.deepEqual(years, []);
  for (const junk of [null, {}, { results: null }, { results: [{}] }])
    assert.deepEqual(extractStyles(junk).styles, [], JSON.stringify(junk));
});

test('Discogs coarse genre counts for less than its styles', () => {
  const ev = discogs({ results: [{ style: ['Tech House'], genre: ['Electronic'] }] },
    { entityType: 'release', entityId: 'r1', matchedBy: 'discogs-id' });
  const style = ev.find(r => r.concept === 'tech-house');
  const coarse = ev.find(r => r.concept === 'electronic');
  assert.ok(style.sourceConfidence > coarse.sourceConfidence);
});

test('MusicBrainz ISRC parsing degrades to null rather than throwing', () => {
  const ok = extractRecordingFromIsrc({ recordings: [{ id: 'rec', title: 'X',
    releases: [{ id: 'rel', date: '1994-05-02', 'release-group': { id: 'rg' } }] }] });
  assert.equal(ok.recordingMbid, 'rec');
  assert.equal(ok.year, 1994);
  for (const junk of [null, {}, { recordings: [] }, { recordings: [{}] }])
    assert.equal(extractRecordingFromIsrc(junk), null, JSON.stringify(junk));
});

test('Spotify supplies era from a release date and asserts nothing else', () => {
  const ev = spotify(TRACK);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].field, 'era');
  assert.equal(ev[0].concept, '2010s');
  assert.equal(ev[0].identityConfidence, 1);
  assert.deepEqual(spotify({ id: 'x' }), [], 'no date, no claim');
  assert.deepEqual(spotify({ id: 'x', released: 'nonsense' }), []);
});

test('the v1 caches read as artist-level evidence, on one scale', () => {
  const local = cacheToEvidence({ a1: { tags: [['jungle', 100], ['dnb', 60]], checkedAt: 1 } }, {});
  const shared = cacheToEvidence({ a1: { tags: [['jungle', 10], ['dnb', 6]] } }, { source: SHARED_TABLE.id, scale: SCALES.shared });
  assert.equal(local.get('a1')[0].concept, 'jungle');
  assert.equal(local.get('a1')[0].entityType, 'artist');
  assert.equal(shared.get('a1')[0].sourceConfidence, local.get('a1')[0].sourceConfidence,
    'the shipped table stores 0-10 and the local caches 0-100 — same shape either way');
  assert.deepEqual(normaliseScale([['x', 5]], SCALES.shared), [['x', 50]]);
  // An artist with a resolved MBID was asked by id, not by name.
  const byMbid = cacheToEvidence({ a1: { tags: [['jungle', 100]] } }, { mbids: { a1: 'mb-1' } });
  assert.ok(byMbid.get('a1')[0].identityConfidence > local.get('a1')[0].identityConfidence);
});

test('the shipped table shares Last.fm\'s independence group and cannot corroborate it', () => {
  assert.equal(REG.independenceOf(SHARED_TABLE.id), REG.independenceOf(LASTFM.id));
  const set = setOf(
    ...lastfm(lfm([['techno', 100]]), { entityType: 'artist', entityId: 'a1' }),
    ...cacheToEvidence({ a1: { tags: [['techno', 100]], checkedAt: Date.now() } },
      { source: SHARED_TABLE.id }).get('a1'));
  assert.equal(genreOf(set).independentGroups, 1, 'it is the same crowd answering twice');
});

/* ---------- the classifier ---------- */

test('two independent sources agreeing on a subgenre is the one HIGH case', () => {
  const c = genreOf(setOf(
    ...lastfm(lfm([['tech house', 100], ['house', 70]]), { entityType: 'artist', entityId: 'a1' }),
    ...discogs(dgs(['Tech House', ['Tech House', 'House']]), { entityType: 'release', entityId: 'r1', matchedBy: 'discogs-id' })));
  assert.equal(c.primary, 'tech-house');
  assert.deepEqual(c.parents, ['house', 'electronic']);
  assert.equal(c.confidence, CONFIDENCE.HIGH);
  assert.equal(c.independentGroups, 2);
});

test('one thin, name-matched artist answer is never HIGH', () => {
  const c = genreOf(setOf(...lastfm(lfm([['tech house', 100]]), { entityType: 'artist', entityId: 'a1' })));
  assert.equal(c.primary, 'tech-house');
  assert.notEqual(c.confidence, CONFIDENCE.HIGH);
  assert.equal(c.independentGroups, 1);
  assert.ok(c.explanation.some(e => /only one independent source/.test(e.text)));
});

test('a track-level answer beats the artist cloud it contradicts', () => {
  const c = genreOf(setOf(
    ...lastfm(lfm([['drum and bass', 100], ['jungle', 90]]), { entityType: 'artist', entityId: 'a1' }),
    ...lastfm(lfm([['ambient', 100]]), { entityType: 'track', entityId: 't1', matchedBy: 'mbid-recording' })));
  assert.equal(c.primary, 'ambient', 'the whole point of a track-level engine');
  assert.ok(c.secondary.includes('drum-and-bass'), 'and the artist evidence stays visible');
});

test('evidence split evenly across siblings is a confident parent, not an ambiguous child', () => {
  const c = genreOf(setOf(...lastfm(
    lfm([['tech house', 100], ['deep house', 95], ['progressive house', 90]]), { entityType: 'artist', entityId: 'a1' })));
  assert.equal(c.primary, 'house');
  assert.deepEqual(c.alternatives, ['tech-house', 'deep-house', 'progressive-house'],
    'the split is the useful part of the answer');
  assert.ok(c.explanation.some(e => /inherited from subgenres/.test(e.text)));
});

test('a minority subgenre does not promote over the parent more sources named', () => {
  // Three releases say Techno, two say Minimal Techno. The majority reading is
  // the one to file on; Minimal Techno stays an alternative.
  const c = genreOf(setOf(...discogs(
    dgs(['Techno', 'Techno', 'Minimal Techno', 'Techno', 'Minimal Techno']),
    { entityType: 'release', entityId: 'r1', matchedBy: 'discogs-id' })));
  assert.equal(c.primary, 'techno');
  assert.ok(c.alternatives.includes('minimal-techno'));
});

test('a lone dominant subgenre does promote', () => {
  const c = genreOf(setOf(...discogs(dgs(['Minimal Techno', 'Minimal Techno', 'Techno']),
    { entityType: 'release', entityId: 'r1', matchedBy: 'discogs-id' })));
  assert.equal(c.primary, 'minimal-techno');
  assert.deepEqual(c.parents, ['techno', 'electronic']);
});

test('the answer\'s own lineage does not dilute its share', () => {
  // House and Electronic scoring highly alongside Tech House is the hierarchy
  // agreeing with itself, not three claims splitting the vote.
  const c = genreOf(setOf(
    ...lastfm(lfm([['tech house', 100], ['house', 70]]), { entityType: 'artist', entityId: 'a1' })));
  assert.equal(c.share, 1);
  assert.equal(leaderShare(null, []), 0);
});

test('genuine cross-branch disagreement is reported as ambiguous, not resolved', () => {
  const c = genreOf(setOf(
    ...lastfm(lfm([['techno', 100]]), { entityType: 'artist', entityId: 'a1' }),
    ...cacheToEvidence({ a1: { tags: [['hip hop', 100]], checkedAt: Date.now() } },
      { source: SHARED_TABLE.id }).get('a1')));
  assert.equal(c.confidence, CONFIDENCE.AMBIGUOUS);
  assert.ok(c.secondary.length, 'and the losing side is named');
});

test('no evidence, and junk-only evidence, both decline', () => {
  assert.equal(genreOf(setOf()).confidence, CONFIDENCE.INSUFFICIENT_DATA);
  assert.equal(genreOf(setOf()).primary, null);
  const junk = genreOf(setOf(...lastfm(lfm([['seen live', 100], ['albums i own', 90]]), { entityType: 'artist', entityId: 'a1' })));
  assert.equal(junk.primary, null);
  assert.equal(junk.confidence, CONFIDENCE.INSUFFICIENT_DATA);
});

test('every classification carries the versions it was built under', () => {
  const c = genreOf(setOf(...lastfm(lfm([['house', 100]]), { entityType: 'artist', entityId: 'a1' })));
  assert.match(c.versions.classifier, /^\d+\.\d+\.\d+$/);
  assert.ok(c.versions.ontology);
  assert.ok(c.versions.weights);
});

test('a classification explains itself from the records that did the work', () => {
  const c = genreOf(setOf(
    ...discogs(dgs(['Jungle', 'Jungle']), { entityType: 'release', entityId: 'r1', matchedBy: 'discogs-id' })));
  assert.ok(c.explanation.length);
  assert.ok(c.explanation.some(e => /release-level discogs/.test(e.text) && /discogs-id/.test(e.text)));
});

/* ---------- other facets ---------- */

test('mood is multi-label and separate from genre', () => {
  const set = setOf(...lastfm(lfm([['deep house', 100], ['melancholic', 90], ['dreamy', 70], ['summer', 60]]),
    { entityType: 'artist', entityId: 'a1' }));
  assert.equal(classifyGenre(set, { registry: REG }).primary, 'deep-house');
  const mood = classifyFlatFacet(set, 'mood', { registry: REG });
  assert.equal(mood.primary, 'melancholic');
  assert.ok(mood.values.some(v => v.concept === 'dreamy'), 'a track can be two moods at once');
  assert.equal(classifyFlatFacet(set, 'context', { registry: REG }).primary, 'summer');
});

test('a facet nobody supplied comes back as insufficient, not as a guess', () => {
  const set = setOf(...lastfm(lfm([['house', 100]]), { entityType: 'artist', entityId: 'a1' }));
  const mood = classifyFlatFacet(set, 'mood', { registry: REG });
  assert.equal(mood.primary, null);
  assert.equal(mood.confidence, CONFIDENCE.INSUFFICIENT_DATA);
});

/* ---------- profile and DNA ---------- */

test('a profile omits fields nothing measured rather than defaulting them to zero', () => {
  const p = musicProfile(setOf(...lastfm(lfm([['house', 100]]), { entityType: 'artist', entityId: 'a1' })), { registry: REG });
  assert.deepEqual(p.musical, {}, 'a bpm of 0 is a lie that scores; a missing bpm is a fact');
  assert.equal('bpm' in p.musical, false);
  assert.ok(p.versions.profile && p.versions.ontology && p.versions.identity);
  assert.equal(p.confidence.coverage, 1);
});

test('a profile keeps the concepts the ontology could not place', () => {
  const p = musicProfile(setOf(...lastfm(lfm([['schranz', 100], ['hard groove', 80]]),
    { entityType: 'artist', entityId: 'a1' })), { registry: REG });
  assert.deepEqual(p.unknown.map(u => u.raw).sort(), ['hard groove', 'schranz']);
});

test('DNA is comparable and drops what cannot be compared', () => {
  const houseish = musicDNA(musicProfile(setOf(...lastfm(lfm([['tech house', 100]]),
    { entityType: 'artist', entityId: 'a1' })), { registry: REG }));
  const alsoHouse = musicDNA(musicProfile(setOf(...lastfm(lfm([['deep house', 100]]),
    { entityType: 'artist', entityId: 'a1' })), { registry: REG }));
  const metal = musicDNA(musicProfile(setOf(...lastfm(lfm([['death metal', 100]]),
    { entityType: 'artist', entityId: 'a1' })), { registry: REG }));

  assert.equal(houseish.explanation, undefined, 'DNA is for comparing, not for showing');
  assert.ok(dnaSimilarity(houseish, alsoHouse) > dnaSimilarity(houseish, metal),
    'two house subgenres share a lineage and must score closer than house and metal');
  assert.equal(dnaSimilarity(houseish, houseish), 1);
  assert.equal(dnaSimilarity(null, houseish), 0);
  assert.equal(dnaSimilarity(metal, musicDNA(musicProfile(setOf(), { registry: REG }))), 0);
});
