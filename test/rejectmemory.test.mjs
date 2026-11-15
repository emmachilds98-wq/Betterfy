import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as P from '../profile.mjs';

const { buildProfiles, rank, artistRejectMemory, rejectFactors, downweightRejected, REJECT_MEMORY } = P;

/*
 * BUILD-5-PLAN §5.1: rejections teach the tag engine. Tags are per artist, so
 * every track by one artist ranks the same — a "not that playlist" on one of
 * them is evidence about the rest. A rejection of playlist P for artist X's
 * track now lowers P for X's *other* tracks in the File queue's tag picks,
 * fading with time and with each later accept of X into P. With no rejection
 * nothing changes, to the object.
 */

const DAY = 864e5;
const trk = (id, artistId) => ({ id, name: id, artists: [{ id: artistId, name: artistId }] });

/* ---------- the arithmetic ---------- */

test('no feedback, no rejection, or no matching artist: nothing changes, to the object', () => {
  const lib = { liked: [trk('t1', 'x'), trk('t2', 'x')], playlists: [] };
  const ranked = [{ id: 'A', score: 0.8 }, { id: 'B', score: 0.5 }];
  for (const fb of [undefined, null, {}, { t1: { skips: 2, lastSkip: null, rejected: [] } }, { t1: { skips: 0, rejected: [], accepted: ['A'] } }]) {
    const mem = artistRejectMemory(fb, lib);
    assert.equal(mem.size, 0);
    assert.equal(rejectFactors(lib.liked[1], mem), null);
    assert.equal(downweightRejected(ranked, rejectFactors(lib.liked[1], mem)), ranked, 'the same array back');
  }
  const mem = artistRejectMemory({ t1: { skips: 0, lastSkip: null, rejected: ['A'] } }, lib);
  assert.equal(rejectFactors(trk('t9', 'someone-else'), mem), null, 'another artist is untouched');
  assert.equal(rejectFactors(lib.liked[0], mem), null, 'the rejected track itself: its own reject already removes A outright');
});

test('a rejection lowers that playlist for the same artist\'s other tracks, and fades with time', () => {
  const lib = { liked: [trk('t1', 'x'), trk('t2', 'x')], playlists: [] };
  const now = 1_800_000_000_000;
  const at = d => ({ t1: { skips: 0, lastSkip: null, rejected: ['A'], rejectedAt: { A: now - d * DAY } } });
  const f = d => rejectFactors(lib.liked[1], artistRejectMemory(at(d), lib), { now }).get('A');
  assert.equal(f(0), 1 - REJECT_MEMORY.strength);
  assert.ok(Math.abs(f(REJECT_MEMORY.halfLifeDays) - (1 - REJECT_MEMORY.strength / 2)) < 1e-9, 'half the pull after one half-life');
  assert.ok(f(0) < f(30) && f(30) < f(365) && f(365) < 1);
  // An old store with no times keeps the rejection at full weight (it still fades with accepts).
  const old = rejectFactors(lib.liked[1], artistRejectMemory({ t1: { skips: 0, lastSkip: null, rejected: ['A'] } }, lib), { now });
  assert.equal(old.get('A'), 1 - REJECT_MEMORY.strength);
});

