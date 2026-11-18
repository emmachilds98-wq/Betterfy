// The merge/split wizard (BUILD-6 F4): the pure planning in
// core/playlists/mergesplit.mjs, and the wizard in web/screens/lists.mjs driven
// through its ctx: what it shows, what it writes, one History group, rollback.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as MS from '../core/playlists/mergesplit.mjs';
import * as LISTS from '../web/screens/lists.mjs';

const T = (id, isrc, name = id) => ({ id, isrc, name, artists: [{ name: 'Art ' + id }] });

test('trackKey: the ISRC when there is one (any case), else the id; nothing for a blank slot', () => {
  assert.equal(MS.trackKey(T('a', 'gbabc1')), 'isrc:GBABC1');
  assert.equal(MS.trackKey({ id: 'a', external_ids: { isrc: 'X1' } }), 'isrc:X1');
  assert.equal(MS.trackKey(T('a', null)), 'id:a');
  assert.equal(MS.trackKey({ id: null }), null);
});

test('mergePlan: all of the first in order, then what only the second has; same id or same ISRC counted once', () => {
  const a = { id: 'A', name: 'Deep', tracks: [T('1', 'I1'), T('2', 'I2'), T('2', 'I2'), { id: null }, T('3', null)] };
  const b = { id: 'B', name: 'Deeper', tracks: [T('2', 'I2'), T('9', 'I1'), T('4', 'I4'), T('5', null), T('4', 'I4')] };
  const p = MS.mergePlan(a, b);
  assert.equal(p.kind, 'merge');
  assert.deepEqual(p.parts[0].rows.map(r => r.id), ['1', '2', '3', '4', '5'], '"9" is "1" relinked: the same ISRC');
  assert.deepEqual(p.parts[0].rows.map(r => r.from), ['a', 'a', 'a', 'b', 'b']);
  assert.equal(p.parts[0].name, 'Deep + Deeper');
  assert.deepEqual(p.counts, { a: 3, b: 2, both: 2, total: 5, dupes: 4 });
  assert.deepEqual(p.sources.map(s => s.id), ['A', 'B']);
  assert.equal(MS.mergeName({ name: 'x'.repeat(90) }, { name: 'y'.repeat(20) }).length, 100);
});

test('splitPlan: each part its named tracks in playlist order; the rest to part 0, or left out', () => {
  const pl = { id: 'H', name: 'House', tracks: ['h1', 'j1', 'h2', 'u1', 'j2', 'h1'].map(id => T(id, 'I' + id)) };
  const parts = [{ name: 'House — House', ids: ['h2', 'h1'] }, { name: 'House — Jungle', ids: ['j2', 'j1', 'h1'] }];
  const p = MS.splitPlan(pl, parts);
  assert.deepEqual(p.parts.map(x => x.rows.map(r => r.id)), [['h1', 'h2', 'u1'], ['j1', 'j2']]);
  assert.equal(p.rest, 1);
  assert.deepEqual(p.parts[0].rows.map(r => r.from), ['named', 'named', 'rest']);
  const out = MS.splitPlan(pl, parts, { restTo: -1 });
  assert.deepEqual(out.parts[0].rows.map(r => r.id), ['h1', 'h2']);
});

test('parts from a sound split and a tag split', () => {
  assert.deepEqual(MS.partsFromSound('House', { keep: { name: 'House', ids: ['a'] }, move: { name: 'Jungle', ids: ['b'] } }),
    [{ name: 'House — House', ids: ['a'] }, { name: 'House — Jungle', ids: ['b'] }]);
  assert.deepEqual(MS.partsFromTags({ name: 'Bass', parts: [{ label: 'Bass', rest: true, ids: ['a'] }, { label: 'UK Garage', ids: ['b'] }] }),
    [{ name: 'Bass — rest of Bass', ids: ['a'] }, { name: 'Bass — UK Garage', ids: ['b'] }]);
  assert.deepEqual(MS.partsFromSound('X', null), []);
});

