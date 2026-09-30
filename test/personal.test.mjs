import { test } from 'node:test';
import assert from 'node:assert/strict';
import { correction, CorrectionLog, fromV1Feedback, mergeLogs, personalView, KINDS } from '../core/personal/corrections.mjs';
import { uncertaintyOf, relevanceOf, playlistReach, analysisPriority, UNCERTAINTY } from '../core/personal/relevance.mjs';
import { reviewQueue, trackQueue, conceptQueue, playlistQueue, REASONS } from '../core/review/queue.mjs';
import { indexCaches, buildRegistry, profileLibrary, analysePlaylists } from '../core/engine.mjs';
import { buildFixtureLibrary, NOW } from '../core/benchmark/playlists.mjs';
import { CONFIDENCE } from '../core/analysis/classify.mjs';

/*
 * §39's layering, from the bottom up: a correction never touches provider
 * evidence, and provider evidence never overwrites a correction. Both answers
 * stay available, which is what lets the library be reclassified after an
 * ontology change without discarding a year of somebody's corrections.
 */

test('a correction is immutable and cannot claim a kind nobody defined', () => {
  const c = correction({ kind: 'genre', trackId: 't1', value: 'jungle' });
  assert.ok(Object.isFrozen(c));
  assert.throws(() => correction({ kind: 'telepathy' }), /unknown correction kind/);
  for (const k of KINDS) assert.ok(correction({ kind: k }));
});

test('the log is append-only: changing your mind keeps both entries', () => {
  const log = new CorrectionLog().add(
    correction({ kind: 'genre', trackId: 't1', value: 'deep-house', at: 1 }),
    correction({ kind: 'genre', trackId: 't1', value: 'tech-house', at: 2 }));
  assert.equal(log.genreOf('t1'), 'tech-house', 'the latest statement wins');
  assert.equal(log.entries.length, 2, 'and the earlier one is still recoverable');
  assert.equal(log.genreOf('nobody'), null);
});

test('a personal classification sits beside the global one, never on top of it', () => {
  const profile = { identity: { spotifyId: 't1' }, genre: { primary: 'techno', confidence: CONFIDENCE.HIGH } };
  const log = new CorrectionLog().add(correction({ kind: 'genre', trackId: 't1', value: 'jungle' }));
  const view = personalView(profile, log);
  assert.equal(view.global.primary, 'techno', 'what the evidence says is still available');
  assert.equal(view.personal.primary, 'jungle');
  assert.equal(view.effective, 'jungle', 'and the listener wins — it is their library');
  assert.equal(view.overridden, true);
  // The global profile object itself is untouched.
  assert.equal(profile.genre.primary, 'techno');
});

test('with no correction the global answer stands, and nothing claims an override', () => {
  const view = personalView({ identity: { spotifyId: 't1' }, genre: { primary: 'techno' } }, new CorrectionLog());
  assert.equal(view.personal, null);
  assert.equal(view.effective, 'techno');
  assert.equal(view.overridden, false);
});

test('rejections and skips are recorded per track and never expire', () => {
  const log = new CorrectionLog().add(
    correction({ kind: 'reject', trackId: 't1', playlistId: 'p1' }),
    correction({ kind: 'reject', trackId: 't1', playlistId: 'p1' }),
    correction({ kind: 'reject', trackId: 't1', playlistId: 'p2' }),
    correction({ kind: 'skip', trackId: 't1', at: 5 }),
    correction({ kind: 'skip', trackId: 't1', at: 9 }));
  assert.deepEqual(log.rejectedFor('t1').sort(), ['p1', 'p2']);
  assert.equal(log.skipsOf('t1').skips, 2);
  assert.equal(log.skipsOf('t1').lastSkip, 9);
});

test("v1's feedback survives the upgrade rather than being discarded", () => {
  // Somebody sat and told the app "no, not there" one track at a time.
  const log = fromV1Feedback({ t1: { skips: 2, lastSkip: '2025-06-01T00:00:00Z', rejected: ['p1', 'p2'] } });
  assert.deepEqual(log.rejectedFor('t1').sort(), ['p1', 'p2']);
  assert.equal(log.skipsOf('t1').skips, 2);
  assert.ok(log.entries.every(e => e.note?.includes('v1')), 'and is labelled as imported');
  assert.equal(fromV1Feedback(null).entries.length, 0);
  assert.equal(fromV1Feedback({ t1: {} }).entries.length, 0);
});

test('two devices merge with no field to pick a winner for, and syncing twice is a no-op', () => {
  const phone = new CorrectionLog().add(correction({ kind: 'reject', trackId: 't1', playlistId: 'p1', at: 1 }));
  const laptop = new CorrectionLog().add(correction({ kind: 'reject', trackId: 't1', playlistId: 'p2', at: 2 }));
  const merged = mergeLogs(phone, laptop);
  assert.deepEqual(merged.rejectedFor('t1').sort(), ['p1', 'p2'], 'neither device loses what it recorded');
  assert.equal(mergeLogs(merged, merged).entries.length, merged.entries.length);
  assert.equal(mergeLogs(merged, phone).entries.length, merged.entries.length);
});