test('each later accept of the artist into the playlist halves what is left; an earlier one does not', () => {
  const lib = { liked: ['t1', 't2', 't3', 't4'].map(id => trk(id, 'x')), playlists: [] };
  const now = 10 * DAY;
  const base = { t1: { skips: 0, lastSkip: null, rejected: ['A'], rejectedAt: { A: 5 * DAY } } };
  const fa = fb => rejectFactors(lib.liked[3], artistRejectMemory(fb, lib), { now, halfLifeDays: Infinity })?.get('A') ?? 1;
  const s = REJECT_MEMORY.strength;
  assert.equal(fa(base), 1 - s);
  assert.equal(fa({ ...base, t2: { skips: 0, rejected: [], accepted: ['A'], acceptedAt: { A: 6 * DAY } } }), 1 - s / 2);
  assert.equal(fa({ ...base, t2: { skips: 0, rejected: [], accepted: ['A'], acceptedAt: { A: 6 * DAY } },
                    t3: { skips: 0, rejected: [], accepted: ['A'], acceptedAt: { A: 7 * DAY } } }), 1 - s / 4);
  assert.equal(fa({ ...base, t2: { skips: 0, rejected: [], accepted: ['A'], acceptedAt: { A: 4 * DAY } } }), 1 - s, 'an accept before the reject is not a later accept');
  // An accept with no time (an older store) is read as later: it can only lift a penalty.
  assert.equal(fa({ ...base, t2: { skips: 0, rejected: [], accepted: ['A'] } }), 1 - s / 2);
  // "Keep here" for the artist in that playlist is the same kind of yes.
  assert.equal(fa({ ...base, t2: { skips: 0, rejected: [], kept: ['A'] } }), 1 - s / 2);
});

test('rejections compound but never below the floor, and re-ranking is stable', () => {
  const lib = { liked: ['t1', 't2', 't3', 't4', 't5'].map(id => trk(id, 'x')), playlists: [] };
  const fb = Object.fromEntries(['t1', 't2', 't3', 't4'].map(id => [id, { skips: 0, lastSkip: null, rejected: ['A'] }]));
  const f = rejectFactors(lib.liked[4], artistRejectMemory(fb, lib));
  assert.equal(f.get('A'), REJECT_MEMORY.floor);
  const ranked = [{ id: 'A', score: 0.9 }, { id: 'B', score: 0.3 }, { id: 'C', score: 0.3 }];
  const out = downweightRejected(ranked, f);
  assert.deepEqual(out.map(b => b.id), ['B', 'C', 'A']);
  assert.ok(Math.abs(out[2].score - 0.9 * REJECT_MEMORY.floor) < 1e-12);
  assert.deepEqual(ranked.map(b => b.score), [0.9, 0.3, 0.3], 'the input is not mutated');
});

test('the artist is the first-billed one, looked up across liked songs and playlists', () => {
  const lib = { liked: [trk('t2', 'x')], playlists: [{ id: 'B', tracks: [{ id: 't1', artists: [{ id: 'x' }, { id: 'guest' }] }] }] };
  const mem = artistRejectMemory({ t1: { skips: 0, lastSkip: null, rejected: ['A'] } }, lib);
  assert.ok(rejectFactors(lib.liked[0], mem).has('A'));
  assert.equal(rejectFactors({ id: 't9', artists: [{ id: 'guest' }] }, mem), null, 'a guest credit is not the artist');
});

/* ---------- the measurement: held-out top-1 with simulated verdicts ---------- */

/**
 * A synthetic account: six genre playlists, each filed with eight clean
 * artists whose tags are that genre's. The inbox holds 60 more artists, four
 * liked tracks each, of three kinds (tags are per artist, so all four tracks
 * of an artist rank the same):
 *   clean       tagged as their genre                                   (36)
 *   confusable  tagged more like another genre than their own            (12)
 *   mistagged   tagged only as another genre: no tag says their own       (6)
 *   split       filed across two genres, tags leaning to one of them      (6)
 * The listener reviews the first `reviewed` tracks of every inbox artist the
 * way the File screen works: take the top pick, accept it if it is right,
 * else reject it and look at the next (up to three tries). The remaining
 * tracks are held out — never reviewed — and scored by their top pick.
 */
