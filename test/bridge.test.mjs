import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as Deezer from '../core/sources/deezer.mjs';
import * as LB from '../core/sources/listenbrainz.mjs';
import * as WD from '../core/sources/wikidata.mjs';
import { sourceArtists, libraryNames, bridgeFrom, bridgeIndex, artistHomes, bridgeScores,
         BRIDGE_VERSION } from '../core/intrinsic/bridge.mjs';
import { gatherBridge, TTL_MS } from '../core/intrinsic/bridge-fetch.mjs';
import { buildSpace, placements, WEIGHTS } from '../core/intrinsic/space.mjs';
import { placementAccuracy, scoredTracks } from '../core/validate/loo.mjs';

/* ---------- a library where some artists have never been filed ----------
 *
 * Three genre playlists, each built from its own family of artists, so the
 * artist graph separates them. Every playlist also holds four "newcomer"
 * tracks: each by an artist who appears on that one track only. Held out,
 * the graph has nothing on them and every playlist shares one shape, so the
 * engine without a bridge is guessing. With a bridge that names their family's
 * core artists as neighbours, it should not be.
 */
const FAMS = ['jungle', 'garage', 'techno'];
function library() {
  const playlists = [];
  FAMS.forEach((fam, fi) => {
    const core = Array.from({ length: 5 }, (_, i) => ({ id: `${fam}Core${i}`.padEnd(22, 'x'), name: `${fam} core ${i}` }));
    const tracks = [];
    for (let i = 0; i < 16; i++) {
      const newcomer = i >= 12;
      const artists = newcomer
        ? [{ id: `${fam}New${i}`.padEnd(22, 'x'), name: `${fam} newcomer ${i}` }]
        : [core[i % 5], core[(i + 1) % 5]];
      tracks.push({
        id: `${fam}-t${i}`, name: `${fam} ${i}`, artists,
        albumType: 'single', albumTracks: 2, trackNo: 1, released: '2021-01-01',
        duration_ms: 300000, explicit: false, popularity: 40,
        // A newcomer is a self-released one-off on a distributor's code, so the
        // label cannot give the answer away either.
        isrc: newcomer ? `ZZAGG${21 + fi}${String(10000 + i).slice(0, 5)}`
                       : `GB${'ABC'[fi]}XX21${String(10000 + i).slice(0, 5)}`,
        added_at: '2025-01-01T00:00:00Z',
      });
    }
    playlists.push({ id: `p-${fam}`, name: fam, tracks });
  });
  // A crossover playlist so core artists have a document frequency above one.
  playlists.push({ id: 'p-mix', name: 'Mix', tracks: playlists.flatMap(p => p.tracks.slice(0, 3)) });
  return { playlists, liked: [] };
}

/** Raw lookups naming each newcomer's family core as Deezer neighbours. */
function rawFor(lib) {
  const raw = {};
  for (const p of lib.playlists.filter(p => p.id !== 'p-mix')) {
    const fam = p.name;
    for (const t of p.tracks.filter(t => t.artists[0].id.includes('New'))) {
      raw[t.artists[0].id] = {
        deezerId: null,
        deezer: Array.from({ length: 5 }, (_, i) => ({ id: 1000 + i, name: `${fam} core ${i}` })),
        deezerAt: 1,
      };
    }
  }
  return raw;
}

const TARGETS = FAMS.map(f => `p-${f}`);

/* ---------- Deezer parsing ---------- */

test('Deezer: the ISRC route takes the credit whose name matches, main artist first', () => {
  const json = { id: 5, isrc: 'GBDUW0000059', artist: { id: 27, name: 'Daft Punk' },
                 contributors: [{ id: 27, name: 'Daft Punk' }, { id: 99, name: 'Romanthony' }] };
  assert.deepEqual(Deezer.artistFromIsrc(json, 'Daft Punk'), { answered: true, artist: { id: 27, name: 'Daft Punk' } });
  assert.deepEqual(Deezer.artistFromIsrc(json, 'ROMANTHONY'), { answered: true, artist: { id: 99, name: 'Romanthony' } });
  // The recording exists but not under this credit: an answer, and it is "nobody".
  assert.deepEqual(Deezer.artistFromIsrc(json, 'Someone Else'), { answered: true, artist: null });
});

