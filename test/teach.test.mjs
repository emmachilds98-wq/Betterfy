// The teach queue (BUILD-6 SG; docs/SMARTER-GENRES-PLAN.md §4.3, phase 4).
//
// Gate: "Score after 20 teach answers beats before". Measured two ways, on
// synthetic accounts only (test/fixtures: nothing here is a real listener's data):
//
//   1. The waiting liked songs of the small/typical/large accounts, answered from
//      an answer key (each fixture artist's leading genre in docs/tags.json, the
//      tag the fixture built its genre playlists from). Score = the account-native
//      engine's top-1 on the waiting tracks nobody was asked about.
//   2. teachGate, the per-account gate the Score run applies: a hidden fold of the
//      account's own filing stands in for the queue.
//
// What it found (2026-11-16), and so what ships:
//
//                  before    after 20 answers
//   small          21.1%     26.3%   (4 -> 5 of 19)
//   typical        82.1%     80.4%   (92 -> 90 of 112)
//   large          73.7%     74.2%   (3672 -> 3695 of 4980)
//   gate typical   26.3%     27.2%   (+1 track: under the bar)
//   gate large     10.5%     10.5%
//   gate shaped    36.9%     39.3%   (+2 tracks, +2.4 points: passes, by exactly
//                                    the minimum; with 3 calibration folds instead
//                                    of the Score run's 5 it is +1 and shut)
//
// No reliable gain: one answer about an artist barely moves the account-native
// engine, because an artist enters the co-occurrence graph only from two
// playlists (cooccurrence.mjs MIN_ARTIST_PLAYLISTS) and one filing shifts a
// playlist's centroid by one member in forty. So the teach card ships behind the
// per-account gate (`bf_teach`, written by the Score run), shut on every fixture
// account here except the owner-shaped one. This file holds those verdicts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeAccount } from './fixtures/accounts.mjs';
import { shapedLibrary } from './fixtures/shaped-library.mjs';
import { teachQueue, teachValue, choicesOf, artistSpread, artistKeyOf, TEACH } from '../core/review/teach.mjs';
import { simulateTeach, teachGate, teachVerdict, withAnswers, TEACH_GATE } from '../core/validate/teach.mjs';

const TAGS = JSON.parse(readFileSync(new URL('../docs/tags.json', import.meta.url), 'utf8'));

/* ---------- the queue ---------- */

const row = (id, artist, o = {}) => ({ id, artists: [{ id: artist, name: artist.toUpperCase() }], artist: artist.toUpperCase(),
                                        added: '2024-01-01', skips: 0, ...o });
const pl = (...ids) => ids.map(id => ({ id, name: 'Name ' + id }));

test('choices: a checked short list, the card\'s guesses when unsure, nothing when confident', () => {
  const g = () => pl('x', 'y', 'z', 'w');
  assert.deepEqual(choicesOf(row('t', 'a'), { kind: 'choose', playlists: pl('p', 'q') }, g),
                   { choices: pl('p', 'q'), checked: true });
  assert.deepEqual(choicesOf(row('t', 'a'), { kind: 'unsure', playlists: [] }, g), { choices: pl('x', 'y', 'z'), checked: false });
  assert.deepEqual(choicesOf(row('t', 'a'), null, g).checked, false, 'no verdict reads as unsure');
  assert.equal(choicesOf(row('t', 'a'), { kind: 'confident', playlists: ['p'] }, g), null);
  assert.equal(choicesOf(row('t', 'a'), { kind: 'unsure' }, () => []), null, 'nothing to offer, nothing to ask');
  // Plain ids from decide() work as well as { id, name } from the page.
  assert.deepEqual(choicesOf(row('t', 'a'), { kind: 'choose', playlists: ['p'] }).choices, [{ id: 'p', name: 'p' }]);
});

