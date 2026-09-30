import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  cooccurrence, trackVector, cosine, centroid,
  MIN_ARTIST_PLAYLISTS, COOCCURRENCE_VERSION,
} from '../core/intrinsic/cooccurrence.mjs';
import {
  registrantOf, registrantIndex, registrantWeight, formatOf, eraOf,
  sessionsOf, profileOf, shapeScores, numericCloseness,
} from '../core/intrinsic/features.mjs';
import { buildSpace, placements, combine, WEIGHTS, BANDS } from '../core/intrinsic/space.mjs';
import { sweepWeights, componentValue, SWEEP } from '../core/intrinsic/fit.mjs';
import { rungOf, RUNGS, tagCoverage, proposeBuckets } from '../core/intrinsic/coldstart.mjs';
import { bonusIndex, bonusScores, keyCompatibility, KEY_MATCH, MIN_KNOWN } from '../core/intrinsic/bonus-rekordbox.mjs';
import { serialiseSpace, reviveSpace, fingerprint, ENGINE_STAMP } from '../core/intrinsic/persist.mjs';
import { placementAccuracy, foldOf, truthOf } from '../core/validate/loo.mjs';
import { baselineAccuracy, libraryWithout } from '../core/validate/baseline.mjs';
import { explain, summarise, MARKS } from '../core/intrinsic/explain.mjs';
import { bucketPairs, boundaryTracks, drift, unnamedClusters } from '../core/intrinsic/reports.mjs';

/* ---------- a fixture library with real structure ----------
 *
 * Four families of artists, four buckets each drawn from one family, with a
 * family-specific label registrant, duration band and era.
 *
 * Two properties of a real library are load-bearing here, and the first draft
 * of this fixture had neither — which broke two tests in an instructive way
 * rather than a annoying one.
 *
 * **Artists must span more than one bucket.** `MIN_ARTIST_PLAYLISTS` drops any
 * artist seen in a single playlist, because one coincidence is not a pattern.
 * A fixture where every artist lives in exactly one bucket therefore produces
 * an *entirely empty graph* — and the engine still scored 0.78 on shape
 * features alone, which looked like the graph working and was not. So the
 * crossover playlists below exist to give core artists a document frequency
 * above one, exactly as a real listener's "Favourites" and mood buckets do.
 *
 * **Some artists must be rare.** Memorisation — the thing the canary detects —
 * bites hardest where an artist appears on one track only: with the track left
 * in, the bucket's centroid contains that artist and the cosine spikes; with it
 * held out, the artist is absent entirely. Where every artist is on a dozen
 * tracks, removing one changes almost nothing and leakage is undetectable. The
 * guest artists below are that case, and every real library is full of them.
 *
 * **Shape must not give the answer away.** The first draft gave each family its
 * own era, album type, duration band and popularity, so every track was
 * placeable from format alone and both the honest and the leaky path scored a
 * perfect 1.000 — a ceiling that hid whether the graph worked *and* left the
 * canary nothing to detect. Here every bucket shares one shape, so separation
 * has to come from the artist graph and the label, which is the thing under
 * test.
 *
 * **Some records must be genuinely unplaceable when held out.** Two tracks per
 * bucket are credited to two artists who appear nowhere else and carry the
 * aggregator's registrant rather than a label's — a self-released one-off, which
 * every library has. Held out, there is nothing left to place them by; left in,
 * their own artists sit in the centroid and they are trivial. That gap is
 * exactly what the canary measures.
 *
 * Deliberately over 50 distinct tracks, because `mirrorPredicate` will not call
 * anything a mirror below a minimum library size, and the mirror-exclusion
 * tests need it to fire.
 */
const FAMILIES = ['tech', 'deep', 'jungle', 'ambient'];

function fixture({ withAggregator = true } = {}) {
  const playlists = [];
  const all = [];
  const core = {};

  FAMILIES.forEach((fam, fi) => {
    core[fam] = Array.from({ length: 6 }, (_, i) => ({ id: `${fam}-a${i}`, name: `${fam} artist ${i}` }));
    const letter = String.fromCharCode(65 + fi);
    const tracks = Array.from({ length: 15 }, (_, i) => {
      // 0..11  two core artists of the family      — the graph should nail these
      // 12..13 a one-off guest plus a core artist  — degraded but recoverable
      // 14     two artists seen nowhere else       — unplaceable once held out
      const orphan = i === 14;
      const guest = i === 12 || i === 13;
      const a1 = orphan ? { id: `${fam}-o${i}a` } : guest ? { id: `${fam}-g${i}` } : core[fam][i % 6];
      const a2 = orphan ? { id: `${fam}-o${i}b` } : core[fam][(i + 2) % 6];
      // An orphan record carries the distributor's code, not a label's, so the
      // one remaining signal is gone too. A few ordinary tracks carry it as
      // well, which is the case `registrantWeight` has to defuse.
      const aggregated = orphan || (withAggregator && i % 5 === 0);
      const reg = aggregated ? 'ZZAGG' : `GB${letter}${letter}${letter}`;
      const t = {
        id: `${fam}-t${i}`,
        name: `${fam} track ${i}`,
        artists: [a1, a2],
        albumId: `${fam}-al${i % 5}`,
        // Uniform across families on purpose: shape must not leak the answer.
        albumType: 'single',
        albumTracks: 2,
        trackNo: 1,
        released: '2020-03-01',
        duration_ms: 6 * 60000 + (i % 5) * 20000,
        explicit: false,
        isrc: `${reg}${20 + fi}${String(10000 + i).slice(0, 5)}`,
        popularity: 45 + (i % 5),
        added_at: new Date(Date.UTC(2025, fi, 1 + Math.floor(i / 5), 12, i % 5)).toISOString(),
      };
      all.push(t);
      return t;
    });
    playlists.push({ id: `p-${fam}`, name: fam, tracks });
  });

  // Crossover buckets, the way a listener really files: a favourites view and
  // two mood buckets that each straddle two families. These are what lift core
  // artists above one playlist. Note which pairs are NOT joined — tech and
  // ambient never share a bucket, so they remain genuine strangers and the
  // "no edge between strangers" assertion stays meaningful.
  const pick = (fam, from, to) => playlists.find(p => p.id === `p-${fam}`).tracks.slice(from, to);
  playlists.push({ id: 'p-favs',  name: 'Favourites', tracks: [...pick('tech', 0, 5), ...pick('deep', 0, 5)] });
  playlists.push({ id: 'p-night', name: 'Late Night', tracks: [...pick('deep', 5, 9), ...pick('ambient', 0, 5)] });
  playlists.push({ id: 'p-bang',  name: 'Bangers',    tracks: [...pick('tech', 5, 9), ...pick('jungle', 0, 5)] });

  return { playlists, all };
}