test('Deezer: "no data" is an answer, a quota is a retry, anything else is not an answer', () => {
  assert.deepEqual(Deezer.artistFromIsrc({ error: { code: 800, message: 'no data' } }, 'x'), { answered: true, artist: null });
  assert.deepEqual(Deezer.artistFromIsrc({ error: { code: 4, message: 'Quota limit exceeded' } }, 'x'), { answered: false, retry: true });
  assert.deepEqual(Deezer.artistFromIsrc({ error: { code: 100 } }, 'x'), { answered: false, retry: false });
  assert.deepEqual(Deezer.artistFromIsrc(null, 'x'), { answered: false, retry: false });
  assert.deepEqual(Deezer.relatedFrom({ error: { code: 4 } }), { answered: false, retry: true });
  assert.deepEqual(Deezer.relatedFrom({ data: [], total: 0 }), { answered: true, related: [] });
  assert.deepEqual(Deezer.relatedFrom('<html>'), { answered: false, retry: false });
});

test('Deezer: related keeps Deezer\'s order and the limit', () => {
  const data = Array.from({ length: 30 }, (_, i) => ({ id: i, name: `a${i}` }));
  const out = Deezer.relatedFrom({ data }, { limit: 3 });
  assert.deepEqual(out, { answered: true, related: [{ id: 0, name: 'a0' }, { id: 1, name: 'a1' }, { id: 2, name: 'a2' }] });
});

test('Deezer: only api.deezer.com URLs may go through the JSONP frame', () => {
  assert.ok(Deezer.isDeezerApiUrl(Deezer.isrcUrl('GBDUW0000059')));
  assert.ok(Deezer.isDeezerApiUrl(Deezer.relatedUrl(27)));
  for (const bad of ['https://evil.example/api.deezer.com/x', 'http://api.deezer.com/track/1',
                     'https://api.deezer.com.evil.example/x', 'javascript:alert(1)',
                     'https://api.deezer.com/track/1?callback=<script>', 'https://api.deezer.com/a"b'])
    assert.equal(Deezer.isDeezerApiUrl(bad), false, bad);
});

test('names normalise so "The Ragga Twins" is "Ragga Twins", and no further', () => {
  assert.equal(Deezer.normName('The Ragga Twins'), Deezer.normName('Ragga Twins'));
  assert.equal(Deezer.normName('Sigur Rós'), Deezer.normName('Sigur Ros'));
  assert.equal(Deezer.normName('Chase & Status'), Deezer.normName('Chase and Status'));
  assert.notEqual(Deezer.normName('DJ Zinc'), Deezer.normName('Zinc'));
});

/* ---------- ListenBrainz and Wikidata parsing ---------- */

test('ListenBrainz: score-ordered, bad rows dropped, non-arrays are not answers', () => {
  const m = i => `8f6bd1e4-fbe1-4f50-aa9b-94c450ec0f1${i}`;
  const out = LB.similarFrom([{ artist_mbid: m(1), name: 'A', score: 5 }, { artist_mbid: 'nope', name: 'B', score: 9 },
                              { artist_mbid: m(2), name: 'C', score: 7 }]);
  assert.deepEqual(out.similar.map(x => x.name), ['C', 'A']);
  assert.deepEqual(LB.similarFrom({ error: 'x' }), { answered: false });
  assert.deepEqual(LB.similarFrom([]), { answered: true, similar: [] });
  assert.ok(LB.similarUrl(m(1)).startsWith(LB.ENDPOINT + '?artist_mbids='));
});

test('Wikidata: ids are validated before they reach the query text', () => {
  const ok = '1P6U1dCeHxPui5pIrGmndZ';
  const q = WD.mbidQuery([ok, ok, '" } DROP', 'short']);
  assert.ok(q.includes(`"${ok}"`));
  assert.equal(q.match(new RegExp(ok, 'g')).length, 1, 'deduplicated');
  assert.ok(!q.includes('DROP') && !q.includes('short'));
});