test('a log round-trips through JSON', () => {
  const log = new CorrectionLog().add(correction({ kind: 'genre', trackId: 't1', value: 'jungle' }));
  const back = CorrectionLog.fromJSON(JSON.parse(JSON.stringify(log)));
  assert.equal(back.genreOf('t1'), 'jungle');
  assert.ok(Object.isFrozen(back.entries[0]));
});

test('"not sure" is recorded, because a human looking and failing is also data', () => {
  const log = new CorrectionLog().add(correction({ kind: 'not-sure', trackId: 't1' }));
  assert.deepEqual(log.unsure(), ['t1']);
});

test('repeated corrections about one concept are reported, not fed back into the model', () => {
  const log = new CorrectionLog().add(
    ...Array.from({ length: 4 }, (_, i) => correction({ kind: 'genre', trackId: `t${i}`, value: 'tech-house' })),
    correction({ kind: 'genre', trackId: 'tx', value: 'jungle' }));
  assert.deepEqual(log.disagreements()[0], { concept: 'tech-house', count: 4 });
});

/* ---------- the personal concept map ---------- */

const MYSTERY = { playlists: [{ id: 'p', name: 'X', tracks: [
  { id: 't1', name: 'A', artists: [{ id: 'a1', name: 'Art' }] }] }], liked: [] };
const MYSTERY_TAGS = { a1: { tags: [['hard groove', 100]], checkedAt: NOW } };

const profileWith = conceptMap => {
  const idx = indexCaches({ lastfm: MYSTERY_TAGS, now: NOW, conceptMap });
  return profileLibrary(MYSTERY, idx, { registry: buildRegistry(idx.present), now: NOW }).get('t1').profile;
};

test('answering an unknown tag resolves it for that listener without editing the ontology', () => {
  const before = profileWith(null);
  assert.equal(before.genre.primary, null);
  assert.deepEqual(before.unknown.map(u => u.raw), ['hard groove']);

  const log = new CorrectionLog().add(correction({ kind: 'concept', raw: 'hard groove', value: 'hard techno' }));
  const after = profileWith(log.conceptMap());
  assert.equal(after.genre.primary, 'hard-techno');
  assert.deepEqual(after.unknown, []);

  // …and the global ontology is unchanged: another listener sees the gap.
  assert.equal(profileWith(null).genre.primary, null);
});

test('a personal concept mapping can fill a gap but never overrule a known concept', () => {
  const idx = indexCaches({
    lastfm: { a1: { tags: [['jungle', 100]], checkedAt: NOW } }, now: NOW,
    conceptMap: new Map([['jungle', 'metal']]),
  });
  const p = profileLibrary(MYSTERY, idx, { registry: buildRegistry(idx.present), now: NOW }).get('t1').profile;
  assert.equal(p.genre.primary, 'jungle', 'the ontology answered, so the override is never consulted');
});

/* ---------- relevance: priority only, never genre ---------- */

test('listening never reaches the classifier', async () => {
  const src = await import('node:fs').then(fs => fs.readFileSync('core/analysis/classify.mjs', 'utf8'));
  assert.ok(!src.includes('relevance'), '§22: how much you play something is not what it is');
  assert.ok(!src.includes('listening'));
});

test('uncertainty is steep where it matters', () => {
  assert.ok(UNCERTAINTY[CONFIDENCE.INSUFFICIENT_DATA] > UNCERTAINTY[CONFIDENCE.AMBIGUOUS]);
  // The deliberate cliff: a LIKELY answer is usually right and re-asking is
  // near-wasted; an AMBIGUOUS one is a coin-flip somebody will be shown.
  assert.ok(UNCERTAINTY[CONFIDENCE.AMBIGUOUS] >= 2 * UNCERTAINTY[CONFIDENCE.LIKELY]);
  assert.ok(UNCERTAINTY[CONFIDENCE.LIKELY] > UNCERTAINTY[CONFIDENCE.HIGH]);
  assert.equal(uncertaintyOf({ genre: { confidence: 'NONSENSE' } }), 0.5);
});

test('priority spends effort on the played and the uncertain, not the obscure and the settled', () => {
  const weights = new Map([['Big', 8], ['Obscure', 0]]);
  const track = name => ({ id: 't', artists: [{ name }] });
  const unsure = { profile: { genre: { confidence: CONFIDENCE.AMBIGUOUS } } };
  const settled = { profile: { genre: { confidence: CONFIDENCE.HIGH } } };

  const playedUnsure = analysisPriority(unsure, { weights, track: track('Big') });
  const playedSettled = analysisPriority(settled, { weights, track: track('Big') });
  const obscureUnsure = analysisPriority(unsure, { weights, track: track('Obscure') });
  assert.ok(playedUnsure > playedSettled, 'a settled answer is not worth re-asking');
  assert.ok(playedUnsure > obscureUnsure, 'and neither is a record nobody plays');
  assert.equal(relevanceOf({ artists: [{ name: 'Nobody' }] }, weights), 1, 'the floor is 1, never 0');
});

