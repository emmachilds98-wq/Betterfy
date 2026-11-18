import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { trackWeights, orderBacklog, valueOf, rowUncertainty, sureOnes, cardBand, registrantOfIsrc } from '../core/review/filequeue.mjs';
import * as INBOX from '../web/screens/inbox.mjs';

// BUILD-5-PLAN §5.2: File's queue order by value, the sure batch, and the
// roll-forward by sound ID and label.

const row = (id, artist, score, extra = {}) => ({ id, artists: [{ id: 'a-' + artist, name: artist }], artist, title: 'T' + id,
  added: '2026-01-01', skips: 0, suggest: score == null ? [] : [{ id: 'p1', name: 'One', score }], ...extra });

test('trackWeights: top-track ranks and recent plays are counts', () => {
  const w = trackWeights({ topTracks: [{ weight: 3, items: ['a', 'b'] }], recentTracks: ['b', 'b', 'c'] });
  assert.ok(w.get('a') > w.get('b') - 1.2 && w.get('a') > 2.9);
  assert.equal(+w.get('c').toFixed(2), 0.6);
  assert.equal(trackWeights().size, 0);
});

test('uncertainty: a known band wins, else 1 - the top score, else nothing known', () => {
  assert.equal(rowUncertainty(row('x', 'A', 0.9), 'HIGH'), 0.05);
  assert.equal(rowUncertainty(row('x', 'A', 0.9), 'AMBIGUOUS'), 0.9);
  assert.equal(+rowUncertainty(row('x', 'A', 0.7)).toFixed(2), 0.3);
  assert.equal(rowUncertainty(row('x', 'A', null)), 1);
});

test('the queue leads with what you play most and the engine is least sure of', () => {
  const rows = [row('quiet-sure', 'Quiet', 0.95), row('loud-sure', 'Loud', 0.95),
                row('quiet-lost', 'Quiet2', 0.1), row('loud-lost', 'Loud', 0.1)];
  const weights = new Map([['Loud', 5]]);
  assert.deepEqual(orderBacklog(rows, { weights }).map(r => r.id), ['loud-lost', 'quiet-lost', 'loud-sure', 'quiet-sure']);
  // a track you play by name counts on top of its artist
  const tracks = new Map([['quiet-lost', 10]]);
  assert.equal(orderBacklog(rows, { weights, tracks })[0].id, 'quiet-lost');
});

test('skipped cards stay below unseen ones, and with no signal it is newest first', () => {
  const rows = [row('old', 'A', 0.5, { added: '2025-01-01' }), row('skipped', 'B', 0, { skips: 1, added: '2027-01-01' }),
                row('new', 'C', 0.5, { added: '2026-06-01' })];
  assert.deepEqual(orderBacklog(rows).map(r => r.id), ['new', 'old', 'skipped']);
});

test('the calibrated band takes over from the pick score when the engine judged the track', () => {
  const rows = [row('judged-sure', 'A', 0.2), row('guess', 'B', 0.2)];
  const bandOf = r => (r.id === 'judged-sure' ? 'HIGH' : null);
  assert.equal(orderBacklog(rows, { bandOf })[0].id, 'guess');
  assert.ok(valueOf(rows[0], { bandOf }) < valueOf(rows[1], { bandOf }));
});

test('cardBand: calibrated verdict first, then the pick\'s own band', () => {
  assert.equal(cardBand([{ band: 'LIKELY' }], { kind: 'confident' }), 'HIGH');
  assert.equal(cardBand([{ band: 'LIKELY' }], null), 'LIKELY');
  assert.equal(cardBand([{}], null), null);
});

test('sureOnes: HIGH leading pick only, skipped cards left out', () => {
  const rows = [row('a', 'A', 0.9), row('b', 'B', 0.9), row('c', 'C', 0.9, { skips: 1 }), row('d', 'D', 0.9)];
  const picksOf = r => r.suggest, bandOf = r => (r.id === 'd' ? 'LIKELY' : 'HIGH');
  assert.deepEqual(sureOnes(rows, { picksOf, bandOf }).map(s => s.row.id), ['a', 'b']);
  assert.equal(sureOnes(rows, { picksOf, bandOf, limit: 1 }).length, 1);
});

test('registrantOfIsrc reads country + registrant, or nothing', () => {
  assert.equal(registrantOfIsrc('GB-AYE-20-00123'), 'GBAYE');
  assert.equal(registrantOfIsrc('nope'), null);
});

// --- the File screen ---

function mk(n = 3, over = {}) {
  const log = [], adds = [], toasts = [];
  const ctx = {
    S: { inboxAt: 0, fileSel: new Set(), fileSelFor: null }, esc: x => x,
    R: { backlog: Array.from({ length: n }, (_, i) => row('t' + (i + 1), 'A' + i, 0.9)) },
    CFG: { p1: { name: 'One' } }, FB: {},
    fileSure: () => sureOnes(ctx.R.backlog, { picksOf: r => r.suggest, bandOf: () => 'HIGH' }),
    addTracks: async (pl, ids) => { adds.push([pl, ...ids]); },
    logAction: async e => { log.push(e); }, getLog: async () => [{ at: 'at' + log.length }],
    undoAction: async at => { toasts.push('undo ' + at); }, newGroup: () => 'G1',
    recordAccept: async () => {}, forgetAccept: async () => {},
    toast: (m, undo) => toasts.push([m, undo]), render() {}, ...over,
  };
  return { ctx, log, adds, toasts };
}