/** The same library plus a record-of-everything playlist. */
function withMirror(lib) {
  return { ...lib, playlists: [...lib.playlists, { id: 'p-all', name: 'Remember Everything', tracks: lib.all }] };
}

/* ---------- co-occurrence ---------- */

test('artists co-occurring in a bucket get positive PPMI; strangers get no edge', () => {
  const lib = fixture();
  const g = cooccurrence(lib);
  assert.equal(g.version, COOCCURRENCE_VERSION);

  // Same family, repeatedly in the same bucket.
  const row = g.ppmi.get('tech-a0');
  assert.ok(row, 'an artist filed across a bucket should have a neighbourhood');
  assert.ok(row.get('tech-a2') > 0, 'same-family artists should be neighbours');

  // tech and jungle DO share the Bangers bucket, so they are not strangers.
  // tech and ambient share none, which is what makes this assertion mean
  // something: an edge between them could only come from a mirror.
  assert.ok(row.get('jungle-a0') > 0, 'artists joined by a crossover bucket are neighbours');
  assert.equal(row.get('ambient-a0'), undefined, 'artists that never co-occur must not be linked');
});

test('an artist in only one playlist is excluded — one coincidence is not a pattern', () => {
  const lib = fixture();
  // A loner: present once, in one bucket.
  lib.playlists[0].tracks.push({
    id: 'loner-t', name: 'loner', artists: [{ id: 'loner-a', name: 'Loner' }],
    duration_ms: 300000, released: '2020-01-01', isrc: 'GBQQQ2400001', popularity: 5,
  });
  const g = cooccurrence(lib);
  assert.equal(g.df.get('loner-a'), 1);
  assert.ok(MIN_ARTIST_PLAYLISTS > 1);
  assert.equal(g.ppmi.get('loner-a'), undefined, 'a single-playlist artist carries no co-occurrence evidence');
});

test('a record-of-everything playlist is kept out of the graph', () => {
  const plain = cooccurrence(fixture());
  const mirrored = cooccurrence(withMirror(fixture()));
  // If the mirror were counted, every artist would co-occur with every other
  // and cross-family edges would appear.
  assert.equal(mirrored.ppmi.get('tech-a0')?.get('ambient-a0'), undefined,
    'a mirror would link every artist to every other; it must be dropped');
  assert.equal(mirrored.playlists, plain.playlists,
    'the mirror must not even count toward the playlist total the PPMI is normalised by');
});

test('a track vector carries its own artists as well as their neighbours', () => {
  const lib = fixture();
  const g = cooccurrence(lib);
  const t = lib.playlists[0].tracks[0];
  const v = trackVector(t, g);
  assert.ok(v.get('tech-a0') > 0, 'the credited artist itself must be in the vector');
  // Identity matters most in a library where an artist has no neighbours at all,
  // which in a new account is the common case.
  const bare = trackVector({ artists: [{ id: 'nobody' }] }, g);
  assert.equal(bare.get('nobody'), 1, 'with no neighbourhood, a track is still located by its artist');
});

test('billing order is weighted: the first credit carries the record', () => {
  const g = cooccurrence(fixture());
  const v = trackVector({ artists: [{ id: 'x' }, { id: 'y' }] }, g);
  assert.ok(v.get('x') > v.get('y'), 'a featured second credit must count for less than the lead');
});

test('cosine and centroid behave', () => {
  const a = new Map([['p', 1], ['q', 0]]);
  const b = new Map([['p', 2]]);
  assert.equal(cosine(a, b), 1);
  assert.equal(cosine(a, new Map([['z', 5]])), 0);
  assert.equal(cosine(new Map(), b), 0);
  const c = centroid([new Map([['p', 1]]), new Map([['p', 3]])]);
  assert.equal(c.get('p'), 2);
  assert.equal(centroid([]).size, 0);
});

/* ---------- features ---------- */

test('the ISRC registrant is parsed, and junk is refused rather than guessed', () => {
  assert.equal(registrantOf({ isrc: 'GBAYE2400123' }), 'GBAYE');
  assert.equal(registrantOf({ isrc: 'gb-aye-24-00123' }), 'GBAYE', 'punctuation and case are cosmetic');
  assert.equal(registrantOf({ isrc: 'nonsense' }), null);
  assert.equal(registrantOf({ isrc: '' }), null);
  assert.equal(registrantOf({}), null);
});