test('Wikidata: an item with two MBIDs answers the same one every time', () => {
  const b = (s, m) => ({ s: { value: s }, mbid: { value: m } });
  const s = '1P6U1dCeHxPui5pIrGmndZ';
  const one = WD.mbidsFrom({ results: { bindings: [b(s, 'bbbbbbbb-0000-0000-0000-000000000000'), b(s, 'aaaaaaaa-0000-0000-0000-000000000000')] } });
  const two = WD.mbidsFrom({ results: { bindings: [b(s, 'aaaaaaaa-0000-0000-0000-000000000000'), b(s, 'bbbbbbbb-0000-0000-0000-000000000000')] } });
  assert.equal(one.mbids.get(s), 'aaaaaaaa-0000-0000-0000-000000000000');
  assert.equal(one.mbids.get(s), two.mbids.get(s));
  assert.deepEqual(WD.mbidsFrom({}), { answered: false });
});

/* ---------- turning lookups into a bridge ---------- */

test('sourceArtists: first-billed artist, first valid ISRC, order kept', () => {
  const m = sourceArtists([
    { id: 't1', artists: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], isrc: 'bad' },
    { id: 't2', artists: [{ id: 'a', name: 'A' }], isrc: 'GB-DUW-00-00059' },
    { id: 't3', artists: [{ id: 'c', name: 'C' }], isrc: 'USRC17607839' },
  ]);
  assert.deepEqual([...m.keys()], ['a', 'c']);
  assert.equal(m.get('a').isrc, 'GBDUW0000059');
});

test('bridgeFrom: exact ids beat names, shared names map to nobody, nobody is their own neighbour', () => {
  const lib = { playlists: [{ id: 'p', tracks: [
    { id: 't1', artists: [{ id: 'S1', name: 'Source' }] },
    { id: 't2', artists: [{ id: 'N1', name: 'Neighbour' }] },
    { id: 't3', artists: [{ id: 'X1', name: 'Twin' }] },
    { id: 't4', artists: [{ id: 'X2', name: 'Twin' }] },
    { id: 't5', artists: [{ id: 'E1', name: 'Renamed On Spotify' }] },
  ] }] };
  const raw = {
    S1: { deezerId: 1, deezer: [{ id: 2, name: 'Neighbour' }, { id: 3, name: 'Twin' },
                                { id: 1, name: 'Source' }, { id: 7, name: 'Not In Library' },
                                { id: 5, name: 'Renamed On Deezer' }] },
    // E1's own lookup resolved to Deezer id 5, so id 5 maps to E1 exactly
    // even though the names differ.
    E1: { deezerId: 5, deezer: [] },
  };
  const b = bridgeFrom(raw, lib);
  assert.equal(b.version, BRIDGE_VERSION);
  const n = Object.fromEntries(b.neighbours.S1);
  assert.deepEqual(Object.keys(n).sort(), ['E1', 'N1']);
  assert.equal(n.N1, 1, 'first in the list weighs 1');
  assert.ok(n.E1 < n.N1, 'later in the list weighs less');
  assert.equal(libraryNames(lib).get(Deezer.normName('Twin')), null);
  assert.deepEqual(b.coverage, { asked: 2, deezer: 1, listenbrainz: 0, withNeighbours: 1 });
});

test('bridgeFrom: an artist both sources name gets both votes', () => {
  const lib = { playlists: [{ id: 'p', tracks: [{ id: 't', artists: [{ id: 'N', name: 'Both' }] },
                                                { id: 'u', artists: [{ id: 'M', name: 'One' }] }] }] };
  const raw = { S: { deezer: [{ id: 1, name: 'Both' }],
                     listenbrainz: [{ mbid: 'm1', name: 'Both', score: 10 }, { mbid: 'm2', name: 'One', score: 5 }] } };
  const n = Object.fromEntries(bridgeFrom(raw, lib).neighbours.S);
  assert.equal(n.N, 2);
  assert.equal(n.M, 0.5);
});