test('File the sure ones: one add per playlist, one History group, band sure, one undo', async () => {
  const { ctx, log, adds, toasts } = mk(3);
  assert.match(INBOX.sureBatchHTML(ctx), /File the 3 sure ones/);
  await INBOX.fileSureOnes(ctx);
  assert.deepEqual(adds, [['p1', 't1', 't2', 't3']]);
  assert.equal(log.length, 1);
  assert.equal(log[0].band, 'sure');
  assert.equal(log[0].group, 'G1');
  assert.equal(ctx.R.backlog.length, 0);
  const [msg, undo] = toasts.at(-1);
  assert.match(msg, /Filed 3 sure ones/);
  await undo();
  assert.ok(toasts.includes('undo at1'), 'undoAction on the group runs once');
});

test('the batch button needs two or more sure cards', () => {
  const { ctx } = mk(1);
  assert.equal(INBOX.sureBatchHTML(ctx), '');
});

test('a failed write in the batch leaves the queue alone and says why', async () => {
  const { ctx, toasts } = mk(2, { addTracks: async () => { throw new Error('403 nope'); } });
  await INBOX.fileSureOnes(ctx);
  assert.equal(ctx.R.backlog.length, 2);
  assert.match(toasts.at(-1)[0], /^Failed: 403/);
  assert.equal(ctx.S.filing, false);
});

test('filing one card logs the band as sure / likely / unsure', async () => {
  const { ctx, log } = mk(2);
  ctx.fileBand = () => 'HIGH';
  ctx.filePicks = t => t.suggest;
  await INBOX.fileCurrent(ctx, 'p1');
  assert.equal(log[0].band, 'sure');
});

test('roll-forward also follows the same sound ID, and the same label when the engine picks that playlist', () => {
  const t = { id: 't', artists: [{ id: 'a1', name: 'A' }] };
  const bl = [
    { id: 'same-artist', artists: [{ id: 'a1' }], suggest: [] },
    { id: 'same-sound', artists: [{ id: 'a2' }], suggest: [] },
    { id: 'other-sound', artists: [{ id: 'a3' }], suggest: [] },
    { id: 'label-fits', artists: [{ id: 'a4' }], suggest: [{ id: 'p1' }] },
    { id: 'label-elsewhere', artists: [{ id: 'a5' }], suggest: [{ id: 'p9' }] },
  ];
  const sound = x => (x.id === 't' || x.id === 'same-sound' ? 'Jungle' : x.id === 'other-sound' ? 'House' : null);
  const reg = x => (x.id === 't' || x.id.startsWith('label') ? 'GBAYE' : null);
  const got = INBOX.rollForwardFor(t, bl, ['p1'], {}, { sound, registrant: reg });
  assert.deepEqual(got.map(r => [r.id, r.how]), [['same-artist', 'artist'], ['same-sound', 'sound'], ['label-fits', 'label']]);
  // without the page's lookups it is the artist roll-forward it always was
  assert.deepEqual(INBOX.rollForwardFor(t, bl, ['p1']).map(r => r.id), ['same-artist']);
  // a rejection is still an answer
  assert.deepEqual(INBOX.rollForwardFor(t, bl, ['p1'], { 'same-sound': { rejected: ['p1'] } }, { sound, registrant: reg })
    .map(r => r.id), ['same-artist', 'label-fits']);
});

// --- built page: the listening fetch and the order it feeds ---

const BUNDLE = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');

test('the page asks for /me/top/tracks in three windows, cached with the rest', () => {
  assert.match(BUNDLE, /\/me\/top\/tracks\?limit=50&time_range=\$\{range\}/);
  assert.match(BUNDLE, /const data = \{ topWindows, recentArtists, topTracks, recentTracks \}/);
  assert.match(BUNDLE, /tracks: trackWeights\(\{ topTracks, recentTracks \}\)/);
});

test('the page bundles relevance and the file queue as globals', () => {
  const i = BUNDLE.indexOf('/* Generated by bundler.mjs'), j = BUNDLE.indexOf('/* ---------- storage ----------');
  const sandbox = { console };
  vm.createContext(sandbox);
  vm.runInContext(BUNDLE.slice(i, j), sandbox);
  for (const name of ['orderBacklog', 'sureOnes', 'trackWeights', 'relevanceOf', 'uncertaintyOf', 'BAND_LOG'])
    assert.equal(typeof vm.runInContext(`typeof ${name}`, sandbox), 'string');
  assert.equal(vm.runInContext('typeof orderBacklog', sandbox), 'function');
});