test('value: reach, listening and an open question each raise it; confident is never asked', () => {
  const spread = new Map([['a', 8], ['b', 1]]);
  const two = { kind: 'choose', choices: pl('p', 'q') };
  assert.ok(teachValue(row('1', 'a'), two, { spread }) > teachValue(row('2', 'b'), two, { spread }), 'reach');
  const weights = new Map([['B', 3]]);
  assert.ok(teachValue(row('2', 'b'), two, { spread, weights }) > teachValue(row('2', 'b'), two, { spread }), 'listening');
  assert.ok(teachValue(row('2', 'b'), two) > teachValue(row('2', 'b'), { kind: 'choose', choices: pl('p') }), 'two over one');
  assert.ok(teachValue(row('2', 'b'), { kind: 'unsure', choices: pl('p', 'q') }) > teachValue(row('2', 'b'), two), 'unsure over choose');
  assert.equal(teachValue(row('2', 'b'), { kind: 'confident', choices: pl('p') }), 0);
  assert.equal(teachValue(row('2', 'b'), { kind: 'choose', choices: [] }), 0);
});

test('the batch: one per artist, most valuable first, skipped, answered and rejected left out', () => {
  const rows = [row('a1', 'a'), row('a2', 'a'), row('a3', 'a'), row('b1', 'b'), row('c1', 'c'), row('d1', 'd'),
                row('e1', 'e', { skips: 1 }), row('f1', 'f'), row('g1', 'g')];
  const dec = { a1: { kind: 'choose', playlists: pl('p', 'q') }, a2: { kind: 'choose', playlists: pl('p', 'q') },
                a3: { kind: 'confident', playlists: pl('p') },
                b1: { kind: 'confident', playlists: pl('p') }, c1: { kind: 'unsure', playlists: [] },
                d1: { kind: 'choose', playlists: pl('p', 'q') }, f1: { kind: 'choose', playlists: pl('r') } };
  const q = teachQueue(rows, { decisionOf: r => dec[r.id] ?? null, guesses: r => (r.id === 'g1' ? [] : pl('x', 'y')),
                               answered: new Set(['d1']), rejected: (r, id) => r.id === 'f1' && id === 'r' });
  const ids = q.map(x => x.row.id);
  assert.equal(ids.filter(id => id.startsWith('a')).length, 1, 'one question per artist');
  assert.equal(ids[0].startsWith('a'), true, 'the artist with three waiting tracks first');
  for (const gone of ['b1', 'd1', 'e1', 'f1', 'g1']) assert.ok(!ids.includes(gone), gone);
  assert.ok(ids.includes('c1') && q.find(x => x.row.id === 'c1').checked === false, 'unsure: best guesses');
  assert.equal(q.find(x => x.row.id.startsWith('a')).checked, true);
  assert.ok(teachQueue(rows, { decisionOf: r => dec[r.id] ?? null, limit: 1 }).length === 1);
  assert.equal(teachQueue([], {}).length, 0);
  assert.equal(TEACH.batch, 10, 'ten at a time (plan §4.3)');
});

test('artist keys and spread read backlog rows and raw tracks alike', () => {
  assert.equal(artistKeyOf({ artists: [{ id: 'x' }] }), 'x');
  assert.equal(artistKeyOf({ artist: 'Foo, Bar' }), 'Foo');
  assert.equal(artistKeyOf({}), null);
  assert.deepEqual([...artistSpread([row('1', 'a'), row('2', 'a'), row('3', 'b')])], [['a', 2], ['b', 1]]);
});

/* ---------- the measurement ---------- */

/** A fixture account's waiting liked songs and where each really goes: the playlists
 *  built from its artist's leading genre (test/fixtures/accounts.mjs). */
function keyed(kind) {
  const lib = makeAccount(kind);
  const g = id => TAGS[id]?.[0]?.[0];
  const plGenre = new Map(lib.playlists.map(p => {
    const c = new Map();
    for (const t of p.tracks) c.set(g(t.artists[0].id), (c.get(g(t.artists[0].id)) ?? 0) + 1);
    return [p.id, [...c].sort((a, b) => b[1] - a[1])[0][0]];
  }));
  const filed = new Set(lib.playlists.flatMap(p => p.tracks.map(t => t.id)));
  const waiting = lib.liked.filter(t => !filed.has(t.id));
  const truth = new Map(waiting.map(t => [t.id, lib.playlists.filter(p => plGenre.get(p.id) === g(t.artists[0].id)).map(p => p.id)]));
  return { lib, waiting, truth };
}

