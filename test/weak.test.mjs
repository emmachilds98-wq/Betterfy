import { test } from 'node:test';
import assert from 'node:assert/strict';

import { playlistStats, weakPlaylists, weakPairs, diagnoseWeak, weakLine, weakSummary, weakWords, WEAK }
  from '../core/intrinsic/weak.mjs';
import { pairCandidates, fitPairs, pairPick } from '../core/intrinsic/pairs.mjs';
import { audioQueue, FOCUS_MAX } from '../core/audio/queue.mjs';
import { scopeIds } from '../web/audio/settings.mjs';
import * as LISTS from '../web/screens/lists.mjs';
import { weakCard } from '../web/screens/engine.mjs';

// The playlists it understands least, and why (core/intrinsic/weak.mjs).

/** A held-out row: `ranked` best first, `truth` where it is filed. */
const row = (id, ranked, truth) => ({ id, scores: ranked.map((p, i) => [p, 1 - i / 10]), truth });
const T = (id, artist) => ({ id, artists: [{ id: artist }] });

test('per playlist: first, in the top three, and where the misses went', () => {
  const rows = [row('1', ['Q', 'X', 'Y', 'P'], ['P']), row('2', ['Q', 'P', 'Y'], ['P']),
                row('3', ['P', 'Q'], ['P']), row('4', ['Q', 'P'], ['Q'])];
  const s = playlistStats(rows);
  assert.deepEqual({ n: s.get('P').n, top1: s.get('P').top1, inTop3: s.get('P').inTop3, misses: s.get('P').misses },
                   { n: 3, top1: 1, inTop3: 2, misses: 2 });
  assert.equal(s.get('P').missTo.get('Q'), 2);
  assert.equal(s.get('Q').top1, 1);
  // Out-of-scope playlists are neither ranked nor credited.
  const only = playlistStats(rows, { inScope: id => id !== 'Q' });
  assert.ok(!only.has('Q'));
  assert.equal(only.get('P').top1, 2, 'with Q out of scope, P leads the rows where Q was ahead of it');
});

test('weak: below half in the top three, five scored at least, weakest first, with the partner that takes the misses', () => {
  const rows = [];
  for (let i = 0; i < 6; i++) rows.push(row('p' + i, ['Q', 'X', 'Y', 'P'], ['P']));          // P never offered
  for (let i = 0; i < 6; i++) rows.push(row('s' + i, i < 2 ? ['S'] : ['X', 'Y', 'Z', 'S'], ['S'])); // S 33%, misses spread? all to X
  for (let i = 0; i < 4; i++) rows.push(row('t' + i, ['Q', 'X', 'Y', 'T'], ['T']));           // too few scored
  for (let i = 0; i < 10; i++) rows.push(row('q' + i, ['Q', 'P'], ['Q']));
  const weak = weakPlaylists(rows);
  assert.deepEqual(weak.map(w => w.id), ['P', 'S']);
  assert.deepEqual(weak[0].partner, { id: 'Q', misses: 6, share: 1 });
  assert.equal(weak[0].inTop3, 0);
  assert.equal(weak[1].partner.id, 'X');
  // A partner must take its share of the misses.
  const spread = ['A', 'B', 'C', 'D', 'E', 'F'].map((x, i) => row('m' + i, [x, 'G', 'H', 'M'], ['M']));
  assert.equal(weakPlaylists(spread)[0].partner, null);
  assert.deepEqual(weakPairs(weak).map(p => [p.a, p.b, p.weak]), [['P', 'Q', 'P'], ['S', 'X', 'S']]);
  assert.deepEqual(weakPairs([...weak, { id: 'Q', partner: { id: 'P', misses: 2 } }]).length, 2, 'one pair each way round');
});

/** A library around one weak playlist P and its partner Q. */
function libWith({ pSize = 8, shareArtists = 0, shareTracks = 0, qSize = 40 } = {}) {
  const P = Array.from({ length: pSize }, (_, i) => T('p' + i, i < shareArtists ? 'qa' + i : 'pa' + i));
  for (let i = 0; i < shareTracks; i++) P[i] = T('q' + i, 'qa' + i);
  const Q = Array.from({ length: qSize }, (_, i) => T('q' + i, 'qa' + (i % 10)));
  return { playlists: [{ id: 'P', name: 'Dancehall', tracks: P }, { id: 'Q', name: 'Bashment', tracks: Q }] };
}
const weakP = { id: 'P', n: 6, top1: 0, inTop3: 0, misses: 6, partner: { id: 'Q', misses: 6, share: 1 } };
const cause = (lib, o = {}) => diagnoseWeak([weakP], { lib, ...o })[0];

