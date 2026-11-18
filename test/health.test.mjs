// The library health report and the Tidy sprint's counts (BUILD-6 F9): core/review/health.mjs,
// and the Tidy screen drawing them (web/screens/tidy.mjs) on a fixture ctx.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tidyCounts, sectionFor, healthInputs, rankHealth, sprintStart, sprintDecide, sprintUndo, sprintStats,
  sprintSave, sprintTotals, REPORT_N, HEALTHY, SPRINT_KEEP } from '../core/review/health.mjs';
import { playlistHealth, repeatCount, staleDays, twinsOf } from '../web/screens/lists.mjs';
import * as TIDY from '../web/screens/tidy.mjs';

const h = (score, notes = []) => ({ score, word: score >= 85 ? 'Healthy' : score >= 65 ? 'Fine' : 'Needs a look', notes });

test('tidyCounts counts Wrong place by currentPlaylistId, By sound by from, Repeats by playlistId', () => {
  const m = tidyCounts({
    misfiled: [{ currentPlaylistId: 'a' }, { currentPlaylistId: 'a' }, { playlistId: 'b' }],
    soundRows: [{ from: 'b' }], within: [{ playlistId: 'c' }, { playlistId: 'a' }] });
  assert.deepEqual(m.get('a'), { misfile: 2, sound: 0, dupes: 1 });
  assert.deepEqual(m.get('b'), { misfile: 0, sound: 1, dupes: 0 }, 'a row with only playlistId is not a misfile row');
  assert.deepEqual(m.get('c'), { misfile: 0, sound: 0, dupes: 1 });
  assert.equal(sectionFor(m.get('a')), 'misfile');
  assert.equal(sectionFor(m.get('b')), 'sound');
  assert.equal(sectionFor(m.get('c')), 'dupes');
  assert.equal(sectionFor({ misfile: 0, sound: 0, dupes: 0 }), null);
  assert.equal(sectionFor(undefined), null);
});

test('healthInputs reads misfiled rows by currentPlaylistId, so the score sees them', () => {
  const list = [{ id: 'x', added_at: '2020-01-01T00:00:00Z' }, { id: 'x' }, ...Array.from({ length: 10 }, (_, i) => ({ id: 't' + i }))];
  const inp = healthInputs({ id: 'p', tracks: 12, list,
    misfiled: [{ currentPlaylistId: 'p' }, { currentPlaylistId: 'p' }, { currentPlaylistId: 'q' }],
    drift: [{ playlistId: 'p' }], splitIds: new Set(['p']), undecidedIds: new Set(), twins: new Map([['p', ['Other']]]) },
    { repeatCount, staleDays });
  assert.equal(inp.misfiled, 2);
  assert.equal(inp.drifting, true);
  assert.equal(inp.split, true);
  assert.equal(inp.undecided, false);
  assert.deepEqual(inp.twins, ['Other']);
  assert.equal(inp.repeats, 1);
  assert.ok(inp.staleDays >= 365);
  const score = playlistHealth(inp);
  assert.ok(score.score < 65, 'Library\'s own score, from these inputs');
  assert.match(score.notes[0], /2 tracks look misfiled/);
  // No helpers: no repeats, no staleness, nothing invented.
  const bare = healthInputs({ id: 'p', tracks: 9 });
  assert.deepEqual(bare, { tracks: 9, misfiled: 0, drifting: false, split: false, undecided: false, twins: [], repeats: 0, staleDays: null });
});

test('rankHealth: the worst five under 85, lowest first, with why and where to go', () => {
  const rows = [
    { id: 'a', name: 'A', tracks: 50, health: h(40, ['x', 'y', 'z', 'w']), tidy: { misfile: 3, sound: 0, dupes: 0 } },
    { id: 'b', name: 'B', tracks: 50, health: h(90) },
    { id: 'c', name: 'C', tracks: 5, health: null },
    { id: 'd', name: 'D', tracks: 20, health: h(70, ['repeats']), tidy: { misfile: 0, sound: 0, dupes: 2 } },
    { id: 'e', name: 'E', tracks: 30, health: h(70, ['old']) },
    { id: 'f', name: 'F', tracks: 80, health: h(70) },
    { id: 'g', name: 'G', tracks: 10, health: h(84) },
    { id: 'i', name: 'I', tracks: 10, health: h(60) },
    { id: 'j', name: 'J', tracks: 10, health: h(85) },
  ];
  const out = rankHealth(rows);
  assert.equal(out.length, REPORT_N);
  assert.deepEqual(out.map(r => r.id), ['a', 'i', 'd', 'f', 'e'], 'score, then fixable work, then size');
  assert.deepEqual(out[0], { id: 'a', name: 'A', score: 40, word: 'Needs a look', why: ['x', 'y', 'z'], section: 'misfile', fixable: 3 });
  assert.equal(out[2].section, 'dupes');
  assert.equal(out[3].section, null);
  assert.ok(!out.some(r => r.score >= HEALTHY));
  // Order does not depend on the input's.
  assert.deepEqual(rankHealth([...rows].reverse()).map(r => r.id), out.map(r => r.id));
  assert.deepEqual(rankHealth([]), []);
  assert.deepEqual(rankHealth(null), []);
});

