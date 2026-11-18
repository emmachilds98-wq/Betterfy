import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import * as D from '../core/audio/discover.mjs';
import { audioIndex } from '../core/intrinsic/audio.mjs';
import { genreMembership } from '../core/audio/match.mjs';
import { soundRecord } from './fixtures/sound-library.mjs';
import { norm } from '../norm.mjs';
import { ownsAnyOf } from '../credits.mjs';

// Discover by sound (docs/SOUND-EVERYWHERE-PLAN.md S4): picks heard and
// re-ranked by fit to the seed's sound, sound-led playlist picks for a heard
// pick, and the keyless candidate path. Synthetic sound: tracks built around
// fixed directions in embedding space (test/fixtures/sound-library.mjs).

const track = (id, artist = 'A') => ({ id, name: `${id} song`, artists: [{ id: `sp-${artist}`, name: artist }], isrc: 'GBAAA2400001' });

/** A library: playlist X sounds like direction x, Y like y. Plus records for candidates. */
function world() {
  const recs = [], X = [], Y = [];
  for (let i = 0; i < 20; i++) { recs.push(soundRecord(`x${i}`, { mix: { x: 2 } })); X.push(track(`x${i}`, 'Ex')); }
  for (let i = 0; i < 20; i++) { recs.push(soundRecord(`y${i}`, { mix: { y: 2 } })); Y.push(track(`y${i}`, 'Why')); }
  const lib = { playlists: [{ id: 'pX', name: 'Jungle', tracks: X }, { id: 'pY', name: 'Dubstep', tracks: Y }], liked: [] };
  const cands = [soundRecord('cx', { mix: { x: 2 } }), soundRecord('cy', { mix: { y: 2 } }), soundRecord('cm', { mix: { x: 1.2, y: 1.2 } })];
  return { lib, index: audioIndex(recs), cand: audioIndex(cands), X, Y };
}

/* ---------- the seed's sound, and a pick's fit to it ---------- */

test('a seed with too few heard tracks cannot be judged, and says how many it has', () => {
  const { index } = world();
  assert.deepEqual(D.seedSound(['x0', 'x1', 'nope'], index), { ok: false, n: 2 });
  assert.deepEqual(D.seedSound([], index), { ok: false, n: 0 });
});

test('the fit is calibrated: as close as the seed is to itself is near 1, an outside track near 0', () => {
  const { index, cand, X } = world();
  const seed = D.seedSound(X, index);
  assert.equal(seed.ok, true);
  assert.equal(seed.n, 20);
  assert.ok(seed.self > seed.base, `self ${seed.self} > base ${seed.base}`);
  const fx = D.soundFit(cand.get('cx').emb, seed), fy = D.soundFit(cand.get('cy').emb, seed),
        fm = D.soundFit(cand.get('cm').emb, seed);
  assert.ok(fx.fit > 0.8, `sounds like the seed: ${fx.fit}`);
  assert.ok(fy.fit < 0.2, `sounds like the other playlist: ${fy.fit}`);
  assert.ok(fm.fit > fy.fit && fm.fit < fx.fit, `in between: ${fm.fit}`);
  assert.ok(fx.near.every(id => id.startsWith('x')) && fx.near.length === 3, 'closest seed tracks named');
  // Every heard candidate gets one.
  assert.deepEqual([...D.soundFits(cand, seed).keys()].sort(), ['cm', 'cx', 'cy']);
  assert.equal(D.soundFits(cand, { ok: false, n: 1 }).size, 0);
});

test('a seed that is everything heard still calibrates, against a fixed window', () => {
  const { index, cand, X } = world();
  const only = new Map([...index].filter(([id]) => id.startsWith('x')));
  const seed = D.seedSound(X, only);
  assert.equal(seed.base, null);
  assert.ok(D.soundFit(cand.get('cx').emb, seed).fit > 0.5);
  assert.equal(D.calibrate(NaN, seed), null);
});

test('"everything I listen to" is the heard tracks of the artists you play, most played first', () => {
  const { index, X, Y } = world();
  const w = new Map([['Why', 3], ['Ex', 1]]);
  const ids = D.weightedSeedIds([...X, ...Y, track('unheard', 'Why'), track('zz', 'Nobody')],
    t => Math.max(0, ...t.artists.map(a => w.get(a.name) ?? 0)), index);
  assert.equal(ids.length, 40, 'unheard and unplayed tracks are left out');
  assert.ok(ids.slice(0, 20).every(id => id.startsWith('y')), 'the most-played artist first');
  assert.equal(D.weightedSeedIds([...X], () => 1, index, { limit: 5 }).length, 5);
});

