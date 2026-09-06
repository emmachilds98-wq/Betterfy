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
