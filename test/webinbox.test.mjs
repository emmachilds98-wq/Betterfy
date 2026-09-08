import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// The File screen used to write to Spotify the instant you tapped a playlist
// name — one misclick and a track was filed somewhere wrong, with only a
// toast's undo link as a way back. These tests cover the fix: a tap only ever
// builds a selection (which can include more than one playlist), and nothing
// reaches Spotify until File is actually pressed or the card is swiped.

const BUNDLE = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');

const between = (from, to, what) => {
  const i = BUNDLE.indexOf(from), j = BUNDLE.indexOf(to);
  assert.ok(i > 0 && j > i, `${what} not found — rebuild with npm run build:web`);
  return BUNDLE.slice(i, j);
};

function load({ backlog = [], inboxAt = 0, sel = new Set() } = {}) {
  const calls = { add: [], log: [], undo: [] };
  const sandbox = {
    R: { backlog }, S: { inboxAt, fileSel: sel, fileSelFor: sel.size ? backlog[inboxAt]?.id ?? null : null },
    CFG: { p1: { name: 'Jungle & Breaks' }, p2: { name: 'Late Night' } },
    matchMedia: () => ({ matches: false }),
    esc: s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])),
    mmss: ms => ms == null ? '—' : `${Math.floor(ms/60000)}:${String(Math.round(ms%60000/1000)).padStart(2,'0')}`,
    hueOf: () => 200,
    ICON_PLAY: '<svg id="playicon"></svg>',
    toast: (msg) => { calls.toast = msg; },
    render: () => { calls.rendered = (calls.rendered ?? 0) + 1; },
    addTracks: async (pl, ids) => { calls.add.push([pl, ...ids]); },
    logAction: async e => { calls.log.push(e); },
    getLog: async () => [{ at: 'T' + calls.log.length }],
    undoAction: async at => { calls.undo.push(at); },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(between('function artHTML(t', 'function vTidy()', 'vInbox'), sandbox);
  vm.runInContext(between('function toggleFileSel(id)', '// Keyboard parity', 'toggleFileSel/fileCurrent/inboxAct'), sandbox);
  return Object.assign(sandbox, { calls });
}

const track = (id, over = {}) => ({ id, title: 'Rinse It', artist: 'Tim Reaper', album: 'A', released: '2023',
  dur: 200000, art: null, added: '2024-01-01', tags: [],
  suggest: [{ id: 'p1', name: 'Jungle & Breaks', axis: 'genre', score: 0.6 },
            { id: 'p2', name: 'Late Night', axis: 'mood', score: 0.3 }], ...over });

test('tapping a suggested playlist only selects it — nothing is written yet', () => {
  const app = load({ backlog: [track('t1')] });
  const html = app.vInbox();
  assert.match(html, /data-selfile="p1"/, 'a pick is a selection toggle, not an instant file');
  assert.doesNotMatch(html, /data-file="p1"/, 'the old instant-file attribute must be gone');
  assert.deepEqual(app.calls.add, []);
});

/* ---- a suggestion built from filing history, not tags (see profile.mjs's artistHistory) ---- */

test('a history-based suggestion reads as a placement count, not a misleading tag-fit percentage', () => {
  const html = load({ backlog: [track('t1', {
    suggest: [{ id: 'p1', name: 'Jungle & Breaks', axis: 'genre', score: 0.8, count: 4, total: 5, via: 'history' }],
  })] }).vInbox();
  assert.match(html, /4 of 5 other tracks by this artist are already here/);
  assert.match(html, />no tags yet</);
  assert.doesNotMatch(html, />80%</, 'never shown as if it were a tag-cosine fit');
});

test('a tag-based suggestion is unaffected by the history rendering path', () => {
  const html = load({ backlog: [track('t1')] }).vInbox(); // default fixture: via is unset, i.e. 'tags'
  assert.match(html, />60%</);
  assert.doesNotMatch(html, /other tracks by this artist/);
});

test('the confirm button is disabled with nothing to file and no fallback pick', () => {
  const app = load({ backlog: [track('t2', { suggest: [] })] });
  const html = app.vInbox();
  assert.match(html, /data-filesel="1" disabled/);
  assert.match(html, /Pick a playlist below/);
});

test('the confirm button names the single best pick until you choose otherwise', () => {
  const html = load({ backlog: [track('t1')] }).vInbox();
  assert.match(html, /data-filesel="1"[^>]*>File in Jungle &amp; Breaks</);
});

test('selecting a second playlist changes the confirm button to a count, and marks both picks', () => {
  const html = load({ backlog: [track('t1')], sel: new Set(['p1', 'p2']) }).vInbox();
  assert.match(html, /File into 2 playlists/);
  // A selected pick shows a check instead of its rank number.
  assert.match(html, />✓<[\s\S]*Jungle/);
  assert.match(html, />✓<[\s\S]*Late Night/);
});

test('a playlist added only via the dropdown shows as a removable chip', () => {
  const html = load({ backlog: [track('t1')], sel: new Set(['p9']) }).vInbox();
  assert.match(html, /data-selfile="p9"[^>]*title="Remove"/);
});

test('switching to a different track clears the previous selection', () => {
  const app = load({ backlog: [track('t1'), track('t2')], inboxAt: 0, sel: new Set(['p1']) });
  app.vInbox(); // renders track 0, adopting fileSelFor = 't1'
  app.S.inboxAt = 1;
  const html = app.vInbox();
  assert.equal(app.S.fileSel.size, 0, 'a fresh track starts with nothing selected');
  assert.doesNotMatch(html, /border-color:var\(--accent\)/, 'so nothing shows as pre-picked');
});

