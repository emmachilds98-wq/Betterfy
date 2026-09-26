import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateOntology, resolveConcept, normKey, GENRE_INDEX,
         lineageOf, ancestorsOf, isWithin, commonAncestor, contradicts, isRelated,
         ONTOLOGY_VERSION } from '../core/ontology/index.mjs';
import { GENRES } from '../core/ontology/genres.mjs';
import { eraOfYear, MOODS, CONTEXTS } from '../core/ontology/facets.mjs';
import { tagFacet } from '../profile.mjs';

/*
 * The ontology is a declaration, and a declaration with a typo in it produces
 * an orphan genre nobody can ever reach — silently, and only visible as
 * slightly worse suggestions months later. validateOntology() is the guard;
 * this is the test that runs it.
 */

test('the ontology is structurally sound', () => {
  const { errors } = validateOntology();
  assert.deepEqual(errors, [], 'ontology declaration errors');
});

test('the ontology does not disagree with v1 about what kind of word a tag is', () => {
  // A warning here means the genre table claims a word profile.mjs reads as a
  // mood or an era — the alias would never resolve, and the two vocabularies
  // would be quietly drifting apart.
  const { warnings } = validateOntology();
  assert.deepEqual(warnings, [], 'ontology/profile.mjs vocabulary disagreements');
});

test('spelling variance collapses, distinct concepts do not', () => {
  for (const s of ['drum and bass', 'Drum & Bass', 'drum-and-bass', 'DnB', 'd&b'])
    assert.equal(resolveConcept(s).concept, 'drum-and-bass', s);
  for (const s of ['tech house', 'Tech-House', 'TECHHOUSE'])
    assert.equal(resolveConcept(s).concept, 'tech-house', s);
  // …but two genres that merely look alike stay apart.
  assert.equal(resolveConcept('uk garage').concept, 'uk-garage');
  assert.equal(resolveConcept('garage rock').concept, 'garage-rock');
  assert.notEqual(resolveConcept('house').concept, resolveConcept('hardcore').concept);
});

test('a compound tag resolves to the genre it is a shade of, and says it inferred that', () => {
  const r = resolveConcept('dark techno');
  assert.equal(r.concept, 'techno');
  assert.equal(r.via, 'suffix', 'a suffix match must be labelled, so it can be discounted');
  assert.equal(resolveConcept('melodic dubstep').concept, 'dubstep');
  // A single word is never a suffix match — that would just be the exact match.
  assert.equal(resolveConcept('techno').via, 'alias');
});

test('an unrecognised tag is kept, never discarded', () => {
  const r = resolveConcept('hard groove');
  assert.equal(r.concept, null);
  assert.equal(r.via, 'unknown');
  assert.equal(r.raw, 'hard groove', 'the raw value has to survive for the review queue');
});

test('facets are separated: a mood, an occasion and an era are not genres', () => {
  assert.equal(resolveConcept('chill').facet, 'mood');
  assert.equal(resolveConcept('chill').concept, 'relaxed');
  assert.equal(resolveConcept('workout').facet, 'context');
  assert.equal(resolveConcept('90s').facet, 'era');
  assert.equal(resolveConcept('90s').concept, '1990s');
  assert.equal(resolveConcept('1994').concept, '1990s');
  assert.equal(resolveConcept('british').facet, 'descriptor');
  assert.equal(resolveConcept('british').concept, null, 'a nationality names no concept');
});

test('a word v1 leaves on the genre side falls through to the facet tables', () => {
  // profile.mjs deliberately does not demote "club" — it leaves ambiguous
  // words that carry sound with them as genres rather than lose genre signal.
  // It is not a genre in the ontology, so it must reach the context table
  // rather than dead-end as unknown.
  assert.equal(tagFacet('club'), 'genre', 'precondition: v1 reads it as a genre word');
  const r = resolveConcept('club');
  assert.equal(r.facet, 'context');
  assert.equal(r.concept, 'club');
  assert.equal(r.via, 'fallback');
  // …but only after the genre index has declined it. "rave" is both, and the
  // genre reading wins.
  assert.equal(resolveConcept('rave').concept, 'hardcore');
});

test('the hierarchy answers what it exists to answer', () => {
  assert.deepEqual(ancestorsOf('tech-house'), ['house', 'electronic']);
  assert.deepEqual(lineageOf('tech-house'), ['tech-house', 'house', 'electronic']);
  assert.ok(isWithin('tech-house', 'house'));
  assert.ok(isWithin('tech-house', 'electronic'));
  assert.ok(isWithin('house', 'house'), 'a genre is within itself');
  assert.ok(!isWithin('house', 'tech-house'), 'and not within its own child');
  assert.equal(commonAncestor('tech-house', 'deep-house'), 'house');
  assert.equal(commonAncestor('tech-house', 'jungle'), 'electronic');
  assert.equal(commonAncestor('tech-house', 'metal'), null);
});

test('children and relations are derived, not hand-maintained', () => {
  assert.ok(GENRE_INDEX.get('house').children.includes('tech-house'));
  assert.ok(GENRE_INDEX.get('drum-and-bass').children.includes('jungle'));
  // `related` is declared once and closed both ways.
  assert.ok(isRelated('tech-house', 'techno'));
  assert.ok(isRelated('techno', 'tech-house'), 'relations must be symmetric');
  assert.ok(contradicts('garage-rock', 'uk-garage'));
  assert.ok(contradicts('uk-garage', 'garage-rock'));
});

test('normKey ignores exactly the punctuation providers disagree about', () => {
  assert.equal(normKey('Tech House'), normKey('tech-house'));
  assert.equal(normKey('R&B'), normKey('r and b'));
  assert.equal(normKey(null), '');
});

test('eraOfYear covers the decades it declares and nothing else', () => {
  assert.equal(eraOfYear(1994), '1990s');
  assert.equal(eraOfYear(2020), '2020s');
  assert.equal(eraOfYear(1867), null);
  assert.equal(eraOfYear('not a year'), null);
});

test('every genre reaches a root, so nothing is unreachable', () => {
  for (const slug of Object.keys(GENRES)) {
    const line = lineageOf(slug);
    assert.ok(line.length >= 1, slug);
    assert.equal(GENRE_INDEX.get(line[line.length - 1]).parent, null, `${slug} does not reach a root`);
  }
});

test('the ontology carries a version, so a profile can say what it was built under', () => {
  assert.match(ONTOLOGY_VERSION, /^genres@\d+\.\d+\.\d+\+facets@\d+\.\d+\.\d+$/);
});

test('mood and context tables are non-empty and disjoint from each other', () => {
  assert.ok(Object.keys(MOODS).length > 5);
  assert.ok(Object.keys(CONTEXTS).length > 5);
  const moods = new Set(Object.keys(MOODS));
  for (const c of Object.keys(CONTEXTS)) assert.ok(!moods.has(c), `${c} is in both tables`);
});