/* ---------- re-ranking ---------- */

test('with no fits the order is untouched', () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const out = D.rerank(list, new Map());
  assert.deepEqual(out, list);
  assert.notEqual(out, list, 'a new array, never the caller’s');
  assert.deepEqual(D.rerank(list, new Map([['a', { fit: 0.9 }]]), { from: 1 }), list, 'no fit after `from`: untouched');
});

test('picks that sound like the seed move up; the cards already seen stay put', () => {
  const list = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id }));
  const fits = new Map([['b', { fit: 0.05 }], ['e', { fit: 0.95 }], ['d', { fit: 0.9 }]]);
  const ids = D.rerank(list, fits, { from: 1 }).map(x => x.id);
  assert.equal(ids[0], 'a', 'the card on screen is not moved');
  assert.deepEqual(ids.slice(1, 3).sort(), ['d', 'e'], 'the two that fit lead');
  assert.equal(ids.at(-1), 'b', 'the one that does not fit sinks');
  // An unheard pick counts as neutral, so it lands between a good and a bad fit.
  const two = D.rerank([{ id: 'u' }, { id: 'g' }, { id: 'p' }], new Map([['g', { fit: 1 }], ['p', { fit: 0 }]])).map(x => x.id);
  assert.deepEqual(two, ['g', 'u', 'p']);
});

/* ---------- where a heard pick would go ---------- */

test('a heard pick is offered the playlist whose filed tracks it sounds like', () => {
  const { lib, index, cand } = world();
  const memb = genreMembership(lib);
  const px = D.soundPlace(cand.get('cx').emb, index, memb);
  assert.equal(px[0].id, 'pX');
  assert.equal(px[0].name, 'Jungle');
  assert.equal(px[0].via, 'sound');
  assert.ok(px[0].score > 0.9);
  assert.equal(D.soundPlace(cand.get('cy').emb, index, memb)[0].id, 'pY');
  assert.deepEqual(D.soundPlace(cand.get('cx').emb, new Map(), memb), [], 'nothing heard, nothing offered');
  const few = new Map([...index].slice(0, 3));
  assert.deepEqual(D.soundPlace(cand.get('cx').emb, few, memb), [], 'too few filed sound-alikes to vote');
});

/* ---------- the keyless candidate path ---------- */

test('seed artists are the most-played first, each with an ISRC, weighted 0.35 to 1', () => {
  const tracks = [
    { id: 't1', artists: [{ id: 'a1', name: 'Low' }], isrc: 'GBAAA2400001' },
    { id: 't2', artists: [{ id: 'a2', name: 'High' }], isrc: null },
    { id: 't3', artists: [{ id: 'a2', name: 'High' }], isrc: 'GB-BBB-24-00002' },
    { id: 't4', artists: [{ id: 'a3', name: 'Local' }], is_local: true },
  ];
  const w = { a1: 1, a2: 4 };
  const { artists, seeds } = D.seedArtists(tracks, { weightOf: t => w[t.artists[0].id] ?? 0 });
  assert.deepEqual([...artists.keys()], ['a2', 'a1'], 'local files have no artist to ask about');
  assert.equal(artists.get('a2').isrc, 'GBBBB2400002', 'the first track with an ISRC reaches them');
  assert.deepEqual(seeds.map(s => [s.name, s.w]), [['High', 1], ['Low', 0.5125]]);
  assert.equal(D.seedArtists(tracks, { limit: 1 }).seeds.length, 1);
});

test('candidates are the neighbours you do not own; agreement adds up', () => {
  const raw = {
    a1: { deezerId: 10, deezer: [{ id: 1, name: 'Tim Reaper' }, { id: 2, name: 'Owned Act' }, { id: 3, name: 'Seed Two' }],
          listenbrainz: [{ mbid: 'm1', name: 'Tim Reaper', score: 50 }, { mbid: 'm9', name: 'Kid Lib', score: 25 }] },
    a2: { deezer: [{ id: 4, name: 'Sherelle' }, { id: 1, name: 'The Tim Reaper' }] },
  };
  const seeds = [{ id: 'a1', name: 'Seed One', w: 1 }, { id: 'a2', name: 'Seed Two', w: 0.5 }, { id: 'nope', name: 'X', w: 1 }];
  const out = D.bridgeCandidates(raw, seeds, { isOwned: n => n === 'Owned Act' });
  assert.deepEqual(out.map(c => c.name), ['Tim Reaper', 'Kid Lib', 'Sherelle']);
  const tim = out[0];
  assert.deepEqual(tim.via, ['Seed One', 'Seed Two'], 'both seeds that named them');
  assert.deepEqual(tim.sources, ['deezer', 'listenbrainz']);
  assert.equal(tim.deezerId, 1);
  assert.equal(tim.mbid, 'm1');
  assert.equal(tim.score, +(1 + 1 + 0.5 * 0.5).toFixed(4));
  assert.ok(!out.some(c => c.name === 'Seed Two'), 'a seed artist is never a candidate');
  assert.equal(D.bridgeCandidates(raw, seeds, { limit: 1 }).length, 1);
  assert.deepEqual(D.bridgeCandidates(null, seeds), []);
});

