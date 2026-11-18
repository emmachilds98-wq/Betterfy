import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardState, cardStateOf, pickAgrees, sureOnes, keptRate, keptLine, KEPT_MIN,
         learnedNote, learnedFor } from '../core/review/filequeue.mjs';
import { evidenceWords, evidenceLine } from '../web/ui/sound.mjs';
import * as INBOX from '../web/screens/inbox.mjs';

// BUILD-7 U1: every File card is Sure, two-way or your call, decided in one place.

const tagsOnly = { id: 'p1', name: 'Rollers', score: 0.8, band: 'HIGH', via: 'tags' };
const heard = { id: 'p1', name: 'Rollers', score: 0.8, band: 'HIGH', via: 'sound', tagsAgree: true, evidence: { sound: 0.6 } };
const history = { id: 'p1', name: 'Rollers', score: 0.8, band: 'HIGH', via: 'history', count: 3, total: 4 };

test('cardState: no pick is your call', () => {
  assert.equal(cardState(null), 'yourCall');
  assert.equal(cardState(undefined, { others: 3 }), 'yourCall');
});

test('cardState: a settled family is two-way, even with a HIGH backed pick', () => {
  assert.equal(cardState(heard, { band: 'HIGH', family: true, others: 1 }), 'twoWay');
});

test('cardState: HIGH, backed and agreeing is Sure, by sound or by filing history', () => {
  assert.equal(cardState(heard, { band: 'HIGH' }), 'sure');
  assert.equal(cardState(history, { band: 'HIGH' }), 'sure');
  assert.equal(cardState({ ...tagsOnly, evidence: { learned: 0.2 } }), 'sure', 'learned counts as backing');
  assert.equal(cardState({ id: 'x', band: 'high', filed: true }), 'sure', "Tidy's lower-case band too");
});

test('cardState: a tags-only HIGH pick is never Sure', () => {
  assert.equal(cardState(tagsOnly, { band: 'HIGH', others: 2 }), 'twoWay');
  assert.equal(cardState(tagsOnly, { band: 'HIGH', others: 0 }), 'yourCall', 'nothing to set it against');
  assert.equal(cardState(tagsOnly, { band: 'HIGH', backed: true }), 'sure', 'an explicit backed wins over the pick');
});

test('cardState: disagreement or a pair check takes Sure away', () => {
  assert.equal(cardState(heard, { band: 'HIGH', agree: false, others: 1 }), 'twoWay');
  assert.equal(cardState(heard, { band: 'HIGH', pair: true, others: 1 }), 'twoWay');
  assert.equal(cardState(heard, { band: 'LIKELY', pair: true, others: 1 }), 'twoWay');
});

test('cardState: LIKELY with a second pick is two-way; without one, or AMBIGUOUS, or no band, your call', () => {
  assert.equal(cardState(heard, { band: 'LIKELY', others: 1 }), 'twoWay');
  assert.equal(cardState(heard, { band: 'medium', others: 1 }), 'twoWay');
  assert.equal(cardState(heard, { band: 'LIKELY', others: 0 }), 'yourCall');
  assert.equal(cardState(heard, { band: 'AMBIGUOUS', others: 2 }), 'yourCall');
  assert.equal(cardState({ ...tagsOnly, band: null }, { band: null, others: 2 }), 'yourCall');
  assert.equal(cardState({ ...history, band: null }, { band: null, others: 1 }), 'twoWay', 'backed with no band: one of two');
  assert.equal(cardState({ ...history, band: null }, { band: null, others: 0 }), 'yourCall');
  assert.equal(cardState(heard, { others: 1 }), 'sure', "the pick's own band when none is given");
});

test('pickAgrees: only a sound pick the tags do not name, on a tagged track, disagrees', () => {
  const s = { id: 'p1', via: 'sound', tagsAgree: false };
  assert.equal(pickAgrees(s, { suggest: [{ id: 'p2' }] }), false);
  assert.equal(pickAgrees(s, { suggest: [] }), true, 'no tags: nothing to disagree');
  assert.equal(pickAgrees(heard, { suggest: [{ id: 'p1' }] }), true);
  assert.equal(pickAgrees(tagsOnly, null), true);
  assert.equal(pickAgrees(null), false);
});