/* ---------- the engine, with and without ---------- */

test('without a bridge the space and every placement are exactly what they were', () => {
  const lib = library();
  const a = buildSpace(lib, { targets: TARGETS });
  const b = buildSpace(lib, { targets: TARGETS, bridge: null });
  assert.equal('bridge' in a, false);
  assert.equal('artistHomes' in a, false);
  assert.deepEqual(Object.keys(a), Object.keys(b));
  for (const t of lib.playlists[0].tracks)
    assert.deepEqual(placements(t, a, { why: true }), placements(t, b, { why: true }));
  // An empty bridge is the same as none.
  const c = buildSpace(lib, { targets: TARGETS, bridge: { neighbours: {} } });
  assert.equal('bridge' in c, false);
});

test('a never-filed artist is placed by where their neighbours are filed', () => {
  const lib = library();
  const bridge = bridgeFrom(rawFor(lib), lib);
  const newcomer = lib.playlists[1].tracks[13];             // a garage newcomer
  const skip = new Set([newcomer.id]);
  const plain = placements(newcomer, buildSpace(lib, { skip, targets: TARGETS }));
  const space = buildSpace(lib, { skip, targets: TARGETS, bridge });
  const withIt = placements(newcomer, space);
  assert.equal(withIt.results[0].playlistId, 'p-garage');
  assert.ok('bridge' in withIt.results[0].parts);
  assert.equal(withIt.results[0].parts.bridge, 1, 'every neighbour lives in Garage');
  assert.ok(!('bridge' in (plain.results[0]?.parts ?? {})));
});

test('a neighbour whose only filed tracks are held out casts no vote', () => {
  const lib = library();
  const fam = lib.playlists[0];
  const newcomer = fam.tracks[12];
  const bridge = { neighbours: { [newcomer.artists[0].id]: [[fam.tracks[0].artists[0].id, 1]] } };
  // Hold out every track by that neighbour: it is then filed nowhere.
  const nb = fam.tracks[0].artists[0].id;
  const skip = new Set(lib.playlists.flatMap(p => p.tracks).filter(t => t.artists.some(a => a.id === nb)).map(t => t.id));
  skip.add(newcomer.id);
  const space = buildSpace(lib, { skip, targets: TARGETS, bridge });
  assert.equal(bridgeScores(newcomer, space), null);
});

test('a neighbour spreads its vote over the playlists it really lives in', () => {
  const homes = artistHomes(new Map([
    ['A', { id: 'A', artistCounts: new Map([['n', { n: 9 }]]) }],
    ['B', { id: 'B', artistCounts: new Map([['n', { n: 1 }]]) }],
  ]));
  const v = bridgeScores({ artists: [{ id: 's' }] }, { bridge: bridgeIndex({ neighbours: { s: [['n', 1]] } }), artistHomes: homes });
  assert.equal(+v.get('A').toFixed(4), 0.9);
  assert.equal(+v.get('B').toFixed(4), 0.1);
});

test('the harness scores both ways on the same folds; the headline numbers do not move', () => {
  const lib = library();
  const bridge = bridgeFrom(rawFor(lib), lib);
  const without = placementAccuracy(lib, { folds: 4, targets: TARGETS });
  const withIt = placementAccuracy(lib, { folds: 4, targets: TARGETS, bridge });
  // Everything that was reported before is identical.
  const { withBridge, ...headline } = withIt;
  assert.deepEqual(headline, without);
  assert.equal(without.withBridge, undefined);
  // The newcomers are the never-filed subset: 4 per playlist, 3 playlists.
  assert.equal(without.neverFiled.scored, 12);
  assert.equal(withBridge.neverFiled.scored, 12);
  assert.ok(withBridge.neverFiled.top1 > without.neverFiled.top1,
    `bridge ${withBridge.neverFiled.top1} should beat ${without.neverFiled.top1} on never-filed artists`);
  assert.equal(withBridge.neverFiled.top1, 1);
  assert.ok(withBridge.top1 >= without.top1);
  assert.equal(withBridge.judged, 12);
  assert.equal(withBridge.weight, WEIGHTS.bridge);
});

