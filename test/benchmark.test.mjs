import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBenchmark, evaluate, evidenceForCase } from '../core/benchmark/run.mjs';
import { compare } from '../core/benchmark/compare.mjs';
import { CASES, KNOWN_GOOD, KNOWN_BAD } from '../core/benchmark/fixtures.mjs';

/*
 * §26 makes the benchmark mandatory and §37 makes running it a quality gate.
 * That only bites if a classifier change that loses accuracy fails the build,
 * which is what this file is. The numbers asserted below are the current
 * measured floor — raise them when the engine improves, and never lower them
 * to make a change pass.
 */

test('every benchmark case passes', () => {
  const r = runBenchmark();
  const failed = r.results.filter(x => !x.pass);
  assert.deepEqual(failed.map(f => `${f.id}: ${f.checks.filter(k => !k.ok).map(k => k.detail).join('; ')}`), []);
});

test('accuracy does not regress below the recorded floor', () => {
  const r = runBenchmark();
  assert.ok(r.primaryGenreAccuracy >= 1, `primary genre accuracy fell to ${r.primaryGenreAccuracy}`);
  assert.ok(r.top3GenreAccuracy >= 1, `top-3 accuracy fell to ${r.top3GenreAccuracy}`);
  assert.equal(r.falsePositiveRate, 0, 'a known-bad case was answered confidently');
});

test('the confidence bands mean something — HIGH is at least as accurate as LIKELY', () => {
  const { byBand } = runBenchmark();
  const high = byBand.HIGH?.accuracy ?? 1;
  const likely = byBand.LIKELY?.accuracy ?? 0;
  assert.ok(high >= likely, `HIGH (${high}) must not be less accurate than LIKELY (${likely})`);
});

test('the fixtures cover both halves, and every case explains what it stands for', () => {
  assert.ok(KNOWN_GOOD.length >= 5);
  assert.ok(KNOWN_BAD.length >= 4, 'declining correctly is half of what is being measured');
  for (const c of CASES) {
    assert.ok(c.why && c.why.length > 30, `${c.id} does not say what failure it stands for`);
    assert.ok(c.track?.id, `${c.id} has no track`);
  }
});

test('fixtures are run through the real adapters, not hand-built evidence', () => {
  // If a fixture named a provider no adapter handles, it would be silently
  // contributing nothing — so the harness refuses rather than under-reporting.
  const set = evidenceForCase(CASES[0]);
  assert.ok(set.records.length > 0);
  assert.throws(() => evidenceForCase({ id: 'x', track: { id: 'x', artists: [] },
    evidence: [{ provider: 'nonexistent', entityType: 'artist', response: {} }] }), /unknown provider/);
});

test('v3 beats v1 on the known-good half and does not lose ground on the known-bad half', () => {
  const { summary } = compare();
  assert.ok(summary.knownGood.v3 > summary.knownGood.v1,
    `v3 ${summary.knownGood.v3} vs v1 ${summary.knownGood.v1} on cases with a knowable answer`);
  assert.ok(summary.knownBad.v3 >= summary.knownBad.v1,
    `v3 ${summary.knownBad.v3} vs v1 ${summary.knownBad.v1} on cases that should be declined`);
  assert.ok(summary.overall.v3 > summary.overall.v1);
});

test('the comparison gives v1 every advantage it could have had', () => {
  // v1 is scored on artist-level tags because that is the only kind it has a
  // mechanism to fetch — not because it was denied data here.
  const c = CASES.find(x => x.id === 'good-track-beats-diverse-artist');
  const r = evaluate(c);
  assert.equal(r.got, 'ambient');
  const trackLevel = evidenceForCase(c).records.filter(x => x.entityType === 'track');
  assert.ok(trackLevel.length, 'the fixture does supply track-level evidence');
});
