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
  const i = BUNDLE.indexOf('const EVENT = ');
  const j = BUNDLE.indexOf('/* ---------- reports (mirrors');
  assert.ok(i > 0 && j > i, 'classify block not found — rebuild with npm run build:web');
  // classify reads tag coherence, so the scoring helpers have to come too.
  const p = BUNDLE.indexOf('/* ---- profile.mjs ---- */');
  const pEnd = BUNDLE.indexOf('/* ============', p);
  assert.ok(p > 0 && pEnd > p, 'profile.mjs block not found — rebuild with npm run build:web');
  const sandbox = { localStorage: { getItem: () => JSON.stringify(saved) }, console };
  vm.createContext(sandbox);
  vm.runInContext(BUNDLE.slice(p, pEnd), sandbox);
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

const axisOf = (playlists, saved) => {
  const app = load(saved);
  const cfg = vm.runInContext('classify', app)({ playlists }, NOW);
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