test('a registrant spanning every bucket weights itself out; a real label does not', () => {
  const lib = fixture();
  const idx = registrantIndex(lib);

  // ZZAGG is on tracks in all four buckets — the aggregator shape.
  assert.equal(idx.span.get('ZZAGG'), idx.playlists, 'the aggregator code reaches every bucket');
  assert.equal(registrantWeight('ZZAGG', idx), 0,
    'a code appearing in every playlist distinguishes nothing and must score zero');

  // GBAAA is only in the first bucket.
  // tech's own label reaches its bucket plus the two crossovers that draw from
  // it — concentrated, but not confined to one playlist, which is what a real
  // label looks like once a listener keeps a favourites view.
  assert.ok(idx.span.get('GBAAA') < idx.playlists, 'a label must not span every bucket');
  assert.ok(registrantWeight('GBAAA', idx) > 0, 'a concentrated label carries real signal');
  assert.ok(registrantWeight('GBAAA', idx) > registrantWeight('ZZAGG', idx),
    'a label must outweigh a distributor, which is the whole point of the span weighting');
  assert.equal(registrantWeight(null, idx), 0);
});

test('format, era and sessions read what is there and admit what is not', () => {
  const f = formatOf({ duration_ms: 420000, albumType: 'single', albumTracks: 2, trackNo: 1 });
  assert.equal(f.minutes, 7);
  assert.equal(f.albumType, 'single');
  assert.equal(formatOf({}).minutes, null, 'a missing duration is null, not zero');

  assert.ok(eraOf({ released: '1994-05-01' }));
  assert.equal(eraOf({ released: 'unknown' }), null);
  assert.equal(eraOf({}), null);

  const s = sessionsOf({ tracks: [
    { id: 'a', added_at: '2025-01-01T12:00:00Z' },
    { id: 'b', added_at: '2025-01-01T12:05:00Z' },   // same sitting
    { id: 'c', added_at: '2025-03-01T12:00:00Z' },   // months later
  ]});
  assert.equal(s.sessions, 2);
  assert.equal(s.session.get('a'), s.session.get('b'));
  assert.notEqual(s.session.get('a'), s.session.get('c'));
  assert.equal(sessionsOf({ tracks: [] }).sessions, 0);
});

test('numericCloseness peaks at the mean and widens with the spread', () => {
  assert.equal(numericCloseness(10, { mean: 10, sd: 2 }), 1);
  const tight = numericCloseness(14, { mean: 10, sd: 1 });
  const loose = numericCloseness(14, { mean: 10, sd: 8 });
  assert.ok(loose > tight, 'a bucket with a wide spread should not reject an outlier as hard');
  assert.equal(numericCloseness(null, { mean: 10, sd: 1 }), null, 'unknown is null, never zero');
  assert.equal(numericCloseness(10, {}), null, 'a bucket with no mean cannot judge');
  // Too few members to have a spread: proportional, not confidently wrong.
  assert.ok(numericCloseness(11, { mean: 10, sd: null }) > 0);
});

test('a profile honours skip, so a bucket can be described as it was before a track joined', () => {
  const lib = fixture();
  const p = lib.playlists[0];
  const full = profileOf(p);
  const less = profileOf(p, { skip: new Set([p.tracks[0].id]) });
  assert.equal(full.n, 15);
  assert.equal(less.n, 14);
});

test('shape scores distinguish "cannot judge" from "judged badly"', () => {
  const lib = fixture();
  const idx = registrantIndex(lib);
  const prof = profileOf(lib.playlists[0]);

  const bare = shapeScores({ id: 'x' }, prof, { registrants: idx });
  assert.equal(bare.minutes, null, 'no duration means unjudgeable');
  assert.equal(bare.registrant, null, 'no ISRC means unjudgeable');

  const agg = shapeScores({ id: 'y', isrc: 'ZZAGG2400001' }, prof, { registrants: idx });
  assert.equal(agg.registrant, 0, 'an aggregator code IS judged — and judged worthless');
});

/* ---------- the combining layer ---------- */

test('combine renormalises over what is present, so a missing field costs nothing', () => {
  const both = combine({ graph: 1, era: 1 });
  const onlyGraph = combine({ graph: 1, era: null });
  assert.equal(both.score, 1);
  assert.equal(onlyGraph.score, 1, 'a null component must not drag a perfect score down');
  assert.equal(onlyGraph.judged, 1);
  assert.equal(combine({}).score, 0);
  assert.equal(combine({}).judged, 0);
  assert.ok(WEIGHTS.graph >= Math.max(...Object.values(WEIGHTS)), 'the graph must lead');
});

test('placements rank the account\'s own buckets, and refuse when there is nothing to go on', () => {
  const lib = fixture();
  const space = buildSpace(lib);
  assert.equal(space.destinations.size, 7, 'four family buckets and three crossovers');

  const t = lib.playlists[0].tracks[3];
  const out = placements(t, space);
  assert.equal(out.results[0].playlistId, 'p-tech');
  assert.ok(out.band === BANDS.HIGH || out.band === BANDS.LIKELY);

  assert.equal(placements({}, space).declined, 'NO_TRACK');
  assert.equal(placements(t, { destinations: new Map() }).declined, 'NO_DESTINATIONS');
});

test('a mirror is never offered as a destination', () => {
  const space = buildSpace(withMirror(fixture()));
  assert.ok(!space.destinations.has('p-all'),
    'a playlist holding the whole library would win every comparison by containing everything');
  assert.equal(space.destinations.size, 7);
});

test('a bucket too small to have a meaning is not a destination', () => {
  const lib = fixture();
  lib.playlists.push({ id: 'p-tiny', name: 'Tiny', tracks: lib.playlists[0].tracks.slice(0, 2) });
  const space = buildSpace(lib);
  assert.ok(!space.destinations.has('p-tiny'));
});

/* ---------- the harness, and the canary ---------- */

