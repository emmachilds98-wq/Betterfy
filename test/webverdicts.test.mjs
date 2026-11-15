import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { installTidy } from './tidyctx.mjs';
import * as TIDY from '../web/screens/tidy.mjs';
import { feedbackExamples } from '../core/intrinsic/audio-feedback.mjs';

/*
 * Build 5, B6 and B7 (docs/BUILD-5-PLAN.md §1.3, §5.1), run out of the built page.
 *
 * B7: filing from the File screen never wrote anything to feedback, so the
 * sound learner (audio-feedback.mjs reads FB.accepted and FB.rejected) learned
 * only from rejects. An accept is now FB[track].accepted.
 *
 * B6: Tidy's tag-tier "Wrong place" rows had no "Keep here", so a row you had
 * decided to leave came back every sync. It now has one, recording the same
 * "not that playlist" verdict By sound's Keep here always did, plus
 * FB[track].kept, and a kept track is offered as wrong there by neither tier.
 */

const PAGE = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
const own = x => JSON.parse(JSON.stringify(x));
function slice(from, to, what) {
  const i = PAGE.indexOf(from), j = PAGE.indexOf(to, i);
  assert.ok(i > 0 && j > i, `${what} not found — rebuild with node build-web.mjs`);
  return PAGE.slice(i, j);
}
const esc = x => String(x ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** The real feedback helpers over an in-memory idb. */
function helpers(extra = {}) {
  let store;
  const sandbox = {
    idb: { get: async () => (store ? JSON.parse(JSON.stringify(store)) : undefined),
           set: async (k, v) => { if (k === 'feedback') store = JSON.parse(JSON.stringify(v)); } },
    console, peek: () => store, ...extra,
  };
  vm.createContext(sandbox);
  vm.runInContext(slice('let FB = {};', 'const FIELDS =', 'feedback helpers') + `
    globalThis.getFB = () => FB;`, sandbox);
  return sandbox;
}

/* ---- B7: accepts ---- */

test('recordAccept writes FB.accepted, in the shape audio-feedback.mjs reads as a positive', async () => {
  const s = helpers();
  await vm.runInContext("recordAccept('t1', ['p1', 'p2'])", s);
  assert.deepEqual(s.peek().t1.accepted, ['p1', 'p2']);
  const ex = feedbackExamples(s.peek());
  assert.deepEqual(own([...ex.pos]), [['t1', ['p1', 'p2']]]);
  assert.equal(ex.neg.size, 0);
});

test('an accept is the latest word: it lifts an earlier rejection of the same playlist', async () => {
  const s = helpers();
  await vm.runInContext("recordReject('t1', 'p1')", s);
  await vm.runInContext("recordReject('t1', 'p9')", s);
  await vm.runInContext("recordAccept('t1', 'p1')", s);
  assert.deepEqual(s.peek().t1.rejected, ['p9']);
  const ex = feedbackExamples(s.peek());
  assert.deepEqual(own([...ex.pos]), [['t1', ['p1']]]);
  assert.deepEqual(own([...ex.neg]), [['t1', ['p9']]]);
});

test('forgetAccept takes it back, and leaves no empty list behind', async () => {
  const s = helpers();
  await vm.runInContext("recordAccept('t1', ['p1', 'p2'])", s);
  await vm.runInContext("forgetAccept('t1', ['p1'])", s);
  assert.deepEqual(s.peek().t1.accepted, ['p2']);
  await vm.runInContext("forgetAccept('t1', ['p2'])", s);
  assert.equal('accepted' in s.peek().t1, false);
  await vm.runInContext("forgetAccept('nobody', ['p2'])", s);
  assert.equal(s.peek().nobody, undefined, 'forgetting on a track with no feedback creates nothing');
});

function filing(backlog) {
  const calls = { add: [], undo: [] };
  const s = helpers({
    R: { backlog }, S: { inboxAt: 0, fileSel: new Set() }, CFG: { p1: { name: 'Jungle' }, p2: { name: 'Late' } },
    toast: (m, undo) => { calls.toastUndo = undo; }, render: () => {}, rollForwardFor: () => [],
    addTracks: async (pl, ids) => { calls.add.push([pl, ...ids]); },
    logAction: async () => {}, getLog: async () => [{ at: 'T' + calls.add.length }],
    undoAction: async at => { calls.undo.push(at); },
  });
  vm.runInContext(slice('function toggleFileSel(id)', '// Keyboard parity', 'fileCurrent'), s);
  return Object.assign(s, { calls });
}

test('filing from the File screen records the accept, and its undo forgets it', async () => {
  const s = filing([{ id: 't1', title: 'Rinse It', artist: 'Tim Reaper', suggest: [] }]);
  await vm.runInContext("fileCurrent(['p1', 'p2'])", s);
  assert.deepEqual(s.calls.add, [['p1', 't1'], ['p2', 't1']]);
  assert.deepEqual(s.peek().t1.accepted, ['p1', 'p2']);
  await s.calls.toastUndo();
  assert.deepEqual(s.calls.undo, ['T2', 'T1']);
  assert.equal(s.getFB().t1.accepted, undefined);
});

test('a failed write records no accept', async () => {
  const s = filing([{ id: 't1', title: 'Rinse It', artist: 'Tim Reaper', suggest: [] }]);
  s.addTracks = async () => { throw new Error('403'); };
  s.toast = () => {};
  await vm.runInContext("fileCurrent('p1')", s);
  assert.equal(s.peek(), undefined);
});

test('two devices\' accepts and keeps union like rejections do, and appear only once used', () => {
  const s = helpers();
  vm.runInContext(slice('function mergeFeedback(local, remote)', '/**', 'mergeFeedback'), s);
  const m = own(vm.runInContext(`mergeFeedback(
    { t1: { skips: 0, lastSkip: null, rejected: [], accepted: ['p1'] }, t2: { skips: 0, lastSkip: null, rejected: [] } },
    { t1: { skips: 0, lastSkip: null, rejected: [], accepted: ['p2'], kept: ['p3'] }, t2: { skips: 1, lastSkip: null, rejected: [] } })`, s));
  assert.deepEqual(m.t1.accepted.sort(), ['p1', 'p2']);
  assert.deepEqual(m.t1.kept, ['p3']);
  assert.deepEqual(Object.keys(m.t2).sort(), ['lastSkip', 'rejected', 'skips'], 'no empty accepted/kept on entries that never had them');
});

/* ---- B6: Keep here ---- */

test('recordKeep marks the track kept where it is and rejects where it was to go', async () => {
  const s = helpers();
  await vm.runInContext("recordKeep('t1', 'p-house', ['p-jungle', 'p-dnb'])", s);
  await vm.runInContext("recordKeep('t1', 'p-house', ['p-jungle'])", s);
  assert.deepEqual(s.peek().t1.kept, ['p-house']);
  assert.deepEqual(s.peek().t1.rejected, ['p-jungle', 'p-dnb'], 'the same record By sound\'s Keep here always wrote');
  const ex = feedbackExamples(s.peek());
  assert.deepEqual(own([...ex.neg]), [['t1', ['p-dnb', 'p-jungle']]]);
  assert.equal(ex.pos.size, 0, 'a keep is not read as a new accept');
});

function tidy(R, { fb = {}, audio = false, rows = [] } = {}) {
  const s = { esc, thumbHTML: () => '', cmpTable: () => '', tagChips: () => '', tagEditorHTML: () => '',
    LISTENING_CACHE: { recentlyActive: new Set() }, LISTENING_PENDING: true, getListening: async () => null,
    render: () => {}, R, FB: fb, view: 'tidy',
    LIB: { playlists: [{ id: 'p-house', name: 'House', tracks: [{ id: 't1', name: 'Stray', artists: [{ name: 'Someone' }] }] }] } };
  if (audio) Object.assign(s, { AUDIO: { records: new Map([['t1', {}]]) }, soundHeard: () => 1,
    engineTargets: () => ['p-house', 'p-jungle'], audioSettings: () => ({ on: true }), fire: () => {} });
  vm.createContext(s);
  installTidy(s, slice);
  if (audio) {
    s.__rows = rows;
    vm.runInContext("Object.assign(TSOUND, { status: 'ready', res: { rows: __rows, accuracy: null } }); TSOUND.key = tidySoundKey();", s);
  }
  return s;
}
const MF = { id: 't1', title: 'Stray', artist: 'Someone', current: 'House', currentPlaylistId: 'p-house', currentScore: 0.05,
  confidence: 'high', suggest: [{ id: 'p-jungle', name: 'Jungle', score: 0.8 }, { id: 'p-dnb', name: 'DnB', score: 0.6 }, { id: 'p-x', name: 'X', score: 0.5 }], tags: [] };
const SOUND_ROW = { id: 't1', from: 'p-house', to: 'p-jungle', fromName: 'House', toName: 'Jungle', band: 'sure',
  sound: 'Jungle', bpm: 172, near: { to: 11, from: 0, k: 12 }, why: ['x'] };

test('a Wrong place row has Keep here, naming where it is and the moves it was offered', () => {
  const html = vm.runInContext('secMisfile()', tidy({ misfiled: [MF], within: [], across: [] }));
  assert.match(html, /data-mfkeep="t1" data-mffrom="p-house" data-mfaway="p-jungle,p-dnb">Keep here</);
});

test('a moved row has no Keep here', () => {
  const s = tidy({ misfiled: [MF], within: [], across: [] });
  vm.runInContext("S.moved.add('t1')", s);
  assert.doesNotMatch(vm.runInContext('secMisfile()', s), /data-mfkeep/);
});

test('By sound\'s Keep here now carries where the track is, so it can be kept in both tiers', () => {
  const s = tidy({ misfiled: [], within: [], across: [] }, { audio: true, rows: [SOUND_ROW] });
  vm.runInContext("S.tidySec = 'sound'", s);
  assert.match(vm.runInContext('vTidy()', s), /data-tsfrom="p-house" data-tskeep="t1" data-tsto="p-jungle">Keep here/);
});

test('kept in Wrong place hides the By sound row for the same track and playlist, even to another destination', () => {
  const fb = { t1: { skips: 0, lastSkip: null, rejected: ['p-dnb'], kept: ['p-house'] } };
  const s = tidy({ misfiled: [], within: [], across: [] }, { fb, audio: true, rows: [SOUND_ROW] });
  assert.equal(vm.runInContext('tidySoundCount()', s), 0);
  // Kept somewhere else is not kept here.
  fb.t1.kept = ['p-elsewhere'];
  assert.equal(vm.runInContext('tidySoundCount()', s), 1);
});

test('both Keep here buttons write through recordKeep; Wrong place drops the row at once', async () => {
  const kept = [], toasts = [];
  const c = { R: { misfiled: [{ id: 't1', currentPlaylistId: 'p-house' }, { id: 't2', currentPlaylistId: 'p-house' }] },
    recordKeep: async (...a) => kept.push(a), toast: m => toasts.push(m), render() {} };
  await TIDY.actions.tskeep(c, { dataset: { tskeep: 't1', tsfrom: 'p-house', tsto: 'p-jungle' } });
  await TIDY.actions.mfkeep(c, { dataset: { mfkeep: 't1', mffrom: 'p-house', mfaway: 'p-jungle,p-dnb' } });
  assert.deepEqual(kept, [['t1', 'p-house', ['p-jungle']], ['t1', 'p-house', ['p-jungle', 'p-dnb']]]);
  assert.deepEqual(c.R.misfiled.map(m => m.id), ['t2']);
  assert.equal(toasts.length, 2);
});

/* ---- kept tracks leave the tag tier at the source (buildReports) ---- */

function reports(fb) {
  const s = { console, FB: fb, LS: { getItem: () => null, setItem: () => {} } };
  vm.createContext(s);
  vm.runInContext(slice('/* Generated by bundler.mjs', '/* ---------- storage ----------', 'scoring core'), s);
  vm.runInContext('const mmss = ms => "0:00";', s);
  vm.runInContext(slice('/* ---------- reports (mirrors', '/* ===================== UI', 'reports'), s);
  vm.runInContext('const ALL_SONGS_NAME = "All Songs — Betterfy";', s);
  const track = (id, artist, title) => ({ id, name: title, artists: [{ id: 'a-' + artist, name: artist }], isrc: 'I' + id, duration_ms: 1 });
  const J = [['jungle', 100], ['breakbeat', 80], ['drum and bass', 60]], T = [['techno', 100], ['industrial techno', 70], ['minimal techno', 50]];
  const tags = { 'a-J1': { tags: J }, 'a-J2': { tags: J }, 'a-J3': { tags: J }, 'a-T1': { tags: T }, 'a-T2': { tags: T }, 'a-T3': { tags: T } };
  const lib = { playlists: [
    { id: 'p1', name: 'Jungle', tracks: [track('j1', 'J1', 'a'), track('j2', 'J2', 'b'), track('j3', 'J3', 'c'),
                                          track('j4', 'J1', 'd'), track('j5', 'J2', 'e'), track('stray', 'T3', 'Stray')] },
    { id: 'p2', name: 'Techno', tracks: [track('k1', 'T1', 'a'), track('k2', 'T2', 'b'), track('k3', 'T3', 'c'),
                                          track('k4', 'T1', 'd'), track('k5', 'T2', 'e')] }], liked: [] };
  const cfg = { p1: { name: 'Jungle', axis: 'genre', target: true }, p2: { name: 'Techno', axis: 'genre', target: true } };
  return own(s.buildReports(lib, cfg, tags).misfiled.map(m => [m.id, m.currentPlaylistId]));
}

test('a track kept in its playlist is not reported as Wrong place there on the next build', () => {
  assert.deepEqual(reports({}), [['stray', 'p1']], 'the fixture has one misfiled track');
  assert.deepEqual(reports({ stray: { skips: 0, lastSkip: null, rejected: ['p2'], kept: ['p1'] } }), []);
  assert.deepEqual(reports({ stray: { skips: 0, lastSkip: null, rejected: [], kept: ['p2'] } }), [['stray', 'p1']],
    'kept somewhere else says nothing about this playlist');
});
