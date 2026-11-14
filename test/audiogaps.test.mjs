import { test } from 'node:test';
import assert from 'node:assert/strict';
import { soundProposals, soundPlaylists, tightGroups } from '../core/recommend/audio-gaps.mjs';
import { audioIndex } from '../core/intrinsic/audio.mjs';
import { uncoveredGenres, splitCandidates } from '../core/recommend/gaps.mjs';
import { soundLibrary } from './fixtures/sound-library.mjs';

const ids = (xs, prefix) => xs.filter(id => id.startsWith(prefix));

test('no records: every list is empty and the tag gaps are untouched', () => {
  const { lib, targets } = soundLibrary();
  const out = soundProposals({ lib, targets, records: null });
  assert.deepEqual(out, { pick: [], hybrids: [], orphans: [], heard: 0, version: out.version });
  assert.deepEqual(soundProposals({ lib, targets, records: [] }).pick, []);
  // gaps.mjs does not read records at all; pinned so a later change has to mean it.
  const before = JSON.stringify([uncoveredGenres({ lib, targets, tagsOf: () => [] }), splitCandidates({ lib, targets, tagsOf: () => [] })]);
  soundProposals({ lib, targets, records: soundLibrary().records });
  assert.equal(JSON.stringify([uncoveredGenres({ lib, targets, tagsOf: () => [] }), splitCandidates({ lib, targets, tagsOf: () => [] })]), before);
});

test('playlists are measured in their own units', () => {
  const { lib, targets, records } = soundLibrary({ kinds: [] });
  const lists = soundPlaylists({ lib, targets, index: audioIndex(records) });
  assert.deepEqual(lists.map(l => l.id), ['p-x', 'p-y', 'p-z']);
  for (const l of lists) {
    assert.ok(l.inside > l.outside + 0.3, `${l.id}: members sit far closer to their centre than other playlists' do`);
    assert.equal(l.members, 20);
  }
});

test('separable: unfiled tracks that sound like one playlist propose nothing', () => {
  const { lib, targets, records } = soundLibrary({ kinds: ['inside'] });
  const out = soundProposals({ lib, targets, records });
  assert.equal(out.heard, 6);
  assert.deepEqual([out.pick, out.hybrids, out.orphans], [[], [], []]);
});

test('toss-ups between two playlists become one "pick one of these two" offer for the pair', () => {
  const { lib, targets, records } = soundLibrary({ kinds: ['inside', 'pick'] });
  const out = soundProposals({ lib, targets, records });
  assert.equal(out.pick.length, 1);
  const [p] = out.pick;
  assert.deepEqual(p.between.map(x => x.id), ['p-x', 'p-y']);
  assert.deepEqual(p.between.map(x => x.name), ['Drum & Bass', 'Bass']);
  assert.equal(p.ids.length, 4);
  assert.ok(p.ids.every(id => id.startsWith('pk')));
  assert.equal(p.kind, 'pick');
  assert.deepEqual([out.hybrids, out.orphans], [[], []]);
});

test('too few toss-ups for one pair is not worth asking about here', () => {
  const { lib, targets, records } = soundLibrary({ kinds: ['pick'] });
  assert.deepEqual(soundProposals({ lib, targets, records, minPick: 5 }).pick, []);
});

test('learned probabilities, when given, decide the toss-up instead of closeness', () => {
  const { lib, targets, records } = soundLibrary({ kinds: ['inside'] });
  // The inside tracks sound like Drum & Bass, but the learner calls them a coin toss with Dubstep.
  const learned = id => id.startsWith('in') ? new Map([['p-x', 0.45], ['p-z', 0.4], ['p-y', 0.15]]) : null;
  const out = soundProposals({ lib, targets, records, learned });
  assert.equal(out.pick.length, 1);
  assert.deepEqual(out.pick[0].between.map(x => x.id), ['p-x', 'p-z']);
  // And a confident learner says nothing.
  const sure = () => [['p-x', 0.9], ['p-y', 0.05], ['p-z', 0.05]];
  assert.deepEqual(soundProposals({ lib, targets, records, learned: sure }).pick, []);
});

