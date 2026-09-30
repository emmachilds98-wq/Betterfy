import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldAsk, buildRequest, validateResponse, applyReconciliation,
         reconcile, reconcileLibrary, TASKS, REJECTIONS } from '../core/ai/reconcile.mjs';
import { CONFIDENCE } from '../core/analysis/classify.mjs';
import { EvidenceSet } from '../core/evidence/evidence.mjs';
import { trackIdentity } from '../core/identity/track-identity.mjs';
import { ProviderRegistry } from '../core/sources/provider.mjs';
import { LASTFM, toEvidence as lastfm } from '../core/sources/lastfm.mjs';
import { DISCOGS, toEvidence as discogs } from '../core/sources/discogs.mjs';
import { SHARED_TABLE, cacheToEvidence } from '../core/sources/legacy.mjs';
import { musicProfile } from '../core/analysis/music-dna.mjs';

/*
 * §24 is mostly a list of things AI must not be allowed to do, so these tests
 * are mostly a badly-behaved model trying to do them. A constraint layer is
 * only worth anything against an adversary; a well-behaved mock would prove
 * nothing at all.
 */

const REG = new ProviderRegistry([LASTFM, DISCOGS, SHARED_TABLE]);
const TRACK = { id: 't1', name: 'Crossover', artists: [{ id: 'a1', name: 'Two Scenes' }], released: '2019-01-01' };
const lfm = tags => ({ toptags: { tag: tags.map(([name, count]) => ({ name, count })) } });

/**
 * A genuinely divided track: two sources at the same specificity, matched the
 * same way, naming genres from unrelated branches. Note it takes real care to
 * build one — a release-level statement against an artist-level one is not
 * ambiguous, it is just a weaker claim losing, which is the deterministic
 * layer working rather than a case for a model.
 */
function ambiguousProfile() {
  const set = new EvidenceSet(trackIdentity(TRACK)).add(
    ...lastfm(lfm([['techno', 100]]), { entityType: 'artist', entityId: 'a1' }),
    ...cacheToEvidence({ a1: { tags: [['hip hop', 100]], checkedAt: Date.now() } },
      { source: SHARED_TABLE.id }).get('a1'));
  return musicProfile(set, { registry: REG });
}

function confidentProfile() {
  const set = new EvidenceSet(trackIdentity(TRACK)).add(
    ...lastfm(lfm([['tech house', 100], ['house', 70]]), { entityType: 'artist', entityId: 'a1' }),
    ...discogs({ results: [{ style: ['Tech House'] }, { style: ['Tech House'] }] },
      { entityType: 'release', entityId: 'r1', matchedBy: 'discogs-id' }));
  return musicProfile(set, { registry: REG });
}

test('the precondition: the fixtures really are ambiguous and confident', () => {
  assert.equal(ambiguousProfile().genre.confidence, CONFIDENCE.AMBIGUOUS);
  assert.equal(confidentProfile().genre.confidence, CONFIDENCE.HIGH);
});

test('AI is never asked a question the evidence already answered', () => {
  assert.equal(shouldAsk(confidentProfile()), false,
    're-opening a settled answer with a language model is how a good answer gets talked out of');
  assert.equal(shouldAsk(ambiguousProfile()), true);
  assert.equal(shouldAsk(null), false);
});

test('a track with nothing to reconcile is not asked about either', () => {
  const empty = musicProfile(new EvidenceSet(trackIdentity(TRACK)), { registry: REG });
  assert.equal(empty.genre.confidence, CONFIDENCE.INSUFFICIENT_DATA);
  assert.equal(shouldAsk(empty), false, 'a model asked to pick from an empty set will pick something');
});

test('the request carries a closed set of candidates, all evidence-backed', () => {
  const p = ambiguousProfile();
  const req = buildRequest(p);
  assert.ok(req.choices.length >= 2);
  for (const c of req.choices)
    assert.ok(p.genre.candidates.some(x => x.concept === c), `${c} is not a deterministic candidate`);
  assert.ok(Object.isFrozen(req));
  assert.throws(() => buildRequest(p, { task: 'write me a genre' }), /unknown AI task/);
  for (const t of TASKS) assert.ok(buildRequest(p, { task: t }));
});

test('the request describes the KIND of evidence, which is the actual question', () => {
  const req = buildRequest(ambiguousProfile());
  const c = req.candidates[0];
  // "an artist tag says techno, a release says jungle, which kind of
  // statement is more likely right about this record" — not "what genre is
  // this", which is the question a model would answer from the title.
  assert.equal(typeof c.assertedDirectly, 'boolean');
  assert.equal(typeof c.inheritedFromSubgenres, 'boolean');
  assert.equal(typeof c.independentSources, 'number');
  assert.ok(req.evidence.length, 'and the evidence lines the deterministic layer produced');
});