test('folds are deterministic, so two runs of the harness are comparable', () => {
  assert.equal(foldOf('abc', 5), foldOf('abc', 5));
  const seen = new Set(Array.from({ length: 200 }, (_, i) => foldOf(`t${i}`, 5)));
  assert.equal(seen.size, 5, 'all folds should be used over a few hundred ids');
  for (const f of seen) assert.ok(f >= 0 && f < 5);
});

test('truth is a set, because one track can belong in several buckets at once', () => {
  const lib = fixture();
  // The README's own case: a track legitimately in a genre bucket and a mood one.
  lib.playlists.push({ id: 'p-mood', name: 'Late Night', tracks: lib.playlists[0].tracks.slice(0, 6) });
  const truth = truthOf(lib);
  // Also in Favourites, which the fixture builds from the front of each bucket.
  assert.deepEqual([...truth.get('tech-t0')].sort(), ['p-favs', 'p-mood', 'p-tech']);
});

test('truth excludes a mirror — finding a track in the record of everything is not a placement', () => {
  const truth = truthOf(withMirror(fixture()));
  assert.ok(!truth.get('tech-t0').has('p-all'));
});

test('held-out accuracy finds the signal in a structured library', () => {
  const r = placementAccuracy(fixture(), { folds: 5 });
  assert.equal(r.mode, '5-fold');
  assert.equal(r.scored, 60);
  // Four well-separated families: an engine that works should place most of them.
  assert.ok(r.top1 > 0.75, `top-1 should be high on an obviously structured library, got ${r.top1}`);
  assert.ok(r.top3 >= r.top1);
  assert.ok(r.worstPlaylists.length > 0, 'per-bucket accuracy is what finds the buckets it does not understand');
  for (const p of r.playlists) {
    assert.ok(p.inTop3 >= p.rank1, 'being offered at all cannot be rarer than being offered first');
  }
});

test('a crossover bucket is not scored as a failure for losing to a tighter one', () => {
  // The first version of the per-bucket metric gave every crossover exactly 0,
  // because a view can never outrank the specific bucket its tracks also sit in
  // — the engine was right and the number said otherwise.
  const r = placementAccuracy(fixture(), { folds: 5 });
  const favs = r.playlists.find(p => p.id === 'p-favs');
  assert.ok(favs, 'the crossover bucket should be measured');
  assert.ok(favs.inTop3 > 0, 'a view the engine understands must at least be offered');
});

test('THE CANARY: scoring tracks the space has already seen must beat the honest path', () => {
  // This is the test that keeps every other number in this file honest. If the
  // fold machinery ever stops excluding held-out tracks, the honest path starts
  // seeing its own answers and these two converge. A gap is proof the exclusion
  // is real; no gap is proof it is not.
  const lib = fixture();
  const honest = placementAccuracy(lib, { folds: 5 });
  const leaky = placementAccuracy(lib, { leaky: true });

  assert.equal(leaky.mode, 'leaky');
  assert.equal(honest.scored, leaky.scored);
  assert.ok(leaky.top1 > honest.top1,
    `a space that has seen the answer must score better (leaky ${leaky.top1} vs honest ${honest.top1}); ` +
    'if these are equal the folds are leaking and the honest number is fiction');
});

test('abstention is measured as a cost, not counted as a virtue', () => {
  const r = placementAccuracy(fixture(), { folds: 5 });
  assert.ok(Number.isInteger(r.declined));
  assert.ok(Number.isInteger(r.declinedWouldHaveBeenRight));
  assert.ok(r.declinedWouldHaveBeenRight <= r.declined,
    'a refusal that would have been right is tracked so refusing cannot look free');
});

test('bands are reported with their own accuracy, so confidence can be checked rather than trusted', () => {
  const r = placementAccuracy(fixture(), { folds: 5 });
  const names = Object.keys(r.bands);
  assert.ok(names.length > 0);
  for (const n of names) {
    assert.ok(Object.values(BANDS).includes(n), `unexpected band ${n}`);
    assert.ok(r.bands[n].n > 0);
  }
});

test('the harness survives a library with nothing in it', () => {
  const r = placementAccuracy({ playlists: [] });
  assert.equal(r.scored, 0);
  assert.equal(r.top1, null, 'no rows means no rate, not a rate of zero');
});

/* ---------- the baseline half of the gate ----------
 *
 * A gate is only a gate if both engines are measured the same way, so these
 * tests are as much about the fairness of the comparison as about v1.
 */

/** Tags in the shape `profile.mjs` expects: { artistId: { tags: [[name, count]] } }. */
function tagsFor(lib, { cover = () => true } = {}) {
  const tags = {};
  for (const p of lib.playlists) {
    for (const t of p.tracks ?? []) {
      for (const a of t.artists ?? []) {
        if (!a?.id || tags[a.id] || !cover(a.id)) continue;
        const fam = a.id.split('-')[0];
        tags[a.id] = { tags: [[fam, 100], [`${fam} sound`, 80], ['electronic', 60]] };
      }
    }
  }
  return tags;
}

test('libraryWithout removes tracks everywhere and leaves the original alone', () => {
  const lib = fixture();
  const before = lib.playlists[0].tracks.length;
  const held = libraryWithout(lib, new Set(['tech-t0']));
  assert.equal(lib.playlists[0].tracks.length, before, 'the input must not be mutated');
  assert.ok(held.playlists[0].tracks.length < before);
  for (const p of held.playlists) {
    assert.ok(!(p.tracks ?? []).some(t => t.id === 'tech-t0'), 'held-out track must be gone from every bucket');
  }
});

