// Listening-weighted enrichment (BUILD-6 D9): the tag-gap fill, Wikidata's
// genres and the similar-artist lookups ask about the artists this account
// plays most first, by analysisPriority (core/personal/relevance.mjs
// enrichOrder). The number: the share of the top-100 listened artists covered
// after the first N requests at the page's real pacing, before (origin/main's
// order) and after, on the non-owner fixtures with synthetic listening. With
// no listening data every order is exactly what it was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { enrichOrder, listenedWeights, analysisPriority } from '../core/personal/relevance.mjs';
import { makeAccount } from './fixtures/accounts.mjs';
import { makeListening, withUniqueNames } from './fixtures/listening.mjs';
import * as SIM from './fixtures/enrich-sim.mjs';

/* ---------- the ordering itself ---------- */

const W = new Map([['Played', 3], ['Sometimes', 0.5]]);

test('no listening weights: the entries come back exactly as they went in', () => {
  const e = [['a', 'X'], ['b', 'Played'], ['c', 'Y']];
  for (const weights of [null, undefined, new Map()]) {
    const out = enrichOrder(e, { weights });
    assert.deepEqual(out, e);
    assert.notEqual(out, e, 'a copy, never the caller\'s array');
  }
  assert.equal(listenedWeights(null), null);
  assert.equal(listenedWeights({ topWindows: [], recentArtists: [] }), null);
  assert.equal(listenedWeights({ topWindows: [{ weight: 3, items: [] }], recentArtists: [] }), null);
});

test('most-listened first, the rest in the order they came', () => {
  const out = enrichOrder([['a', 'X'], ['b', 'Sometimes'], ['c', 'Y'], ['d', 'Played']], { weights: W });
  assert.deepEqual(out.map(([id]) => id), ['d', 'b', 'a', 'c']);
});

test('at equal listening, an artist with no tags goes before one with a thin answer', () => {
  const tags = { a: 2, b: 0, c: 5 };
  const out = enrichOrder([['a', 'Played'], ['b', 'Played'], ['c', 'Played']], { weights: W, tagCount: id => tags[id] });
  assert.deepEqual(out.map(([id]) => id), ['b', 'a', 'c']);
});

test('it is analysisPriority, per artist', () => {
  const p = name => analysisPriority({ profile: { genre: { confidence: 'INSUFFICIENT_DATA' } } },
                                     { weights: W, track: { id: 'x', artists: [{ name }] } });
  assert.ok(p('Played') > p('Sometimes') && p('Sometimes') > p('Nobody'));
});

test('a bridge Map entry works with a name reader', () => {
  const m = new Map([['a', { name: 'X' }], ['b', { name: 'Played' }]]);
  assert.deepEqual(enrichOrder(m, { weights: W, nameOf: ([, v]) => v.name }).map(([id]) => id), ['b', 'a']);
});

test('listening weights carry no library floor', () => {
  const w = listenedWeights({ topWindows: [{ weight: 3, items: ['A', 'B'] }], recentArtists: ['C'] });
  assert.deepEqual([...w.keys()].sort(), ['A', 'B', 'C']);
});

/* ---------- the number, on the fixtures ---------- */

const KINDS = ['typical', 'large'], SEEDS = [7, 8, 9];
const PER = SIM.perWindow();
const RUNS = [
  // name, order, requests in the window (artists asked about)
  ['Last.fm, 5 minutes', SIM.lastfmOrder, () => PER.lastfm],
  ['Last.fm, first 100 requests', SIM.lastfmOrder, () => 100],
  ['Wikidata, first request (300)', SIM.wikidataOrder, () => 300],
  ['Score lookups, 5 minutes', SIM.scoreBridgeOrder, order => PER.deezer(order.length)],
  ['File lookups, 5 minutes', SIM.blendBridgeOrder, order => PER.deezer(order.length)],
];

/** { run: { kind: [before, after] averaged over seeds } } */
function measure() {
  const out = {};
  for (const [name, fn, nOf] of RUNS) for (const kind of KINDS) {
    let b = 0, a = 0;
    for (const seed of SEEDS) {
      const lib = withUniqueNames(makeAccount(kind)), raw = makeListening(lib, seed), top = SIM.topListened(lib, raw);
      // An account the shipped table does not cover: every artist is a gap.
      const before = fn(lib, raw, {}, { after: false }), after = fn(lib, raw, {}, { after: true });
      b += SIM.coveredShare(before, top, nOf(before)); a += SIM.coveredShare(after, top, nOf(after));
    }
    (out[name] ??= {})[kind] = [Math.round(10 * b / SEEDS.length) / 10, Math.round(10 * a / SEEDS.length) / 10];
  }
  return out;
}
const M = measure();

test('the number: top-100 listened artists covered, before vs after', t => {
  t.diagnostic(`pacing: Last.fm ${PER.lastfm} artists / 5 min; Wikidata 300 per request; Deezer ${PER.deezer(600)} artists / 5 min (latency ${JSON.stringify(SIM.LATENCY)})`);
  for (const [name, byKind] of Object.entries(M))
    t.diagnostic(`${name}: ${Object.entries(byKind).map(([k, [b, a]]) => `${k} ${b}% -> ${a}%`).join(', ')}`);
  for (const [name, byKind] of Object.entries(M))
    for (const [kind, [b, a]] of Object.entries(byKind)) assert.ok(a >= b, `${name}, ${kind}: ${b}% -> ${a}% must not get worse`);
});