test('moveTrack, renamePart and includePart are pure, and writesOf says what would be made and why not', () => {
  const pl = { id: 'P', name: 'P', tracks: ['a', 'b', 'c'].map(id => T(id, null)) };
  const p0 = MS.splitPlan(pl, [{ name: 'One', ids: ['a', 'b'] }, { name: 'Two', ids: ['c'] }]);
  const p1 = MS.moveTrack(p0, 'a', 1);
  assert.deepEqual(p0.parts[0].rows.map(r => r.id), ['a', 'b'], 'the old plan is untouched');
  assert.deepEqual(p1.parts.map(x => x.rows.map(r => r.id)), [['b'], ['c', 'a']]);
  assert.equal(MS.moveTrack(p1, 'zz', 0), p1);
  assert.equal(MS.moveTrack(p1, 'a', 7), p1);
  assert.deepEqual(MS.writesOf(p1), { writes: [{ name: 'One', ids: ['b'] }, { name: 'Two', ids: ['c', 'a'] }], problems: [] });
  assert.deepEqual(MS.writesOf(MS.includePart(p1, 0, false)).writes.map(w => w.name), ['Two']);
  assert.match(MS.writesOf(MS.renamePart(p1, 1, '  ')).problems[0], /needs a name/);
  assert.match(MS.writesOf(MS.renamePart(p1, 1, ' one ')).problems[0], /same name/);
  const empty = MS.moveTrack(MS.moveTrack(MS.moveTrack(p1, 'b', 1), 'c', 1), 'a', 1);
  assert.deepEqual(MS.writesOf(empty).writes.map(w => w.name), ['Two'], 'an empty part is not made');
  assert.match(MS.writesOf(MS.includePart(empty, 1, false)).problems[0], /Nothing to make/);
});

test('twinOffers: one offer per indistinguishable pair, either way round; views and self-pairs are not twins', () => {
  const pairs = [
    { verdict: 'indistinguishable', a: { id: 'x', name: 'X' }, b: { id: 'y', name: 'Y' }, similarity: 0.99 },
    { verdict: 'indistinguishable', a: { id: 'y', name: 'Y' }, b: { id: 'x', name: 'X' } },
    { verdict: 'view', a: { id: 'x' }, b: { id: 'z' } },
    { verdict: 'indistinguishable', a: { id: 'q' }, b: { id: 'q' } },
  ];
  const o = MS.twinOffers(pairs);
  assert.equal(o.length, 1);
  assert.equal(o[0].key, 'merge:x+y');
  assert.equal(MS.offerKey('merge', ['y', 'x']), 'merge:x+y');
  assert.equal(MS.offerKey('split', ['P']), 'split:P');
  assert.deepEqual(MS.twinOffers(null), []);
});

test('the measure: shown once per offer, dismissed and made count as shown, the rate against its bar', () => {
  let m = null;
  const rec = (what, key, at) => { const n = MS.recordOffer(m, what, key, at); if (n) m = n; return n; };
  assert.ok(rec('shown', 'split:A', 1));
  assert.equal(rec('shown', 'split:A', 2), null, 'shown again: nothing new');
  assert.equal(m.shown['split:A'], 1, 'the first time stands');
  assert.ok(rec('dismissed', 'merge:x+y', 3));
  assert.equal(m.shown['merge:x+y'], 3);
  assert.equal(rec('dismissed', 'merge:x+y', 4), null);
  let r = MS.dismissRate(m);
  assert.deepEqual([r.shown, r.dismissed, r.made, r.rate, r.enough], [2, 1, 0, 0.5, false]);
  assert.deepEqual([r.merge.shown, r.split.shown], [1, 1]);
  assert.match(MS.dismissLine(m), /2 shown, 1 dismissed \(50%\), 0 made\. Not enough data yet \(2 of 10\)/);
  for (let i = 0; i < 10; i++) rec('made', 'split:P' + i, 10 + i);
  r = MS.dismissRate(JSON.stringify(m));
  assert.deepEqual([r.shown, r.dismissed, r.made, r.enough, r.ok], [12, 1, 10, true, true]);
  assert.match(MS.dismissLine(m), /Within the 25% bar/);
  assert.equal(MS.dismissLine(null), '');
  assert.deepEqual(MS.readMeasure('{nope'), { shown: {}, dismissed: {}, made: {} });
  assert.deepEqual(MS.readMeasure({ shown: { a: 'x', b: 2 } }).shown, { b: 2 });
});

