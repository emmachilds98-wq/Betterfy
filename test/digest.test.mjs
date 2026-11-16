// F5 "since you last opened" (docs/BUILD-6-PLAN.md §4.1/§4.2): every figure the
// digest prints is a count of one source, and these tests count that source
// independently and require the two to agree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDigest, filedIn, digestWindow, playlistMap, playlistDiff, listeningShift, digestBaseline,
         parseBaseline, digestLines, misfitKey, FALLBACK_MS, DAY } from '../core/measure/digest.mjs';
import { measureHistory, isFiling } from '../core/measure/history.mjs';
import * as INBOX from '../web/screens/inbox.mjs';

const T0 = Date.parse('2026-11-10T12:00:00.000Z');
const iso = (offMin) => new Date(T0 + offMin * 60000).toISOString();
const NOW = T0 + 3 * DAY;

/** A History log with every kind of entry the digest must count or ignore. */
function sampleLog() {
  return [
    // before the window: never counted
    { at: iso(-60 * 24 * 10), op: 'add', playlistId: 'p1', trackIds: ['old'], reason: 'filed from inbox', band: 'sure' },
    // in the window: three cards filed, one later undone
    { at: iso(1), op: 'add', playlistId: 'p1', trackIds: ['a'], reason: 'filed from inbox', band: 'sure', undoneAt: iso(2) },
    { at: iso(3), op: 'add', playlistId: 'p1', trackIds: ['b'], reason: 'filed from inbox', band: 'sure' },
    { at: iso(4), op: 'add', playlistId: 'p2', trackIds: ['c'], reason: 'filed from inbox', band: 'likely' },
    // one track filed into two playlists: one song, two entries
    { at: iso(5), op: 'add', playlistId: 'p1', trackIds: ['d'], reason: 'filed from inbox', band: 'sure' },
    { at: iso(6), op: 'add', playlistId: 'p2', trackIds: ['d'], reason: 'filed from inbox', band: 'sure' },
    // a sure batch, one group of two steps, undone as a group via an undo entry
    { at: iso(10), op: 'add', playlistId: 'p1', trackIds: ['e', 'f'], reason: 'filed the sure ones', band: 'sure', group: 'g1' },
    { at: iso(11), op: 'add', playlistId: 'p3', trackIds: ['g'], reason: 'filed the sure ones', band: 'sure', group: 'g1' },
    { at: iso(12), op: 'undo', of: iso(11), ofGroup: 'g1', trackIds: ['g'] },
    // filed, then taken out of the same playlist later (Tidy): moved
    { at: iso(20), op: 'add', playlistId: 'p2', trackIds: ['h'], reason: 'filed with the rest of X', band: 'sure' },
    { at: iso(30), op: 'remove', playlistId: 'p2', trackIds: ['h'], reason: 'tidy', move: { tier: 'likely' } },
    // not filings: skips, discovery adds, unlikes
    { at: iso(40), op: 'skip', trackIds: ['s'], queuePos: 0 },
    { at: iso(41), op: 'add', playlistId: 'p1', trackIds: ['z'], reason: 'from discovery' },
    { at: iso(42), op: 'unlike', trackIds: ['u'] },
    // after the session opened: belongs to the next digest
    { at: new Date(NOW + 1000).toISOString(), op: 'add', playlistId: 'p1', trackIds: ['late'], reason: 'filed from inbox' },
  ];
}

/** The same figures, counted the plain way from the raw log. */
function countByHand(log, since, until) {
  const inWin = e => Date.parse(e.at) >= since && Date.parse(e.at) < until;
  const filings = log.filter(e => isFiling(e) && inWin(e));
  const undoneAts = new Set(log.filter(e => e.op === 'undo').map(e => e.of));
  const undoneGroups = new Set(log.filter(e => e.op === 'undo' && e.ofGroup).map(e => e.ofGroup));
  const tracks = new Set(filings.flatMap(e => e.trackIds));
  const back = new Set();
  for (const e of filings) {
    const undone = e.undoneAt || undoneAts.has(e.at) || (e.group && undoneGroups.has(e.group));
    const removed = log.some(x => x.op === 'remove' && x.at > e.at && x.playlistId === e.playlistId && x.trackIds.some(t => e.trackIds.includes(t)));
    if (undone || removed) e.trackIds.forEach(t => back.add(t));
  }
  return { entries: filings.length, tracks: tracks.size, back: back.size };
}

test('filed and "later moved or undone" equal the History log, counted by hand', () => {
  const log = sampleLog(), since = T0 - DAY, until = NOW;
  const got = filedIn(log, since, until), want = countByHand(log, since, until);
  assert.deepEqual(got, want);
  // and the literal numbers, so the hand count cannot drift with the code
  assert.deepEqual(got, { entries: 8, tracks: 8, back: 5 });   // a,b,c,d,e,f,g,h; back: a, e,f,g (the group), h
});

