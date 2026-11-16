// Fill this playlist in the Library sheet (BUILD-6 F2): the gate as the page
// applies it, and Add / Add all going through the History log as one entry each.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as LISTS from '../web/screens/lists.mjs';
import * as F from '../core/recommend/fill.mjs';

const esc = s => String(s ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
const tr = (id, artist) => ({ id, name: 'Song ' + id, artists: [{ id: artist, name: artist.toUpperCase() }] });

/** A playlist of 20 by two artists, another of 20 by two others, and liked tracks by all four. */
function ctx({ measure = null, force = false, backlog = true } = {}) {
  const A = Array.from({ length: 20 }, (_, i) => tr('a' + i, i % 2 ? 'ann' : 'abe'));
  const B = Array.from({ length: 20 }, (_, i) => tr('b' + i, i % 2 ? 'bob' : 'bea'));
  const liked = [tr('l1', 'ann'), tr('l2', 'bob'), tr('l3', 'abe'), tr('l4', 'bea'), tr('l5', 'zed')];
  const LIB = { captured_at: 't' + Math.random(), liked, playlists: [{ id: 'PA', name: 'Alpha', tracks: A }, { id: 'PB', name: 'Beta', tracks: B }] };
  const store = { 'bf_fill': measure ? JSON.stringify(measure) : null, 'bf_fill_force': force ? '1' : null };
  const calls = { add: [], log: [], undo: [], toast: [], render: 0 };
  let renderWait = null;
  const c = {
    LIB, CFG: { PA: { name: 'Alpha' }, PB: { name: 'Beta' } }, TAGS: null, esc,
    R: { backlog: backlog ? liked.map(t => ({ id: t.id, title: t.name })) : [] }, S: { inboxAt: 0 },
    LS: { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = v; } },
    isMirrorPlaylist: () => false,
    engineLoad: async () => true, engineAudio: async () => null, BetterfyFill: F,
    addTracks: async (id, ids) => { calls.add.push([id, ids]); },
    logAction: async e => { calls.log.push(e); return 'at' + calls.log.length; },
    undoAction: async at => { calls.undo.push(at); },
    newGroup: () => 'g1',
    toast: (msg, undo) => calls.toast.push([msg, undo]),
    render: () => { calls.render++; renderWait?.(); },
  };
  c.rendered = () => new Promise(ok => { renderWait = ok; });
  return { c, calls, store };
}

test('the page bar is the core bar', () => assert.equal(LISTS.FILL_BAR, F.FILL.bar));

test('no section without liked-but-unfiled tracks, or on a short playlist', () => {
  const { c } = ctx({ backlog: false, measure: { recall: 0.9 } });
  assert.equal(LISTS.fillHTML(c, 'PA', c.LIB.playlists[0]), '');
  const { c: c2 } = ctx({ measure: { recall: 0.9 } });
  assert.equal(LISTS.fillHTML(c2, 'PA', { ...c2.LIB.playlists[0], tracks: c2.LIB.playlists[0].tracks.slice(0, 9) }), '');
});

test('unmeasured: offers the check; below the bar: off, with the number', () => {
  const { c } = ctx();
  const html = LISTS.fillHTML(c, 'PA', c.LIB.playlists[0]);
  assert.match(html, /Fill this playlist/);
  assert.match(html, /data-act="fillcheck"/);
  assert.ok(!html.includes('data-act="filladd"'));
  const low = ctx({ measure: { recall: 0.31, random: 0.02 } }).c;
  const off = LISTS.fillHTML(low, 'PA', low.LIB.playlists[0]);
  assert.match(off, /Off for your library: it found <b class="mono">31%<\/b>/);
  assert.match(off, /needs 40%/);
  assert.ok(!off.includes('data-act="filladd"') && !off.includes('fillcheck'));
});

test('the check writes the measure the gate reads', async () => {
  const { c, store } = ctx();
  // Two playlists of 20 are enough to measure.
  const done = LISTS.actions.fillcheck(c);
  await done;
  const m = JSON.parse(store.bf_fill);
  assert.ok(Number.isFinite(m.recall) && m.playlists === 2);
});

test('on: ranks the liked tracks, Add writes one History entry with an undo, Add all one more', async () => {
  const { c, calls } = ctx({ measure: { recall: 0.6 } });
  const pl = c.LIB.playlists[0];
  assert.match(LISTS.fillHTML(c, 'PA', pl), /Finding tracks that fit/);
  await c.rendered();
  const html = LISTS.fillHTML(c, 'PA', pl);
  const ids = [...html.matchAll(/data-act="filladd" data-pl="PA" data-tid="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(ids.slice(0, 2).sort(), ['l1', 'l3'], 'the two by Alpha’s own artists lead');
  assert.match(html, /Add all \d+ shown/);
  assert.match(html, /On your library it finds 60% of hidden tracks/);

  await LISTS.actions.filladd(c, { dataset: { pl: 'PA', tid: ids[0] }, disabled: false });
  assert.deepEqual(calls.add, [['PA', [ids[0]]]]);
  assert.equal(calls.log.length, 1);
  assert.deepEqual({ ...calls.log[0], group: undefined }, { op: 'add', playlistId: 'PA', playlistName: 'Alpha', trackIds: [ids[0]],
    reason: 'fill this playlist', group: undefined });
  assert.ok(!c.R.backlog.some(b => b.id === ids[0]), 'filed: off the File queue');
  assert.ok(!LISTS.fillHTML(c, 'PA', pl).includes(`data-tid="${ids[0]}"`));
  const [msg, undo] = calls.toast.at(-1);
  assert.match(msg, /^Added “Song l\d” to Alpha\.$/);
  await undo();
  assert.deepEqual(calls.undo, ['at1']);
  assert.ok(c.R.backlog.some(b => b.id === ids[0]), 'undone: back in the queue');

  // Ranked again after the undo; then every shown one in a single write and a single entry.
  LISTS.fillHTML(c, 'PA', pl); await c.rendered();
  const shown = [...LISTS.fillHTML(c, 'PA', pl).matchAll(/data-tid="([^"]+)"/g)].map(m => m[1]);
  await LISTS.actions.fillall(c, { dataset: { pl: 'PA' }, disabled: false });
  assert.equal(calls.add.length, 2);
  assert.deepEqual(calls.add[1], ['PA', shown]);
  assert.equal(calls.log.length, 2, 'one History entry for the lot');
  assert.deepEqual(calls.log[1].trackIds, shown);
  assert.match(calls.toast.at(-1)[0], new RegExp(`^Added ${shown.length} tracks to Alpha\\.$`));
});

test('the owner flag shows it below the bar, and says what it measured', async () => {
  const { c } = ctx({ measure: { recall: 0.2 }, force: true });
  LISTS.fillHTML(c, 'PB', c.LIB.playlists[1]); await c.rendered();
  assert.match(LISTS.fillHTML(c, 'PB', c.LIB.playlists[1]), /Shown by the flag; it measured 20%/);
});