test('scoredTracks is the harness\'s own selection', () => {
  const lib = library();
  const picked = scoredTracks(lib, { limit: 10, targets: TARGETS });
  assert.equal(picked.length, 10);
  assert.deepEqual(picked.map(t => t.id), [...picked.map(t => t.id)].sort());
  assert.equal(placementAccuracy(lib, { limit: 10, folds: 3, targets: TARGETS }).scored, 10);
});

/* ---------- gathering ---------- */

const ID = i => `${'A'.repeat(21)}${i}`;
function fakeNet({ quotaAlways = false, deezerFailsFor = new Set() } = {}) {
  const calls = { deezer: [], json: [] };
  const deezer = async url => {
    calls.deezer.push(url);
    if (quotaAlways) return { error: { code: 4, message: 'Quota limit exceeded' } };
    const isrc = url.match(/isrc:([A-Z0-9]+)/)?.[1];
    if (isrc) {
      if (deezerFailsFor.has(isrc)) throw new Error('network');
      if (isrc.endsWith('0')) return { error: { code: 800, message: 'no data' } };
      return { id: 1, artist: { id: Number(isrc.slice(-1)), name: `Artist ${isrc.slice(-1)}` } };
    }
    const id = url.match(/artist\/(\d+)\/related/)?.[1];
    return { data: [{ id: 100 + Number(id), name: `Near ${id}` }] };
  };
  const json = async (url, init) => {
    calls.json.push(url);
    if (url.startsWith(WD.ENDPOINT)) {
      const q = new URLSearchParams(init.body).get('query');
      const ids = [...q.matchAll(/"([0-9A-Za-z]{22})"/g)].map(m => m[1]);
      return { results: { bindings: ids.filter(s => s.endsWith('2'))
        .map(s => ({ s: { value: s }, mbid: { value: '8f6bd1e4-fbe1-4f50-aa9b-94c450ec0f11' } })) } };
    }
    return [{ artist_mbid: '10adbe5e-a2c0-4bf3-8249-2b4cbf6e6ca8', name: 'LB Near', score: 3 }];
  };
  return { deezer, json, calls };
}
const artistsN = n => new Map(Array.from({ length: n }, (_, i) =>
  [ID(i), { name: `Artist ${i}`, isrc: `GBAAA2100000${i}` }]));
const noSleep = async () => {};

test('gather: answers cached, "no data" cached as nothing, MBIDs only where Wikidata has one', async () => {
  const net = fakeNet();
  const { raw, stats } = await gatherBridge(artistsN(4), { ...net, sleep: noSleep, now: 1000 });
  assert.deepEqual(raw[ID(0)], { mbid: null, mbidAt: 1000, deezerId: null, deezer: [], deezerAt: 1000 });
  assert.deepEqual(raw[ID(1)].deezer, [{ id: 101, name: 'Near 1' }]);
  assert.equal(raw[ID(1)].deezerId, 1);
  assert.deepEqual(raw[ID(2)].listenbrainz, [{ mbid: '10adbe5e-a2c0-4bf3-8249-2b4cbf6e6ca8', name: 'LB Near', score: 3 }]);
  assert.equal(raw[ID(1)].listenbrainz, undefined, 'no MBID, no ListenBrainz request');
  assert.equal(stats.deezer, 4);
  assert.equal(stats.listenbrainz, 1);
  assert.equal(net.calls.json.filter(u => u.startsWith(WD.ENDPOINT)).length, 1, 'one Wikidata batch');
});