test('filed equals History in any order, newest-first as getLog gives it', () => {
  const log = sampleLog();
  assert.deepEqual(filedIn([...log].reverse(), T0 - DAY, NOW), filedIn(log, T0 - DAY, NOW));
});

test('"moved or undone" equals the batch measure on the same sure-band filings', () => {
  // Single-track, sure-band filings only: then "tracks back" and the batch
  // measure's "entries back" are the same count over the same entries.
  const log = sampleLog().filter(e => !(e.trackIds?.length > 1) && !(e.op === 'add' && e.band !== 'sure' && isFiling(e)))
    .filter(e => !['late', 'old'].includes(e.trackIds?.[0]) && !(e.trackIds?.[0] === 'd' && e.playlistId === 'p2'));
  const m = measureHistory(log), f = filedIn(log, -Infinity, Infinity);
  assert.equal(f.entries, m.batch.n);
  assert.equal(f.back, m.batch.back);
});

test('the window: since the last open, else the last seven days; ends where this session opened', () => {
  assert.deepEqual(digestWindow(null, NOW), { since: NOW - FALLBACK_MS, until: NOW, sinceLastOpen: false });
  assert.deepEqual(digestWindow({ at: iso(0) }, NOW), { since: T0, until: NOW, sinceLastOpen: true });
  // a clock that went backwards is not a last open
  assert.equal(digestWindow({ at: new Date(NOW + DAY).toISOString() }, NOW).sinceLastOpen, false);
  const d = buildDigest({ base: { at: iso(4.5) }, now: NOW, log: sampleLog() });
  assert.deepEqual(d.filed, countByHand(sampleLog(), Date.parse(iso(4.5)), NOW));
});

test('new liked songs waiting equal the liked list in the window that are still in the backlog', () => {
  const liked = [
    { id: 'l1', added_at: iso(5) }, { id: 'l2', added_at: iso(6) }, { id: 'l3', added_at: iso(7) },
    { id: 'l4', added_at: iso(-60 * 24 * 30) },            // long before
    { id: 'l5', added_at: new Date(NOW + 5).toISOString() },  // after the open
    { id: 'l6' },                                            // no date
  ];
  const backlog = [{ id: 'l1' }, { id: 'l3' }, { id: 'l4' }, { id: 'l5' }, { id: 'l6' }];
  const d = buildDigest({ base: { at: iso(0) }, now: NOW, liked, backlog });
  const want = liked.filter(t => Date.parse(t.added_at) >= T0 && Date.parse(t.added_at) < NOW && backlog.some(b => b.id === t.id)).length;
  assert.equal(d.likedWaiting, want);
  assert.equal(d.likedWaiting, 2);
  assert.equal(d.likedNew, 3);
});

test('new misfits are the rows of R.misfiled not there at the last open; none without one', () => {
  const misfiled = [{ id: 't1', currentPlaylistId: 'p1' }, { id: 't2', currentPlaylistId: 'p1' },
                    { id: 't1', currentPlaylistId: 'p2' }, { id: 't3', currentPlaylistId: 'p3' }];
  const base = { at: iso(0), misfits: [misfitKey(misfiled[0]), misfitKey({ id: 'gone', currentPlaylistId: 'p9' })] };
  const d = buildDigest({ base, now: NOW, misfiled });
  assert.equal(d.misfits, misfiled.filter(m => !base.misfits.includes(misfitKey(m))).length);
  assert.equal(d.misfits, 3);
  assert.equal(buildDigest({ base: null, now: NOW, misfiled }).misfits, null);
});

test('new genres are clusters overlapping no cluster seen at the last open', () => {
  const r = (p, n) => Array.from({ length: n }, (_, i) => p + i);
  const base = { at: iso(0), genres: [r('a', 10), r('b', 8)] };
  const genres = [
    { ids: [...r('a', 7), ...r('x', 3)] },   // 7 of 10 shared: the same genre, grown
    { tracks: r('b', 3).concat(r('y', 9)).map(id => ({ id })) },  // 3 of 8 shared: below half, new
    { ids: r('c', 6) },                      // new
  ];
  assert.equal(buildDigest({ base, now: NOW, genres }).newGenres, 2);
  assert.equal(buildDigest({ base, now: NOW, genres: null }).newGenres, null, 'not worked out this session: no line');
  assert.equal(buildDigest({ base: { at: iso(0) }, now: NOW, genres }).newGenres, null, 'nothing remembered: nothing is new');
});