test('buildReports orders the queue by listening once it has landed, newest first before', () => {
  const cut = (a, b) => { const i = BUNDLE.indexOf(a), j = BUNDLE.indexOf(b, i); assert.ok(i > 0 && j > i, a); return BUNDLE.slice(i, j); };
  const tr = (id, artist, added) => ({ id, name: 'N' + id, artists: [{ id: 'a-' + artist, name: artist }], album: 'x',
    duration_ms: 2e5, isrc: 'I' + id, added_at: added });
  const lib = { user: { id: 'u' }, playlists: [], liked: [tr('new', 'Quiet', '2026-02-01'), tr('old', 'Loud', '2025-01-01')] };
  const run = listening => {
    const sb = { console, FB: {}, LS: { getItem: () => null, setItem: () => {} }, LC: listening };
    vm.createContext(sb);
    vm.runInContext(cut('/* Generated by bundler.mjs', '/* ---------- storage ----------'), sb);
    vm.runInContext('const mmss = ms => "0:00"; const ALL_SONGS_NAME = "All Songs";' + (listening ? 'var LISTENING_CACHE = LC;' : ''), sb);
    vm.runInContext(cut('/* ---------- reports (mirrors', '/* ===================== UI'), sb);
    return sb.buildReports(lib, {}, {}).backlog.map(b => b.id);
  };
  assert.deepEqual(run(null), ['new', 'old']);
  assert.deepEqual(run({ weights: new Map([['Loud', 4]]), tracks: null }), ['old', 'new']);
});

test('pickBacked: only sound or filing history backs a pick, never tags alone', async () => {
  const { pickBacked, backedBand } = await import('../core/review/filequeue.mjs');
  assert.equal(pickBacked({ via: 'history' }), true);
  assert.equal(pickBacked({ via: 'sound' }), true);
  assert.equal(pickBacked({ via: 'blend', filed: true }), true);
  assert.equal(pickBacked({ via: 'blend', evidence: { sound: 0, history: 0.2 } }), true);
  assert.equal(pickBacked({ via: 'tags', axis: 'genre' }), false);
  assert.equal(pickBacked({ via: 'blend', similar: true }), false, 'similar artists alone are not filing history');
  assert.equal(pickBacked({ evidence: { tags: 1, sound: 0 } }), false);
  assert.equal(pickBacked(null), false);
  assert.equal(backedBand('HIGH', { via: 'tags' }), 'LIKELY');
  assert.equal(backedBand('high', {}), 'medium');
  assert.equal(backedBand('HIGH', { via: 'history' }), 'HIGH');
  assert.equal(backedBand('AMBIGUOUS', {}), 'AMBIGUOUS');
  assert.equal(backedBand(undefined, {}), null);
});

test('filing a liked song where it already is writes nothing but still records the answer', async () => {
  const accepted = [];
  const { ctx, log, adds } = mk(2, { recordAccept: async (id, ids) => { accepted.push([id, ...ids]); } });
  ctx.R.backlog[0].inPl = [{ id: 'p1', name: 'P1' }];
  const id = ctx.R.backlog[0].id;
  await INBOX.fileCurrent(ctx, 'p1');
  assert.deepEqual(adds, [], 'no second copy in p1');
  assert.equal(log.length, 0);
  assert.deepEqual(accepted, [[id, 'p1']], 'File remembers it is filed, so it leaves the queue');
  assert.equal(ctx.R.backlog.length, 1);
});

test('the sure batch skips the ones already in their playlist and still takes them off the queue', async () => {
  const accepted = [];
  const { ctx, adds } = mk(3, { recordAccept: async (id, ids) => { accepted.push([id, ...ids]); } });
  ctx.R.backlog[1].inPl = [{ id: 'p1', name: 'P1' }];
  await INBOX.fileSureOnes(ctx);
  assert.deepEqual(adds, [['p1', 't1', 't3']]);
  assert.equal(ctx.R.backlog.length, 0);
  assert.equal(accepted.length, 3);
});

test('a card already in a playlist offers Keep it there and a two-tap Remove from Liked', async () => {
  const { ctx, adds } = mk(2, { libraryCall: async () => {}, logAction: async () => {}, getLog: async () => [{ at: 'u1' }] });
  const t = ctx.R.backlog[0];
  t.inPl = [{ id: 'p1', name: 'Jungle' }];
  assert.match(INBOX.alreadyHTML(ctx, t), /Already in <b>Jungle<\/b>/);
  assert.match(INBOX.alreadyHTML(ctx, t), />Remove from Liked</);
  assert.equal(INBOX.alreadyHTML(ctx, ctx.R.backlog[1]), '', 'not shown for a song in no playlist');
  await INBOX.actions.unlikeask(ctx);
  assert.equal(ctx.R.backlog.length, 2, 'the first tap only asks');
  assert.match(INBOX.alreadyHTML(ctx, t), /Tap again to remove from Liked/);
  await INBOX.actions.unlikeask(ctx);
  assert.equal(ctx.R.backlog.length, 1, 'the second tap removes it from Liked and from File');
  await INBOX.actions.keepthere(ctx);
  assert.deepEqual(adds, [], 'Keep it there on a song in no playlist does nothing');
});