/* ---------- the adversarial half ---------- */

const req = () => buildRequest(ambiguousProfile());

test('a genre invented from the title is rejected, not merely discouraged', () => {
  const r = validateResponse({ choice: 'crossover-bass', reason: 'the title says Crossover' }, req());
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'NOT_IN_ONTOLOGY');
});

test('a REAL genre that nothing in this track supports is still rejected', () => {
  // The subtler failure: the model names something the ontology knows, so a
  // naive "is it a valid genre" check passes it. It is still a guess.
  const r = validateResponse({ choice: 'metal', reason: 'it feels heavy to me, honestly' }, req());
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'NOT_A_CHOICE');
  assert.ok(REJECTIONS.NOT_A_CHOICE);
});

test('a model cannot manufacture certainty the evidence does not have', () => {
  const choice = req().choices[0];
  const r = validateResponse({ choice, confidence: 'HIGH', reason: 'I am quite sure about this one' }, req());
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'OVERCONFIDENT');
});

test('an answer with no reason referring to the evidence is rejected', () => {
  const choice = req().choices[0];
  assert.equal(validateResponse({ choice }, req()).reason, 'NO_REASON');
  assert.equal(validateResponse({ choice, reason: 'yes' }, req()).reason, 'NO_REASON');
});

test('malformed answers are rejected rather than crashing a library pass', () => {
  for (const junk of [null, undefined, 'techno', 42, [], { choice: 7 }])
    assert.equal(validateResponse(junk, req()).ok, false, JSON.stringify(junk));
});

test('abstaining is valid, and is often the right answer', () => {
  const r = validateResponse({ choice: null, reason: 'the two sources are equally specific and disagree' }, req());
  assert.equal(r.ok, true);
  assert.equal(r.value.choice, null);
  assert.equal(validateResponse({ choice: 'abstain', reason: 'genuinely cannot tell' }, req()).ok, true);
});

test('a well-formed choice among the candidates is accepted', () => {
  const choice = req().choices[0];
  const r = validateResponse({ choice, confidence: 'LIKELY', reason: 'the release-level statement is more specific than the artist tag' }, req());
  assert.equal(r.ok, true);
  assert.equal(r.value.choice, choice);
});

/* ---------- application ---------- */

test('a reconciled answer is capped at LIKELY and labelled as not-evidence', () => {
  const p = ambiguousProfile();
  const choice = p.genre.candidates[1].concept;
  const applied = applyReconciliation(p, { ok: true, value: { choice, reason: 'release beats artist tag here' } }, { model: 'test-model' });
  assert.equal(applied.genre.primary, choice);
  assert.equal(applied.genre.confidence, CONFIDENCE.LIKELY,
    'the evidence was divided before the model spoke and is divided still');
  assert.equal(applied.genre.reconciledBy, 'ai');
  assert.deepEqual(applied.genre.reconciliation.wasAmbiguousBetween, p.genre.candidates.map(c => c.concept));
  assert.ok(applied.explanation.some(e => /reconciled by test-model/.test(e.text)));
});

test('reconciliation does not mutate the profile it was given', () => {
  const p = ambiguousProfile();
  const before = JSON.stringify(p);
  applyReconciliation(p, { ok: true, value: { choice: p.genre.candidates[1].concept, reason: 'because' } });
  assert.equal(JSON.stringify(p), before);
});

test('reconciliation adds no evidence — the next run starts from the same records', () => {
  const p = ambiguousProfile();
  const applied = applyReconciliation(p, { ok: true, value: { choice: p.genre.candidates[0].concept, reason: 'a reason' } });
  assert.equal(applied.evidence, p.evidence, '§24: AI must not replace or augment provider evidence');
  assert.deepEqual(applied.genre.candidates, p.genre.candidates);
});

test('an invalid answer changes nothing at all', () => {
  const p = ambiguousProfile();
  assert.equal(applyReconciliation(p, { ok: false, reason: 'NOT_A_CHOICE' }), p);
  assert.equal(applyReconciliation(p, { ok: true, value: { choice: null } }), p);
});

/* ---------- end to end, with a misbehaving model ---------- */

