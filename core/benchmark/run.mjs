// The benchmark harness — §26, §37.
//
// "Every major classifier change must run against this benchmark" only means
// something if running it is one command and reading it takes ten seconds.
// This is that: `node core/benchmark/run.mjs`.
//
// Two things are measured, and the second is the one v1 cannot be measured on
// at all:
//
//   accuracy   how often the primary genre is right, and how often the right
//              answer is at least in the top three.
//   restraint  how often the engine declines to answer when the evidence does
//              not support one. §26: optimise for trustworthy labels, not for
//              every track getting a label.
//
// A metric per confidence band is reported alongside, because §27 says a band
// is meaningless until it has been validated against measured performance —
// HIGH has to actually be more accurate than LIKELY or it is decoration.
import { EvidenceSet } from '../evidence/evidence.mjs';
import { trackIdentity } from '../identity/track-identity.mjs';
import { ProviderRegistry } from '../sources/provider.mjs';
import { LASTFM, toEvidence as lastfmEvidence } from '../sources/lastfm.mjs';
import { DISCOGS, toEvidence as discogsEvidence } from '../sources/discogs.mjs';
import { SPOTIFY, toEvidence as spotifyEvidence } from '../sources/spotify.mjs';
import { SHARED_TABLE } from '../sources/legacy.mjs';
import { musicProfile } from '../analysis/music-dna.mjs';
import { CASES } from './fixtures.mjs';
import { loadImported } from './import.mjs';

const ADAPTERS = {
  lastfm: lastfmEvidence,
  discogs: discogsEvidence,
  // The shipped table is Last.fm data at one remove and parses identically —
  // the difference that matters (it shares Last.fm's independence group, so
  // it cannot corroborate a live Last.fm answer) lives in the provider
  // declaration, not in the parsing.
  'shared-tags': (json, ctx) => lastfmEvidence(json, ctx).map(r =>
    Object.freeze({ ...r, source: SHARED_TABLE.id })),
};

export const REGISTRY = new ProviderRegistry([SPOTIFY, LASTFM, DISCOGS, SHARED_TABLE]);

/** Build the EvidenceSet one fixture describes, through the real adapters. */
export function evidenceForCase(c, now = Date.UTC(2026, 0, 1)) {
  const set = new EvidenceSet(trackIdentity(c.track));
  set.add(...spotifyEvidence(c.track, { retrievedAt: now }));
  for (const e of c.evidence ?? []) {
    const adapt = ADAPTERS[e.provider];
    if (!adapt) throw new Error(`benchmark fixture ${c.id} names an unknown provider: ${e.provider}`);
    set.add(...adapt(e.response, {
      entityType: e.entityType,
      entityId: e.entityId ?? null,
      matchedBy: e.matchedBy ?? (e.entityType === 'artist' ? 'name-autocorrect' : 'name-exact'),
      retrievedAt: now,
    }));
  }
  return set;
}

/** Run one case and say, in detail, whether it passed and why. */
export function evaluate(c, { now = Date.UTC(2026, 0, 1) } = {}) {
  const profile = musicProfile(evidenceForCase(c, now), { registry: REGISTRY, now });
  const got = profile.genre.primary;
  const accept = new Set([c.expectGenre, ...(c.acceptGenre ?? [])].filter(Boolean));
  const top3 = profile.genre.candidates.slice(0, 3).map(x => x.concept);

  const checks = [];
  if (c.expectGenre === null) {
    // A known-bad case passes by declining, or by answering only within the
    // set of readings that are defensible. Answering something else entirely
    // is the failure this half of the benchmark exists to catch.
    const declined = got === null || ['AMBIGUOUS', 'INSUFFICIENT_DATA'].includes(profile.genre.confidence);
    checks.push({ name: 'declined or hedged', ok: declined || accept.has(got),
                  detail: `got ${got ?? 'nothing'} at ${profile.genre.confidence}` });
  } else {
    checks.push({ name: 'primary genre', ok: accept.has(got), detail: `expected ${[...accept].join('/')}, got ${got ?? 'nothing'}` });
    checks.push({ name: 'top-3 genre', ok: top3.some(g => accept.has(g)), detail: `top3 = ${top3.join(', ') || 'none'}` });
  }
  if (c.expectConfidence)
    checks.push({ name: 'confidence band', ok: c.expectConfidence.includes(profile.genre.confidence),
                  detail: `expected ${c.expectConfidence.join('/')}, got ${profile.genre.confidence}` });
  if (c.expectMood)
    checks.push({ name: 'mood', ok: profile.mood.primary === c.expectMood,
                  detail: `expected ${c.expectMood}, got ${profile.mood.primary ?? 'nothing'}` });
  if (c.expectEra)
    checks.push({ name: 'era', ok: profile.era.primary === c.expectEra,
                  detail: `expected ${c.expectEra}, got ${profile.era.primary ?? 'nothing'}` });
  if (c.expectUnknown) {
    const kept = new Set(profile.unknown.map(u => u.raw));
    checks.push({ name: 'unknown concepts kept', ok: c.expectUnknown.every(u => kept.has(u)),
                  detail: `kept ${[...kept].join(', ') || 'none'}` });
  }

  return { id: c.id, why: c.why, profile, got, checks, pass: checks.every(k => k.ok) };
}