test('withAnswers files a copy and leaves the library alone', () => {
  const { lib, waiting } = keyed('small');
  const pid = lib.playlists[0].id, n = lib.playlists[0].tracks.length;
  const next = withAnswers(lib, [[waiting[0], pid]]);
  assert.equal(next.playlists[0].tracks.length, n + 1);
  assert.equal(lib.playlists[0].tracks.length, n);
});

test('20 simulated answers on the fixture accounts: before and after, on the same unanswered tracks', { timeout: 120000 }, t => {
  const want = {
    small:   { n: 19,   before: 4,    after: 5 },
    typical: { n: 112,  before: 92,   after: 90 },
    large:   { n: 4980, before: 3672, after: 3695 },
  };
  for (const kind of ['small', 'typical', 'large']) {
    const { lib, waiting, truth } = keyed(kind);
    const r = simulateTeach(lib, { waiting, truth });
    t.diagnostic(`${kind}: ${r.before.top1} -> ${r.after.top1} (${r.before.right} -> ${r.after.right} of ${r.before.n}), ${r.inList} of ${r.asked} on the list`);
    assert.equal(r.asked, 20, `${kind}: 20 questions asked`);
    assert.equal(r.answered.length, 20);
    assert.equal(new Set(r.answered.map(([id]) => id)).size, 20, 'never the same track twice');
    assert.equal(r.before.n, r.after.n, 'scored on the same tracks');
    assert.ok(r.answered.every(([id, pid]) => truth.get(id).includes(pid)), 'every answer is where the track really goes');
    assert.deepEqual({ n: r.before.n, before: r.before.right, after: r.after.right }, want[kind],
      `${kind}: the measured result moved. Re-measure, update the table at the top of this file, and check the gate verdicts below still say what ships.`);
    // The honest reading: nothing here clears the gate's bar.
    assert.ok(!teachVerdict({ asked: r.asked, scored: r.before.n, gain: r.gain, right: [r.before.right, r.after.right] }).pass,
      `${kind}: a gain this size would open the gate`);
  }
});

test('the per-account gate: shut where answers did not help, open where they did', { timeout: 120000 }, t => {
  const verdicts = {};
  for (const kind of ['empty', 'small', 'typical', 'large']) verdicts[kind] = teachGate(makeAccount(kind));
  const shaped = shapedLibrary();
  verdicts.shaped = teachGate(shaped, { targets: shaped.targets });
  for (const [k, v] of Object.entries(verdicts)) t.diagnostic(`${k}: ${v.pass ? 'open' : 'shut'} (${v.why}) ${v.before} -> ${v.after}`);
  assert.match(verdicts.empty.why, /not enough filed tracks/);
  assert.match(verdicts.small.why, /not enough filed tracks/);
  assert.equal(verdicts.typical.pass, false);
  assert.equal(verdicts.large.pass, false);
  assert.match(verdicts.typical.why, /did not move the score enough/);
  // The positive control: the gate can open, on the owner-shaped synthetic library.
  assert.equal(verdicts.shaped.pass, true, `shaped: ${verdicts.shaped.why}`);
  assert.ok(verdicts.shaped.after > verdicts.shaped.before);
  for (const v of Object.values(verdicts)) assert.equal(JSON.stringify(v).length < 2000, true, 'small enough to keep in localStorage');
});

test('the verdict: all 20 asked, enough left to score, a point and two tracks better', () => {
  const ok = { asked: 20, scored: 100, gain: 0.02, right: [50, 52] };
  assert.equal(teachVerdict(ok).pass, true);
  assert.equal(teachVerdict(ok).why, 'beats');
  assert.match(teachVerdict({ ...ok, asked: 12 }).why, /only 12 of 20/);
  assert.match(teachVerdict({ ...ok, scored: 10 }).why, /only 10 tracks/);
  assert.equal(teachVerdict({ ...ok, right: [50, 51] }).pass, false, 'one track is not a verdict');
  assert.equal(teachVerdict({ ...ok, gain: 0.005 }).pass, false, 'under a point');
  assert.equal(teachVerdict({ ...ok, gain: 0, right: [50, 50] }).pass, false, 'a tie does not beat');
  assert.equal(TEACH_GATE.answers, 20);
});