test('cardStateOf reads the decision, the pair mark and the other picks', () => {
  const row = { id: 't', suggest: [{ id: 'p1' }] };
  assert.equal(cardStateOf(row, [heard, { id: 'p2' }], { band: 'HIGH' }), 'sure');
  assert.equal(cardStateOf(row, [heard, { id: 'p2' }], { band: 'LIKELY', decision: { kind: 'family', family: 'dnb' } }), 'twoWay');
  assert.equal(cardStateOf(row, [{ ...heard, pair: true }, { id: 'p2' }], { band: 'HIGH' }), 'twoWay');
  assert.equal(cardStateOf(row, [{ ...heard, tagsAgree: false }, { id: 'p2' }], { band: 'HIGH' }), 'twoWay');
  assert.equal(cardStateOf(row, [], {}), 'yourCall');
});

test('sureOnes leaves out a HIGH card whose sources disagree', () => {
  const rows = [{ id: 'a', suggest: [{ id: 'p1' }] }, { id: 'b', suggest: [{ id: 'p1' }] }];
  const picks = { a: [heard], b: [{ ...heard, tagsAgree: false }] };
  const got = sureOnes(rows, { picksOf: r => picks[r.id], bandOf: () => 'HIGH' });
  assert.deepEqual(got.map(s => s.row.id), ['a']);
});

/* ---- the 30-day kept rate ---- */
const NOW = Date.parse('2026-11-18T12:00:00Z');
const iso = daysAgo => new Date(NOW - daysAgo * 864e5).toISOString();
const filing = (n, extra = {}) => ({ at: iso(n), op: 'add', playlistId: 'p1', trackIds: ['t' + n], reason: 'filed from inbox', ...extra });

test('keptRate: shown only from 20 filings in the window', () => {
  const log = Array.from({ length: KEPT_MIN - 1 }, (_, k) => filing(k / 2));
  assert.equal(keptRate(log, NOW).show, false);
  assert.equal(keptLine(keptRate(log, NOW)), '');
  log.push(filing(12));
  const k = keptRate(log, NOW);
  assert.equal(k.n, 20); assert.equal(k.show, true);
  assert.equal(keptLine(k), 'Last 30 days: 100% of the picks you filed stayed');
});

test('keptRate: undone and later-removed filings did not stay; older ones are not counted', () => {
  const log = Array.from({ length: 18 }, (_, k) => filing(k));
  log.push(filing(1.5, { undoneAt: iso(1) }));
  log.push(filing(2.5));
  log.push({ at: iso(2), op: 'remove', playlistId: 'p1', trackIds: ['t2.5'] });
  log.push(filing(40));                                        // outside the window
  log.push({ at: iso(0.1), op: 'skip', trackIds: ['x'], queuePos: 0 });
  const k = keptRate(log, NOW);
  assert.equal(k.n, 20); assert.equal(k.kept, 18);
  assert.equal(keptLine(k), 'Last 30 days: 90% of the picks you filed stayed');
});

test('keptRate: a batch counts each track, and an undo of its group takes all of them back', () => {
  const g = { group: 'g1', reason: 'filed the sure ones' };
  const log = [{ ...filing(1, g), trackIds: Array.from({ length: 12 }, (_, i) => 'a' + i) },
               { ...filing(1, g), at: iso(0.9), playlistId: 'p2', trackIds: Array.from({ length: 10 }, (_, i) => 'b' + i) },
               { at: iso(0.5), op: 'undo', of: iso(1), ofGroup: 'g1' }];
  const k = keptRate(log, NOW);
  assert.equal(k.n, 22); assert.equal(k.kept, 0);
  assert.deepEqual(keptRate([], NOW), { n: 0, kept: 0, rate: null, days: 30, show: false });
});

