import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as INBOX from '../web/screens/inbox.mjs';

// Optimistic filing (docs/BUILD-5-PLAN.md §4.2, UI-C): the card leaves and the
// deck redraws before Spotify answers; a failed write puts the card back.

const T = id => ({ id, title: 'T' + id, artist: 'A', artists: [{ id: 'a' + id, name: 'A' }], suggest: [] });
function mk({ fail = false, n = 3 } = {}) {
  const seen = { add: [], render: [], toast: [], fly: 0 };
  let release; const gate = new Promise(r => { release = r; });
  const ctx = {
    S: { inboxAt: 0, fileSel: new Set(), fileSelFor: null }, R: { backlog: Array.from({ length: n }, (_, i) => T('t' + (i + 1))) },
    CFG: { p1: { name: 'One' } }, FB: {},
    addTracks: async (pl, ids) => { seen.add.push([pl, ...ids]); await gate; if (fail) throw new Error('403 nope'); },
    logAction: async () => {}, getLog: async () => [{ at: 'A' }], undoAction: async () => {},
    recordAccept: async () => {}, forgetAccept: async () => {},
    toast: (m) => seen.toast.push(m), flyCard: () => { seen.fly++; },
    render() { seen.render.push(ctx.R.backlog.map(b => b.id).join()); },
  };
  return { ctx, seen, release };
}

test('the card leaves and the deck redraws before the Spotify write finishes', async () => {
  const { ctx, seen, release } = mk();
  const p = INBOX.fileCurrent(ctx, 'p1');
  assert.deepEqual(ctx.R.backlog.map(b => b.id), ['t2', 't3'], 'removed at once');
  assert.equal(seen.render[0], 't2,t3');
  assert.equal(ctx.S.promote, true, 'the peek card springs up');
  assert.equal(seen.fly, 1);
  assert.deepEqual(seen.toast, [], 'the undo toast waits for the write');
  release(); await p;
  assert.match(seen.toast[0], /Filed “Tt1” into One/);
});

test('a failed write brings the card back with its selection, and a toast', async () => {
  const { ctx, seen, release } = mk({ fail: true });
  ctx.S.fileSel = new Set(['p1']); ctx.S.fileSelFor = 't1';
  const p = INBOX.fileCurrent(ctx, ['p1']);
  release(); await p;
  assert.deepEqual(ctx.R.backlog.map(b => b.id), ['t1', 't2', 't3']);
  assert.equal(ctx.S.inboxAt, 0);
  assert.deepEqual([...ctx.S.fileSel], ['p1']);
  assert.match(seen.toast.at(-1), /^Failed: 403/);
  assert.equal(seen.render.at(-1), 't1,t2,t3');
});

test('a rapid second tap does not file the next card', async () => {
  const { ctx, seen, release } = mk();
  const a = INBOX.fileCurrent(ctx, 'p1');
  const b = INBOX.fileCurrent(ctx, 'p1');
  release(); await Promise.all([a, b]);
  assert.deepEqual(seen.add, [['p1', 't1']]);
  assert.deepEqual(ctx.R.backlog.map(x => x.id), ['t2', 't3']);
});

test('after a failure the lock is released so the retry goes through', async () => {
  const { ctx, release } = mk({ fail: true });
  const a = INBOX.fileCurrent(ctx, 'p1'); release(); await a;
  ctx.addTracks = async () => {};
  await INBOX.fileCurrent(ctx, 'p1');
  assert.deepEqual(ctx.R.backlog.map(x => x.id), ['t2', 't3']);
});