test('bar: after five minutes, every one of the top-100 listened artists has been asked about', () => {
  for (const name of ['Last.fm, 5 minutes', 'Score lookups, 5 minutes', 'File lookups, 5 minutes'])
    for (const kind of KINDS) assert.equal(M[name][kind][1], 100, `${name}, ${kind}`);
});

test('bar: the first answers go to what you play (the gain this holds)', () => {
  for (const kind of KINDS) {
    const [b, a] = M['Last.fm, first 100 requests'][kind];
    assert.ok(a >= 99 && a > b, `Last.fm first 100 requests, ${kind}: ${b}% -> ${a}%`);
    const [wb, wa] = M['Wikidata, first request (300)'][kind];
    assert.ok(wa === 100 && wa - wb >= 40, `Wikidata first request, ${kind}: ${wb}% -> ${wa}%`);
  }
  const [sb, sa] = M['Score lookups, 5 minutes'].typical;
  assert.ok(sa > sb, `Score lookups, typical: ${sb}% -> ${sa}%`);
});

test('control: adding analysisPriority\'s reach term would have cost the listened artists', () => {
  // Why enrichOrder leaves reach out: measured here, not assumed.
  const lib = withUniqueNames(makeAccount('large')), raw = makeListening(lib, 7), top = SIM.topListened(lib, raw);
  const reach = new Map();
  for (const p of lib.playlists) for (const id of new Set(p.tracks.flatMap(t => t.artists.map(a => a.id)))) reach.set(id, (reach.get(id) ?? 0) + 1);
  const weights = listenedWeights(raw);
  const base = SIM.lastfmOrder(lib, raw, {}, { after: false });
  const withReach = base.map((e, i) => [e, i, analysisPriority({ profile: { genre: { confidence: 'INSUFFICIENT_DATA' } } },
    { weights, reach, track: { id: e[0], artists: [{ name: e[1] }] } })]).sort((a, b) => b[2] - a[2] || a[1] - b[1]).map(x => x[0]);
  const without = SIM.lastfmOrder(lib, raw, {}, { after: true });
  assert.ok(SIM.coveredShare(withReach, top, 100) < SIM.coveredShare(without, top, 100));
});

test('byte-identical with no listening data: every run asks in exactly the order it did', () => {
  const none = { topWindows: [], recentArtists: [], topTracks: [], recentTracks: [] };
  for (const kind of ['small', 'typical', 'large']) {
    const lib = makeAccount(kind);
    for (const [, fn] of RUNS) assert.deepEqual(fn(lib, none, {}, { after: true }), fn(lib, none, {}, { after: false }), kind);
  }
});

/* ---------- the page ---------- */

const PAGE = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
const between = (from, to) => { const i = PAGE.indexOf(from), j = PAGE.indexOf(to, i); assert.ok(i > 0 && j > i, `${from} — rebuild`); return PAGE.slice(i, j); };
const ENRICH = between('/* Listening-weighted enrichment', '/** Fill tag gaps');

function pageOrder(listening) {
  const box = { enrichOrder, listenedWeights, TAGS: { b: { tags: [['x', 50]] } },
    idb: { get: async k => (k === 'listening_raw' && listening ? { at: 1, data: listening } : undefined) } };
  vm.createContext(box);
  vm.runInContext(ENRICH, box);
  return box;
}

test('the page reads the listening it already kept, and fetches nothing for this', () => {
  assert.ok(!/\bsp\(|fetch\(/.test(ENRICH), 'no request in the ordering');
  assert.match(ENRICH, /idb\.get\('listening_raw'\)/);
});

test('the page: no listening kept, the order is untouched; with it, played first', async () => {
  const e = [['a', 'X'], ['b', 'Y'], ['c', 'Played']];
  const own = x => JSON.parse(JSON.stringify(x));   // built in the vm: brought home to compare
  assert.deepEqual(own(await pageOrder(null).inEnrichOrder(e)), e);
  assert.deepEqual(own(await pageOrder({ topWindows: [], recentArtists: [] }).inEnrichOrder(e)), e);
  const box = pageOrder({ topWindows: [{ weight: 3, items: ['Played'] }], recentArtists: [] });
  assert.deepEqual(own((await box.inEnrichOrder(e)).map(([id]) => id)), ['c', 'a', 'b']);
  const throws = { enrichOrder, listenedWeights, TAGS: {}, idb: { get: async () => { throw new Error('blocked'); } } };
  vm.createContext(throws); vm.runInContext(ENRICH, throws);
  assert.deepEqual(own(await throws.inEnrichOrder(e)), e, 'storage blocked: order untouched');
});

test('the page runs all four request loops through it', () => {
  const uses = between('/* Listening-weighted enrichment', '</script>').match(/await inEnrichOrder\(/g) ?? [];
  assert.ok(uses.length >= 4, `${uses.length} uses`);
  assert.match(between('async function enrichMissing', 'async function fillFromWikidata'), /todo = await inEnrichOrder\(todo\)/);
  assert.match(between('async function fillFromWikidata', '/* ---------- the neighbour bridge'), /inEnrichOrder\(/);
  assert.match(between('async function engineBridge', 'const engineValidate'), /inEnrichOrder\(BetterfyBridge\.sourceArtists\(tracks\)/);
  assert.match(between('async function blendFetch', 'function blendTags'), /inEnrichOrder\(BetterfyBridge\.sourceArtists\(tracks\)/);
});
