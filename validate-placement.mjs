// Does the account-native engine actually beat the tag engine on YOUR library?
//
// This is Phase 0's gate, and it is meant to be able to fail. If the intrinsic
// signals do not match or beat v1 here, the right move is to stop and re-plan
// rather than build five more phases on a premise that did not hold — see
// docs/THINKING-ENGINE-PLAN.md §8.
//
// Nothing here touches the network, writes to a cache, or needs a key. It reads
// library.json and, if you have them, your existing tag caches.
//
//   npm run validate:placement
//   npm run validate:placement -- --folds=10 --limit=2000
//   npm run validate:placement -- --reports   what it sees in your library
//   npm run validate:placement -- --sweep     which weights the library constrains
import { readFileSync } from 'node:fs';
import { placementAccuracy } from './core/validate/loo.mjs';
import { baselineAccuracy } from './core/validate/baseline.mjs';
import { cooccurrence } from './core/intrinsic/cooccurrence.mjs';
import { registrantIndex } from './core/intrinsic/features.mjs';
import { buildSpace, placements } from './core/intrinsic/space.mjs';
import { bucketPairs, boundaryTracks, drift, unnamedClusters } from './core/intrinsic/reports.mjs';
import { sweepWeights, componentValue } from './core/intrinsic/fit.mjs';
import { summarise } from './core/intrinsic/explain.mjs';
import { rungOf, RUNGS, tagCoverage, proposeBuckets } from './core/intrinsic/coldstart.mjs';
import { loadTags } from './tagstore.mjs';

const arg = (name, fallback) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : fallback;
};

const folds = arg('folds', 5);
const limit = arg('limit', null);

let lib;
try {
  lib = JSON.parse(readFileSync('library.json', 'utf8'));
} catch {
  console.error('No library.json. Run `npm run snapshot` first — this reads it and nothing else.');
  process.exit(1);
}

const pct = v => (v === null || v === undefined ? '    —' : (v * 100).toFixed(1).padStart(5));

/* ---------- what the account actually gives the engine ---------- */

const graph = cooccurrence(lib);
const regs = registrantIndex(lib);
const space = buildSpace(lib);

let tags = null;
try { tags = loadTags(); } catch { /* no caches: v1 simply cannot be scored */ }

const distinct = new Set();
for (const p of lib.playlists ?? []) for (const t of p.tracks ?? []) if (t?.id) distinct.add(t.id);

console.log('\n=== WHAT THIS ACCOUNT GIVES THE ENGINE, WITH NOTHING CONFIGURED ===\n');
console.log(`  playlists in the graph     ${String(graph.playlists).padStart(6)}`);
console.log(`  filing destinations        ${String(space.destinations.size).padStart(6)}   (non-mirror, enough members to have a meaning)`);
console.log(`  distinct filed tracks      ${String(distinct.size).padStart(6)}`);
console.log(`  artists with a neighbourhood ${String(graph.artists).padStart(4)}   of ${graph.df.size} seen`);
console.log(`  artist pairs considered    ${String(graph.pairsConsidered).padStart(6)}`);
if (graph.wideSkipped) {
  console.log(`  very broad playlists       ${String(graph.wideSkipped).padStart(6)}   counted for frequency, not for pairs`);
}
console.log(`  label registrants          ${String(regs.span.size).padStart(6)}`);

// An artist seen in only one playlist contributes no co-occurrence evidence. If
// that is most of the library, the graph is thin and the engine is leaning on
// shape — which is worth knowing before reading any accuracy number below.
const loners = [...graph.df.values()].filter(n => n < 2).length;
if (graph.df.size) {
  const share = loners / graph.df.size;
  console.log(`  artists in one bucket only ${String(loners).padStart(6)}   ${(share * 100).toFixed(0)}% — these carry no co-occurrence evidence`);
  if (share > 0.8) {
    console.log('\n  NOTE: almost every artist here lives in exactly one bucket, so the');
    console.log('  artist graph is nearly empty and the numbers below are mostly shape.');
  }
}

/* ---------- the gate ---------- */

