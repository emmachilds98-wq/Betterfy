// Tidy › Hard to find: songs Spotify's search shows as another version (core/review/hidden.mjs,
// web/screens/hidden.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judge, sameSong, songsToCheck, hiddenRows, hiddenProgress, findInLibrary, searchQuery, shapeHit, RECHECK_MS } from '../core/review/hidden.mjs';
import * as hidden from '../web/screens/hidden.mjs';

const tr = (id, name, artist, extra = {}) => ({ id, name, artists: [{ id: 'a-' + artist, name: artist }], duration_ms: 200000, album: 'Old EP', released: '2014-01-01', ...extra });
const OLD = tr('old1', 'Gold Dust', 'DJ Fresh', { isrc: 'GBAAA1400001', added_at: '2015-03-01T00:00:00Z' });
const NEW = { ...tr('new1', 'Gold Dust', 'DJ Fresh', { isrc: 'GBAAA1400001', album: 'Greatest Hits', released: '2020-05-05' }), playable: true };
const lib = () => ({
  playlists: [
    { id: 'p1', name: 'DnB', tracks: [OLD, tr('t2', 'Louder', 'DJ Fresh', { added_at: '2019-01-01T00:00:00Z' })] },
    { id: 'p2', name: 'Gym', tracks: [OLD] },
  ],
  liked: [{ ...OLD, added_at: '2016-01-01T00:00:00Z' }],
});

test('search showing the same song under another id is the missing tick', () => {
  assert.deepEqual(judge(OLD, [NEW]), { state: 'version', to: NEW });
  assert.equal(judge(OLD, [{ ...OLD, playable: true }, NEW]).state, 'ok', 'top answer is our copy');
  assert.equal(judge(OLD, []).state, 'missing');
  // a namesake on top and our copy further down is fine: nothing to fix
  const other = { ...tr('x', 'Gold Dust (Flux Pavilion Remix)', 'DJ Fresh', { isrc: 'ZZ' }), playable: true };
  assert.equal(judge(OLD, [other, { ...OLD, playable: true }]).state, 'ok');
  // a remix alone is not the same song
  assert.equal(judge(OLD, [other]).state, 'missing');
  // an unplayable twin is not offered
  assert.equal(judge(OLD, [{ ...NEW, playable: false }]).state, 'missing');
});

test('same song: ISRC, or title/artist/version at the same length', () => {
  assert.ok(sameSong(OLD, NEW));
  assert.ok(sameSong(tr('a', 'Song - 2011 Remaster', 'X'), tr('b', 'Song', 'X')));
  assert.ok(!sameSong(tr('a', 'Song', 'X'), tr('b', 'Song - Radio Edit', 'X')));
  assert.ok(!sameSong(tr('a', 'Song', 'X'), tr('b', 'Song', 'X', { duration_ms: 260000 })));
});

test('songs are checked oldest-added first, once each, and remembered for a month', () => {
  const s = songsToCheck(lib());
  assert.deepEqual(s.map(e => e.track.id), ['old1', 't2']);
  assert.deepEqual(s[0].places.map(p => p.id), ['p1', 'p2']);
  assert.equal(s[0].liked, true);
  const now = Date.now();
  assert.deepEqual(songsToCheck(lib(), { old1: { at: now } }, now).map(e => e.track.id), ['t2']);
  assert.equal(songsToCheck(lib(), { old1: { at: now - RECHECK_MS - 1 } }, now).length, 2);
  assert.deepEqual(hiddenProgress(lib(), { old1: { state: 'ok', at: now } }, now), { total: 2, checked: 1, left: 1 });
});

test('rows are the flagged songs still in the library; fixed ones go', () => {
  const checks = { old1: { state: 'version', to: NEW, at: 1 }, t2: { state: 'ok', at: 1 }, gone: { state: 'version', to: NEW, at: 1 } };
  const rows = hiddenRows(lib(), checks);
  assert.deepEqual(rows.map(r => [r.id, r.state, r.places.length]), [['old1', 'version', 2]]);
  assert.equal(hiddenRows(lib(), { old1: { ...checks.old1, fixed: true } }).length, 0);
});

test('find in library matches every word and says where it sits', () => {
  assert.deepEqual(findInLibrary(lib(), 'gold fresh').map(e => e.track.id), ['old1']);
  assert.deepEqual(findInLibrary(lib(), 'fresh').map(e => e.track.id), ['old1', 't2']);
  assert.equal(findInLibrary(lib(), '').length, 0);
  assert.equal(searchQuery(tr('a', 'Song (feat. Y)', 'X')), 'Song X');
  assert.equal(shapeHit({ id: 'z', name: 'n', is_playable: false, album: { name: 'A', images: [] }, artists: [], external_ids: { isrc: 'I' } }).playable, false);
});

function ctx(L, calls) {
  const log = [];
  return {
    LIB: L, esc: s => String(s ?? ''), thumbHTML: () => '', emptyState: (t) => `<i>${t}</i>`, moreButton: () => '', shownOf: () => 50,
    render() {}, toast() {}, store: { touch() {} },
    newGroup: () => 'g1',
    async playlistEntries(id) { return L.playlists.find(p => p.id === id).tracks.map((t, pos) => ({ id: t.id, pos })); },
    async plCall(...a) { calls.push(['post', ...a]); },
    async delTracks(...a) { calls.push(['del', ...a]); },
    async libraryCall(...a) { calls.push(['lib', ...a]); },
    async logAction(e) { log.push(e); },
    async getLog() { return [...log].reverse().map((x, i) => ({ at: String(i), ...x })); },
    log,
  };
}