test('a track is taken only when its credits name the artist, and you do not own it', () => {
  const items = [
    { id: 's1', name: 'Rinse', artists: [{ name: 'Someone Else' }] },
    { id: 's2', name: 'Owned', artists: [{ name: 'Tim Reaper' }] },
    { id: 's3', name: 'New One', artists: [{ name: 'dwarde' }, { name: 'Tim Reaper' }] },
  ];
  const hit = D.pickTrack(items, 'tim reaper', { isOwnedTrack: t => t.name === 'Owned' });
  assert.equal(hit.id, 's3');
  assert.equal(D.pickTrack(items, 'Nobody'), null);
  assert.equal(D.pickTrack(items, ''), null);
});

/* ---------- the page: the shipped code, run against stubs ---------- */

const BUNDLE = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
const between = (from, to) => {
  const i = BUNDLE.indexOf(from), j = BUNDLE.indexOf(to, i);
  assert.ok(i > 0 && j > i, `${from} not found — rebuild with node build-web.mjs`);
  return BUNDLE.slice(i, j);
};
const line = re => { const m = BUNDLE.match(re); assert.ok(m, String(re)); return m[0]; };

function page(extra = {}) {
  const sandbox = { S: {}, CFG: { pX: { name: 'Jungle', axis: 'genre', target: true }, pY: { name: 'Dubstep', axis: 'genre', target: true } },
                    BetterfyDiscover: D, view: 'discover', console, render() { sandbox.rendered++; }, rendered: 0,
                    store: { get() {}, on() {}, set() { sandbox.rendered++; }, touch() { sandbox.rendered++; } },
                    document: { getElementById: () => null }, ...extra };
  vm.createContext(sandbox);
  vm.runInContext(line(/const esc = [^\n]+/), sandbox);
  vm.runInContext(between('/* ---------- Discover without a key', '/** The discovery currently on the card. */'), sandbox);
  vm.runInContext(between('/* The "by sound" pieces of the Discover screen.', '/* ---------- giving a tag back'), sandbox);
  return sandbox;
}

test('the page draws nothing by sound until there is sound', () => {
  const p = page();
  assert.equal(p.discSoundLine(), '');
  assert.equal(p.discFitHTML({ id: 'a' }), '');
  assert.equal(p.discFitHTML({ id: 'a', fit: null }), '');
});

