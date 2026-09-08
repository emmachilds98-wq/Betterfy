import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Which axis a playlist is on decides everything downstream: only genre and
// mood playlists receive suggestions, and a track is only ever compared with
// playlists on its own axis. A name says it when it says "Drumsheds" or "90s".
// A night out named after who you were with says nothing — so the filed dates
// have to, and they must do it without dragging in a playlist somebody built
// last week by dropping fifty tracks in at once.

const BUNDLE = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
const NOW = Date.parse('2026-09-06T00:00:00Z');
const day = 86400000;

function load(saved = {}) {
  const i = BUNDLE.indexOf('/* ---------- axis classification');
  const j = BUNDLE.indexOf('/* ---------- reports (mirrors');
  assert.ok(i > 0 && j > i, 'classify block not found — rebuild with npm run build:web');
  // classify asks profile.mjs which kind of thing each tag is, so the scoring
  // core has to come with it.
  const p = BUNDLE.indexOf('/* ---- profile.mjs ---- */');
  const pEnd = BUNDLE.indexOf('/* ============', p);
  assert.ok(p > 0 && pEnd > p, 'profile.mjs block not found — rebuild with npm run build:web');
  const sandbox = { LS: { getItem: k => (k === 'bf_axes' ? JSON.stringify(saved) : null) }, console };
  vm.createContext(sandbox);
  vm.runInContext(BUNDLE.slice(p, pEnd), sandbox);
  // classify() skips the All Songs mirror when it works out the library's tag
  // baseline — it holds a copy of everything, so reading it in would count the
  // whole library twice.
  vm.runInContext(`const ALL_SONGS_NAME = 'All Songs — Betterfy';`, sandbox);
  const m = BUNDLE.indexOf("const ALL_SONGS_KEY = 'bf_allsongs';");
  const mEnd = BUNDLE.indexOf('/** A row of tag chips', m);
  assert.ok(m > 0 && mEnd > m, 'mirror predicate not found — rebuild with npm run build:web');
  vm.runInContext(BUNDLE.slice(m, mEnd), sandbox);
  vm.runInContext(BUNDLE.slice(i, j), sandbox);
  return sandbox;
}

/** A playlist of `n` tracks, added over `span` days, ending `since` days ago. */
const pl = (id, name, { n = 20, span = 900, since = 2 } = {}) => ({
  id, name,
  tracks: Array.from({ length: n }, (_, k) => ({
    id: id + '-' + k,
    added_at: new Date(NOW - since * day - (span * day * (n - 1 - k)) / Math.max(1, n - 1)).toISOString(),
  })),
});

const axisOf = (playlists, saved, tags = null) => {
  const app = load(saved);
  const cfg = vm.runInContext('classify', app)({ playlists }, tags, NOW);
  return id => ({ axis: cfg[id].axis, why: cfg[id].why, target: cfg[id].target });
};

test('a name that says what it is still decides', () => {
  const of = axisOf([
    pl('a', 'Drumsheds 12.04'), pl('b', 'mellow emma'), pl('c', '90s nostalgia'),
    pl('d', 'Mix 3'), pl('e', 'jungle emma'),
  ]);
  assert.equal(of('a').axis, 'event');
  assert.equal(of('b').axis, 'mood');
  assert.equal(of('c').axis, 'era');
  assert.equal(of('d').axis, 'djset');
  assert.equal(of('e').axis, 'genre');
  assert.equal(of('e').why, 'no signal in the name — treated as genre');
});

test('a genre name that contains a mood word as a substring is not mood', () => {
  // "Chillstep" and "Hyperpop" are genres, not moods — MOOD used to match them
  // on "chill" and "hype" with no word boundary, which is a name-matching bug
  // that misfires on anyone's library, not just one person's vocabulary.
  const of = axisOf([
    pl('a', 'Chillstep Bangers', { span: 900, since: 3 }),
    pl('b', 'Hyperpop Essentials', { span: 900, since: 3 }),
    pl('c', 'Nu-Groovebox', { span: 900, since: 3 }),
    pl('d', 'chill vibes'), pl('e', 'so hype rn'),
  ]);
  assert.equal(of('a').axis, 'genre');
  assert.equal(of('b').axis, 'genre');
  assert.equal(of('c').axis, 'genre');
  assert.equal(of('d').axis, 'mood', 'a real mood word on its own still matches');
  assert.equal(of('e').axis, 'mood');
});

test('the All Songs mirror is never treated as a filing target, however it would otherwise classify', () => {
  // It holds a copy of every track by construction, so left eligible it would
  // always "win" as a destination — a centroid of the whole library, and (once
  // artistHistory() existed) every artist's own placement trivially
  // "confirmed" by their own copy sitting inside it.
  const of = axisOf([pl('as1', 'All Songs — Betterfy')]);
  assert.equal(of('as1').axis, 'genre', 'falls through to genre exactly like any other unnamed playlist');
  assert.equal(of('as1').target, false, 'but is never offered as a destination');
});