test('a model that throws, lies and invents is absorbed without damage', async () => {
  const p = ambiguousProfile();
  const liars = [
    () => { throw new Error('rate limited'); },
    () => ({ choice: 'not-a-real-genre', reason: 'trust me on this one' }),
    () => ({ choice: 'metal', reason: 'it has a heavy feeling to it' }),
    () => ({ choice: p.genre.candidates[0].concept, confidence: 'HIGH', reason: 'definitely certain about this' }),
    () => 'techno',
  ];
  for (const ask of liars) {
    const r = await reconcile(p, ask, { model: 'liar' });
    assert.equal(r.applied, false);
    assert.equal(r.profile, p, 'the profile must come back untouched');
    assert.ok(r.rejected, 'and the refusal must be counted');
  }
});

test('a well-behaved model settles the case it was asked about', async () => {
  const p = ambiguousProfile();
  const ask = request => ({ choice: request.choices[0], confidence: 'LIKELY',
                            reason: 'the release-level style is more specific than the artist tag' });
  const r = await reconcile(p, ask, { model: 'good' });
  assert.equal(r.asked, true);
  assert.equal(r.applied, true);
  assert.equal(r.profile.genre.confidence, CONFIDENCE.LIKELY);
});

test('a concept proposal goes to a human and is never applied', async () => {
  const set = new EvidenceSet(trackIdentity(TRACK)).add(
    ...lastfm(lfm([['schranz', 100]]), { entityType: 'artist', entityId: 'a1' }));
  const p = musicProfile(set, { registry: REG });
  assert.ok(p.unknown.length);

  const ask = () => ({ proposals: [{ raw: 'schranz', concept: 'hard-techno', reason: 'a hard techno style' }] });
  const r = await reconcile(p, ask, { task: 'propose-concept', model: 'good' });
  assert.equal(r.applied, false, 'proposals feed the review queue, they are not answers');
  assert.deepEqual(r.proposals, [{ raw: 'schranz', concept: 'hard-techno', reason: 'a hard techno style' }]);
  assert.equal(r.profile, p);
});

test('a proposal to an invented concept, or about a tag nobody asked about, is rejected', async () => {
  const set = new EvidenceSet(trackIdentity(TRACK)).add(
    ...lastfm(lfm([['schranz', 100]]), { entityType: 'artist', entityId: 'a1' }));
  const p = musicProfile(set, { registry: REG });
  for (const bad of [
    { proposals: [{ raw: 'schranz', concept: 'industrial-hard-groove', reason: 'invented' }] },
    { proposals: [{ raw: 'something-nobody-mentioned', concept: 'techno', reason: 'unasked' }] },
    { proposals: 'not an array' },
  ]) {
    const r = await reconcile(p, () => bad, { task: 'propose-concept' });
    assert.equal(r.applied, false);
    assert.ok(r.rejected, JSON.stringify(bad));
  }
});

test('a library pass reports how often the model was refused', async () => {
  const profiles = new Map([
    ['a', { profile: ambiguousProfile() }],
    ['b', { profile: ambiguousProfile() }],
    ['c', { profile: confidentProfile() }],
  ]);
  let n = 0;
  const flaky = request => (n++ % 2
    ? { choice: 'metal', reason: 'a wrong but well-formed answer' }
    : { choice: request.choices[0], reason: 'the more specific statement wins' });
  const { profiles: out, stats } = await reconcileLibrary(profiles, flaky, { model: 'flaky' });
  assert.equal(stats.asked, 2, 'the confident track is never asked about');
  assert.equal(stats.skipped, 1);
  assert.equal(stats.applied + stats.rejectedTotal, 2);
  assert.ok(stats.rejections.NOT_A_CHOICE >= 1,
    'a model being refused often is one that should not be trusted with what got through');
  assert.equal(out.get('c').profile, profiles.get('c').profile);
});

test('a limit caps how many questions a run will ask', async () => {
  const profiles = new Map(Array.from({ length: 5 }, (_, i) => [String(i), { profile: ambiguousProfile() }]));
  const { stats } = await reconcileLibrary(profiles, r => ({ choice: r.choices[0], reason: 'a sufficient reason' }),
    { limit: 2 });
  assert.equal(stats.asked, 2);
  assert.equal(stats.skipped, 3);
});

test('nothing in the reconciler names a vendor or calls the network', async () => {
  const src = await import('node:fs').then(fs => fs.readFileSync('core/ai/reconcile.mjs', 'utf8'));
  assert.ok(!/\bfetch\s*\(/.test(src), 'the ask function is injected; this module makes no calls');
  for (const vendor of ['openai', 'anthropic', 'gemini', 'api_key', 'apiKey'])
    assert.ok(!src.toLowerCase().includes(vendor.toLowerCase()), `${vendor} is named — §32 phase 5's "do not couple to a single vendor" applies here too`);
});