/** Run everything and roll the results up into the §26 metric set. */
/**
 * The cases the benchmark runs on: the committed synthetic seed, plus any
 * real reviewed cases imported from your own library.
 *
 * Real cases cannot be committed — they republish a third party's tags and go
 * stale — so they live in a gitignored file and are picked up only if you
 * have produced some. That keeps the number CI reports honest (it is the
 * synthetic seed, always) while letting a real library actually constrain the
 * weights locally, which is the whole point of §26.
 */
export function allCases() {
  return [...CASES, ...loadImported()];
}

export function runBenchmark(cases = allCases(), opts = {}) {
  const results = cases.map(c => evaluate(c, opts));
  const known = results.filter(r => cases.find(c => c.id === r.id).expectGenre !== null);
  const bad = results.filter(r => cases.find(c => c.id === r.id).expectGenre === null);

  const rate = (list, name) => {
    const scored = list.filter(r => r.checks.some(k => k.name === name));
    if (!scored.length) return null;
    return +(scored.filter(r => r.checks.find(k => k.name === name).ok).length / scored.length).toFixed(3);
  };

  const byBand = {};
  for (const r of known) {
    const band = r.profile.genre.confidence;
    byBand[band] ??= { n: 0, correct: 0 };
    byBand[band].n++;
    if (r.checks.find(k => k.name === 'primary genre')?.ok) byBand[band].correct++;
  }
  for (const b of Object.values(byBand)) b.accuracy = +(b.correct / b.n).toFixed(3);

  return {
    cases: results.length,
    passed: results.filter(r => r.pass).length,
    primaryGenreAccuracy: rate(known, 'primary genre'),
    top3GenreAccuracy: rate(known, 'top-3 genre'),
    confidenceBandAccuracy: rate(results, 'confidence band'),
    moodAccuracy: rate(results, 'mood'),
    eraAccuracy: rate(results, 'era'),
    // §26's false-positive rate: how often a known-bad case was answered
    // confidently anyway. This is the number that must not be traded away for
    // coverage.
    falsePositiveRate: bad.length
      ? +(bad.filter(r => !r.checks.find(k => k.name === 'declined or hedged').ok).length / bad.length).toFixed(3)
      : 0,
    byBand,
    results,
  };
}

function main() {
  const cases = allCases();
  const imported = cases.length - CASES.length;
  const r = runBenchmark(cases);
  console.log(`=== BETTERFY ENGINE v3 BENCHMARK ===`);
  console.log(`${CASES.length} synthetic${imported ? ` + ${imported} reviewed from your library` : ''}`
    + `${imported ? '' : '  (none imported — see npm run benchmark:import)'}\n`);
  for (const res of r.results) {
    console.log(`${res.pass ? 'PASS' : 'FAIL'}  ${res.id}`);
    for (const k of res.checks) if (!k.ok || process.argv.includes('-v')) console.log(`        ${k.ok ? 'ok  ' : 'BAD '} ${k.name}: ${k.detail}`);
  }
  console.log(`\n${r.passed}/${r.cases} cases passed`);
  console.log(`  primary genre accuracy   ${r.primaryGenreAccuracy}`);
  console.log(`  top-3 genre accuracy     ${r.top3GenreAccuracy}`);
  console.log(`  confidence band accuracy ${r.confidenceBandAccuracy}`);
  console.log(`  mood accuracy            ${r.moodAccuracy}`);
  console.log(`  era accuracy             ${r.eraAccuracy}`);
  console.log(`  false-positive rate      ${r.falsePositiveRate}   (known-bad cases answered confidently)`);
  console.log('\n  by confidence band:');
  for (const [band, b] of Object.entries(r.byBand)) console.log(`    ${band.padEnd(18)} n=${b.n}  accuracy ${b.accuracy}`);
  if (r.passed < r.cases) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) main();