test('a playlist built in one night and never touched since reads as an event', () => {
  // Named for who you were with, so the name gives nothing away.
  const of = axisOf([pl('x', 'me tash and liv', { span: 1, since: 200 })]);
  assert.equal(of('x').axis, 'event');
  assert.match(of('x').why, /built in a day, nothing added since/);
  assert.equal(of('x').target, false, 'and so it stops competing for suggestions');
});

test('a genre bucket that grew over years is left alone', () => {
  const of = axisOf([pl('x', 'jungle emma', { span: 900, since: 3 })]);
  assert.equal(of('x').axis, 'genre');
  assert.equal(of('x').target, true);
});

test('a playlist somebody built last week is not an event yet', () => {
  // The whole false-positive case: a new listener drops fifty tracks into a
  // brand-new genre playlist in one sitting. Same shape as a night out.
  const of = axisOf([pl('x', 'new bangers', { span: 1, since: 5 })]);
  assert.equal(of('x').axis, 'genre', 'still growing, so still a bucket');
  assert.equal(of('x').target, true);
});

test('a short playlist is never guessed from dates', () => {
  const of = axisOf([pl('x', 'three tunes', { n: 3, span: 0, since: 400 })]);
  assert.equal(of('x').axis, 'genre');
});

test('one track added late does not hide a night out', () => {
  const night = pl('x', 'brixton w liv', { n: 20, span: 1, since: 300 });
  night.tracks.push({ id: 'x-late', added_at: new Date(NOW - 60 * day).toISOString() });
  const of = axisOf([night]);
  assert.equal(of('x').axis, 'event', 'the middle 80% still spans a day');
});

test('tracks with no dates at all fall back to the name', () => {
  const of = axisOf([{ id: 'x', name: 'whatever', tracks: Array.from({ length: 30 }, (_, k) => ({ id: 'k' + k })) }]);
  assert.equal(of('x').axis, 'genre');
});

test('your own correction beats both, and says so', () => {
  const of = axisOf([pl('x', 'me tash and liv', { span: 1, since: 200 })], { x: { axis: 'genre', target: true } });
  assert.equal(of('x').axis, 'genre');
  assert.equal(of('x').why, 'set by you');
  assert.equal(of('x').target, true);
});

test('too few tracks to model never receives suggestions, whatever the axis', () => {
  const of = axisOf([pl('x', 'tiny genre thing', { n: 9, span: 900, since: 2 })]);
  assert.equal(of('x').axis, 'genre');
  assert.equal(of('x').target, false, 'nine tracks is not a centroid');
});

/* ---- signals that need no vocabulary at all ----
 * The name hints above only work in the author's own words: one person's club
 * nights are "Drumsheds", another's are "me tash and liv". These read the
 * tracks instead, so they work for a library nobody has tuned for.
 */

/** A playlist whose tracks carry release years and artist ids. */
const withTracks = (id, name, tracks) => ({ id, name, tracks });
// Added over a long span and still growing, so these fixtures test the era and
// coherence rules rather than tripping the "built in one sitting" event rule.
const trk = (id, year, artistId, k = 0) => ({
  id, released: `${year}-06-01`,
  added_at: new Date(NOW - 3 * day - k * 30 * day).toISOString(),
  artists: artistId ? [{ id: artistId, name: artistId }] : [],
});
/** tags[artistId] = { tags: [[tag, weight]] } */
const tagset = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { tags: v.map(t => [t, 100]) }]));

test('with no tags loaded at all, classification still works from name and dates', () => {
  const tracks = Array.from({ length: 12 }, (_, k) => trk('t' + k, 2015 + (k % 8), 'a' + k, k));
  const of = axisOf([withTracks('x', 'unlabelled', tracks)], {}, null);
  assert.equal(of('x').axis, 'genre', 'the old behaviour, unchanged');
});

/* ---- names that mean the same thing on every account ---- */

test('Spotify\'s own generated playlists are an inflow, not a filing destination', () => {
  // Everybody has these, under exactly these names. Left as genre they are
  // filing targets, so Tidy offers to move your music into a playlist Spotify
  // overwrites every Monday.
  const of = axisOf([
    pl('a', 'Discover Weekly'), pl('b', 'Release Radar'), pl('c', 'On Repeat'),
    pl('d', 'My Shazam Tracks'), pl('e', 'Your Top Songs 2025'), pl('f', 'Daily Mix 3'),
  ]);
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) assert.equal(of(id).axis, 'inbox', id);
  assert.equal(of('a').target, false, 'and nothing is ever suggested into one');
});

test('a playlist named for a situation is context, not a genre bucket', () => {
  const of = axisOf([
    pl('a', 'Gym'), pl('b', 'Sunday Roast Dinner'), pl('c', 'Road Trip 2024'),
    pl('d', 'Wedding Reception'), pl('e', 'Study Focus'),
  ]);
  for (const id of ['a', 'b', 'c', 'd', 'e']) assert.equal(of(id).axis, 'context', id);
  assert.equal(of('a').target, false, 'a workout playlist has no genre to compare anything against');
});