test('the baseline reports the same fields, so the two engines are comparable at all', () => {
  const lib = fixture();
  const base = baselineAccuracy(lib, tagsFor(lib), { folds: 5 });
  const mine = placementAccuracy(lib, { folds: 5 });
  assert.equal(base.mode, mine.mode, 'both engines must be scored over the same folds');
  assert.equal(base.scored, mine.scored, 'both must be scored over the same tracks');
  for (const k of ['top1', 'top3', 'scored']) assert.ok(k in base && k in mine);
});

test('with good tag coverage the tag engine scores well — the harness is not rigged against it', () => {
  const lib = fixture();
  const base = baselineAccuracy(lib, tagsFor(lib), { folds: 5 });
  // Family-named tags make this an easy library for v1 too, which is the point:
  // a comparison where the baseline cannot win is not evidence of anything.
  assert.ok(base.top1 > 0.5, `v1 should do well given clean tags, got ${base.top1}`);
});

test('a track v1 has no tags for is a miss, not an abstention — it has no way to abstain', () => {
  const lib = fixture();
  // Cover only the tech family, so every other bucket's tracks have no vector.
  const thin = tagsFor(lib, { cover: id => id.startsWith('tech') });
  const base = baselineAccuracy(lib, thin, { folds: 5 });
  assert.ok(base.noAnswer > 0, 'v1 returns nothing for an untagged artist');
  assert.equal(base.scored, placementAccuracy(lib, { folds: 5 }).scored,
    'the denominator stays the whole library: returning nothing is not a free pass');
  assert.ok(base.top1 < 0.5, 'and it costs accuracy, which is the honest accounting');
});

/* ---------- explanations ---------- */

test('an explanation is countable facts about the listener\'s own library', () => {
  const lib = fixture();
  const space = buildSpace(lib);
  const t = lib.playlists[0].tracks[3];
  const out = placements(t, space, { why: true, limit: 1 });
  const text = summarise(out.results[0].why);

  assert.ok(out.results[0].why.length > 0);
  assert.match(text, /already here \d+ times?/, 'it should count, not assert');
  assert.ok(!/genre|house|techno|jungle|ambient/i.test(text),
    `an explanation must name no genre at all, got: ${text}`);
  for (const line of out.results[0].why) {
    assert.ok(Object.values(MARKS).includes(line.mark));
    assert.equal(typeof line.text, 'string');
  }
});

test('a clause true of every bucket is left out — an explanation is not a horoscope', () => {
  // Every track in this fixture is a single from the 2020s, so "a single, and
  // 100% of this bucket is too" would appear identically under every
  // alternative: true, thorough-looking, and no help choosing.
  const lib = fixture();
  const space = buildSpace(lib);
  const out = placements(lib.playlists[0].tracks[3], space, { why: true, limit: 1 });
  const text = summarise(out.results[0].why);
  assert.ok(!/is too/.test(text), `a non-distinguishing format clause must be dropped, got: ${text}`);

  // Whereas a genuinely distinguishing one is kept. Give one bucket a format
  // the rest of the library does not have.
  const odd = fixture();
  for (const t of odd.playlists[1].tracks) { t.albumType = 'compilation'; t.albumTracks = 30; }
  const space2 = buildSpace(odd);
  const out2 = placements(odd.playlists[1].tracks[2], space2, { why: true, limit: 1 });
  assert.match(summarise(out2.results[0].why), /compilation/,
    'a format that does distinguish this bucket should be said');
});

test('a truncated artist list does not attach its count to more artists than it names', () => {
  const lib = fixture();
  const space = buildSpace(lib);
  const out = placements(lib.playlists[0].tracks[3], space, { why: true, limit: 1 });
  const nearby = out.results[0].why.find(l => l.text.startsWith('sits with'));
  if (nearby && /more of this bucket/.test(nearby.text)) {
    assert.match(nearby.text, /who appear here \d+ times?, and \d+ more/,
      'the count must belong to the named artists, with the remainder stated separately');
  }
});

/* ---------- the difference reports ---------- */

test('a view of another bucket is identified as a view, not as a rival', () => {
  const lib = fixture();
  // Favourites is built from the front of tech and deep, so it is contained.
  const pairs = bucketPairs(buildSpace(lib));
  const favs = pairs.filter(p => p.a.id === 'p-favs' || p.b.id === 'p-favs');
  assert.ok(favs.length > 0, 'a contained bucket should be reported');
  assert.ok(favs.some(p => p.verdict === 'view'), 'and reported as a view');
});

test('two buckets that hold different records but sit in the same place are flagged as indistinguishable', () => {
  const lib = fixture();
  // Split one family into two buckets with NO shared tracks. The listener keeps
  // them apart; the library cannot tell them apart.
  const tech = lib.playlists.find(p => p.id === 'p-tech').tracks;
  lib.playlists.push({ id: 'p-split-a', name: 'Split A', tracks: tech.slice(0, 6) });
  lib.playlists.push({ id: 'p-split-b', name: 'Split B', tracks: tech.slice(6, 12) });

  const pairs = bucketPairs(buildSpace(lib));
  const hit = pairs.find(p =>
    (p.a.id === 'p-split-a' && p.b.id === 'p-split-b') ||
    (p.a.id === 'p-split-b' && p.b.id === 'p-split-a'));
  assert.ok(hit, 'the pair should be reported');
  assert.equal(hit.sharedTracks, 0, 'they share no records');
  assert.equal(hit.verdict, 'indistinguishable',
    'a distinction the library cannot see is the finding worth surfacing');
});

test('boundary tracks are the ones the engine genuinely cannot split', () => {
  const lib = fixture();
  const rows = boundaryTracks(lib, buildSpace(lib), { limit: 20 });
  for (const r of rows) {
    assert.equal(r.between.length, 2);
    assert.ok(r.gap >= 0);
    assert.ok(Array.isArray(r.filedIn));
  }
  // Sorted tightest-first, because that is the order worth asking about.
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i].gap >= rows[i - 1].gap);
});