test('swap puts the search version in each old slot, likes it where the old one was liked, and logs one group', async () => {
  const L = lib(), calls = [];
  const c = ctx(L, calls);
  hidden.H.checks = { old1: { state: 'version', to: NEW, at: 1 } };
  const r = await hidden.hiddenSwap(c, 'old1', NEW);
  assert.deepEqual(r, { group: 'g1', playlists: 2, liked: true });
  assert.deepEqual(calls.map(x => x[0] + ':' + x[1]), ['post:p1', 'del:p1', 'post:p2', 'del:p2', 'lib:PUT']);
  assert.deepEqual(calls[0][3], { uris: ['spotify:track:new1'], position: 0 });
  assert.deepEqual(c.log.map(e => e.op), ['add', 'remove', 'add', 'remove', 'like']);
  assert.ok(c.log.every(e => e.group === 'g1'));
  assert.deepEqual(c.log[1].positions, { old1: [0] }, 'undo puts the old copy back where it was');
  assert.equal(L.playlists[0].tracks[0].id, 'new1');
  assert.equal(L.playlists[0].tracks[0].added_at, OLD.added_at);
  assert.equal(L.playlists[0].snapshot_id, null, 'next sync reads it back');
  assert.equal(L.liked[0].id, 'new1');
  assert.equal(hiddenRows(L, hidden.H.checks).length, 0, 'the row leaves');
});

test('fix asks first: Use this version, then Swap or Cancel', async () => {
  const L = lib(), calls = [];
  const c = ctx(L, calls);
  hidden.H.checks = { old1: { state: 'version', to: NEW, at: Date.now() } };
  hidden.H.confirm = null;
  let html = hidden.hiddenView(c);
  assert.match(html, /Shown as another version/);
  assert.match(html, /data-act="hdFix" data-from="old1" data-to="new1"/);
  assert.doesNotMatch(html, /hdYes/);
  hidden.hiddenActions.hdFix(c, { dataset: { from: 'old1', to: 'new1' } });
  html = hidden.hiddenView(c);
  assert.match(html, /Swap in 2 playlists and Liked Songs\?/);
  assert.equal(calls.length, 0, 'nothing written before the confirm');
  await hidden.hiddenActions.hdYes(c, { dataset: { from: 'old1', to: 'new1' } });
  assert.equal(calls.length, 5);
  assert.doesNotMatch(hidden.hiddenView(c), /data-from="old1"/);
});

test('a check run asks search about each song and saves what it found', async () => {
  const L = lib(), calls = [];
  const c = ctx(L, calls);
  const saved = {};
  c.idb = { async get(k) { return saved[k]; }, async set(k, v) { saved[k] = v; } };
  c.sp = async path => {
    calls.push(path);
    const q = decodeURIComponent(path.match(/q=([^&]*)/)[1]);
    const item = q.startsWith('Gold') ? { id: 'new1', name: 'Gold Dust', artists: [{ name: 'DJ Fresh' }], duration_ms: 200000, external_ids: { isrc: 'GBAAA1400001' }, album: { name: 'Greatest Hits', images: [] } }
      : { id: 't2', name: 'Louder', artists: [{ name: 'DJ Fresh' }], duration_ms: 200000, album: { name: 'Old EP', images: [] } };
    return { tracks: { items: [item] } };
  };
  hidden.H.checks = {};
  await hidden.hiddenRun(c);
  assert.ok(calls.every(p => /market=from_token/.test(p)));
  assert.equal(saved.hidden_checks.old1.state, 'version');
  assert.equal(saved.hidden_checks.t2.state, 'ok');
  assert.equal(hidden.hiddenCount(c), 1);
});

// DESIGN-PLAN §7.7 A2 (provisional): a batch is checked by itself, once a day, after the
// radar's first read; the button is only a small "Check N more".
test('the background check runs once a day, only while songs are left, and the button is small', async () => {
  const L = lib(), calls = [], kept = new Map();
  const c = ctx(L, calls);
  const saved = {};
  c.idb = { async get(k) { return saved[k]; }, async set(k, v) { saved[k] = v; } };
  c.LS = { getItem: k => kept.get(k) ?? null, setItem: (k, v) => kept.set(k, v) };
  let asked = 0;
  c.sp = async () => { asked++; return { tracks: { items: [] } }; };
  hidden.H.checks = {};
  let html = hidden.hiddenView(c);
  assert.match(html, /None checked yet\. A batch of your oldest songs is checked by itself/);
  assert.match(html, /<button class="b sm" data-act="hdRun">Check 2 more<\/button>/);
  const now = Date.now();
  assert.equal(await hidden.hiddenAuto(c, now), true);
  assert.equal(asked, 2);
  assert.equal(await hidden.hiddenAuto(c, now + 3600_000), false, 'not again the same day');
  assert.equal(asked, 2);
  // A day later there is nothing left to ask, so it does not run either.
  assert.equal(await hidden.hiddenAuto(c, now + 25 * 3600_000), false);
  html = hidden.hiddenView(c);
  assert.match(html, /2 of 2 songs checked, all of them\./);
  assert.doesNotMatch(html, /data-act="hdRun"/);
  // Without Spotify (tests, a page without sp) it is idle.
  hidden.H.checks = {};
  assert.equal(await hidden.hiddenAuto({ ...c, sp: null }, now + 50 * 3600_000), false);
});