/* ---- "it learned" ---- */
test('learnedNote says what was recorded, and only for the same artist on another track', () => {
  const l = { kind: 'picked', artistId: 'a1', artist: 'Tim Reaper', playlist: 'Rollers', trackId: 't1' };
  assert.equal(learnedNote(l), 'Learned: you file Tim Reaper in Rollers.');
  assert.equal(learnedNote({ ...l, kind: 'skip' }), 'Noted: you skipped the last one by Tim Reaper.');
  assert.equal(learnedNote({ ...l, kind: 'undo' }), 'Noted: you took Tim Reaper back out of Rollers.');
  assert.equal(learnedNote({ ...l, kind: 'picked', playlist: null }), '');
  assert.equal(learnedNote(null), '');
  assert.equal(learnedFor(l, { id: 't2', artists: [{ id: 'a1' }] }), true);
  assert.equal(learnedFor(l, { id: 't1', artists: [{ id: 'a1' }] }), false, 'not the track it came from');
  assert.equal(learnedFor(l, { id: 't3', artists: [{ id: 'a2' }] }), false);
});

/* ---- the evidence line ---- */
test('evidenceWords: words for each part the pick carries, never a percentage', () => {
  assert.deepEqual(evidenceWords({ playlist: 'Rollers', via: 'tags', tags: ['liquid dnb', 'dnb', 'x'] }),
    ['tags say liquid dnb, dnb', 'not heard yet']);
  assert.deepEqual(evidenceWords({ playlist: 'Rollers', via: 'history', count: 3, total: 4 }),
    ['3 of 4 other tracks by this artist are already here', 'not heard yet']);
  assert.deepEqual(evidenceWords({ playlist: 'Rollers', via: 'sound', sound: true, tagsAgree: true }),
    ['sounds like your Rollers', 'tags agree']);
  assert.deepEqual(evidenceWords({ playlist: 'Rollers', via: 'blend', untagged: true }),
    ['where you file this artist and ones like them', 'not heard yet']);
  assert.deepEqual(evidenceWords({ playlist: 'R', via: 'tags', learned: true, sound: true }),
    ['sounds like your R', 'its tags fit here', 'learned from what you filed']);
  assert.deepEqual(evidenceWords(null), []);
  const html = evidenceLine({ playlist: 'A<b>', via: 'sound', sound: true });
  assert.match(html, /class="ax evline"/);
  assert.match(html, /A&lt;b&gt;/);
  assert.doesNotMatch(html, /%/);
});

/* ---- the card ---- */
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function ctx({ picks, band = 'HIGH', decision = null, learned = null, kept = null, track = {} }) {
  const t = { id: 't2', title: 'Song', artist: 'Tim Reaper', artists: [{ id: 'a1', name: 'Tim Reaper' }], added: '2026', tags: ['liquid dnb'], suggest: picks, ...track };
  return {
    S: { inboxAt: 0, fileSel: new Set(), learned, kept }, R: { backlog: [t] }, LIB: { liked: [t] }, CFG: {}, esc,
    filePicks: () => picks, artHTML: () => '', ICON_PLAY: '', mmss: () => '', trackChip: () => '', tagChips: () => '',
    trackStrip: () => '', soundIdHTML: () => '', soundNote: () => '', pickEvidence: () => '',
    pickBand: sg => `<span class="band">${sg.band}</span>`, fileBand: () => band, fileDecision: () => decision,
    matchMedia: () => ({ matches: false }),
  };
}
const second = { id: 'p2', name: 'Jungle', score: 0.5, via: 'tags' };

test('the card: Sure lights the top pick, fills File and shows the band', () => {
  const html = INBOX.view(ctx({ picks: [history, second] }));
  assert.match(html, /data-state="sure"/);
  assert.match(html, /class="pick best"/);
  assert.match(html, /class="b big go grow"/);
  assert.match(html, /class="band">HIGH/);
  assert.match(html, /3 of 4 other tracks by this artist are already here/);
});