test('drift compares a bucket\'s newer half with its older half, not with itself', () => {
  const lib = fixture();
  const rows = drift(lib, buildSpace(lib), { recent: 5 });
  for (const r of rows) {
    assert.ok(r.similarity >= 0 && r.similarity <= 1);
    assert.ok(r.older > 0 && r.newer > 0);
  }
});

test('a pile of tracks that fits no bucket is offered as a bucket that does not exist yet', () => {
  const lib = fixture();
  const space = buildSpace(lib);
  // Eight records by artists the library has never seen, all sharing a credit
  // so they hang together.
  const strangers = Array.from({ length: 8 }, (_, i) => ({
    id: `new-${i}`, name: `stranger ${i}`,
    artists: [{ id: 'stranger-1', name: 'Stranger One' }, { id: `stranger-${i + 2}` }],
    albumType: 'single', albumTracks: 2, released: '2024-01-01',
    duration_ms: 360000, popularity: 10,
  }));
  const clusters = unnamedClusters(strangers, space, { minCluster: 5, similarity: 0.3 });
  assert.ok(clusters.length >= 1, 'a coherent pile with no home should surface');
  assert.ok(clusters[0].size >= 5);
});

test('tracks the engine can already place are not offered as a missing bucket', () => {
  const lib = fixture();
  const space = buildSpace(lib);
  // These are squarely inside an existing bucket.
  const clusters = unnamedClusters(lib.playlists[0].tracks.slice(0, 10), space, { minCluster: 3 });
  assert.equal(clusters.length, 0, 'a well-placed track is not evidence of a missing bucket');
});

/* ---------- the weight sweep ---------- */

test('the sweep reports a verdict per weight, and FLAT means the library could not tell', () => {
  const lib = fixture();
  const { rows } = sweepWeights(lib, { folds: 3 });
  assert.equal(rows.length, Object.keys(SWEEP).length);
  for (const r of rows) {
    assert.ok(r.scores.length > 1);
    assert.ok(r.spread >= 0);
    assert.equal(typeof r.verdict, 'string');
    if (r.spread === 0) assert.match(r.verdict, /FLAT/,
      'a weight the data cannot distinguish must say so rather than look validated');
  }
});

test('every sweep includes zero, because "does this earn its place" comes first', () => {
  for (const values of Object.values(SWEEP)) assert.ok(values.includes(0));
});

test('componentValue says what removing each component would cost', () => {
  const lib = fixture();
  const rows = componentValue(lib, { folds: 3 });
  assert.equal(rows.length, Object.keys(WEIGHTS).length);
  for (const r of rows) {
    assert.ok(Number.isFinite(r.costOfRemoving));
    assert.ok(r.withAll >= 0 && r.without >= 0);
  }
  // Sorted by what it costs to remove, so the load-bearing components are first.
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i].costOfRemoving <= rows[i - 1].costOfRemoving);
  }
});

test('dropping the artist graph costs accuracy on a library that has one', () => {
  // If this ever stops being true, the engine is not doing what it claims and
  // the shape features are carrying it.
  const lib = fixture();
  const withGraph = placementAccuracy(lib, { folds: 5 }).top1;
  const without = placementAccuracy(lib, { folds: 5, weights: { ...WEIGHTS, graph: 0 } }).top1;
  assert.ok(withGraph > without,
    `the co-occurrence graph must earn its keep (with ${withGraph}, without ${without})`);
});

/* ---------- the cold-start ladder ---------- */

test('an empty library is rung 0, and says what would change that', () => {
  const space = buildSpace({ playlists: [] });
  const r = rungOf({ playlists: [] }, space);
  assert.equal(r.rung, RUNGS.NOTHING);
  assert.equal(r.destinations, 0);
  assert.match(r.reason, /nowhere to place/);
  assert.match(r.reason, /\d+ tracks/, 'the reason must name the threshold that would be crossed');
});

test('a library whose buckets are all too small is still rung 0', () => {
  // Filed, but nothing filed *enough* — a real and easily-missed case.
  const lib = { playlists: Array.from({ length: 6 }, (_, i) => ({
    id: `p${i}`, name: `p${i}`,
    tracks: [{ id: `t${i}a`, artists: [{ id: `a${i}` }] }, { id: `t${i}b`, artists: [{ id: `a${i}` }] }],
  })) };
  assert.equal(rungOf(lib, buildSpace(lib)).rung, RUNGS.NOTHING);
});

test('a handful of buckets is rung 1: placement runs, but on identity and shape', () => {
  const lib = fixture();
  lib.playlists = lib.playlists.slice(0, 3);
  const r = rungOf(lib, buildSpace(lib));
  assert.equal(r.rung, RUNGS.SPARSE);
  assert.match(r.reason, /bucket/);
  assert.equal(r.mayUseExternalTiebreak, true,
    'at the rungs where the intrinsic gap is arithmetic, an outside source may break ties');
});

test('an established library is above the rungs where an outside source may interfere', () => {
  const lib = fixture();
  // Enough buckets to clear MIN_BUCKETS_FOR_GRAPH, built from the same families
  // so artists genuinely span them.
  for (let i = 0; i < 6; i++) {
    lib.playlists.push({ id: `p-extra-${i}`, name: `Extra ${i}`,
      tracks: lib.playlists[i % 4].tracks.slice(i, i + 7) });
  }
  const r = rungOf(lib, buildSpace(lib));
  assert.ok(r.rung >= RUNGS.WORKING, `expected a working rung, got ${r.rung}: ${r.reason}`);
  assert.equal(r.mayUseExternalTiebreak, false,
    'above the sparse rungs, intrinsic evidence must never be overridden by tags');
});

