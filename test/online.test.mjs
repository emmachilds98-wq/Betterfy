// Learning from every tap (docs/BUILD-7-PLAN.md E1): a "not there", a pick of
// the second choice over the first, a move away and an undo change the next
// card at once (core/intrinsic/space.mjs learnRejected / learnUndone), and the
// Score's folds replayed in order measure it (core/validate/online.mjs).
//
// Measured 2026-11-18 on synthetic libraries only (top-1, same tracks):
//
//                  static   file only   file + "not there"
//   shaped seed 11  32.9%    34.8%       35.0%   (526 tracks)
//   shaped seed 5   36.1%    36.6%       36.4%   (623)
//   shaped seed 3   35.8%    36.6%       36.4%   (579)
//   typical         27.6%    29.0%       29.0%   (700)
//   large           10.9%    10.9%       11.7%   (2400: 262 -> 261 -> 280 right)
//
// The online arm is never lower than static. The "not there" half is a track
// either way on the shaped seeds and +19 tracks on large, so it ships with it.
// The teach gate (test/teach.test.mjs) still opens on 1 of 3 shaped seeds with
// or without it, so teach questions stay behind their per-account gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSpace, placements, learnFiled, learnRejected, learnUndone, rejectPenalty, ONLINE } from '../core/intrinsic/space.mjs';
import { onlineAccuracy } from '../core/validate/online.mjs';
import { shapedLibrary } from './fixtures/shaped-library.mjs';
import { makeAccount } from './fixtures/accounts.mjs';

function firstFiled(lib) {
  for (const p of lib.playlists) for (const t of p.tracks ?? []) if (t.artists?.[0]?.id) return { t, p };
  return null;
}

test('a "not there" lowers that playlist for the artist\'s other tracks, bounded, and undo takes it back', () => {
  const lib = shapedLibrary({ seed: 11 });
  const space = buildSpace(lib, { targets: new Set(lib.targets) });
  const { t, p } = firstFiled(lib);
  const other = { id: 'other-track', name: 'x', artists: [t.artists[0]] };
  const before = placements(other, space, { limit: Infinity }).results.find(r => r.playlistId === p.id);
  assert.ok(before, 'the artist\'s playlist is a candidate');
  const json = JSON.stringify(placements(other, space, { limit: Infinity }));
  assert.equal(learnRejected(space, t, p.id), true);
  const d = space.destinations.get(p.id);
  const pen = rejectPenalty(other, d, space);
  assert.ok(pen > 0 && pen <= ONLINE.max);
  const after = placements(other, space, { limit: Infinity }).results.find(r => r.playlistId === p.id);
  assert.ok(after.score < before.score, `${after.score} < ${before.score}`);
  for (let i = 0; i < 20; i++) learnRejected(space, t, p.id);
  assert.ok(rejectPenalty(other, d, space) <= ONLINE.max, 'never a veto');
  for (let i = 0; i < 21; i++) assert.equal(learnUndone(space), true);
  assert.equal(space.rejected, undefined, 'all taken back');
  assert.equal(JSON.stringify(placements(other, space, { limit: Infinity })), json, 'exactly as before');
});

test('more filings of the artist there shrink the "not there" (evidence the other way wins)', () => {
  const space = buildSpace(shapedLibrary({ seed: 11 }));
  const d = [...space.destinations.values()].find(x => x.artistCounts.size);
  const [aid] = d.artistCounts.keys();
  const tr = { id: 'q', artists: [{ id: aid }] };
  learnRejected(space, tr, d.id);
  const one = rejectPenalty(tr, d, space);
  d.artistCounts.get(aid).n += 5;
  assert.ok(rejectPenalty(tr, d, space) < one);
});

test('undo of a filing puts the playlist back exactly; only the newest learn is undone', () => {
  const lib = shapedLibrary({ seed: 5 });
  const space = buildSpace(lib);
  const liked = { id: 'new-liked', name: 'n', artists: [firstFiled(lib).t.artists[0]] };
  const pid = [...space.destinations.keys()][0];
  const probe = { id: 'probe', artists: liked.artists };
  const json = JSON.stringify(placements(probe, space, { limit: Infinity }));
  assert.equal(learnFiled(space, liked, pid), true);
  assert.notEqual(JSON.stringify(placements(probe, space, { limit: Infinity })), json);
  assert.equal(learnUndone(space, { trackId: 'someone-else' }), false, 'not the newest: left to the rebuild');
  assert.equal(learnUndone(space, { trackId: 'new-liked', playlistId: pid }), true);
  assert.equal(JSON.stringify(placements(probe, space, { limit: Infinity })), json);
  assert.equal(space.destinations.get(pid).trackIds.has('new-liked'), false);
  assert.equal(learnUndone(space), false, 'nothing left');
});

test('a space no tap touched scores exactly as before (no `rejected`, no change)', () => {
  const lib = shapedLibrary({ seed: 3 });
  const a = buildSpace(lib), b = buildSpace(lib);
  const t = firstFiled(lib).t;
  learnRejected(b, { id: 'z', artists: [{ id: 'nobody-here' }] }, [...b.destinations.keys()][0]);
  assert.equal(JSON.stringify(placements(t, a, { limit: Infinity })), JSON.stringify(placements(t, b, { limit: Infinity })),
    'a "not there" on an artist the track does not have changes nothing for it');
});

test('the replay: online is never below static, on the same tracks (E1 gate)', { timeout: 120000 }, () => {
  const seen = [];
  for (const seed of [11, 5, 3]) {
    const lib = shapedLibrary({ seed });
    const r = onlineAccuracy(lib, { targets: lib.targets });
    seen.push([seed, r.static.right, r.online.right]);
    assert.ok(r.online.top1 >= r.static.top1, `seed ${seed}: ${r.static.top1} -> ${r.online.top1}`);
    assert.ok(r.repeat.scored > 0 && r.repeat.online.top1 >= r.repeat.static.top1);
  }
  assert.deepEqual(seen, [[11, 173, 184], [5, 225, 227], [3, 207, 211]], 'the measured result moved: re-measure and update the table above');
  const large = onlineAccuracy(makeAccount('large'));
  assert.deepEqual([large.static.right, large.online.right, large.scored], [262, 280, 2400]);
  assert.ok(JSON.stringify(large).length < 600, 'small enough for the Score report');
});