test('the card: a tags-only HIGH pick is two-way, the top two as equals, nothing filled', () => {
  const html = INBOX.view(ctx({ picks: [tagsOnly, second] }));
  assert.match(html, /data-state="twoWay"/);
  assert.match(html, /<b>Rollers<\/b> or <b>Jungle<\/b>\?/);
  assert.equal((html.match(/class="pick twoway"/g) ?? []).length, 2);
  assert.doesNotMatch(html, /pick best/);
  assert.doesNotMatch(html, /class="b big go/);
  assert.doesNotMatch(html, /class="band"/, 'no Sure chip on a choice');
  assert.match(html, /tags say liquid dnb · not heard yet/);
});

test('the card: your call shows the picks with none lit', () => {
  const html = INBOX.view(ctx({ picks: [{ ...tagsOnly, band: 'AMBIGUOUS' }, second], band: 'AMBIGUOUS' }));
  assert.match(html, /data-state="yourCall"/);
  assert.match(html, /Your call/);
  assert.doesNotMatch(html, /pick (best|twoway)/);
});

test('the card: a family decision keeps its own line and two-way picks', () => {
  const html = INBOX.view(ctx({ picks: [heard, second], band: 'LIKELY',
    decision: { kind: 'family', family: 'drum-and-bass', playlists: [{ id: 'p1' }, { id: 'p2' }] } }));
  assert.match(html, /data-state="twoWay"/);
  assert.match(html, /Drum and bass<\/b> for sure/);
  assert.doesNotMatch(html, / or <b>/);
});

test('the card: the learned note shows on the next card by that artist only', () => {
  const learned = { kind: 'picked', artistId: 'a1', artist: 'Tim Reaper', playlist: 'Jungle', trackId: 't1' };
  assert.match(INBOX.view(ctx({ picks: [tagsOnly, second], learned })), /class="learnline"[^>]*>Learned: you file Tim Reaper in Jungle\./);
  assert.doesNotMatch(INBOX.view(ctx({ picks: [tagsOnly, second], learned: { ...learned, artistId: 'a9' } })), /learnline/);
});

test('the card: the kept-rate line only once it is ready and at 20 filings', () => {
  const k = n => ({ status: 'ready', k: { n, kept: n - 1, rate: (n - 1) / n, days: 30, show: n >= 20 } });
  assert.doesNotMatch(INBOX.view(ctx({ picks: [history], kept: k(19) })), /keptline/);
  assert.match(INBOX.view(ctx({ picks: [history], kept: k(20) })), /class="keptline"[^>]*>Last 30 days: 95% of the picks you filed stayed</);
});

test('filing something other than the first pick, skipping, and undoing each leave a note', async () => {
  const mk = () => {
    const a = { id: 'a1', name: 'Tim Reaper' };
    const rows = [{ id: 't1', title: 'One', artist: 'Tim Reaper', artists: [a], tags: [] },
                  { id: 't2', title: 'Two', artist: 'Tim Reaper', artists: [a], tags: [] }];
    let undo = null;
    const c = { S: { inboxAt: 0, fileSel: new Set() }, R: { backlog: rows }, FB: {}, CFG: { p1: { name: 'Rollers' }, p2: { name: 'Jungle' } },
      filePicks: () => [tagsOnly, second], fileBand: () => 'HIGH',
      addTracks: async () => {}, logAction: async () => {}, getLog: async () => [{ at: 'x' }], undoAction: async () => {},
      recordAccept: async () => {}, forgetAccept: async () => {}, recordSkip: async () => {},
      toast: (m, u) => { undo = u; }, render: () => {} };
    return { c, undo: () => undo };
  };
  let { c, undo } = mk();
  await INBOX.fileCurrent(c, 'p2');
  assert.equal(c.S.learned.kind, 'picked'); assert.equal(c.S.learned.playlist, 'Jungle');
  await undo()();
  assert.equal(c.S.learned.kind, 'undo');
  ({ c } = mk());
  await INBOX.fileCurrent(c, 'p1');
  assert.equal(c.S.learned ?? null, null, 'filing the first pick teaches nothing new to say');
  ({ c } = mk());
  await INBOX.inboxAct(c, 'skip');
  assert.equal(c.S.learned.kind, 'skip');
});