test('playlist reach counts placements, so a wrong answer spreading is visible', () => {
  const reach = playlistReach({ playlists: [
    { tracks: [{ id: 'a' }, { id: 'b' }] }, { tracks: [{ id: 'a' }] }, { tracks: [{ id: 'a' }] }] });
  assert.equal(reach.get('a'), 3);
  assert.equal(reach.get('b'), 1);
  assert.equal(playlistReach({}).size, 0);
});

/* ---------- the review queue ---------- */

function fixture({ weights = null, log = null } = {}) {
  const { lib, tags } = buildFixtureLibrary();
  tags.th0 = { tags: [['schranz', 100], ['hard groove', 80]], checkedAt: NOW };
  const idx = indexCaches({ lastfm: tags, now: NOW });
  const profiles = profileLibrary(lib, idx, { registry: buildRegistry(idx.present), now: NOW });
  const analysis = analysePlaylists(lib, profiles, { now: NOW });
  return { lib, profiles, analysis,
    queue: reviewQueue(profiles, lib, { classifications: analysis.classifications,
                                        relationships: analysis.relationships, weights, log }) };
}

test('one question is asked once, however many tracks ride on it', () => {
  const { lib, profiles } = fixture();
  const raw = trackQueue(profiles, lib, { limit: 1000 });
  // Eight tracks by one artist with no track-level evidence are one question.
  const big = raw.find(r => r.tracks > 1);
  assert.ok(big, 'nothing collapsed — the queue is asking the same thing repeatedly');
  assert.equal(big.examples.length <= 5, true, 'and it does not ship every track to the UI');
  assert.equal(big.trackIds.length, big.tracks);
  assert.ok(raw.length < 40, `${raw.length} questions for a 12-playlist library is too many to face`);
});

test('a question covering many tracks outranks one covering a single track', () => {
  const { lib, profiles } = fixture();
  const rows = trackQueue(profiles, lib, { limit: 1000 });
  const many = rows.find(r => r.tracks >= 5);
  const one = rows.find(r => r.tracks === 1 && r.confidence === many.confidence);
  if (one) assert.ok(many.score > one.score);
});

test('an ordinary Spotify track is not flagged as a thin identity', () => {
  // Most tracks in most libraries have no ISRC and no MusicBrainz match. That
  // is the normal state, and flagging it would put the whole library in the
  // queue and say nothing.
  const { lib, profiles } = fixture();
  const flagged = trackQueue(profiles, lib, { limit: 1000 })
    .filter(r => r.reasons.some(x => x.code === 'THIN_IDENTITY'));
  assert.deepEqual(flagged, []);
});

test('a question already answered is never asked again', () => {
  const { queue } = fixture();
  const first = queue.tracks[0];
  const log = new CorrectionLog().add(correction({ kind: 'genre', trackId: first.trackIds[0], value: 'techno' }));
  const after = fixture({ log }).queue;
  assert.ok(after.tracks.length <= queue.tracks.length);
  assert.ok(!after.tracks.some(r => r.trackIds.includes(first.trackIds[0])));
});

test('every queued row says why it is being asked', () => {
  const { queue } = fixture();
  for (const r of queue.tracks) {
    assert.ok(r.reasons.length, `${r.title} is in the queue with no reason`);
    for (const reason of r.reasons) assert.ok(REASONS[reason.code], `unknown reason ${reason.code}`);
  }
});

test('unmapped concepts are ranked by how much of the library is waiting on them', () => {
  const { profiles } = fixture();
  const concepts = conceptQueue(profiles);
  assert.ok(concepts.length >= 2);
  assert.ok(concepts[0].tracks >= concepts[1].tracks);
  assert.ok(concepts[0].why.includes(concepts[0].raw));
  // Answering one removes it — the loop §8 describes, closed.
  const log = new CorrectionLog().add(correction({ kind: 'concept', raw: concepts[0].raw, value: 'techno' }));
  assert.ok(!conceptQueue(profiles, { log }).some(c => c.raw === concepts[0].raw));
});

test('the playlist queue surfaces duplicates and names that disagree with their music', () => {
  const { lib, profiles } = fixture();
  const mislabelled = { ...lib, playlists: lib.playlists.map(p => p.id === 'p-ju' ? { ...p, name: 'Tech House Vol 2' } : p) };
  const idx = indexCaches({ lastfm: buildFixtureLibrary().tags, now: NOW });
  const reprofiled = profileLibrary(mislabelled, idx, { registry: buildRegistry(idx.present), now: NOW });
  const a = analysePlaylists(mislabelled, reprofiled, { now: NOW });
  const q = playlistQueue(a.classifications, a.relationships);

  assert.ok(q.some(r => r.id === 'p-ju' && r.reasons.some(x => /named .* but its tracks/.test(x.detail))));
  assert.ok(q.some(r => r.reasons.some(x => /duplicate/.test(x.detail))));
  void profiles;
});

test('the queue survives an empty library and an empty log', () => {
  const q = reviewQueue(new Map(), {}, {});
  assert.deepEqual(q.tracks, []);
  assert.deepEqual(q.playlists, []);
  assert.deepEqual(q.concepts, []);
});