function account(seed = 1) {
  let s = seed;
  const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 2 ** 32);
  const G = ['house', 'techno', 'jungle', 'dubstep', 'garage', 'trance'];
  const vocab = g => [g, `${g} music`, `${g} classics`];
  const tags = {}, playlists = G.map(g => ({ id: `p-${g}`, name: g, tracks: [] }));
  const tagOf = (a, mix) => { tags[a] = { name: a, tags: mix.flatMap(([g, w]) => vocab(g).map(t => [t, w])) }; };
  G.forEach((g, gi) => { for (let i = 0; i < 8; i++) { const a = `anchor-${g}-${i}`; tagOf(a, [[g, 90]]); playlists[gi].tracks.push(trk(`${a}-t`, a)); } });
  const inbox = [];
  for (let i = 0; i < 60; i++) {
    const g = G[i % 6], other = G[(i + 1 + Math.floor(rnd() * 5)) % 6];
    const a = `artist-${i}`, kind = i < 36 ? 'clean' : i < 48 ? 'confusable' : i < 54 ? 'mistagged' : 'split';
    if (kind === 'clean') tagOf(a, [[g, 90]]);
    else if (kind === 'confusable') tagOf(a, [[other, 90], [g, 50 + Math.floor(rnd() * 25)]]);
    else if (kind === 'mistagged') tagOf(a, [[other, 90]]);
    else tagOf(a, [[other, 90], [g, 70]]);
    const truth = kind === 'split' ? [g, other, other, g] : [g, g, g, g];
    inbox.push({ artist: a, kind, tracks: truth.map((t, k) => ({ track: trk(`${a}-${k}`, a), truth: `p-${t}` })) });
  }
  const lib = { liked: inbox.flatMap(x => x.tracks.map(t => t.track)), playlists };
  return { lib, tags, inbox, targets: new Set(playlists.map(p => p.id)) };
}

/** The File screen's pick order for one track, as web/app/reports.js backlogSuggest makes it. */
function picks(t, A, fb, useMemory, now) {
  const { profiles, idf } = A;
  const mem = useMemory ? artistRejectMemory(fb, A.lib) : null;
  return downweightRejected(rank(t, A.tags, profiles, idf, { top: 8 }), mem ? rejectFactors(t, mem, { now }) : null)
    .filter(b => !fb[t.id]?.rejected?.includes(b.id));
}

function simulate({ reviewed = 1, useMemory = true, seed = 1 } = {}) {
  const A = account(seed);
  Object.assign(A, buildProfiles(A.lib, A.tags, A.targets));
  const fb = {};
  let clock = 1_800_000_000_000;
  const by = { all: [0, 0], clean: [0, 0], confusable: [0, 0], mistagged: [0, 0], split: [0, 0] };
  let verdicts = 0;
  // Reviewed in rounds across artists, the way an inbox interleaves them.
  for (let k = 0; k < reviewed; k++) {
    for (const x of A.inbox) {
      const { track, truth } = x.tracks[k];
      for (let tries = 0; tries < 3; tries++) {
        const top = picks(track, A, fb, useMemory, clock)[0];
        if (!top) break;
        const f = (fb[track.id] ??= { skips: 0, lastSkip: null, rejected: [] });
        clock += 60_000; verdicts++;
        if (top.id === truth) { (f.accepted ??= []).push(top.id); (f.acceptedAt ??= {})[top.id] = clock; break; }
        f.rejected.push(top.id); (f.rejectedAt ??= {})[top.id] = clock;
      }
    }
  }
  for (const x of A.inbox) for (const { track, truth } of x.tracks.slice(reviewed)) {
    const ok = picks(track, A, fb, useMemory, clock)[0]?.id === truth ? 1 : 0;
    for (const b of [by.all, by[x.kind]]) { b[0] += ok; b[1]++; }
  }
  const pct = ([a, n]) => +(a / n).toFixed(4);
  return { verdicts, n: by.all[1], top1: pct(by.all), clean: pct(by.clean), confusable: pct(by.confusable),
           mistagged: pct(by.mistagged), split: pct(by.split) };
}

