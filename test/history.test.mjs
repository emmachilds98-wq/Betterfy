// A move is an add and a remove. The user made one decision, so History has to
// show one row and Undo has to reverse both halves — v1 reversed only one.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { historyGrouped } from '../actions.mjs';

const cwd = process.cwd();
let dir;

before(() => { dir = mkdtempSync(join(tmpdir(), 'betterfy-')); process.chdir(dir); });
after(() => { process.chdir(cwd); rmSync(dir, { recursive: true, force: true }); });

const writeLog = rows => writeFileSync('actions.log.jsonl', rows.map(r => JSON.stringify(r)).join('\n') + '\n');

const MOVE = [
  { at: '2026-01-01T10:00:00Z', txn: 'tx1', txnLabel: 'move Techno → Jungle', op: 'add',
    playlistId: 'pJ', playlistName: 'Jungle', trackIds: ['t1'], undoable: true },
  { at: '2026-01-01T10:00:01Z', txn: 'tx1', txnLabel: 'move Techno → Jungle', op: 'remove',
    playlistId: 'pT', playlistName: 'Techno', trackIds: ['t1'], positions: { t1: [4] }, undoable: true },
];

test('a move is one row, not two', () => {
  writeLog(MOVE);
  const rows = historyGrouped();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].op, 'move Techno → Jungle');
  assert.equal(rows[0].steps.length, 2);
  assert.equal(rows[0].undoable, true);
  assert.deepEqual(rows[0].trackIds, ['t1'], 'the same track counted once');
});

test('undoing a transaction retires its row', () => {
  writeLog([...MOVE, { at: '2026-01-01T10:05:00Z', op: 'undo', of: MOVE[0].at, ofTxn: 'tx1', steps: 2 }]);
  const rows = historyGrouped();
  const move = rows.find(r => r.txn === 'tx1');
  assert.equal(move.undoable, false, 'it cannot be undone twice');
  assert.equal(rows[0].op, 'undo', 'the undo itself is listed, newest first');
  assert.equal(rows[0].undoable, false);
});

test('an ungrouped step from an older log still works', () => {
  writeLog([{ at: '2025-01-01T00:00:00Z', op: 'add', playlistId: 'p', playlistName: 'P', trackIds: ['x'], undoable: true }]);
  const rows = historyGrouped();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].undoable, true);
});

test('an ungrouped step that was undone is retired too', () => {
  writeLog([
    { at: '2025-01-01T00:00:00Z', op: 'add', playlistId: 'p', playlistName: 'P', trackIds: ['x'], undoable: true },
    { at: '2025-01-01T00:01:00Z', op: 'undo', of: '2025-01-01T00:00:00Z', ofTxn: null, steps: 1 },
  ]);
  assert.equal(historyGrouped().find(r => r.op === 'add').undoable, false);
});

test('a row is undoable only if every step is', () => {
  writeLog([
    { at: '2026-02-01T10:00:00Z', txn: 'tx2', txnLabel: 'create Breaks', op: 'create-playlist',
      playlistId: 'pB', playlistName: 'Breaks', undoable: true },
    { at: '2026-02-01T10:00:01Z', txn: 'tx2', txnLabel: 'create Breaks', op: 'note', trackIds: [] },
  ]);
  assert.equal(historyGrouped()[0].undoable, false, 'a step with no undo blocks the group');
});

test('newest first, and the limit counts rows not steps', () => {
  writeLog([
    ...MOVE,
    { at: '2026-03-01T10:00:00Z', op: 'add', playlistId: 'p', playlistName: 'Later', trackIds: ['z'], undoable: true },
  ]);
  const rows = historyGrouped();
  assert.equal(rows[0].playlistName, 'Later');
  assert.equal(historyGrouped(1).length, 1);
});

test('an empty or missing log is not an error', () => {
  rmSync('actions.log.jsonl', { force: true });
  assert.deepEqual(historyGrouped(), []);
});