test('playlist snapshot diff counts changed, new and gone playlists and the net tracks', () => {
  const pl = (id, snap, n) => ({ id, name: id, snapshot_id: snap, tracks: Array.from({ length: n }, (_, i) => ({ id: id + i })) });
  const before = playlistMap([pl('p1', 's1', 10), pl('p2', 's1', 5), pl('p3', 's1', 4), pl('p4', 's1', 2), { id: 'unread', snapshot_id: null, tracks: [] }]);
  const after = playlistMap([pl('p1', 's2', 13), pl('p2', 's2', 3), pl('p3', 's1', 4), pl('p5', 's1', 6), pl('mirror', 's1', 9)],
                            p => p.id === 'mirror');
  assert.deepEqual(playlistDiff(before, after), { changed: 2, added: 1, gone: 1, plus: 3 + 6, minus: 2 + 2 });
  assert.equal(playlistDiff(null, after), null);
  const d = buildDigest({ base: { at: iso(0), pls: before }, now: NOW, playlists: after });
  assert.deepEqual(d.playlists, playlistDiff(before, after));
  assert.equal(d.empty, false);
});

test('listening shift is the overlap of the short- and long-term top artists the listening fetch cached', () => {
  const raw = { topWindows: [
    { range: 'short_term', items: ['A', 'B', 'C', 'D', 'E', 'F', 'A'] },
    { range: 'medium_term', items: ['Q'] },
    { range: 'long_term', items: ['A', 'B', 'C', 'X', 'Y', 'Z'] } ] };
  assert.deepEqual(listeningShift(raw), { top: 6, overlap: 3, fresh: 3, examples: ['D', 'E', 'F'] });
  assert.equal(listeningShift({ topWindows: [{ range: 'short_term', items: ['A'] }] }), null);
  assert.equal(listeningShift(null), null);
  // never a reason to show the card on its own
  const d = buildDigest({ base: { at: iso(0) }, now: NOW, listening: raw });
  assert.equal(d.empty, true);
  assert.equal(digestLines(d), null);
});

test('nothing to say: empty, and no lines', () => {
  const d = buildDigest({ base: { at: iso(0), misfits: [], genres: [], pls: {} }, now: NOW, log: [], liked: [], backlog: [],
                         misfiled: [], genres: [], playlists: {} });
  assert.equal(d.empty, true);
  assert.equal(digestLines(d), null);
});

test('the printed lines carry exactly the digest figures', () => {
  const pl = (id, snap, n) => ({ id, snapshot_id: snap, tracks: Array.from({ length: n }, () => ({})) });
  const d = buildDigest({ base: { at: iso(0), misfits: [], genres: [['q1', 'q2', 'q3', 'q4']], pls: playlistMap([pl('p1', 's1', 2)]) },
    now: NOW, log: sampleLog(), liked: [{ id: 'l1', added_at: iso(9) }], backlog: [{ id: 'l1' }],
    misfiled: [{ id: 'm', currentPlaylistId: 'p1' }], genres: [{ ids: ['n1', 'n2', 'n3', 'n4'] }],
    playlists: playlistMap([pl('p1', 's2', 5)]),
    listening: { topWindows: [{ range: 'short_term', items: ['A', 'B', 'C', 'D', 'E'] }, { range: 'long_term', items: ['A', 'B', 'C', 'D', 'Z'] }] } });
  const L = digestLines(d), by = Object.fromEntries(L.lines.map(l => [l.k, l]));
  assert.equal(L.head, 'Since you last opened, 3 days ago');
  assert.equal(by.filed.text, `Filed ${d.filed.tracks} songs, ${d.filed.back} later moved or undone`);
  assert.equal(by.liked.text, '1 new liked song waiting to be filed');
  assert.equal(by.misfits.text, '1 new misfit found');
  assert.equal(by.misfits.go, 'tidy');
  assert.equal(by.genres.text, '1 new genre forming in what File is unsure about');
  assert.equal(by.playlists.text, '1 playlist changed (+3 tracks)');
  assert.equal(by.listening.text, "1 of your top 5 artists lately aren't in your all-time top (E)");
  assert.deepEqual(L.lines.map(l => l.k), ['filed', 'liked', 'misfits', 'genres', 'playlists', 'listening']);
  assert.equal(digestLines(buildDigest({ base: null, now: NOW, log: sampleLog() })).head, 'In the last 7 days');
});

test('the baseline: what to compare with next time, carrying over what this session never worked out', () => {
  const prev = { at: iso(0), genres: [['g1', 'g2']], pls: { p: ['s', 1, 'P'] } };
  const b = digestBaseline({ prev, now: NOW, misfiled: [{ id: 't', currentPlaylistId: 'p' }], genres: null, playlists: null });
  assert.equal(b.at, new Date(NOW).toISOString());
  assert.deepEqual(b.misfits, ['t|p']);
  assert.deepEqual(b.genres, prev.genres);
  assert.deepEqual(b.pls, prev.pls);
  const b2 = digestBaseline({ prev, now: NOW, genres: [{ ids: ['x'] }, { ids: [] }], playlists: {} });
  assert.deepEqual(b2.genres, [['x']]);
  assert.deepEqual(b2.pls, {});
  assert.deepEqual(parseBaseline(JSON.stringify(b)), b);
  for (const bad of ['', 'nope', 'null', '{"at":"never"}', '[1]']) assert.equal(parseBaseline(bad), null);
});