test('held out: with simulated verdicts, rejections lift top-1 on the artist\'s unreviewed tracks (reported)', t => {
  for (const reviewed of [1, 2]) {
    const before = simulate({ reviewed, useMemory: false }), after = simulate({ reviewed, useMemory: true });
    t.diagnostic(`${reviewed} reviewed per artist, ${after.n} held out: top-1 ${before.top1} → ${after.top1} ` +
      `(clean ${before.clean} → ${after.clean}, confusable ${before.confusable} → ${after.confusable}, mistagged ${before.mistagged} → ${after.mistagged}, split ${before.split} → ${after.split})`);
    assert.ok(after.top1 > before.top1, `rejections should lift held-out top-1 (${before.top1} → ${after.top1})`);
    assert.equal(after.clean, before.clean, 'an artist the tags already place right is never touched');
    assert.equal(after.mistagged, before.mistagged, 'no tag for the right genre: lowering the wrong one cannot invent it');
    // The cost, measured rather than hidden: an artist filed across two
    // playlists whose first reviewed track is the minority one teaches "not
    // the majority playlist" too. One more reviewed track (an accept into it
    // after the rejection) takes that back.
    if (reviewed >= 2) assert.ok(after.split >= before.split - 0.0001, `split artists recover (${before.split} → ${after.split})`);
  }
  // A few more seeds, so the gain is not one fixture's luck.
  for (const seed of [2, 3, 4]) {
    const b = simulate({ seed, useMemory: false }), a = simulate({ seed, useMemory: true });
    t.diagnostic(`seed ${seed}, 1 reviewed: top-1 ${b.top1} → ${a.top1}`);
    assert.ok(a.top1 > b.top1, `seed ${seed}: ${b.top1} → ${a.top1}`);
  }
});

/* ---------- the page uses it ---------- */

const PAGE = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
function slice(from, to, what) {
  const i = PAGE.indexOf(from), j = PAGE.indexOf(to, i);
  assert.ok(i > 0 && j > i, `${what} not found — rebuild with node build-web.mjs`);
  return PAGE.slice(i, j);
}

function page() {
  let store;
  const sandbox = {
    idb: { get: async () => (store ? JSON.parse(JSON.stringify(store)) : undefined),
           set: async (k, v) => { if (k === 'feedback') store = JSON.parse(JSON.stringify(v)); } },
    console, peek: () => store, ...P,
  };
  vm.createContext(sandbox);
  vm.runInContext(slice('let FB = {};', 'const FIELDS =', 'feedback helpers') +
    slice('/** "Keep here" was said for this track', '/* =====', 'backlogSuggest') + `
    globalThis.getFB = () => FB; globalThis.setFB = x => { FB = x; };`, sandbox);
  return sandbox;
}

test('the page records when, and its File picks lower a playlist rejected for the same artist', async () => {
  const s = page();
  const A = account(1);
  Object.assign(A, buildProfiles(A.lib, A.tags, A.targets));
  const cfg = Object.fromEntries([...A.targets].map(id => [id, { target: true, name: id }]));
  // A confusable artist: the tags put its tracks in the wrong genre first.
  const x = A.inbox.find(i => i.kind === 'confusable');
  const [t0, t1] = x.tracks.map(r => r.track);
  s.A = A; s.cfg = cfg; s.t0 = t0; s.t1 = t1;
  const first = vm.runInContext('backlogSuggest(t1, A.lib, cfg, A.tags, A.profiles, A.idf)', s);
  assert.notEqual(first[0].id, x.tracks[1].truth, 'the tags alone get it wrong');
  const wrong = first[0].id;
  s.wrong = wrong;
  const before = Date.now();
  await vm.runInContext('recordReject(t0.id, wrong)', s);
  const at = s.peek()[x.tracks[0].track.id].rejectedAt[wrong];
  assert.ok(at >= before && at <= Date.now(), 'the rejection is stamped');
  const after = vm.runInContext('backlogSuggest(t1, A.lib, cfg, A.tags, A.profiles, A.idf)', s);
  assert.equal(after[0].id, x.tracks[1].truth, 'one rejection on a sibling track moves the right genre to the top');
  assert.ok(after.some(b => b.id === wrong), 'lowered, not removed: it is still a pick');
  // Accepting the artist into it later lifts the penalty again.
  await vm.runInContext("recordAccept('" + x.tracks[2].track.id + "', wrong)", s);
  const lifted = vm.runInContext('backlogSuggest(t1, A.lib, cfg, A.tags, A.profiles, A.idf)', s);
  const fOf = list => list.find(b => b.id === wrong).score;
  assert.ok(fOf(lifted) > fOf(after));
});