test('sprint counts: decisions a minute and moves kept, with undo', () => {
  const s = sprintStart(0);
  sprintDecide(s, 'move', { d: 1 }, 5000);
  sprintDecide(s, 'keep', { id: 'k' }, 10000);
  sprintDecide(s, 'move', { d: 2 }, 15000);
  let st = sprintStats(s);
  assert.equal(st.decisions, 3);
  assert.equal(st.perMin, 12);
  assert.equal(st.kept, 1);
  const back = sprintUndo(s, 20000);
  assert.deepEqual(back, { kind: 'move', d: 2 });
  st = sprintStats(s);
  assert.equal(st.decisions, 2, 'an undone decision does not count');
  assert.equal(st.moves, 1);
  assert.equal(st.made, 2);
  assert.equal(st.kept, 0.5, 'one of the two moves made was taken back');
  assert.equal(st.undos, 1);
  assert.equal(st.perMin, 6);
  assert.equal(sprintUndo(s, 21000).kind, 'keep');
  assert.equal(sprintUndo(s, 22000).kind, 'move');
  assert.equal(sprintUndo(s, 23000), null);
  st = sprintStats(s);
  assert.equal(st.decisions, 0);
  assert.equal(st.perMin, null);
  assert.equal(st.kept, 0);
  assert.equal(sprintStats(sprintStart(0)).kept, null, 'no move, no kept rate');
});

test('sprintSave keeps the newest SPRINT_KEEP sessions and drops empty ones; sprintTotals adds them up', () => {
  let list = [];
  list = sprintSave(list, { decisions: 0, undos: 0 }, 't0');
  assert.deepEqual(list, []);
  for (let i = 0; i < SPRINT_KEEP + 3; i++)
    list = sprintSave(list, { decisions: 6, moves: 4, made: 5, keeps: 2, undos: 1, ms: 60000, perMin: 6, kept: 0.8 }, 't' + i);
  assert.equal(list.length, SPRINT_KEEP);
  assert.equal(list.at(-1).at, 't' + (SPRINT_KEEP + 2));
  const tot = sprintTotals(list);
  assert.equal(tot.sessions, SPRINT_KEEP);
  assert.equal(tot.perMin, 6);
  assert.equal(tot.kept, 0.8);
  assert.deepEqual(sprintTotals('junk'), { sessions: 0, decisions: 0, perMin: null, kept: null });
  assert.deepEqual(sprintSave([null, { decisions: 'x' }], { decisions: 1, moves: 1, made: 1, ms: 1000 }, 'a').length, 1);
});