/* ---------- which rung this account is on ---------- */

// Printed before any accuracy number, because it decides how to read them. A
// confidence tells you how sure the engine is; a rung tells you what would make
// it surer, and only the second is actionable.
const rung = rungOf(lib, space);
console.log(`\n=== WHERE THIS ACCOUNT STANDS: ${rung.name.toUpperCase()} (rung ${rung.rung}/3) ===\n`);
console.log(`  ${rung.reason}.`);
if (rung.rung === RUNGS.NOTHING) {
  console.log('\n  So the engine will not suggest placements: there is nowhere to place');
  console.log('  anything, and answering a question that is not well-posed is how an');
  console.log('  empty account gets shown confident nonsense. What it can do is group');
  console.log('  what you already have, for you to name:\n');
  const liked0 = (lib.liked ?? []).filter(t => t?.id);
  for (const p of proposeBuckets(liked0)) {
    console.log(`    ${String(p.size).padStart(4)}  ${p.kind.padEnd(7)} ${p.label}`);
    console.log(`          e.g. ${p.examples.slice(0, 2).map(e => e.name ?? e.id).join(', ')}`);
  }
  console.log('\n  Nothing below this line will mean much until some of that is filed.');
} else if (rung.mayUseExternalTiebreak) {
  console.log('\n  At this rung an outside tag source is allowed to break ties, labelled as');
  console.log('  doing so. Above it, intrinsic evidence is never overridden by tags.');
}

// The single best predictor of how the OLD engine treats a given listener, and
// until now computed nowhere they could see.
if (tags && Object.keys(tags).length) {
  const cov = tagCoverage(lib, tags);
  console.log(`\n  tag-table coverage: ${cov.covered}/${cov.artists} of your artists `
    + `(${cov.share === null ? '—' : (cov.share * 100).toFixed(0)}%)`);
  if (cov.share !== null && cov.share < 0.5) {
    console.log('  Under half. The tag engine is working from very little for this account,');
    console.log("  which is what the shipped table being one library's taste looks like");
    console.log('  from the outside.');
  }
}

console.log('\n=== HELD-OUT PLACEMENT ACCURACY ===\n');
console.log(`  ${folds}-fold. Each track is scored against a library that never saw it.`);
console.log('  Truth is the set of buckets it really lives in, so being right about');
console.log('  either of two legitimate homes counts as right.\n');

const mine = placementAccuracy(lib, { folds, limit });
// `limit` goes to both sides or the comparison is not one: without it here, a
// `--limit=2000` run scored the intrinsic engine on 2,000 tracks and v1 on the
// whole library, and printed the two numbers side by side as though they were
// measured on the same thing.
const base = tags && Object.keys(tags).length
  ? baselineAccuracy(lib, tags, { folds, limit })
  : null;

console.log('  engine                     top-1   top-3   scored');
console.log('  ' + '-'.repeat(52));
console.log(`  intrinsic (account-native) ${pct(mine.top1)}%  ${pct(mine.top3)}%  ${String(mine.scored).padStart(6)}`);
if (base) {
  console.log(`  v1 (Last.fm tag vectors)   ${pct(base.top1)}%  ${pct(base.top3)}%  ${String(base.scored).padStart(6)}`);
  if (base.noAnswer) {
    console.log(`\n  v1 returned nothing at all for ${base.noAnswer} tracks — counted as misses,`);
    console.log('  because a filing tool that returns nothing has not filed anything.');
  }
} else {
  console.log('  v1 (Last.fm tag vectors)       —       —       —   no tag cache found');
}

console.log('\n  bands, with their own accuracy — confidence you can check rather than trust:');
for (const [band, v] of Object.entries(mine.bands)) {
  console.log(`    ${band.padEnd(18)} n=${String(v.n).padStart(5)}   ${pct(v.accuracy)}%`);
}
if (mine.declined) {
  console.log(`\n  declined ${mine.declined}, of which ${mine.declinedWouldHaveBeenRight} would have been right —`);
  console.log('  a refusal that would have been correct is a cost, not a virtue.');
}