/* ---------- the wizard, through lists.mjs's ctx ---------- */

function ctx({ failAddOn = null } = {}) {
  const store = new Map();
  const calls = [], log = [];
  let n = 0;
  const A = { id: 'A', name: 'Deep', tracks: [T('1', 'I1'), T('2', 'I2')] };
  const B = { id: 'B', name: 'Deeper', tracks: [T('2', 'I2'), T('3', 'I3')] };
  const H = { id: 'H', name: 'Bass', tracks: ['h1', 'h2', 'g1', 'g2', 'x1'].map(id => T(id, 'I' + id)) };
  const c = {
    S: { plSheet: null }, LIB: { playlists: [A, B, H], liked: [] }, CFG: {}, R: {},
    LS: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
    GAPS: { status: 'ready', splits: [{ playlistId: 'H', name: 'Bass', parts: [
      { label: 'Bass', rest: true, ids: ['h1', 'h2'] }, { label: 'UK Garage', ids: ['g1', 'g2'] }] }] },
    esc: s => String(s ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]),
    $: () => null, listsSplits: () => [],
    twinPairs: () => [{ verdict: 'indistinguishable', a: { id: 'A', name: 'Deep' }, b: { id: 'B', name: 'Deeper' } }],
    toast: (m, undo) => calls.push(['toast', m, !!undo]), render: () => calls.push(['render']),
    openPlSheet: id => { c.S.plSheet = id; calls.push(['open', id]); },
    newGroup: () => 'g1',
    sp: async (path, o) => { calls.push(['sp', path, JSON.parse(o.body)]); return { id: 'NEW' + (++n) }; },
    addTracks: async (id, ids) => { if (id === failAddOn) throw new Error('403 refused'); calls.push(['add', id, ids]); },
    landedIn: async () => [],
    logAction: async e => { const at = 't' + log.length; log.push({ at, ...e }); return at; },
    undoAction: async at => { calls.push(['undo', at]); },
  };
  return { c, calls, log, store };
}