/* ---------- the Tidy screen ---------- */

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const tr = (id, extra = {}) => ({ id, name: 'Song ' + id, artists: [{ name: 'Artist' }], duration_ms: 1000, ...extra });
function ctx(over = {}) {
  const LIB = { playlists: [
    { id: 'p1', name: 'House', tracks: Array.from({ length: 12 }, (_, i) => tr('h' + i)) },
    { id: 'p2', name: 'Techno', tracks: Array.from({ length: 12 }, (_, i) => tr('t' + i)) },
    { id: 'p3', name: 'Jazz', tracks: [...Array.from({ length: 11 }, (_, i) => tr('j' + i)), tr('j0')] },
  ] };
  const mf = (id, from, fromName, to, toName, confidence = 'high') => ({ id, title: 'Song ' + id, artist: 'Artist', current: fromName,
    currentPlaylistId: from, currentScore: 0.05, confidence, suggest: [{ id: to, name: toName, score: 0.6 }] });
  const R = { within: [{ verdict: 'same-recording', playlistId: 'p3', playlist: 'Jazz', title: 'Song j0', options: [{ id: 'j0', dur: '1:00' }, { id: 'j0b', dur: '1:00' }] }],
    across: [], drift: [{ playlistId: 'p2' }],
    misfiled: [mf('h1', 'p1', 'House', 'p2', 'Techno'), mf('h2', 'p1', 'House', 'p2', 'Techno'), mf('h3', 'p1', 'House', 'p2', 'Techno', 'medium'),
      mf('t1', 'p2', 'Techno', 'p1', 'House')] };
  const calls = [];
  const S = { mfBand: 'high', moved: new Set(), crossMin: 3 };
  const store = new Map();
  return { calls, S, R, LIB, FB: {}, CFG: { p1: { name: 'House', tracks: 12 }, p2: { name: 'Techno', tracks: 12 }, p3: { name: 'Jazz', tracks: 12 } },
    T: {}, esc, thumbHTML: () => '<i class="th"></i>', cmpTable: () => '', tagChips: () => '', tagEditorHTML: () => '',
    emptyState: (t, b) => `<div class="empty-state">${t} ${b}</div>`, moreButton: () => '', shownOf: () => 50,
    store: { touch() {} }, getListening: () => Promise.resolve(), LISTENING_CACHE: null, LISTENING_PENDING: true,
    tidySoundOn: () => false, tidySoundRows: () => [], tidySoundCount: () => 0, tidySoundWarm() {}, TSOUND: {},
    render() { calls.push(['render']); }, toast(m) { calls.push(['toast', m]); },
    recordKeep: async (id, here, away) => { calls.push(['keep', id, here, away]); },
    recordMove: async () => {}, newGroup: () => 'g', addTracks: async (p, ids) => calls.push(['add', p, ids]),
    delTracks: async (p, ids) => calls.push(['del', p, ids]), playlistIds: async () => [], logAction: async e => { calls.push(['log', e.op, e.move?.tier]); return 'at-' + calls.length; },
    undoAction: async at => calls.push(['undo', at]), saveFeedback: async () => calls.push(['savefb']),
    LS: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }, store_: store,
    libHealth: { playlistHealth, repeatCount, staleDays, twinsOf }, NO_SIGNAL: 'no signal',
    ...over };
}

test('Tidy has a Health section only when a playlist scores under 85, and never opens on it', () => {
  const c = ctx();
  const html = TIDY.view(c);
  assert.match(html, /data-tidy="health">Health <span class="n">2<\/span>/);
  assert.match(html, /aria-pressed="true" data-act="section" data-tidy="misfile"/);
  // Without Library's score (an older ctx) there is no Health section at all.
  assert.ok(!/data-tidy="health"/.test(TIDY.view(ctx({ libHealth: undefined }))));
  // Nothing misfiled, no repeats: nothing under 85.
  assert.ok(!/data-tidy="health"/.test(TIDY.view(ctx({ R: { within: [], across: [], misfiled: [], drift: [] } }))));
});

test('the report lists the worst first with why, and Tidy N opens at that playlist', () => {
  const c = ctx();
  c.S.tidySec = 'health';
  const html = TIDY.view(c);
  const ids = [...html.matchAll(/data-hpl="(\w+)"/g)].map(m => m[1]);
  assert.deepEqual(ids, ['p1', 'p2'], 'House (3 misfiled of 12) before Techno (1)');
  assert.match(html, /3 tracks look misfiled/);
  assert.match(html, /data-act="hgo" data-hpl="p1" data-hsec="misfile" aria-label="Tidy 3 in House">Tidy 3</);
  TIDY.actions.hgo(c, { dataset: { hpl: 'p2', hsec: 'misfile' } });
  assert.equal(c.S.tidyPl, 'p2');
  assert.equal(c.S.tidySec, 'misfile');
  assert.equal(c.S.mfBand, 'high');
  const at = TIDY.view(c);
  assert.match(at, /Only <b>Techno<\/b>/);
  assert.match(at, /data-mvtr="t1"/);
  assert.ok(!/data-mvtr="h1"/.test(at), 'only that playlist\'s rows');
  TIDY.actions.hclear(c);
  assert.equal(c.S.tidyPl, null);
  assert.match(TIDY.view(c), /data-mvtr="h1"/);
});

test('the report picks the band that has the playlist\'s rows', () => {
  const c = ctx();
  c.R.misfiled = c.R.misfiled.filter(m => m.id === 'h3');
  TIDY.actions.hgo(c, { dataset: { hpl: 'p1', hsec: 'misfile' } });
  assert.equal(c.S.mfBand, 'medium');
});