test('a genre that merely contains a mood word as a separate word is still a genre', () => {
  // The word-boundary rule cannot separate "Dark Techno" from "dark vibes",
  // so the words that commonly modify a genre are deliberately left out of the
  // mood list. Being wrong toward genre is the cheap direction.
  const of = axisOf([
    pl('a', 'Dark Techno'), pl('b', 'Deep House'), pl('c', 'Heavy Metal'),
    pl('d', 'Hard Trance'), pl('e', 'Smooth Jazz'),
  ]);
  for (const id of ['a', 'b', 'c', 'd', 'e']) assert.equal(of(id).axis, 'genre', id);
});

/* ---- and the last resort, when the name says nothing at all ----
 * A playlist with no clue in its name and no clue in its dates used to be
 * defaulted to genre without asking, which is exactly the silent guess that
 * later shows up as a wrong Tidy suggestion. The tags on its tracks are the
 * one thing left to ask, and they are read against this library's own
 * baseline rather than a fixed share — mood tags are a small slice of
 * anybody's cloud, and whatever number worked for one library would be wrong
 * for the next.
 */

/** A playlist of n tracks by n artists, each carrying `vocab`. */
const tagged = (id, name, n, vocab, tags) => {
  const tracks = [];
  for (let k = 0; k < n; k++) {
    const a = `${id}-a${k}`;
    tags[a] = { tags: vocab.map(t => [t, 100]) };
    tracks.push({ id: `${id}-t${k}`, artists: [{ id: a, name: a }],
                  added_at: new Date(NOW - 3 * day - k * 30 * day).toISOString() });
  }
  return { id, name, tracks };
};

test('with nothing in the name, a playlist held together by mood tags is read as mood', () => {
  const tags = {};
  const lists = [
    tagged('m', 'saudade', 12, ['chill', 'mellow', 'dreamy', 'downtempo'], tags),
    tagged('g1', 'first thing', 14, ['techno', 'industrial techno', 'hard techno'], tags),
    tagged('g2', 'second thing', 14, ['jungle', 'breakbeat', 'hardcore'], tags),
  ];
  const of = axisOf(lists, {}, tags);
  assert.equal(of('m').axis, 'mood');
  assert.match(of('m').why, /mood tags, against .* across your library/);
  assert.equal(of('g1').axis, 'genre', 'the genre buckets it is measured against are left alone');
  assert.equal(of('g2').axis, 'genre');
});

test('a playlist held together by decades is read as an era', () => {
  const tags = {};
  const lists = [
    tagged('e', 'the good ones', 12, ['90s', '80s', 'oldies', 'pop'], tags),
    tagged('g1', 'first thing', 14, ['techno', 'industrial techno', 'hard techno'], tags),
    tagged('g2', 'second thing', 14, ['jungle', 'breakbeat', 'hardcore'], tags),
  ];
  const of = axisOf(lists, {}, tags);
  assert.equal(of('e').axis, 'era');
  assert.equal(of('e').target, false, 'and so it stops competing for filing suggestions');
});

test('the mood lean has to be a lean, not the whole library being tagged that way', () => {
  // Every playlist equally moody: nothing stands out, so nothing is promoted
  // and they all stay the honest "no signal" default.
  const tags = {};
  const lists = ['a', 'b', 'c'].map((id, i) =>
    tagged(id, 'untitled ' + i, 14, ['chill', 'house', 'techno', 'garage'], tags));
  const of = axisOf(lists, {}, tags);
  for (const id of ['a', 'b', 'c']) {
    assert.equal(of(id).axis, 'genre', id);
    assert.equal(of(id).why, 'no signal in the name — treated as genre', id);
  }
});

test('a handful of tracks is never enough to be read from tags', () => {
  const tags = {};
  const lists = [
    tagged('m', 'tiny', 6, ['chill', 'mellow', 'dreamy'], tags),
    tagged('g1', 'first thing', 14, ['techno', 'industrial techno'], tags),
    tagged('g2', 'second thing', 14, ['jungle', 'breakbeat'], tags),
  ];
  const of = axisOf(lists, {}, tags);
  assert.equal(of('m').axis, 'genre', 'below the floor the mix is noise');
});

test('the name and the dates both still beat the tags', () => {
  const tags = {};
  const named = tagged('n', 'jungle emma', 14, ['chill', 'mellow', 'dreamy'], tags);
  const night = tagged('x', 'me tash and liv', 14, ['chill', 'mellow', 'dreamy'], tags);
  night.tracks.forEach((t, k) => { t.added_at = new Date(NOW - 200 * day - k * 3600e3).toISOString(); });
  const filler = tagged('g', 'first thing', 14, ['techno', 'jungle'], tags);
  const of = axisOf([named, night, filler], {}, tags);
  assert.equal(of('n').axis, 'genre', 'a name that says genre is not overruled by the tags');
  assert.equal(of('x').axis, 'event', 'nor is a night out that the dates already caught');
});

test('your own correction still beats every one of them', () => {
  const tags = {};
  const lists = [
    tagged('m', 'saudade', 14, ['chill', 'mellow', 'dreamy'], tags),
    tagged('g', 'first thing', 14, ['techno', 'jungle'], tags),
  ];
  const of = axisOf(lists, { m: { axis: 'genre', target: true } }, tags);
  assert.equal(of('m').axis, 'genre');
  assert.equal(of('m').why, 'set by you');
});