test('the page: with no rejections the File picks are exactly what they were', () => {
  const s = page();
  const A = account(1);
  Object.assign(A, buildProfiles(A.lib, A.tags, A.targets));
  s.A = A; s.cfg = Object.fromEntries([...A.targets].map(id => [id, { target: true, name: id }]));
  for (const fb of [{}, { [A.lib.liked[0].id]: { skips: 3, lastSkip: null, rejected: [] } }]) {
    vm.runInContext('setFB', s)(fb);
    for (const t of A.lib.liked.slice(0, 40)) {
      s.t = t;
      const got = JSON.stringify(vm.runInContext('backlogSuggest(t, A.lib, cfg, A.tags, A.profiles, A.idf)', s));
      const want = JSON.stringify(rank(t, A.tags, A.profiles, A.idf, { top: 8 }).slice(0, 3)
        .map(b => ({ ...b, axis: null, via: 'tags' })));
      assert.equal(got, want);
    }
  }
});

test('mergeFeedback keeps the times, the later one per playlist, and reads old shapes', () => {
  const s = {};
  vm.createContext(s);
  vm.runInContext(slice('function mergeFeedback(local, remote)', '/**', 'mergeFeedback'), s);
  const m = JSON.parse(JSON.stringify(vm.runInContext(`mergeFeedback(
    { t1: { skips: 0, lastSkip: null, rejected: ['A'], rejectedAt: { A: 5 } }, t2: { skips: 0, lastSkip: null, rejected: ['B'] } },
    { t1: { skips: 0, lastSkip: null, rejected: ['A', 'C'], rejectedAt: { A: 9, C: 2 }, accepted: ['D'], acceptedAt: { D: 3 } },
      t2: { skips: 1, lastSkip: null, rejected: [] } })`, s)));
  assert.deepEqual(m.t1, { skips: 0, lastSkip: null, rejected: ['A', 'C'], rejectedAt: { A: 9, C: 2 }, accepted: ['D'], acceptedAt: { D: 3 } });
  assert.deepEqual(m.t2, { skips: 1, lastSkip: null, rejected: ['B'] }, 'no times on either side: no time keys appear');
});

test('every verdict the page writes is stamped, and taking it back takes the stamp too', async () => {
  const s = page();
  const run = c => vm.runInContext(c, s);
  await run("recordReject('t1', 'A')");
  await run("recordAccept('t1', ['A', 'B'])");
  let f = s.peek().t1;
  assert.deepEqual(f.rejected, []);
  assert.equal(f.rejectedAt, undefined, 'an accept lifts the rejection and its time');
  assert.deepEqual(Object.keys(f.acceptedAt).sort(), ['A', 'B']);
  await run("forgetAccept('t1', ['A', 'B'])");
  f = s.peek().t1;
  assert.equal(f.accepted, undefined);
  assert.equal(f.acceptedAt, undefined);
  await run("recordMove('t2', 'A', 'B')");
  f = s.peek().t2;
  assert.deepEqual([f.rejected, Object.keys(f.rejectedAt), f.accepted, Object.keys(f.acceptedAt)], [['A'], ['A'], ['B'], ['B']]);
  await run("unrecordMove('t2', 'A', 'B')");
  f = s.peek().t2;
  assert.equal(f.rejectedAt, undefined);
  assert.equal(f.acceptedAt, undefined);
  await run("recordKeep('t3', 'H', ['X', 'Y'])");
  assert.deepEqual(Object.keys(s.peek().t3.rejectedAt).sort(), ['X', 'Y']);
  await run("recordSkip('t4')");
  assert.deepEqual(Object.keys(s.peek().t4).sort(), ['lastSkip', 'rejected', 'skips'], 'a skip adds no time keys');
});