/* ---------- the canary ---------- */

const leaky = placementAccuracy(lib, { leaky: true, limit });
console.log('\n=== THE CANARY ===\n');
console.log(`  Scored against a library that HAS seen each track: ${pct(leaky.top1)}%`);
console.log(`  Scored honestly:                                   ${pct(mine.top1)}%`);
if (leaky.top1 !== null && mine.top1 !== null && leaky.top1 <= mine.top1) {
  console.log('\n  WARNING: the leaky path did not score better than the honest one.');
  console.log('  Either this library has no memorisable structure, or the fold');
  console.log('  machinery has stopped excluding held-out tracks — in which case');
  console.log('  every number above is fiction. Do not act on this run.');
} else {
  console.log('\n  A gap is what proves the exclusion is real.');
}

/* ---------- where it struggles ---------- */

console.log('\n=== BUCKETS IT UNDERSTANDS LEAST ===\n');
console.log('  Ranked by how often the bucket is offered at all, which is fair to a');
console.log('  bucket that is a view of others — such a bucket can never rank first');
console.log('  against the tighter one its tracks also live in.\n');
const named = new Map((lib.playlists ?? []).map(p => [p.id, p.name]));
console.log('  bucket                             n   offered  first  alone');
console.log('  ' + '-'.repeat(60));
for (const p of mine.worstPlaylists) {
  const name = String(named.get(p.id) ?? p.id).slice(0, 30).padEnd(32);
  console.log(`  ${name}${String(p.n).padStart(4)}  ${pct(p.inTop3)}% ${pct(p.rank1)}% ${pct(p.exclusive)}%`);
}

/* ---------- the verdict ---------- */

console.log('\n=== GATE ===\n');
if (!base) {
  console.log('  Undecided. Without a tag cache there is no v1 column to beat, so this');
  console.log('  run cannot answer the question Phase 0 exists to ask. Run');
  console.log('  `npm run enrich` first, or accept that the comparison is untested.');
} else if (mine.top1 >= base.top1) {
  const by = ((mine.top1 - base.top1) * 100).toFixed(1);
  console.log(`  PASS. The account-native engine matches or beats v1 by ${by} points,`);
  console.log('  using no key, no second website and nobody else\'s opinion.');
} else {
  const by = ((base.top1 - mine.top1) * 100).toFixed(1);
  console.log(`  FAIL. v1 is ahead by ${by} points. Per the plan, the right response is`);
  console.log('  to stop and re-plan rather than build further phases on this premise.');
  console.log('  Read the bucket table above first: a single pathological bucket, or a');
  console.log('  nearly empty artist graph, is a different problem from the approach');
  console.log('  being wrong.');
}
console.log();


/* ---------- what the account's own structure says about itself ---------- */

