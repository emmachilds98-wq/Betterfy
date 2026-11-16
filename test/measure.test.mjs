import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measureHistory, measureLines, QUEUE_HEAD, MIN_N } from '../core/measure/history.mjs';

const t0 = Date.parse('2026-11-01T00:00:00Z');
let tick = 0;
const at = () => new Date(t0 + 1000 * tick++).toISOString();
const filing = (o = {}) => ({ at: at(), op: 'add', playlistId: 'p1', trackIds: ['t' + tick], reason: 'filed from inbox', ...o });

test('empty, null and malformed logs give nulls, not NaN', () => {
  for (const l of [[], null, undefined, [{}, null, { op: 'add' }]]) {
    const m = measureHistory(l);
    assert.equal(m.queue.share, null); assert.equal(m.batch.precision, null);
    assert.equal(m.tidy.sure.rate, null); assert.equal(m.discover.rate, null);
  }
});

test('queue share counts only filings that recorded a position', () => {
  const log = [
    ...Array.from({ length: 6 }, (_, i) => filing({ queuePos: i, deck: 200 })),
    ...Array.from({ length: 2 }, () => filing({ queuePos: QUEUE_HEAD, deck: 200 })),
    filing(), // pre-queuePos entry: excluded
    { at: at(), op: 'add', playlistId: 'p', trackIds: ['x'], reason: 'moved from A', group: 'g' }, // not a filing
  ];
  const m = measureHistory(log);
  assert.equal(m.queue.n, 8); assert.equal(m.queue.head, 6); assert.equal(m.queue.share, 0.75); assert.equal(m.queue.of, 9);
  assert.ok(Math.abs(m.queue.baseline - 0.1) < 1e-9); assert.ok(m.queue.beatsRandom);
});

test('batch precision: undone (undoneAt or undo entry) and later removal both count', () => {
  const a = filing({ band: 'sure', trackIds: ['a'] }), b = filing({ band: 'sure', trackIds: ['b'], undoneAt: 'x' });
  const c = filing({ band: 'sure', trackIds: ['c'] }), d = filing({ band: 'sure', trackIds: ['d'] });
  const e = filing({ band: 'likely', trackIds: ['e'] });
  const log = [a, b, c, d, e,
    { at: at(), op: 'undo', of: a.at },
    { at: at(), op: 'remove', playlistId: 'p1', trackIds: ['c'], reason: 'moved to Z', group: 'gg' },
    { at: at(), op: 'remove', playlistId: 'other', trackIds: ['d'] }]; // other playlist: not a reversal
  const m = measureHistory(log);
  assert.equal(m.batch.n, 4); assert.equal(m.batch.back, 3);
  assert.equal(m.batch.movedShare, 0.75); assert.equal(m.batch.precision, 0.25);
});

test('a removal before the filing does not count against it', () => {
  const rm = { at: at(), op: 'remove', playlistId: 'p1', trackIds: ['a'] };
  const f = filing({ band: 'sure', trackIds: ['a'] });
  assert.equal(measureHistory([rm, f]).batch.back, 0);
});

test('log order does not matter', () => {
  const f = filing({ band: 'sure', trackIds: ['a'] });
  const rm = { at: at(), op: 'remove', playlistId: 'p1', trackIds: ['a'] };
  assert.equal(measureHistory([rm, f]).batch.back, 1);
});

test('tidy acceptance per tier; a grouped move undone as a whole is not kept', () => {
  const mv = (tier, extra = {}) => {
    const group = 'g' + tick;
    return [
      { at: at(), op: 'add', playlistId: 'B', trackIds: ['t'], reason: 'moved from A', group, ...extra },
      { at: at(), op: 'remove', playlistId: 'A', trackIds: ['t'], group, move: { trackId: 't', from: 'A', to: 'B', tier }, ...extra },
    ];
  };
  const log = [...mv('sure'), ...mv('sure'), ...mv('sure', { undoneAt: 'z' }), ...mv('likely'), ...mv(undefined),
    ...mv('bogus')];
  const m = measureHistory(log);
  assert.deepEqual([m.tidy.sure.n, m.tidy.sure.kept], [3, 2]);
  assert.ok(Math.abs(m.tidy.sure.rate - 2 / 3) < 1e-9);
  assert.equal(m.tidy.likely.rate, 1); assert.equal(m.tidy.unsure.n, 0);
});

