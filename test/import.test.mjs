import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importCases } from '../core/benchmark/import.mjs';
import { CorrectionLog, correction } from '../core/personal/corrections.mjs';
import { runBenchmark, allCases } from '../core/benchmark/run.mjs';
import { CASES } from '../core/benchmark/fixtures.mjs';

/*
 * §26 asks for ~500 reviewed tracks and the harness has always been able to
 * take them. There was no way to *produce* them: the review page collects
 * answers, and nothing turned answers back into benchmark cases. This is that
 * step, so these tests are about the one property that matters — an imported
 * case has to be indistinguishable to runBenchmark() from a hand-written one.
 */

const lib = {
  playlists: [{ id: 'p1', name: 'Tech House', tracks: [
    { id: 'tr1', name: 'Pressure', released: '2021-06-01', artists: [{ id: 'a1', name: 'Producer One' }] },
    { id: 'tr2', name: 'Unknowable', released: '2019-01-01', artists: [{ id: 'a2', name: 'Producer Two' }] },
    { id: 'tr3', name: 'No Evidence', released: '2020-01-01', artists: [{ id: 'a9', name: 'Nobody' }] },
  ] }],
  liked: [],
};
const caches = {
  lastfm: { a1: { tags: [['tech house', 100], ['house', 60]] },
            a2: { tags: [['techno', 80], ['jungle', 78]] } },
  discogs: { a1: { tags: [['Tech House', 4]] } },
};

test('an answered track becomes a known-good case the harness can run', () => {
  const log = new CorrectionLog().add(correction({ kind: 'genre', trackId: 'tr1', value: 'tech-house' }));
  const { cases } = importCases({ lib, caches, log });

  assert.equal(cases.length, 1);
  const c = cases[0];
  assert.equal(c.expectGenre, 'tech-house');
  assert.equal(c.track.name, 'Pressure');
  // Evidence is emitted in provider-response shape, like the synthetic cases,
  // so an imported case exercises the real adapters rather than a second
  // hand-built path that could quietly stop resembling them.
  assert.ok(c.evidence.some(e => e.provider === 'lastfm' && e.entityType === 'artist'));
  assert.ok(c.evidence.some(e => e.provider === 'discogs'));

  const r = runBenchmark(cases);
  assert.equal(r.cases, 1);
  assert.equal(r.passed, 1, 'the engine should get right what a person said it is');
});

/* A person who could not answer told you something real: the track is hard.
 * Discarding that row would quietly bias the benchmark towards the easy half
 * of the library, which is the exact failure §26 warns about. */
test('"not sure" becomes a known-bad case, not a discarded row', () => {
  const log = new CorrectionLog().add(correction({ kind: 'not-sure', trackId: 'tr2' }));
  const { cases } = importCases({ lib, caches, log });

  assert.equal(cases.length, 1);
  assert.equal(cases[0].expectGenre, null);
  assert.deepEqual(cases[0].expectConfidence, ['AMBIGUOUS', 'INSUFFICIENT_DATA']);
  assert.equal(runBenchmark(cases).passed, 1,
    'two genres from different branches at even weight must not be answered confidently');
});

test('an answered track nothing has said anything about is skipped, not faked', () => {
  const log = new CorrectionLog().add(correction({ kind: 'genre', trackId: 'tr3', value: 'techno' }));
  const { cases, skipped } = importCases({ lib, caches, log });
  assert.equal(cases.length, 0);
  assert.equal(skipped.noEvidence, 1);
});

test('an answer naming a genre the ontology does not know is refused', () => {
  const log = new CorrectionLog().add(correction({ kind: 'genre', trackId: 'tr1', value: 'not-a-real-genre' }));
  const { cases, skipped } = importCases({ lib, caches, log });
  assert.equal(cases.length, 0);
  assert.equal(skipped.unknownGenre, 1);
});

test('the most recent answer wins, the way the correction log reads it', () => {
  const log = new CorrectionLog()
    .add(correction({ kind: 'genre', trackId: 'tr1', value: 'house', at: 1 }))
    .add(correction({ kind: 'genre', trackId: 'tr1', value: 'tech-house', at: 2 }));
  assert.equal(importCases({ lib, caches, log }).cases[0].expectGenre, 'tech-house');
});

/* Real tags cannot be committed — they republish a third party's data and go
 * stale — so imported cases live in a gitignored file. What CI reports must
 * therefore stay the synthetic seed, whatever exists on somebody's disk. */
test('with nothing imported, the benchmark is exactly the committed fixtures', () => {
  assert.deepEqual(allCases().map(c => c.id), CASES.map(c => c.id));
});

/* How somebody files their music is nobody else's business, and §22 is
 * explicit that listening and filing must never reach the classifier. */
test('an imported case carries no playlist membership', () => {
  const log = new CorrectionLog().add(correction({ kind: 'genre', trackId: 'tr1', value: 'tech-house' }));
  const json = JSON.stringify(importCases({ lib, caches, log }).cases);
  assert.ok(!json.includes('p1'));
  assert.ok(!json.includes('Tech House —') && !json.toLowerCase().includes('playlist'));
});