test('wizard: a merge previews the combined list, makes one private playlist, one History entry with created, one undo', async () => {
  const { c, calls, log, store } = ctx();
  LISTS.wizardOpen(c, { kind: 'merge', a: 'A', b: 'B' });
  assert.deepEqual(calls.at(-1), ['open', 'A']);
  const html = LISTS.sheetHTML(c, 'A');
  assert.match(html, /<h2>Merge two playlists<\/h2>/);
  assert.match(html, /id="wiznm0" value="Deep \+ Deeper"/);
  assert.equal((html.match(/<li class="wizrow/g) ?? []).length, 3, 'track 2 once');
  assert.match(html, /data-act="wizgo"[^>]*>Make 1 playlist</);
  assert.ok(!html.includes('data-act="wizmove"'), 'a merge has one part: nothing to move between');
  await LISTS.actions.wizgo(c);
  assert.deepEqual(calls.filter(x => x[0] === 'sp'), [['sp', '/me/playlists', { name: 'Deep + Deeper', public: false, description: 'Made by Betterfy, merged from Deep and Deeper.' }]]);
  assert.deepEqual(calls.filter(x => x[0] === 'add'), [['add', 'NEW1', ['1', '2', '3']]]);
  assert.equal(log.length, 1);
  assert.deepEqual({ ...log[0], at: undefined }, { at: undefined, op: 'add', group: 'g1', playlistId: 'NEW1', playlistName: 'Deep + Deeper',
    trackIds: ['1', '2', '3'], created: true, reason: 'merged from Deep and Deeper' });
  assert.ok(!calls.some(x => x[0] === 'add' && ['A', 'B'].includes(x[1])), 'the originals are never written');
  assert.match(LISTS.sheetHTML(c, 'A'), /Made <b>Deep \+ Deeper<\/b>/);
  assert.ok(JSON.parse(store.get('bf_mergesplit')).made['merge:A+B']);
  await LISTS.actions.wizundo(c, { disabled: false });
  assert.deepEqual(calls.find(x => x[0] === 'undo'), ['undo', 't0']);
  assert.match(LISTS.sheetHTML(c, 'A'), /Undone/);
  LISTS.actions.wizback(c);
  assert.ok(!LISTS.sheetHTML(c, 'A').includes('Merge two playlists'));
});

test('wizard: a split from the Gaps tags previews both parts; moved tracks and a left-out part shape the writes; one group', async () => {
  const { c, calls, log } = ctx();
  LISTS.wizardOpen(c, { kind: 'split', id: 'H', src: 'tags' });
  let html = LISTS.sheetHTML(c, 'H');
  assert.match(html, /Split “Bass”/);
  assert.match(html, /id="wiznm0" value="Bass — rest of Bass"/);
  assert.match(html, /id="wiznm1" value="Bass — UK Garage"/);
  assert.match(html, /data-act="wizmove" data-tid="g1" data-to="0"/);
  assert.match(html, /x1<\/span>[\s\S]*?not placed/, 'a track neither part names goes with the first, marked');
  LISTS.actions.wizmove(c, { dataset: { tid: 'g1', to: '0' } });
  html = LISTS.sheetHTML(c, 'H');
  assert.match(html, /Make 2 playlists/);
  await LISTS.actions.wizgo(c);
  assert.deepEqual(calls.filter(x => x[0] === 'add'), [['add', 'NEW1', ['h1', 'h2', 'x1', 'g1']], ['add', 'NEW2', ['g2']]]);
  assert.deepEqual(log.map(e => [e.group, e.created, e.playlistId]), [['g1', true, 'NEW1'], ['g1', true, 'NEW2']]);
  assert.ok(log.every(e => e.reason === 'split from Bass'));
  assert.equal(calls.filter(x => x[0] === 'toast').at(-1)[2], true, 'the toast carries an Undo');

  const two = ctx();
  LISTS.wizardOpen(two.c, { kind: 'split', id: 'H', src: 'tags' });
  LISTS.actions.wizinc(two.c, { dataset: { k: '0' }, checked: false });
  await LISTS.actions.wizgo(two.c);
  assert.deepEqual(two.calls.filter(x => x[0] === 'sp').map(x => x[2].name), ['Bass — UK Garage']);
});

test('wizard: a write that fails half way is rolled back through the group, and says so', async () => {
  const { c, calls, log } = ctx({ failAddOn: 'NEW2' });
  LISTS.wizardOpen(c, { kind: 'split', id: 'H', src: 'tags' });
  await LISTS.actions.wizgo(c);
  assert.equal(log.length, 2, 'the second playlist exists, so it is logged (with what landed) before the rollback');
  assert.deepEqual(log[1].trackIds, []);
  assert.deepEqual(calls.find(x => x[0] === 'undo'), ['undo', 't0'], 'one undo of the group');
  assert.match(LISTS.sheetHTML(c, 'H'), /That didn’t work: 403 refused Nothing was left behind\./);
});

test('Library: twins surface as merge offers (they used to live only on Engine); Not now hides them and is counted', () => {
  const { c, store } = ctx();
  Object.assign(c, { CFG: { A: { name: 'Deep', tracks: 2, axis: 'genre' }, B: { name: 'Deeper', tracks: 2, axis: 'genre' } },
    tagCoverage: () => ({ pct: 90 }), NO_SIGNAL: 'none', playlistMixes: () => ({ mix: new Map() }),
    LISTS_SOUND: { profile: () => null }, R: {}, GAPS: { status: 'idle' } });
  let html = LISTS.view(c);
  assert.match(html, /Playlists that sound the same/);
  assert.match(html, /data-act="wizmerge" data-a="A" data-b="B"/);
  assert.ok(!/Merge\/split offers/.test(html), 'the rate line is cut from Library (C2); the measure is still kept');
  assert.equal(JSON.parse(store.get('bf_mergesplit')).shown['merge:A+B'] != null, true);
  LISTS.actions.wizdismiss(c, { dataset: { key: 'merge:A+B' } });
  html = LISTS.view(c);
  assert.ok(!html.includes('Playlists that sound the same'));
  assert.ok(JSON.parse(store.get('bf_mergesplit')).dismissed['merge:A+B']);
});