if (process.argv.includes('--reports')) {
  console.log('\n=== BUCKETS THAT MAY BE THE SAME THING TWICE ===\n');
  const pairs = bucketPairs(space);
  if (!pairs.length) {
    console.log('  None. Every bucket holds different records and sits somewhere different.');
  } else {
    console.log('  view              one bucket is largely contained in the other');
    console.log('  indistinguishable different records, same place in your library\n');
    for (const p of pairs.slice(0, 15)) {
      console.log(`  ${String(p.verdict).padEnd(18)} ${String(p.a.name ?? p.a.id).slice(0, 24).padEnd(26)}`
        + `${String(p.b.name ?? p.b.id).slice(0, 24).padEnd(26)} sim ${p.similarity.toFixed(2)}  shared ${p.sharedTracks}`);
    }
    console.log('\n  "indistinguishable" is the one worth reading: you keep those apart and');
    console.log('  they hold different records, but nothing in your library separates them.');
    console.log('  Either the distinction lives somewhere this cannot see, or it has');
    console.log('  quietly stopped being one. Only you can say which.');
  }

  console.log('\n=== TRACKS ON A BORDER ===\n');
  console.log('  The engine cannot split these. They are the best things to be asked about:');
  console.log('  answering one settles a boundary rather than a single record.\n');
  const edge = boundaryTracks(lib, space, { limit: 12 });
  for (const b of edge) {
    const who = b.artists.slice(0, 2).join(', ');
    console.log(`  ${String(b.name ?? b.trackId).slice(0, 30).padEnd(32)} ${who.slice(0, 22).padEnd(24)}`
      + `${String(b.between[0].name ?? b.between[0].id).slice(0, 16)} / ${String(b.between[1].name ?? b.between[1].id).slice(0, 16)}`);
  }
  if (!edge.length) console.log('  None — every track has a clear leader.');

  console.log('\n=== BUCKETS DRIFTING FROM THEMSELVES ===\n');
  const moved = drift(lib, space).slice(0, 10);
  for (const d of moved) {
    console.log(`  ${String(d.name ?? d.id).slice(0, 30).padEnd(32)} newer ${String(d.newer).padStart(3)} vs older ${String(d.older).padStart(4)}`
      + `   similarity ${d.similarity.toFixed(2)}`);
  }
  if (!moved.length) console.log('  Nothing with enough dated history to judge.');
  else console.log('\n  Low similarity is not automatically wrong — taste moves. It is worth');
  console.log('  saying, because otherwise the engine keeps filing into what the bucket was.');

  const liked = (lib.liked ?? []).filter(t => t?.id);
  if (liked.length) {
    console.log('\n=== PILES WITH NO BUCKET ===\n');
    const clusters = unnamedClusters(liked, space, { limit: 6 });
    for (const c of clusters) {
      console.log(`  ${c.size} tracks — e.g. ${c.tracks.slice(0, 3).map(t => t.name ?? t.id).join(', ')}`);
    }
    if (!clusters.length) console.log('  None big enough to be a missing bucket.');
  }

  // One worked example, because a table of numbers does not show whether the
  // reasoning is any good.
  const sample = (lib.playlists ?? []).flatMap(p => p.tracks ?? []).find(t => t?.id);
  if (sample) {
    const r = placements(sample, space, { why: true, limit: 1 });
    if (r.results?.[0]?.why?.length) {
      console.log('\n=== ONE PLACEMENT, EXPLAINED ===\n');
      console.log(`  ${sample.name ?? sample.id} -> ${r.results[0].name ?? r.results[0].playlistId}`);
      for (const l of r.results[0].why) console.log(`    ${l.mark} ${l.text}`);
    }
  }
}

/* ---------- which numbers the library actually pins down ---------- */

if (process.argv.includes('--sweep')) {
  console.log('\n=== WHAT REMOVING EACH COMPONENT WOULD COST ===\n');
  console.log('  Asked before the sweep on purpose: "best at 0.1" invites tuning, while');
  console.log('  "removing it entirely costs nothing" invites deleting it, which is');
  console.log('  usually the better answer and never the one a sweep volunteers.\n');
  for (const c of componentValue(lib, { folds, limit })) {
    const verdict = c.costOfRemoving > 0.005 ? 'earns its place'
                  : c.costOfRemoving < -0.005 ? 'ACTIVELY HURTS — consider removing'
                  : 'costs nothing to remove';
    console.log(`  ${c.name.padEnd(12)} ${pct(c.withAll)}% -> ${pct(c.without)}%   ${verdict}`);
  }

  console.log('\n=== WEIGHT SWEEP, AGAINST YOUR OWN FILING ===\n');
  process.stderr.write('  (sweeping');
  const { rows } = sweepWeights(lib, { folds, limit, onStep: () => process.stderr.write('.') });
  process.stderr.write(')\n');
  console.log('  weight       current  best   verdict');
  console.log('  ' + '-'.repeat(64));
  for (const r of rows) {
    console.log(`  ${r.name.padEnd(12)} ${String(r.current).padStart(6)}  ${String(r.best).padStart(5)}   ${r.verdict}`);
  }
  console.log('\n  FLAT means this library could not tell any value in the range apart —');
  console.log('  a statement about the evidence, never about the number being fine.');
}
