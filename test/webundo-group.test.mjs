import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPage, slice, own } from './fixtures/page-spotify.mjs';
import * as HISTORY from '../web/screens/history.mjs';
import { feedbackExamples } from '../core/intrinsic/audio-feedback.mjs';

// A move in Tidy is two writes to Spotify — add to the new playlist, remove
// from the old — and to the listener it is one thing. These pin that down
// (docs/BUILD-5-PLAN.md §1.3 B1, B2, and the move half of B7):
//
//   B1  Undo used to reverse only the newest entry (the remove), so after
//       Undo the track sat in both playlists. A move is now one group, and
//       undoing any entry of a group undoes all of it, newest first.
//   B2  History offered Undo again on rows already undone (a second tap
//       re-added a duplicate) and showed a move as two unrelated rows.
//   B7  A move was never written to feedback, so the sound learner never
//       heard "yes, there; no, not there".

const MOVE = slice("const mv = e.target.closest('[data-mvto]');", "const dp = e.target.closest('[data-dplay]');", 'the move handler');

function page(playlists) {
  const app = loadPage({ playlists });
  app.run(slice('const esc = s =>', '\n', 'esc'));
  app.run(`async function doMove(e) {\n${MOVE}\n}`);
  app.CFG = { from: { name: 'Jungle' }, to: { name: 'Drum & Bass' } };
  app.S.moved = new Set();
  app.toasts = [];
  app.toast = (msg, fn) => app.toasts.push({ msg, fn });
  // What the History screen is given (web/app/screens.js builds the same from the page).
  app.ctx = { S: app.S, esc: app.run('esc'), isUndone: app.run('isUndone'),
              emptyState: (t, b) => `<empty ${t}>`, undoAction: app.undoAction, toast: app.toast, render() {},
              getLog: () => app.run('getLog()') };
  app.vHistory = () => HISTORY.view(app.ctx);
  return app;
}

/** Press a Move button: `tr` from `from` to `to`. */
async function move(app, tr, from = 'from', to = 'to') {
  const row = { classList: { add() {} } };
  const btn = { disabled: false, dataset: { mvto: to, mvfrom: from, mvtr: tr },
                closest: () => row, classList: { remove() {} }, textContent: 'Move' };
  await app.doMove({ target: { closest: sel => (sel === '[data-mvto]' ? btn : null) } });
  return app.toasts.at(-1);
}

const history = async app => { app.S.history = await app.run('getLog()'); return app.vHistory(); };

test('a move logs its add and its remove under one group', async () => {
  const app = page({ from: ['a', 'x', 'b'], to: ['c'] });
  await move(app, 'x');
  assert.deepEqual(app.ids('from'), ['a', 'b']);
  assert.deepEqual(app.ids('to'), ['c', 'x']);
  const log = app.log();
  assert.equal(log.length, 2);
  assert.deepEqual(own(log.map(e => e.op)), ['add', 'remove']);
  assert.ok(log[0].group, 'the add carries a group id');
  assert.equal(log[1].group, log[0].group, 'and the remove carries the same one');
  assert.notEqual(log[0].at, log[1].at, 'each step is still its own entry, findable by time');
});

test("the toast's Undo reverses the whole move: back in place, and out of the destination (B1)", async () => {
  const app = page({ from: ['a', 'x', 'b'], to: ['c'] });
  const t = await move(app, 'x');
  assert.match(t.msg, /Moved to Drum & Bass/);
  await t.fn();
  assert.deepEqual(app.ids('from'), ['a', 'x', 'b'], 'restored at the position it was removed from');
  assert.deepEqual(app.ids('to'), ['c'], 'and no longer in the playlist it was moved to');
});

test('undoing from either entry of the group undoes both, and marks both undone', async () => {
  const app = page({ from: ['x', 'a'], to: [] });
  await move(app, 'x');
  const removeAt = app.log().find(e => e.op === 'remove').at;
  await app.undoAction(removeAt);
  assert.deepEqual(app.ids('from'), ['x', 'a']);
  assert.deepEqual(app.ids('to'), []);
  const steps = app.log().filter(e => e.op !== 'undo');
  assert.ok(steps.every(e => e.undoneAt), 'both steps carry undoneAt');
  const undos = app.log().filter(e => e.op === 'undo');
  assert.equal(undos.length, 1, 'one undo entry for the one action');
  assert.equal(undos[0].playlistName, 'Jungle → Drum & Bass');
});

test('an undone action cannot be undone a second time (B2: no duplicate re-add)', async () => {
  const app = page({ from: ['x'], to: [] });
  const t = await move(app, 'x');
  await t.fn();
  const before = app.calls.length;
  await assert.rejects(() => t.fn(), /Already undone/);
  assert.equal(app.calls.length, before, 'and Spotify is not touched');
  assert.deepEqual(app.ids('from'), ['x'], 'still exactly one copy');
});

test('a single add, undone, is marked and refuses a second undo too', async () => {
  const app = page({ p: [] });
  await app.run("addTracks('p', ['t'])");
  const at = await app.logAction({ op: 'add', playlistId: 'p', playlistName: 'P', trackIds: ['t'] });
  await app.undoAction(at);
  assert.ok(app.log().find(e => e.at === at).undoneAt);
  await assert.rejects(() => app.undoAction(at), /Already undone/);
});