test('discover keep rate covers adds and likes from discovery, minus undone', () => {
  const log = [
    filing({ reason: 'added from discovery' }), filing({ reason: 'added from discovery', undoneAt: 'x' }),
    { at: at(), op: 'add-liked', trackIds: ['l'], reason: 'from discovery' },
    filing(), // a plain filing is not discovery
  ];
  const m = measureHistory(log);
  assert.equal(m.discover.n, 3); assert.equal(m.discover.kept, 2);
});

test('lines say "not enough data yet" below each minimum and numbers above', () => {
  const few = measureLines(measureHistory([]));
  assert.equal(few.length, 6);
  assert.ok(few.every(l => /not enough data yet/.test(l)));
  assert.match(few[0], new RegExp(`0 of ${MIN_N.queue}`));
  const log = Array.from({ length: 10 }, (_, i) => filing({ queuePos: i < 7 ? i : 40, deck: 100, band: 'sure', trackIds: ['k' + i] }));
  const lines = measureLines(measureHistory(log));
  assert.match(lines[0], /70% of 10 filings came from the first 20 cards \(20% expected/);
  assert.match(lines[1], /0% of 10 sure-band/);
  assert.match(lines[2], /not enough/);
});

test('D1: a batch filing counts, and a grouped undo undoes every member', () => {
  const g = 'batch1';
  const mk = (pl, t) => ({ at: at(), op: 'add', playlistId: pl, trackIds: [t], reason: 'filed the sure ones', band: 'sure', queuePos: 0, group: g });
  const a = mk('p1', 'a'), b = mk('p2', 'b');
  let m = measureHistory([a, b]);
  assert.equal(m.batch.n, 2); assert.equal(m.batch.back, 0); assert.equal(m.batch.precision, 1);
  assert.equal(m.queue.n, 0); // a batch says nothing about queue order
  // The undo entry names only the first step; both were undone.
  m = measureHistory([a, b, { at: at(), op: 'undo', of: a.at, ofGroup: g }]);
  assert.equal(m.batch.back, 2); assert.equal(m.batch.precision, 0);
  m = measureHistory([a, b, { at: at(), op: 'undo', of: a.at }]); // older log, no ofGroup
  assert.equal(m.batch.back, 2);
  // undoneAt on one member alone also takes the group.
  m = measureHistory([{ ...a, undoneAt: 'x' }, b]);
  assert.equal(m.batch.back, 2);
  // A later removal from one playlist reverses only that member.
  m = measureHistory([a, b, { at: at(), op: 'remove', playlistId: 'p2', trackIds: ['b'] }]);
  assert.equal(m.batch.back, 1); assert.equal(m.batch.precision, 0.5);
});

test('D2: queue order can fail, a deck with no skipping does not beat random when the deck is small', () => {
  // Deck of 25: random order already puts 80% in the first 20.
  const small = Array.from({ length: 10 }, (_, i) => filing({ queuePos: i, deck: 25, trackIds: ['s' + i] }));
  let m = measureHistory(small);
  assert.equal(m.queue.share, 1); assert.ok(Math.abs(m.queue.baseline - 0.8) < 1e-9);
  // Filings forced deep into a big deck (bad order): share below baseline-plus-margin.
  const bad = Array.from({ length: 10 }, (_, i) => filing({ queuePos: i < 1 ? 0 : 150, deck: 200, trackIds: ['b' + i] }));
  m = measureHistory(bad);
  assert.equal(m.queue.beatsRandom, false); assert.ok(m.queue.lift < 0.05);
  assert.match(measureLines(m)[0], /no better than random/);
  // Entries without a deck length are left out.
  assert.equal(measureHistory([filing({ queuePos: 0 })]).queue.n, 0);
});