test('the reason: view, working, few, twin, unheard, partner, scattered, in that order of precedence', () => {
  assert.equal(cause(libWith({ pSize: 24, shareTracks: 14 })).cause, 'view');
  const passing = { use: true, rows: [{ key: 'P|Q', use: true, misses: 3, checked: { accuracy: 0.8, n: 30 } }] };
  assert.equal(cause(libWith({ pSize: 8 }), { pairs: passing }).cause, 'working', 'a pair check that works beats "few"');
  const onlyWeak = { use: true, rows: [{ key: 'P|Q', use: true, weak: 'P', misses: 0, checked: { accuracy: 0.8, n: 30 } }] };
  assert.equal(cause(libWith({ pSize: 8 }), { pairs: onlyWeak }).cause, 'few', 'a weak-only pair never re-orders, so it is not "working"');
  const few = cause(libWith({ pSize: 13 }));
  assert.deepEqual([few.cause, few.fix, few.add, few.size], ['few', 'add', WEAK.few - 13, 13]);
  const twin = cause(libWith({ pSize: 30, shareArtists: 12 }));
  assert.deepEqual([twin.cause, twin.fix], ['twin', 'merge']);
  assert.equal(twin.sharedArtists, 0.3333);
  const alike = { use: false, rows: [{ key: 'P|Q', use: false, weak: 'P', misses: 0, checked: { accuracy: 0.52, n: 40 } }] };
  assert.equal(cause(libWith({ pSize: 30 }), { pairs: alike }).cause, 'twin', 'sound can\'t separate them');
  const index = new Map([['p0', {}], ['p1', {}]]);
  assert.deepEqual([cause(libWith({ pSize: 30 }), { index }).cause, cause(libWith({ pSize: 30 }), { index }).heard], ['unheard', 2]);
  assert.equal(cause(libWith({ pSize: 30 })).cause, 'partner');
  const alone = diagnoseWeak([{ ...weakP, partner: null }], { lib: libWith({ pSize: 30 }) })[0];
  assert.deepEqual([alone.cause, alone.loners], ['scattered', 1]);
});