test('gather: a failed request is not written down, and is asked again next time', async () => {
  const net = fakeNet({ deezerFailsFor: new Set(['GBAAA21000001']) });
  const first = await gatherBridge(artistsN(2), { ...net, sleep: noSleep, now: 1000 });
  assert.equal(first.raw[ID(1)].deezerAt, undefined);
  assert.equal(first.stats.failed, 1);
  const again = fakeNet();
  const second = await gatherBridge(artistsN(2), { ...again, cache: first.raw, sleep: noSleep, now: 2000 });
  assert.equal(second.raw[ID(1)].deezerAt, 2000);
  assert.equal(again.calls.deezer.filter(u => u.includes('isrc:GBAAA21000000')).length, 0, 'the answered one is not re-asked');
});

test('gather: a ListenBrainz or Wikidata blip is retried once, then left unanswered', async () => {
  let wd = 0, lb = 0;
  const net = fakeNet();
  const json = async (url, init) => {
    if (url.startsWith(WD.ENDPOINT) && ++wd === 1) throw new Error('blip');
    if (!url.startsWith(WD.ENDPOINT)) { lb++; throw new Error('down'); }
    return net.json(url, init);
  };
  const { raw, stats } = await gatherBridge(artistsN(3), { deezer: net.deezer, json, sleep: noSleep, now: 1 });
  assert.equal(wd, 2, 'Wikidata: one failure, one retry that worked');
  assert.equal(raw[ID(2)].mbid, '8f6bd1e4-fbe1-4f50-aa9b-94c450ec0f11');
  assert.equal(lb, 2, 'ListenBrainz: asked twice, then given up on');
  assert.equal(raw[ID(2)].lbAt, undefined, 'and nothing written down for it');
  assert.equal(stats.failed, 1);
});

test('gather: a fresh cache asks nothing; a stale one asks again', async () => {
  const a = fakeNet();
  const first = await gatherBridge(artistsN(3), { ...a, sleep: noSleep, now: 1000 });
  const b = fakeNet();
  await gatherBridge(artistsN(3), { ...b, cache: first.raw, sleep: noSleep, now: 1000 + TTL_MS - 1 });
  assert.equal(b.calls.deezer.length + b.calls.json.length, 0);
  const c = fakeNet();
  await gatherBridge(artistsN(3), { ...c, cache: first.raw, sleep: noSleep, now: 1000 + TTL_MS + 1 });
  assert.ok(c.calls.deezer.length > 0 && c.calls.json.length > 0);
});

test('gather: a Deezer quota stops Deezer for the run and caches nothing from it', async () => {
  const net = fakeNet({ quotaAlways: true });
  const { raw, stats } = await gatherBridge(artistsN(5), { ...net, sleep: noSleep, now: 1000 });
  assert.equal(stats.quota, true);
  assert.equal(net.calls.deezer.length, 2, 'one request and one retry, then it stops');
  for (const e of Object.values(raw)) assert.equal(e.deezerAt, undefined);
});

test('gather: an input cache is never mutated', async () => {
  const cache = { [ID(1)]: { deezerAt: 1 } };
  const snapshot = JSON.stringify(cache);
  await gatherBridge(artistsN(2), { ...fakeNet(), cache, sleep: noSleep, now: 1 + TTL_MS + 5 });
  assert.equal(JSON.stringify(cache), snapshot);
});

test('the whole path: gathered lookups become a bridge the harness can use', async () => {
  const lib = library();
  const tracks = scoredTracks(lib, { targets: TARGETS });
  const artists = sourceArtists(tracks);
  assert.ok(artists.size > 0);
  const net = {
    deezer: async url => url.includes('isrc:') ? { error: { code: 800 } } : { data: [] },
    json: async url => url.startsWith(WD.ENDPOINT) ? { results: { bindings: [] } } : [],
  };
  const { raw } = await gatherBridge(artists, { ...net, sleep: noSleep, now: 1 });
  const bridge = bridgeFrom(raw, lib);
  // Nobody found: a bridge with no neighbours scores exactly like no bridge.
  const r = placementAccuracy(lib, { folds: 3, targets: TARGETS, bridge });
  assert.equal(r.withBridge.judged, 0);
  assert.equal(r.withBridge.top1, r.top1);
});