test('sprint: one track at a time, → moves, ← keeps, U undoes, Esc saves the counts', async () => {
  const c = ctx();
  const bar = TIDY.view(c);
  assert.match(bar, /data-act="spstart" data-spsec="misfile"[^>]*>Sprint through 3</);
  TIDY.actions.spstart(c, { dataset: { spsec: 'misfile' } });
  let html = TIDY.view(c);
  assert.match(html, /id="sprint"/);
  assert.match(html, /id="sprintCard" tabindex="-1" role="group"[^>]*data-sptr="h1"/);
  assert.match(html, /aria-keyshortcuts="ArrowRight">Move to Techno/);
  assert.match(html, /aria-keyshortcuts="ArrowLeft"><kbd>←<\/kbd> Keep in House/);
  assert.match(html, /data-act="spundo" aria-keyshortcuts="U" disabled/);
  assert.ok(!/class="rows"/.test(html), 'the list gives way to the one track');

  TIDY.actions.spmove(c);
  assert.ok(c.S.moved.has('h1'), 'the screen moves on at once');
  assert.match(TIDY.view(c), /data-sptr="h2"/);
  TIDY.actions.spkeep(c);
  assert.ok(!c.R.misfiled.some(m => m.id === 'h2'), 'kept rows leave the list');
  assert.match(TIDY.view(c), /data-sptr="t1"/);
  TIDY.actions.spundo(c);
  assert.match(TIDY.view(c), /data-sptr="h2"/, 'the keep is undone and the row is back where it was');
  assert.equal(c.R.misfiled.findIndex(m => m.id === 'h2'), 1);
  TIDY.actions.spundo(c);
  assert.ok(!c.S.moved.has('h1'));
  assert.match(TIDY.view(c), /data-sptr="h1"/, 'the move is undone too');
  TIDY.actions.spmove(c);
  TIDY.actions.spmove(c);
  TIDY.actions.spmove(c);
  html = TIDY.view(c);
  assert.match(html, /Sprint done/);
  // Wait for the chained writes and the undo, in order.
  await new Promise(r => setTimeout(r, 20));
  const seq = c.calls.filter(x => ['add', 'del', 'undo'].includes(x[0])).map(x => x[0] + ':' + (x[1]?.[0] === 'p' ? x[1] : '')).join(' ');
  assert.equal(seq, 'add:p2 del:p1 undo: add:p2 del:p1 add:p2 del:p1 add:p1 del:p2');
  assert.ok(c.calls.some(x => x[0] === 'log' && x[1] === 'remove' && x[2] === 'sure'), 'moves carry the tier History counts');
  TIDY.actions.spend(c);
  assert.equal(c.S.sprint, null);
  const saved = JSON.parse(c.store_.get('bf_tidy_sprint'));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].decisions, 3);
  assert.equal(saved[0].made, 4);
  assert.equal(saved[0].kept, 0.75);
});

test('switching section ends a sprint and clears the playlist filter', () => {
  const c = ctx();
  c.S.tidyPl = 'p1';
  TIDY.actions.spstart(c, { dataset: { spsec: 'misfile' } });
  TIDY.actions.spkeep(c);
  TIDY.actions.section(c, { dataset: { tidy: 'dupes' } });
  assert.equal(c.S.sprint, null);
  assert.equal(c.S.tidyPl, null);
  assert.equal(JSON.parse(c.store_.get('bf_tidy_sprint'))[0].keeps, 1);
});

// DESIGN-PLAN §7.7 M3: By sound's rows are Wrong place rows, so the sprint walks them first.
test('the Wrong place sprint walks the band\'s by-sound rows, then the tag rows', () => {
  const snd = { id: 's1', from: 'p1', to: 'p2', fromName: 'House', toName: 'Techno', band: 'sure', why: ['x'] };
  const c = ctx({ tidySoundRows: () => [snd, { ...snd, id: 's2', band: 'likely' }], tidySoundCount: () => 2 });
  assert.deepEqual(TIDY.sprintRows(c, 'misfile').map(x => x.id), ['s1', 'h1', 'h2', 't1']);
  c.S.mfBand = 'medium';
  assert.deepEqual(TIDY.sprintRows(c, 'misfile').map(x => x.id), ['s2', 'h3']);
  c.S.mfBand = 'low';
  assert.deepEqual(TIDY.sprintRows(c, 'misfile').map(x => x.id), []);
  // Library's "Tidy N" link to sound lands on Wrong place, on the band that has rows.
  TIDY.actions.hgo(c, { dataset: { hpl: 'p1', hsec: 'sound' } });
  assert.deepEqual([c.S.tidySec, c.S.mfBand, c.S.tidyPl], ['misfile', 'high', 'p1']);
});
