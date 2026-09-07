import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/*
 * "All Songs — Betterfy" is a playlist Betterfy builds and tops up itself: one
 * copy of every track in the library, so Shuffle has something better to
 * default to than whichever bucket happens to be biggest.
 *
 * It is a view of the library, not a place anything was filed — and reading it
 * as an ordinary playlist broke three screens at once the moment it existed.
 * Every liked song was suddenly "filed" (it is in the mirror), so the File
 * queue emptied. Every track was suddenly in more than one playlist, so
 * Cross-filed swelled to the whole library. And two pressings of one record,
 * which live happily in separate playlists, met inside the mirror and were
 * reported as a repeat.
 */

const BUNDLE = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
const MIRROR = 'All Songs — Betterfy';
// Arrays built inside the vm carry that realm's prototype; bring them home
// before comparing.
const own = x => JSON.parse(JSON.stringify(x));

function slice(from, to, what) {
  const i = BUNDLE.indexOf(from), j = BUNDLE.indexOf(to);
  assert.ok(i > 0 && j > i, `${what} not found — rebuild with npm run build:web`);
  return BUNDLE.slice(i, j);
}

/** buildReports with the scoring core it is bundled alongside. */
function reports(lib, cfg, tags, feedback = {}, pinned = null) {
  const sandbox = { console, FB: feedback,
    LS: { getItem: k => (k === 'bf_allsongs' ? pinned : null), setItem: () => {} } };
  vm.createContext(sandbox);
  vm.runInContext(slice('/* ---- norm.mjs ---- */', '/* ---------- storage ----------', 'scoring core'), sandbox);
  vm.runInContext('const mmss = ms => ms == null ? "—" : Math.floor(ms/60000) + ":" + String(Math.round(ms%60000/1000)).padStart(2,"0");', sandbox);
  vm.runInContext(slice('/* ---------- reports (mirrors', '/* ===================== UI', 'reports'), sandbox);
  vm.runInContext(`const ALL_SONGS_NAME = ${JSON.stringify(MIRROR)};`, sandbox);
  return sandbox.buildReports(lib, cfg, tags);
}

const track = (id, artist, title, over = {}) => ({
  id, name: title, artists: [{ id: 'a-' + artist, name: artist }],
  album: 'Album ' + id, duration_ms: 200000, isrc: 'ISRC' + id, popularity: 50,
  added_at: '2024-01-01T00:00:00Z', ...over });

const TAGS = {
  'a-Tim Reaper':  { tags: [['jungle', 100], ['breakbeat', 80]] },
  'a-Dwarde':      { tags: [['jungle', 100], ['hardcore', 60]] },
  'a-Blawan':      { tags: [['techno', 100]] },
  'a-Surgeon':     { tags: [['techno', 100], ['industrial techno', 70]] },
};

/** A small library plus, optionally, the mirror playlist over the top of it. */
function library({ mirrored }) {
  const jungle = [track('t1', 'Tim Reaper', 'Rinse It'), track('t2', 'Dwarde', 'Dread')];
  const techno = [track('t3', 'Blawan', 'Why They Hide'), track('t4', 'Surgeon', 'Badger Bite')];
  const liked = [track('t1', 'Tim Reaper', 'Rinse It'), track('t5', 'Blawan', 'Getting Me Down')];
  const playlists = [
    { id: 'p1', name: 'Jungle', tracks: jungle },
    { id: 'p2', name: 'Techno', tracks: techno },
  ];
  const cfg = {
    p1: { name: 'Jungle', axis: 'genre', target: true },
    p2: { name: 'Techno', axis: 'genre', target: true },
  };
  if (mirrored) {
    const seen = new Map();
    for (const p of playlists) for (const t of p.tracks) seen.set(t.id, t);
    for (const t of liked) if (!seen.has(t.id)) seen.set(t.id, t);
    playlists.push({ id: 'as1', name: MIRROR, tracks: [...seen.values()] });
    cfg.as1 = { name: MIRROR, axis: 'context', target: false };
  }
  return { lib: { user: { id: 'emma' }, playlists, liked }, cfg };
}

const build = mirrored => { const { lib, cfg } = library({ mirrored }); return reports(lib, cfg, TAGS); };

test('a liked song that is only in the mirror is still unfiled', () => {
  assert.equal(build(false).backlog.length, 1, 'the fixture has exactly one liked song with no playlist');
  assert.equal(build(true).backlog.length, 1,
    'building All Songs must not empty the File queue by filing everything into itself');
});

test('the mirror does not make every track cross-filed', () => {
  assert.equal(build(false).across.length, 0);
  assert.equal(build(true).across.length, 0,
    'a track in one playlist and the mirror is in one playlist');
});

test('two pressings of the same record are not a repeat just because they meet in the mirror', () => {
  const { lib, cfg } = library({ mirrored: true });
  // Same recording, two Spotify ids — one filed in Jungle, one only liked.
  const reissue = track('t6', 'Tim Reaper', 'Rinse It', { isrc: 'ISRCt1' });
  lib.playlists[0].tracks.push(reissue);
  lib.liked.push(reissue);
  lib.playlists[2].tracks.push(reissue);
  const r = reports(lib, cfg, TAGS);
  assert.deepEqual(own(r.within.map(w => w.playlist)), ['Jungle'],
    'the repeat inside a real playlist is reported, and only that one');
});

test('a stray id left in the mirror is dropped rather than reported as a nameless duplicate', () => {
  const { lib, cfg } = library({ mirrored: true });
  // Ids Spotify still has in the playlist but the library no longer knows
  // about — a track unliked or removed since the last refresh.
  lib.playlists[2].tracks.push({ id: 'gone1' }, { id: 'gone2' });
  const r = reports(lib, cfg, TAGS);
  assert.deepEqual(own(r.within), [], 'two unknown ids are not two copies of the same untitled track');
});

test('syncAllSongsPlaylist keeps no bare id stubs in the library copy it writes back', () => {
  const body = slice('async function syncAllSongsPlaylist()', 'function vShuffle()', 'All Songs block');
  assert.match(body, /const byId = new Map\(all\.map\(t => \[t\.id, t\]\)\)/,
    'the merge must index the library rather than scanning it once per track');
  assert.doesNotMatch(body, /\?\?\s*\{ id \}/,
    'an id with no track behind it carries no artist and no title — it is dropped, not kept');
});

test('the mirror is recognised wherever the reports ask, by id as well as by name', () => {
  // By name alone, renaming the mirror turned it back into an ordinary
  // playlist as far as every report was concerned — and re-broke all three
  // screens above. syncAllSongsPlaylist() pins its id; this reads it back.
  const body = slice('/* ---------- reports (mirrors', 'function buildReports', 'mirror predicate');
  assert.match(body, /const isMirrorPlaylist = p => !!p && \(p\.name === ALL_SONGS_NAME \|\| p\.id === pinnedAllSongs\(\)\);/);
  assert.match(body, /const pinnedAllSongs = \(\) => LS\.getItem\(ALL_SONGS_KEY\)/);
});

test('a renamed mirror is still treated as a view of the library, not a playlist', () => {
  const { lib, cfg } = library({ mirrored: true });
  const mirror = lib.playlists.find(p => p.name === MIRROR);
  mirror.name = 'Everything';                      // renamed in Spotify
  const r = reports(lib, cfg, TAGS, {}, mirror.id); // …but still the pinned one
  assert.deepEqual(own(r.backlog.map(b => b.id)), ['t5'],
    'the File queue does not empty just because the mirror got a new name');
  assert.equal(r.across.length, 0, 'and nothing is suddenly cross-filed into it');
});