/* ---- the File screen's card (web/screens/inbox.mjs) ---- */

function memLS(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), m };
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function cardCtx({ log = [], base = null, now = Date.now() } = {}) {
  const LS = memLS(base ? { [INBOX.DIGEST_SEEN]: JSON.stringify(base) } : {});
  let renders = 0;
  const ctx = {
    S: {}, R: { backlog: [{ id: 'l1' }], misfiled: [{ id: 'm1', currentPlaylistId: 'p1' }] },
    LIB: { liked: [{ id: 'l1', added_at: new Date(now - DAY).toISOString() }], playlists: [{ id: 'p1', snapshot_id: 's1', tracks: [{}] }] },
    COLD: { status: 'idle' }, LS, esc, isMirrorPlaylist: () => false,
    getLog: async () => [...log].reverse(), listeningRaw: async () => null,
    render: () => { renders++; },
  };
  return { ctx, LS, renders: () => renders };
}

test('File: no digest before it loads, and none for a brand-new account with no History', async () => {
  const { ctx } = cardCtx();
  assert.equal(INBOX.digestHTML(ctx), '');
  await INBOX.digestMount(ctx);
  assert.equal(ctx.S.digest.status, 'ready');
  assert.equal(INBOX.digestHTML(ctx), '');
});

test('File: the card shows the figures, writes the next baseline, and counts expand and dismiss locally', async () => {
  const now = Date.now();
  const log = [{ at: new Date(now - 2 * DAY).toISOString(), op: 'add', playlistId: 'p1', trackIds: ['x'], reason: 'filed from inbox' },
               { at: new Date(now - 2 * DAY + 1).toISOString(), op: 'add', playlistId: 'p1', trackIds: ['y'], reason: 'filed from inbox', undoneAt: new Date(now - DAY).toISOString() }];
  const { ctx, LS, renders } = cardCtx({ log, base: { at: new Date(now - 3 * DAY).toISOString(), misfits: [], pls: { p1: ['s0', 0, 'P'] } } });
  await INBOX.digestMount(ctx);
  assert.equal(renders(), 1, 'repaints once when there is something to say');
  const html = INBOX.digestHTML(ctx);
  assert.match(html, /id="digestCard"/);
  assert.match(html, /Since you last opened, 3 days ago/);
  assert.match(html, /2 filed · 1 new liked · 1 misfit · 1 playlist changed/);
  assert.match(html, /data-act="digestHide"/);
  // this open is the next baseline
  const saved = JSON.parse(LS.getItem(INBOX.DIGEST_SEEN));
  assert.equal(saved.at, new Date(ctx.S.digest.at).toISOString());
  assert.deepEqual(saved.misfits, ['m1|p1']);
  assert.deepEqual(saved.pls, { p1: ['s1', 1, ''] });

  INBOX.actions.digestMore(ctx);
  INBOX.actions.digestMore(ctx);
  const open = INBOX.digestHTML(ctx);
  assert.match(open, /Filed 2 songs, 1 later moved or undone/);
  assert.match(open, /data-go="tidy"/);
  INBOX.actions.digestHide(ctx);
  assert.equal(INBOX.digestHTML(ctx), '');
  assert.deepEqual(INBOX.digestMeasure(ctx), { shown: 0, expanded: 1, dismissed: 1 });
  assert.deepEqual(JSON.parse(LS.getItem(INBOX.DIGEST_MEASURE)), { shown: 0, expanded: 1, dismissed: 1 });
});

test('File: the next open compares with the baseline this one left, so the same figures are not repeated', async () => {
  const now = Date.now();
  const log = [{ at: new Date(now - DAY).toISOString(), op: 'add', playlistId: 'p1', trackIds: ['x'], reason: 'filed from inbox' }];
  const first = cardCtx({ log });
  await INBOX.digestMount(first.ctx);
  assert.match(INBOX.digestHTML(first.ctx), /In the last 7 days/);
  // Next session, a moment later, same library: nothing new since.
  const second = cardCtx({ log });
  second.LS.setItem(INBOX.DIGEST_SEEN, first.LS.getItem(INBOX.DIGEST_SEEN));
  second.ctx.LIB.liked = [];
  await INBOX.digestMount(second.ctx);
  assert.equal(INBOX.digestHTML(second.ctx), '');
});