test('the words and the paste line: reason, then fix, with only playlist names and counts', () => {
  const name = id => ({ P: 'Dancehall', Q: 'Bashment' })[id];
  const d = cause(libWith({ pSize: 13 }));
  assert.match(weakWords(d, name).why, /^Only 13 tracks, and usually mistaken for Bashment\.$/);
  assert.match(weakWords(d, name).fix, /^Add 7 more/);
  const line = weakLine([d], name);
  assert.match(line, /^Weakest, as File places: Dancehall 0% of 6 in its top 3 \(few vs Bashment: Add 7 more/);
  assert.ok(!/p\d|qa\d/.test(line), 'no track or artist ids');
  for (const c of ['view', 'working', 'few', 'twin', 'unheard', 'partner', 'scattered'])
    assert.ok(weakWords({ ...d, cause: c, pair: { accuracy: 0.5, n: 20 } }, name).fix.length > 10, c);
  const sum = weakSummary([d], 5);
  assert.deepEqual([sum.at, sum.rows[0].partner, sum.rows[0].cause], [5, 'Q', 'few']);
  // A saved row (partner as an id) reads the same.
  assert.deepEqual(weakWords(sum.rows[0], name), weakWords(d, name));
  assert.equal(weakLine([], name), '');
});

test('pairs: a weak pair is fitted on top of the limit, whatever the family, and never re-orders a card', () => {
  const confused = [row('x', ['A', 'B'], ['B']), row('y', ['A', 'B'], ['B'])];
  const c = pairCandidates(confused, [], { limit: 1, together: () => false, extra: [{ a: 'P', b: 'Q', weak: 'P', misses: 4 }] });
  assert.deepEqual(c.map(p => [p.key, !!p.weak]), [['P|Q', true]], 'A|B is not one family; P|Q is kept anyway');
  // Heard: P and Q far apart, so the check passes.
  const index = new Map(), lib = { playlists: [{ id: 'P', tracks: [] }, { id: 'Q', tracks: [] }] };
  for (let i = 0; i < 14; i++) {
    for (const [pl, dir] of [['P', 0], ['Q', 1]]) {
      const id = `${pl}${i}`, emb = new Float32Array(4); emb[dir] = 1; emb[2] = (i % 3) * 0.05;
      index.set(id, { emb });
      lib.playlists.find(p => p.id === pl).tracks.push({ id, artists: [{ id: 'a' + id }] });
    }
  }
  const rows = [...lib.playlists[0].tracks.map(t => row(t.id, ['Q', 'X', 'Y', 'P'], ['P'])),
                ...lib.playlists[1].tracks.map(t => row(t.id, ['Q', 'P'], ['Q']))];
  const fit = fitPairs(lib, index, rows, [], { extra: [{ a: 'P', b: 'Q', weak: 'P' }] });
  const r = fit.rows.find(x => x.key === 'P|Q');
  assert.ok(r.use && r.weak === 'P' && r.checked.accuracy >= 0.9, JSON.stringify(r));
  assert.equal(fit.impact, null, 'a weak-only pair takes no part in the swap check');
  assert.equal(pairPick('P1', 'Q', 'P', { ...fit, use: true }, index, lib), null, 'and never picks between a card\'s top two');
});

test('listening: the weakest playlists\' tracks come right after unfiled liked songs, all of a small one', () => {
  const lib = { liked: [T('l1', 'x')], playlists: [
    { id: 'BIG', name: 'House', tracks: Array.from({ length: 30 }, (_, i) => T('b' + i, 'h' + i)) },
    { id: 'W', name: 'Dancehall', tracks: Array.from({ length: 12 }, (_, i) => T('w' + i, 'd' + i)) }] };
  const q = audioQueue(lib, { targets: ['BIG', 'W'], focus: ['W'], exemplarsPerPlaylist: 2 });
  assert.equal(q[0], 'l1');
  assert.deepEqual(q.slice(1, 13), Array.from({ length: 12 }, (_, i) => 'w' + i));
  assert.deepEqual(audioQueue(lib, { targets: ['BIG', 'W'], exemplarsPerPlaylist: 2 }).slice(1, 3), ['b0', 'w0'], 'without focus: round-robin as before');
  assert.equal(FOCUS_MAX, 60);
  const allowed = scopeIds(lib, { scope: 'mine', targets: ['BIG', 'W'], focus: ['W'], exemplarsPerPlaylist: 2 });
  for (let i = 0; i < 12; i++) assert.ok(allowed.has('w' + i));
  assert.ok(!allowed.has('b5'));
  assert.ok(!scopeIds(lib, { scope: 'mine', targets: ['BIG', 'W'], exemplarsPerPlaylist: 2 }).has('w5'));
});

const esc = s => String(s ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
function libCtx(rows, at = Date.now()) {
  return { esc, LIB: { playlists: [{ id: 'P', name: 'Dancehall', tracks: [] }, { id: 'Q', name: 'Bashment', tracks: [] },
                                    { id: 'L', name: 'Late Night House', tracks: [] }] }, CFG: {},
           weakSaved: () => ({ at, rows }) };
}

test('Library: the advice for each weak playlist, a merge only through the wizard, nothing without a Score', () => {
  const rows = [
    { id: 'P', n: 7, inTop3: 0, size: 30, cause: 'twin', fix: 'merge', partner: 'Q', sharedArtists: 0.4 },
    { id: 'L', n: 7, inTop3: 0.14, size: 13, cause: 'few', fix: 'add', add: 7, partner: null },
    { id: 'gone', n: 7, inTop3: 0, size: 13, cause: 'few', fix: 'add', add: 7 },
  ];
  const c = libCtx(rows);
  assert.deepEqual(LISTS.weakRows(c).map(d => d.id), ['P', 'L'], 'a playlist no longer there is dropped');
  const list = LISTS.weakListHTML(c);
  assert.match(list, /Playlists it gets wrong most/);
  assert.match(list, /data-act="plopen" data-pl="P"/);
  assert.match(list, /If they are the same kind of music, merge them/);
  assert.match(list, /Add 7 more that only belong here/);
  const sheet = LISTS.weakSheetHTML(c, 'P');
  assert.match(sheet, /Help it learn this one/);
  assert.match(sheet, /0% of the 7 tracks it was checked on \(checked today\)/);
  assert.match(sheet, /data-act="wizmerge" data-a="P" data-b="Q">Merge with Bashment…/);
  assert.ok(!LISTS.weakSheetHTML(c, 'L').includes('wizmerge'), 'adding tracks is the listener\'s to do');
  assert.equal(LISTS.weakSheetHTML(c, 'Q'), '');
  assert.equal(LISTS.weakListHTML({ ...c, weakSaved: () => null }), '');
  assert.equal(LISTS.weakListHTML(libCtx([{ ...rows[0], fix: 'wait', cause: 'unheard' }])), '', 'nothing for the listener to do');
});

test('Engine screen: the reasons on the engine that places, else the engine-alone list as before', () => {
  const LIB = libCtx([]).LIB, p = x => `${Math.round(x * 100)}%`;
  const v = { weak: [{ id: 'P', n: 7, inTop3: 0, size: 13, cause: 'few', fix: 'add', add: 7, partner: { id: 'Q' } }] };
  const html = weakCard(v, LIB, p, esc);
  assert.match(html, /Dancehall <span class="sub">· 0% of 7 scored/);
  assert.match(html, /Only 13 tracks, and usually mistaken for Bashment\./);
  assert.match(html, /add tracks/);
  assert.match(weakCard({ weak: [] }, LIB, p, esc), /None: every genre playlist/);
  const old = weakCard({ mine: { playlists: [{ id: 'P', n: 7, inTop3: 0 }] } }, LIB, p, esc);
  assert.match(old, /Low here means the engine has no real idea/);
});