test('the rung is about evidence, not about how many tracks somebody owns', () => {
  // Thousands of tracks in two buckets tells the engine far less than a few
  // hundred across twenty.
  const big = { playlists: [
    { id: 'p1', name: 'A', tracks: Array.from({ length: 2000 }, (_, i) => ({ id: `x${i}`, artists: [{ id: `ax${i % 50}` }] })) },
    { id: 'p2', name: 'B', tracks: Array.from({ length: 2000 }, (_, i) => ({ id: `y${i}`, artists: [{ id: `ay${i % 50}` }] })) },
  ]};
  assert.equal(rungOf(big, buildSpace(big)).rung, RUNGS.SPARSE,
    '4,000 tracks in two buckets is still a sparse account');
});

test('tag coverage is reported as a number, because it decides how the old engine treats you', () => {
  const lib = fixture();
  const all = {};
  for (const p of lib.playlists) for (const t of p.tracks ?? []) for (const a of t.artists ?? []) {
    all[a.id] = { tags: [['x', 100]] };
  }
  const full = tagCoverage(lib, all);
  assert.equal(full.share, 1);
  assert.equal(full.missing.length, 0);

  const none = tagCoverage(lib, {});
  assert.equal(none.share, 0);
  assert.ok(none.artists > 0);
  assert.ok(none.missing.length > 0, 'and it names who is missing, so the gap is actionable');
});

test('at rung 0 the engine proposes buckets instead of pretending to file', () => {
  const tracks = [
    ...Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, name: `prolific ${i}`,
      artists: [{ id: 'busy', name: 'Busy Producer' }], duration_ms: 400000,
      albumType: 'single', released: '2022-01-01', isrc: 'GBAAA2200001' })),
    ...Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, name: `short ${i}`,
      artists: [{ id: `one-off-${i}`, name: `One Off ${i}` }], duration_ms: 180000,
      albumType: 'album', released: '1998-01-01' })),
  ];
  const out = proposeBuckets(tracks);
  assert.ok(out.length >= 2, 'both an artist group and a shape group should surface');

  const byArtist = out.find(p => p.kind === 'artist');
  assert.equal(byArtist.label, 'Busy Producer');
  assert.equal(byArtist.size, 6);
  assert.ok(byArtist.labels.includes('GBAAA'), 'a shared label family is worth showing');

  const byShape = out.find(p => p.kind === 'shape');
  assert.ok(byShape, 'records by artists with too little history still group by shape');
  assert.match(byShape.label, /short|album|unknown/);
});

test('a proposal too small to be a bucket is not offered as one', () => {
  const out = proposeBuckets([
    { id: 'a', artists: [{ id: 'x' }], duration_ms: 200000 },
    { id: 'b', artists: [{ id: 'y' }], duration_ms: 200000 },
  ], { minProposal: 4 });
  assert.equal(out.length, 0);
});

/* ---------- the bonus layer, and the guard that keeps it one ---------- */

test('THE BONUS GUARD: a track the file does not know gets byte-identical output', () => {
  // This is the contract. CLAUDE.md requires external enrichment to be
  // "silently absent and zero-cost for anyone who doesn't have it", and most
  // people will never export a Rekordbox library. Without this test, the bonus
  // layer is exactly the dependency that rule forbids.
  const lib = fixture();

  // Tempo and key for the deep family only. Every tech, jungle and ambient
  // track is unknown to the file.
  const rb = {};
  for (const t of lib.playlists.find(p => p.id === 'p-deep').tracks) {
    rb[t.id] = { bpm: 124, key: 'Am', camelot: '8A' };
  }

  const without = buildSpace(lib);
  const withFile = buildSpace(lib, { rekordbox: rb });
  assert.ok(withFile.bonus.size > 0, 'the fixture must actually exercise the layer');

  const strip = o => JSON.parse(JSON.stringify(o));
  for (const fam of ['tech', 'jungle', 'ambient']) {
    for (const t of lib.playlists.find(p => p.id === `p-${fam}`).tracks) {
      assert.ok(!rb[t.id], 'precondition: this track is not in the file');
      assert.deepEqual(
        strip(placements(t, withFile)),
        strip(placements(t, without)),
        `${t.id} is not in the Rekordbox file, so loading it must change nothing at all`,
      );
    }
  }
});

test('with no file at all the layer is not merely quiet, it is absent', () => {
  const lib = fixture();
  const space = buildSpace(lib);
  assert.equal(space.bonus.size, 0);
  for (const d of space.destinations.values()) {
    assert.equal(d.bonusProfile, null, 'no file means no per-bucket tempo shape is even computed');
  }
  assert.deepEqual(bonusScores(lib.playlists[0].tracks[0], null, space.bonus), { bpm: null, key: null });
});

test('a malformed or missing rekordbox file is the ordinary case, not an error', () => {
  for (const bad of [null, undefined, 'nonsense', 42, [], { x: null }, { y: 'no' }, { z: {} }]) {
    const idx = bonusIndex(bad);
    assert.equal(idx.size, 0, `bonusIndex(${JSON.stringify(bad)}) should be empty, not throw`);
  }
  // A row with a usable bpm but no key is still worth keeping.
  assert.equal(bonusIndex({ t1: { bpm: 128 } }).size, 1);
  assert.equal(bonusIndex({ t1: { bpm: -1, camelot: null } }).size, 0);
});