test('confirming a multi-select files into every chosen playlist and logs one action each', async () => {
  const app = load({ backlog: [track('t1')] });
  await app.fileCurrent(['p1', 'p2']);
  assert.deepEqual(app.calls.add.sort(), [['p1', 't1'], ['p2', 't1']]);
  assert.equal(app.calls.log.length, 2);
  assert.match(app.calls.toast, /2 playlists/);
  assert.equal(app.R.backlog.length, 0, 'the filed track leaves the queue');
});

test('a single id still works — the swipe gesture and keyboard paths pass one, not an array', async () => {
  const app = load({ backlog: [track('t1')] });
  await app.fileCurrent('p1');
  assert.deepEqual(app.calls.add, [['p1', 't1']]);
  assert.match(app.calls.toast, /Jungle & Breaks/);
});

test('undoing a multi-select file undoes every playlist it touched', async () => {
  const app = load({ backlog: [track('t1')] });
  let undo;
  app.toast = (msg, fn) => { undo = fn; };
  await app.fileCurrent(['p1', 'p2']);
  await undo();
  assert.deepEqual(app.calls.undo.sort(), ['T1', 'T2']);
});

test('filing clears the selection, so the next track starts blank', async () => {
  const app = load({ backlog: [track('t1')], sel: new Set(['p1']) });
  await app.fileCurrent(['p1']);
  assert.equal(app.S.fileSel.size, 0);
});

test('toggleFileSel adds and removes, and re-renders either way', () => {
  const app = load({ backlog: [track('t1')] });
  app.toggleFileSel('p1');
  assert.ok(app.S.fileSel.has('p1'));
  app.toggleFileSel('p1');
  assert.ok(!app.S.fileSel.has('p1'));
  assert.equal(app.calls.rendered, 2);
});

/* ---- the queue position the buttons act on ---- */
/*
 * vInbox() clamps its index to the end of the queue; every action used to read
 * R.backlog[S.inboxAt] raw. Tapping a card under "Next up to file" moves that
 * index, and filing then shortens the queue underneath it — so the card on
 * screen and the track the buttons wrote to could be different rows, and at the
 * very end of the queue there was no row at all and File, Skip and Unlike each
 * returned in silence.
 */

test('the buttons act on the track the card is showing, not on a stale index', async () => {
  const app = load({ backlog: [track('t1'), track('t2'), track('t3')], inboxAt: 5 });
  assert.match(app.vInbox(), /Rinse It/);            // clamped to the last row
  await app.fileCurrent('p1');
  assert.deepEqual(app.calls.add, [['p1', 't3']], 'the last row is what gets filed');
  assert.deepEqual(app.R.backlog.map(t => t.id), ['t1', 't2']);
});

test('the last track in the queue can actually be filed', async () => {
  const app = load({ backlog: [track('t1'), track('t2')], inboxAt: 1 });
  await app.fileCurrent('p1');
  assert.deepEqual(app.R.backlog.map(t => t.id), ['t1']);
  // The index now points past the end. Filing again must still work.
  await app.fileCurrent('p1');
  assert.deepEqual(app.calls.add, [['p1', 't2'], ['p1', 't1']]);
  assert.equal(app.R.backlog.length, 0, 'the queue empties rather than jamming on its last row');
});

test('skipping the last track in the queue actually moves on from it', async () => {
  // It goes to the back — where it already was — so staying put showed the very
  // card that had just been skipped, and Skip looked like it did nothing.
  const app = load({ backlog: [track('t1'), track('t2'), track('t3')], inboxAt: 2 });
  app.recordSkip = async () => {};
  await app.inboxAct('skip');
  assert.deepEqual(app.R.backlog.map(t => t.id), ['t1', 't2', 't3']);
  assert.equal(app.S.inboxAt, 0, 'the queue wraps to the front rather than re-showing the skipped card');
});

test('skipping in the middle of the queue holds its place', async () => {
  const app = load({ backlog: [track('t1'), track('t2'), track('t3')], inboxAt: 0 });
  app.recordSkip = async () => {};
  await app.inboxAct('skip');
  assert.deepEqual(app.R.backlog.map(t => t.id), ['t2', 't3', 't1'], 'the skipped card goes to the back');
  assert.equal(app.S.inboxAt, 0, 'and the next one is already under it');
});

test('unliking the last track in the queue removes that track', async () => {
  const app = load({ backlog: [track('t1'), track('t2')], inboxAt: 1 });
  app.libraryCall = async () => {};
  await app.inboxAct('unlike');
  assert.deepEqual(app.R.backlog.map(t => t.id), ['t1']);
});

test('"Next up to file" opens the track that was tapped', () => {
  // The cards under it show the head of the queue, so their index is an
  // absolute position in it. Adding it to wherever the queue had been left
  // instead opened a different track than the one under the finger.
  const i = BUNDLE.indexOf("const gi = e.target.closest('[data-goinbox]')");
  assert.ok(i > 0, 'the Next-up handler is missing — rebuild with npm run build:web');
  const body = BUNDLE.slice(i, i + 400);
  assert.match(body, /S\.inboxAt = Math\.min\(\+gi\.dataset\.goinbox \|\| 0,/);
  assert.doesNotMatch(body, /S\.inboxAt \+ \(\+gi\.dataset\.goinbox/);
  assert.match(BUNDLE, /const upNext = R\.backlog\.slice\(0, 4\);/,
    'which is only an absolute position because the cards come off the head of the queue');
});