test('a tight group between two playlists is a named hybrid proposal', () => {
  const { lib, targets, records } = soundLibrary({ kinds: ['inside', 'hybrid'] });
  const out = soundProposals({ lib, targets, records });
  assert.equal(out.hybrids.length, 1);
  const [h] = out.hybrids;
  assert.equal(h.kind, 'hybrid');
  assert.equal(h.size, 10);
  assert.deepEqual(ids(h.ids, 'hy').length, 10);
  assert.deepEqual(h.between.map(x => x.id).sort(), ['p-y', 'p-z']);
  assert.equal(h.name, 'Bassline / Dubstep', 'named from its top two styles');
  assert.equal(h.mixed, 10, 'every one changes style mid-clip (sections.mjs)');
  assert.deepEqual(out.orphans, []);
  // Its tracks are the group's, not also asked about one pair at a time.
  assert.ok(!out.pick.some(p => p.ids.some(id => id.startsWith('hy'))));
});

test('a tight group near no playlist is "new genre?", with no name', () => {
  const { lib, targets, records } = soundLibrary({ kinds: ['inside', 'orphan'] });
  const out = soundProposals({ lib, targets, records });
  assert.equal(out.orphans.length, 1);
  const [o] = out.orphans;
  assert.equal(o.kind, 'orphan');
  assert.equal(o.size, 10);
  assert.equal(o.name, undefined, 'unnamed until WP-C3');
  assert.ok(o.nearest.fit < 0.35);
  assert.deepEqual([out.hybrids, out.pick], [[], []]);
});

test('noise gives nothing', () => {
  const { lib, targets, records } = soundLibrary({ kinds: ['noise'] });
  const out = soundProposals({ lib, targets, records });
  assert.equal(out.heard, 15);
  assert.deepEqual([out.pick, out.hybrids, out.orphans], [[], [], []]);
  const idx = audioIndex(records);
  const nz = lib.liked.map(t => t.id);
  assert.deepEqual(tightGroups(nz, idx, { neighbour: 0.4, tightness: 0.6 }), [], 'random sounds have no close neighbours');
});

test('all kinds together, each found once and nothing else', () => {
  const { lib, targets, records } = soundLibrary();
  const out = soundProposals({ lib, targets, records });
  assert.equal(out.heard, 45);
  assert.deepEqual([out.pick.length, out.hybrids.length, out.orphans.length], [1, 1, 1]);
  assert.ok(out.orphans[0].ids.every(id => id.startsWith('or')));
  assert.ok(out.hybrids[0].ids.every(id => id.startsWith('hy')));
  assert.ok(out.pick[0].ids.every(id => id.startsWith('pk')));
});

test('ranked by listening: what you are playing comes first', () => {
  const { lib, targets, records } = soundLibrary({ kinds: ['hybrid', 'orphan'] });
  const quiet = soundProposals({ lib, targets, records });
  assert.equal(quiet.hybrids[0].played, 0);
  const orphanArtists = new Set(lib.liked.filter(t => t.id.startsWith('or')).map(t => t.artists[0].name));
  const out = soundProposals({ lib, targets, records, active: orphanArtists });
  assert.equal(out.orphans[0].played, 10);
  assert.equal(out.orphans[0].ids.length, 10);
});

test('filed tracks, mirrors and non-genre playlists are never proposed', () => {
  const { lib, targets, records } = soundLibrary({ kinds: ['orphan'] });
  // The orphan group copied into a genre playlist has a home, so it is not a gap.
  const filed = { ...lib, playlists: [...lib.playlists.slice(0, 2), { ...lib.playlists[2], tracks: [...lib.playlists[2].tracks, ...lib.liked] }] };
  assert.deepEqual(soundProposals({ lib: filed, targets, records }).orphans, []);
  // A mirror is not a destination: with only two playlists left, Y and Z still judge.
  const mirror = soundProposals({ lib, targets, records, isMirror: p => p.id === 'p-x' });
  assert.equal(mirror.orphans.length, 1);
  // One genre playlist is not enough to compare against.
  assert.deepEqual(soundProposals({ lib, targets: ['p-x'], records }).orphans, []);
});

test('deterministic: the same records in another order give the same answer', () => {
  const { lib, targets, records } = soundLibrary();
  const a = JSON.stringify(soundProposals({ lib, targets, records }));
  const b = JSON.stringify(soundProposals({ lib, targets, records: records.slice().reverse() }));
  assert.equal(a, b);
});
