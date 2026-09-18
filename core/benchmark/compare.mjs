// v1 against v3, on the same evidence — Task 11.
//
// A fair comparison needs care, because v1 does not produce genre labels at
// all: it produces a ranking of playlists. What it *implicitly* asserts about
// a track is the strongest tag in that track's vector, and that assertion is
// exactly what drives every filing suggestion it makes — so that is what is
// compared here, resolved through the same ontology so the two answers are
// the same kind of thing.
//
// Two further constraints keep it honest:
//
//  - v1 only ever sees artist-level tags, because that is the only thing it
//    has ever fetched. It is not handicapped here by being denied data it
//    would have had; the track-level and release-level evidence v3 uses is
//    data v1 has no mechanism to ask for.
//  - v1 has no way to decline. It always returns its strongest tag. That is
//    not a bug being scored unfairly — it is the property §4.6 exists to fix,
//    and the known-bad half of the benchmark is where it shows up.
import { trackVec, tagGate, gateTags } from '../../profile.mjs';
import { resolveConcept } from '../ontology/index.mjs';
import { CASES } from './fixtures.mjs';
import { evaluate, runBenchmark } from './run.mjs';

/**
 * The artist tag table v1 would have had for a fixture — its caches hold
 * artist clouds keyed by Spotify artist id and nothing else.
 */
export function v1TagsForCase(c) {
  const tags = {};
  for (const e of c.evidence ?? []) {
    if (e.entityType !== 'artist') continue;   // v1 has no other kind
    const list = (e.response?.toptags?.tag ?? [])
      .filter(t => Number(t.count) >= 10)
      .map(t => [String(t.name).toLowerCase(), Number(t.count)]);
    if (!list.length) continue;
    const prev = tags[e.entityId]?.tags ?? [];
    tags[e.entityId] = { tags: [...prev, ...list] };
  }
  return tags;
}

/**
 * The genre v1's model implicitly asserts: the heaviest tag in the track
 * vector, mapped to the ontology so it can be compared with v3's answer.
 *
 * The library-wide tag gate is applied the way tagstore.mjs applies it, but
 * with the gate computed over the benchmark's own tables — a gate needs a
 * library to be computed from, and a per-case gate of one artist would drop
 * everything. This is generous to v1, deliberately.
 */
export function v1Genre(c, gate = null) {
  const tags = v1TagsForCase(c);
  const gated = gate ? gateTags(tags, gate) : tags;
  const v = trackVec(c.track, gated);
  if (!v.size) return { genre: null, tag: null };
  const [tag] = [...v].sort((a, b) => b[1] - a[1])[0];
  const r = resolveConcept(tag);
  return { genre: r.facet === 'genre' ? r.concept : null, tag, facet: r.facet };
}

/** The gate v1 would compute over the whole benchmark treated as one library. */
export function benchmarkGate(cases = CASES) {
  const all = {};
  for (const c of cases) Object.assign(all, v1TagsForCase(c));
  return tagGate(all);
}

export function compare(cases = CASES) {
  const gate = benchmarkGate(cases);
  const v3 = runBenchmark(cases);

  const rows = cases.map(c => {
    const v1 = v1Genre(c, gate);
    const r = v3.results.find(x => x.id === c.id);
    const accept = new Set([c.expectGenre, ...(c.acceptGenre ?? [])].filter(Boolean));
    const known = c.expectGenre !== null;
    return {
      id: c.id,
      known,
      expected: known ? [...accept].join('/') : '(should decline)',
      v1: v1.genre ?? (v1.tag ? `${v1.tag} [${v1.facet}]` : 'nothing'),
      v1Correct: known ? accept.has(v1.genre)
        // v1 cannot decline, so on a known-bad case it is only "right" if it
        // happened to land on one of the defensible readings.
        : (v1.genre === null || accept.has(v1.genre)),
      v3: r.got ?? 'nothing',
      v3Band: r.profile.genre.confidence,
      v3Correct: known ? accept.has(r.got) : r.checks.find(k => k.name === 'declined or hedged').ok,
    };
  });

  const pct = (list, key) => list.length ? +(list.filter(r => r[key]).length / list.length).toFixed(3) : null;
  const good = rows.filter(r => r.known), bad = rows.filter(r => !r.known);
  return {
    rows,
    summary: {
      knownGood: { n: good.length, v1: pct(good, 'v1Correct'), v3: pct(good, 'v3Correct') },
      knownBad: { n: bad.length, v1: pct(bad, 'v1Correct'), v3: pct(bad, 'v3Correct') },
      overall: { n: rows.length, v1: pct(rows, 'v1Correct'), v3: pct(rows, 'v3Correct') },
    },
  };
}

function main() {
  const { rows, summary } = compare();
  console.log('=== v1 (tag vector) vs v3 (evidence engine) ===\n');
  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad('case', 36) + pad('expected', 26) + pad('v1', 22) + pad('v3', 22) + 'band');
  console.log('-'.repeat(120));
  for (const r of rows)
    console.log(pad(r.id, 36) + pad(r.expected, 26)
      + pad(`${r.v1Correct ? ' ' : 'x'} ${r.v1}`, 22)
      + pad(`${r.v3Correct ? ' ' : 'x'} ${r.v3}`, 22) + r.v3Band);
  console.log('\n                      v1      v3');
  for (const [name, s] of Object.entries(summary))
    console.log(`  ${pad(name + ` (n=${s.n})`, 20)}${pad(s.v1, 8)}${s.v3}`);
  console.log('\n  "x" marks a wrong answer. On the known-bad half, v3 is credited for declining;');
  console.log('  v1 has no way to decline, which is the point rather than a scoring quirk.');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