test('History shows a move as one "Moved A → B" row with one Undo (B2)', async () => {
  const app = page({ from: ['x'], to: [] });
  await move(app, 'x');
  const html = await history(app);
  assert.equal((html.match(/class="row"/g) ?? []).length, 1, 'one row, not two');
  assert.match(html, /Moved <span class="sub">Jungle → Drum &amp; Bass<\/span>/);
  assert.equal((html.match(/data-undo=/g) ?? []).length, 1, 'with one Undo');
});

test('History says Undone, with no button, once a row has been undone (B2)', async () => {
  const app = page({ from: ['x'], to: [], p: [] });
  const t = await move(app, 'x');
  await t.fn();
  const at = await app.logAction({ op: 'add', playlistId: 'p', playlistName: 'P', trackIds: ['y'] });
  await app.undoAction(at);
  const html = await history(app);
  assert.doesNotMatch(html, /data-undo=/, 'nothing left to undo');
  assert.equal((html.match(/>Undone</g) ?? []).length, 2, 'the move row and the add row both say so');
});

test('a log from before undoneAt existed still shows its undone rows as undone', async () => {
  const app = page({});
  app.S.history = [
    { at: '2026-11-01T10:00:01.000Z', op: 'undo', of: '2026-11-01T10:00:00.000Z', playlistId: 'p', trackIds: ['t'] },
    { at: '2026-11-01T10:00:00.000Z', op: 'add', playlistId: 'p', playlistName: 'P', trackIds: ['t'] },
  ];
  const html = app.vHistory();
  assert.doesNotMatch(html, /data-undo=/);
  assert.match(html, />Undone</);
});

test('an ordinary row renders exactly as it did before groups existed', async () => {
  const app = page({});
  app.S.history = [{ at: '2026-11-01T10:00:00.000Z', op: 'remove', playlistId: 'p', playlistName: 'P',
                     trackIds: ['t'], reason: 'duplicate' }];
  assert.equal(app.vHistory(), `<h1>History</h1>
    <p class="lede">Every change Betterfy made to your Spotify library, newest first. Removals record their position, so undo puts a track back where it was rather than at the end.</p>
    <div class="rows"><div class="row"><div class="main">
      <div class="ttl">remove <span class="sub">P</span></div>
      <div class="sub mono">2026-11-01 10:00:00 · 1 track(s) · duplicate</div>
    </div><div class="acts"><button class="b sm" data-act="undo" data-undo="2026-11-01T10:00:00.000Z">Undo</button></div></div></div>`);
});

test('the Undo action undoes the row, says so, and redraws from the log', async () => {
  const app = page({ from: ['x'], to: [] });
  await move(app, 'x');
  const at = app.log().find(e => e.op === 'remove').at;
  let drawn = 0;
  const btn = { disabled: false, dataset: { undo: at } };
  await HISTORY.actions.undo({ ...app.ctx, render: () => drawn++ }, btn);
  assert.equal(app.toasts.at(-1).msg, 'Restored.');
  assert.deepEqual(app.ids('from'), ['x']);
  assert.equal(drawn, 1);
  assert.equal(app.S.history.length, app.log().length, 'the screen reads the fresh log');
});

test('two entries logged in the same millisecond still get different times', async () => {
  const app = page({});
  const a = await app.logAction({ op: 'add', trackIds: [] });
  const b = await app.logAction({ op: 'add', trackIds: [] });
  assert.notEqual(a, b);
  assert.ok(b > a, 'and stay in order');
});

/* ---- B7: a move is a verdict the sound learner reads ---- */

test('a move is written to FB the way audio-feedback.mjs reads a move', async () => {
  const app = page({ from: ['x'], to: [] });
  await move(app, 'x');
  const FB = own(app.run('FB'));
  assert.deepEqual(FB.x.accepted, ['to']);
  assert.deepEqual(FB.x.rejected, ['from']);
  assert.deepEqual(own(app.indexedDB.data.get('feedback')), FB, 'and saved');
  const fb = feedbackExamples(FB);
  assert.deepEqual([...fb.pos], [['x', ['to']]], 'yes to where it went');
  assert.deepEqual([...fb.neg], [['x', ['from']]], 'no to where it was');
});

test('moving to a playlist once rejected for the track clears that reject', async () => {
  // Within FB a pair both accepted and rejected counts as rejected, so a
  // stale reject would silently cancel the move.
  const app = page({ from: ['x'], to: [] });
  app.run("FB.x = { skips: 0, lastSkip: null, rejected: ['to'] };");
  await move(app, 'x');
  const fb = feedbackExamples(own(app.run('FB')));
  assert.deepEqual([...fb.pos], [['x', ['to']]]);
  assert.deepEqual([...fb.neg], [['x', ['from']]]);
});

test('undoing a move takes its verdicts back', async () => {
  const app = page({ from: ['x'], to: [] });
  const t = await move(app, 'x');
  await t.fn();
  const fb = feedbackExamples(own(app.run('FB')));
  assert.equal(fb.n, 0);
});