test('the page says how close a heard pick sounds, and why it is not ranked yet when the seed is thin', () => {
  const p = page({ soundTrackName: id => ({ title: `T<${id}>`, artist: 'Art' }) });
  p.S.discSound = { state: 'done', heard: 7, total: 9, missed: 2, name: 'Jungle & <Breaks>' };
  assert.match(p.discSoundLine(), /Ranked by how close they sound to Jungle &amp; &lt;Breaks&gt;: 7 of 9 picks heard\. 2 had no preview/);
  const fit = p.discFitHTML({ id: 'a', fit: { fit: 0.9, near: ['x1', 'x2', 'x3'] } });
  assert.match(fit, /class="discfit hi"/);
  assert.match(fit, /Sounds right at home in Jungle &amp; &lt;Breaks&gt;/);
  assert.match(fit, /closest: T&lt;x1&gt; — Art; T&lt;x2&gt; — Art<\/span>/, 'two closest, escaped');
  assert.match(fit, /title="90% /);
  assert.match(p.discFitHTML({ id: 'a', fit: { fit: 0.1, near: [] } }), /discfit out.*Doesn’t sound much like/);
  p.S.discSound = { state: 'thin', n: 1, need: 5, name: 'Jungle' };
  assert.match(p.discSoundLine(), /1 of Jungle’s tracks has been heard, and it takes 5/);
  p.S.discSound = { state: 'listening', heard: 3, total: 9, name: 'Jungle' };
  assert.match(p.discSoundLine(), /3 of 9 heard so far\. The cards after this one move/);
});

test('hearing picks re-ranks the cards after this one and gives heard picks sound-led playlists', async () => {
  const { lib, index } = world();
  const recs = new Map([['cy', soundRecord('cy', { mix: { y: 2 } })], ['cx', soundRecord('cx', { mix: { x: 2 } })],
                        ['gone', { id: 'gone', miss: 'NO_PREVIEW' }]]);
  const p = page();
  const tagPick = { id: 'pY', name: 'Dubstep', axis: 'genre', score: 0.4 };
  p.S.discover = [{ id: 'now', isrc: 'I0' }, { id: 'cy', isrc: 'I1', suggest: [tagPick] }, { id: 'u', isrc: 'I2' },
                  { id: 'cx', isrc: 'I3', suggest: [] }, { id: 'gone', isrc: 'I4' }];
  p.S.discAt = 0;
  p.S.discSound = { state: 'listening', heard: 0, total: 5, name: 'Jungle' };
  Object.assign(vm.runInContext('DISC', p), { store: { getAll: async () => recs }, seed: D.seedSound(lib.playlists[0].tracks, index),
                          index, memb: genreMembership(lib) });
  await p.discApply();
  const order = p.S.discover.map(o => o.id);
  assert.equal(order[0], 'now', 'the card on screen stays');
  assert.equal(order[1], 'cx', 'the pick that sounds like Jungle moves up');
  assert.ok(order.indexOf('cy') > order.indexOf('u'), 'the one that sounds like Dubstep drops below an unheard one');
  const cx = p.S.discover[1], cy = p.S.discover.find(o => o.id === 'cy');
  assert.ok(cx.fit.fit > 0.8);
  assert.equal(cx.suggest[0].id, 'pX', 'a pick with no tags gets a playlist by sound');
  assert.equal(cx.suggest[0].via, 'sound');
  assert.equal(cx.suggest[0].axis, 'genre');
  assert.ok(cx.suggest[0].evidence.sound > 0.9);
  assert.equal(cy.suggest[0].id, 'pY');
  assert.deepEqual(cy.tagSuggest, [tagPick], 'the tag engine’s picks are kept beside');
  assert.deepEqual({ heard: p.S.discSound.heard, missed: p.S.discSound.missed }, { heard: 2, missed: 1 });
  assert.equal(p.rendered, 1, 'nothing on screen to update in place, so one redraw');
  // Run again: picks already merged are not merged twice.
  await p.discApply();
  assert.deepEqual(p.S.discover.find(o => o.id === 'cy').tagSuggest, [tagPick]);
});

test('a pick that sounds at home in the seed playlist is offered that playlist first (emma, 2026-11-18)', async () => {
  const { lib, index } = world();
  const recs = new Map([['cy', soundRecord('cy', { mix: { y: 2 } })], ['cx', soundRecord('cx', { mix: { x: 2 } })]]);
  const p = page();
  p.S.discover = [{ id: 'now', isrc: 'I0' }, { id: 'cx', isrc: 'I3', suggest: [] }, { id: 'cy', isrc: 'I1', suggest: [] }];
  p.S.discAt = 0;
  p.S.discSound = { state: 'listening', heard: 0, total: 3, name: 'emma on road' };
  // A mood playlist's radio: not a genre target, so the filed tracks never vote for it.
  const road = { id: 'pRoad', name: 'emma on road', axis: null };
  Object.assign(vm.runInContext('DISC', p), { store: { getAll: async () => recs }, seed: D.seedSound(lib.playlists[0].tracks, index),
                          seedPl: road, index, memb: genreMembership(lib) });
  await p.discApply();
  const cx = p.S.discover.find(o => o.id === 'cx'), cy = p.S.discover.find(o => o.id === 'cy');
  assert.match(p.discFitHTML(cx), /Sounds right at home in emma on road/);
  assert.equal(cx.suggest[0].id, 'pRoad', 'the File button says what the fit line says');
  assert.equal(cx.suggest[0].via, 'seed');
  assert.equal(cx.suggest[1].id, 'pX', 'the sound pick is still one tap away');
  assert.ok(cx.suggest.length <= 3);
  assert.ok(cy.fit.fit < D.SEED_FIT.offer, 'cy does not sound like the seed');
  assert.ok(!cy.suggest.some(sg => sg.id === 'pRoad'), 'so it is not offered the seed');
});

test('seedPicks: leads when at home, second when close, untouched otherwise', () => {
  const seed = { id: 's', name: 'Road', axis: null };
  const picks = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(D.seedPicks(picks, { fit: 0.8 }, seed).map(p => p.id), ['s', 'a', 'b']);
  assert.deepEqual(D.seedPicks(picks, { fit: 0.5 }, seed).map(p => p.id), ['a', 's', 'b']);
  assert.deepEqual(D.seedPicks(picks, { fit: 0.3 }, seed).map(p => p.id), ['a', 'b', 'c']);
  assert.deepEqual(D.seedPicks(picks, null, seed).map(p => p.id), ['a', 'b', 'c'], 'not heard: as it was');
  assert.deepEqual(D.seedPicks(picks, { fit: 0.9 }, null).map(p => p.id), ['a', 'b', 'c'], 'Everything I listen to: no seed playlist');
  assert.deepEqual(D.seedPicks([{ id: 'a' }, { id: 's', via: 'sound' }], { fit: 0.9 }, seed).map(p => p.id), ['s', 'a'], 'never twice');
  assert.deepEqual(D.seedPicks([], { fit: 0.5 }, seed).map(p => p.id), ['s'], 'close and nothing else: still offered');
  const s0 = D.seedPicks(picks, { fit: 0.8 }, seed)[0];
  assert.deepEqual({ name: s0.name, score: s0.score, via: s0.via, sound: s0.evidence.sound }, { name: 'Road', score: 0.8, via: 'seed', sound: 0.8 });
  assert.deepEqual(picks.map(p => p.id), ['a', 'b', 'c'], 'input untouched');
});

test('without a key, candidates come from the cached neighbour lookups and Spotify search', async () => {
  const calls = { bridge: null, saved: null, search: [] };
  const p = page({
    LIB: { liked: [track('l1', 'Seed One')], playlists: [{ id: 'p', name: 'P', tracks: [track('p1', 'Seed Two')] }] },
    isMirrorPlaylist: () => false, norm, ownsAnyOf, stage() {}, discStage() {}, performance: { now: () => 0 },
    engineLoad: async () => true, deezerJsonp() {}, corsJson() {},
    BRIDGE_KEY: 'bridge-raw',
    idb: { get: async () => ({ raw: { old: { deezer: [] } } }), set: async (k, v) => { calls.saved = [k, Object.keys(v.raw)]; } },
    BetterfyBridgeFetch: { gatherBridge: async (artists, io) => {
      calls.bridge = { artists: [...artists.keys()], cache: io.cache };
      return { raw: { ...io.cache, 'sp-Seed One': { deezer: [{ id: 1, name: 'Tim Reaper' }, { id: 2, name: 'Seed Two' }] },
                      'sp-Seed Two': { deezer: [{ id: 3, name: 'Owned Act' }, { id: 4, name: 'Nobody Found' }] } }, stats: {} };
    } },
    sp: async url => {
      calls.search.push(decodeURIComponent(url));
      if (/Tim%20Reaper|Tim Reaper/.test(decodeURIComponent(url)))
        return { tracks: { items: [{ id: 's9', name: 'Rinse', artists: [{ name: 'Tim Reaper' }], external_ids: { isrc: 'GB1' } }] } };
      return { tracks: { items: [] } };
    },
  });
  vm.runInContext('var BRIDGE_KEY = "bridge-raw";', p);
  const owned = new Set(['owned act']);
  const out = await p.discoverKeyless(null, new Map([['Seed One', 3], ['Seed Two', 1]]), owned, new Set());
  assert.deepEqual(calls.bridge.artists, ['sp-Seed One', 'sp-Seed Two'], 'most-played artist asked about first');
  assert.deepEqual(calls.bridge.cache, { old: { deezer: [] } }, 'the Engine screen’s cached lookups are reused');
  assert.deepEqual(calls.saved, ['bridge-raw', ['old', 'sp-Seed One', 'sp-Seed Two']], 'and the new answers saved for both screens');
  assert.equal(out.length, 1);
  assert.equal(out[0].artist, 'Tim Reaper');
  assert.equal(out[0].track, 'Rinse');
  assert.deepEqual(out[0].via, ['Seed One']);
  assert.equal(out[0].hit.external_ids.isrc, 'GB1');
  assert.ok(!calls.search.some(u => /Owned Act/.test(u)), 'an owned artist is never searched for');
});
