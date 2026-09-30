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
import { readFileSync } from 'node:fs';
import { placementAccuracy } from './core/validate/loo.mjs';
import { baselineAccuracy } from './core/validate/baseline.mjs';
import { cooccurrence } from './core/intrinsic/cooccurrence.mjs';
import { registrantIndex } from './core/intrinsic/features.mjs';
import { buildSpace } from './core/intrinsic/space.mjs';
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

console.log('\n=== HELD-OUT PLACEMENT ACCURACY ===\n');
console.log(`  ${folds}-fold. Each track is scored against a library that never saw it.`);
console.log('  Truth is the set of buckets it really lives in, so being right about');
console.log('  either of two legitimate homes counts as right.\n');

const mine = placementAccuracy(lib, { folds, limit });

let tags = null;
try { tags = loadTags(); } catch { /* no caches: v1 simply cannot be scored */ }
const base = tags && Object.keys(tags).length
  ? baselineAccuracy(lib, tags, { folds })
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