test('the Camelot wheel mixes the way a DJ expects, and wraps', () => {
  assert.equal(keyCompatibility('8A', '8A'), KEY_MATCH.same);
  assert.equal(keyCompatibility('8a', '8B'), KEY_MATCH.relative, 'relative major/minor, and case is cosmetic');
  assert.equal(keyCompatibility('8A', '9A'), KEY_MATCH.adjacent);
  assert.equal(keyCompatibility('12A', '1A'), KEY_MATCH.adjacent, 'the wheel wraps at 12');
  assert.equal(keyCompatibility('8A', '2A'), KEY_MATCH.clash);
  assert.equal(keyCompatibility('8A', 'nonsense'), null, 'unreadable is null, never a clash');
});

test('half and double time are not treated as a tempo match', () => {
  // The arithmetic works and the records do not belong together; a 140 bpm
  // track is not at home in a 70 bpm bucket.
  const prof = { n: 10, bpmCount: 10, bpm: { mean: 70 }, keys: new Map(), keyCount: 0 };
  const bonus = bonusIndex({ t: { bpm: 140 } });
  const { bpm } = bonusScores({ id: 't' }, prof, bonus);
  assert.ok(bpm !== null);
  assert.ok(bpm < 0.1, `double time should score near zero, got ${bpm}`);
});

test('a bucket with too little tempo data does not get to judge on it', () => {
  const lib = fixture();
  const deep = lib.playlists.find(p => p.id === 'p-deep');
  // Only two known tracks — below MIN_KNOWN.
  const rb = { [deep.tracks[0].id]: { bpm: 124, camelot: '8A' },
               [deep.tracks[1].id]: { bpm: 125, camelot: '8A' } };
  const space = buildSpace(lib, { rekordbox: rb });
  const prof = space.destinations.get('p-deep').bonusProfile;
  assert.ok(prof.n < MIN_KNOWN);
  assert.deepEqual(bonusScores(deep.tracks[0], prof, space.bonus), { bpm: null, key: null },
    'three records is a coincidence, not a tempo');
});

test('where the file DOES cover both sides, tempo and key actually contribute', () => {
  // The layer has to be capable of mattering, or the guard above is trivially
  // satisfied by a feature that never does anything.
  const lib = fixture();
  const deep = lib.playlists.find(p => p.id === 'p-deep');
  const rb = {};
  for (const t of deep.tracks) rb[t.id] = { bpm: 124, camelot: '8A' };
  const space = buildSpace(lib, { rekordbox: rb });
  const out = placements(deep.tracks[3], space, { limit: 1 });
  assert.ok('bpm' in out.results[0].parts || 'key' in out.results[0].parts,
    'a track the file knows, against a bucket it knows, must be judged on tempo or key');
});

/* ---------- caching the space ---------- */

test('a revived space produces identical placements to the one it was built from', () => {
  // The whole point: the phone must be able to skip the expensive build without
  // getting different answers for having done so.
  const lib = fixture();
  const built = buildSpace(lib);
  const revived = reviveSpace(JSON.parse(JSON.stringify(serialiseSpace(built, lib))), lib);
  assert.ok(revived, 'a fresh cache must revive');

  const strip = o => JSON.parse(JSON.stringify(o));
  for (const p of lib.playlists) {
    for (const t of p.tracks ?? []) {
      assert.deepEqual(strip(placements(t, revived, { why: true })),
                       strip(placements(t, built, { why: true })),
                       `${t.id} must place identically from a cache`);
    }
  }
});

test('a cache survives the round trip a browser would put it through', () => {
  const lib = fixture();
  const json = serialiseSpace(buildSpace(lib), lib);
  // structuredClone is what IndexedDB does; JSON is what a file does. Both.
  assert.ok(reviveSpace(structuredClone(json), lib));
  assert.ok(reviveSpace(JSON.parse(JSON.stringify(json)), lib));
});

test('a cache built from a different library is refused', () => {
  const lib = fixture();
  const json = serialiseSpace(buildSpace(lib), lib);

  const changed = fixture();
  changed.playlists[0].tracks = changed.playlists[0].tracks.slice(0, 10);
  assert.equal(reviveSpace(json, changed), null,
    'filing three tracks changes the graph; serving yesterday\'s answers is a bug nobody can see');
});

test('a cache written by a different engine version is refused', () => {
  const lib = fixture();
  const json = serialiseSpace(buildSpace(lib), lib);
  assert.equal(reviveSpace({ ...json, stamp: 'something-else' }, lib), null);
});

test('a malformed cache is refused rather than half-revived', () => {
  const lib = fixture();
  for (const bad of [null, undefined, 'nonsense', 42, {}, { stamp: ENGINE_STAMP }]) {
    assert.equal(reviveSpace(bad, lib), null, `${JSON.stringify(bad)} should be refused`);
  }
});

test('the fingerprint tracks what the engine reads, and ignores what it does not', () => {
  const a = fixture();
  const b = fixture();
  assert.equal(fingerprint(a), fingerprint(b), 'the same library fingerprints the same');

  // Noise the engine never reads must not invalidate a cache, or it is never used.
  const noisy = fixture();
  noisy.captured_at = new Date().toISOString();
  for (const t of noisy.playlists[0].tracks) t.popularity = (t.popularity ?? 0) + 1;
  assert.equal(fingerprint(noisy), fingerprint(a),
    'a drifting popularity score must not throw away an otherwise valid cache');

  // Membership must.
  const moved = fixture();
  moved.playlists[0].tracks.pop();
  assert.notEqual(fingerprint(moved), fingerprint(a));
});

test('fingerprinting does not depend on the order things happen to be in', () => {
  const a = fixture();
  const b = fixture();
  b.playlists.reverse();
  for (const p of b.playlists) p.tracks.reverse();
  assert.equal(fingerprint(a), fingerprint(b),
    'a reordered library is the same library');
});
