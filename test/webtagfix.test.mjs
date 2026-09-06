import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Last.fm tags are per artist, not per track, and are crowd-submitted — an
// artist Last.fm has simply got wrong (a same-named act, a stray scrobble, a
// niche act with three taggers) keeps its wrong tags forever, because
// enrichMissing() only ever fills a *gap*, never corrects an artist that
// already has (wrong) tags. Every track of that artist inherits the mistake,
// and it shows up as a bad Tidy suggestion that no amount of re-syncing fixes.
// These tests cover the fix: editing, in place, an artist's tags — and having
// that correction actually stick and actually override the shipped set.

const BUNDLE = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');

function slice(from, to, what) {
  const i = BUNDLE.indexOf(from), j = BUNDLE.indexOf(to);
  assert.ok(i > 0 && j > i, `${what} not found — rebuild with npm run build:web`);
  return BUNDLE.slice(i, j);
}

// Values built inside the vm belong to that context's own realm — deepEqual in
// strict mode treats a same-shaped array from another realm as unequal, so
// bring anything compared structurally back to this realm first.
const own = x => JSON.parse(JSON.stringify(x));

/** In-memory idb.tags_extra, just enough for the functions under test. */
function load({ tags = {}, rawTags = {}, key = 'lfm-key', fetchTags = null } = {}) {
  let store = {};
  const sandbox = {
    TAGS: JSON.parse(JSON.stringify(tags)),
    RAW_TAGS: JSON.parse(JSON.stringify(rawTags)),
    LIB: {}, CFG: {},
    buildReports: (...args) => ({ builtWith: args[2] }), // records the TAGS it was called with
    idb: {
      get: async k => (k === 'tags_extra' ? JSON.parse(JSON.stringify(store)) : undefined),
      set: async (k, v) => { if (k === 'tags_extra') store = JSON.parse(JSON.stringify(v)); },
    },
    LS: { getItem: k => (k === 'bf_lfm' ? key : null) },
    fetch: async () => ({ json: async () => fetchTags ?? { toptags: { tag: [] } } }),
    toast: () => {},
    esc: s => String(s ?? ''),
    URLSearchParams,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(slice("/* ---------- correcting one artist's tags", 'const VIEWS = ', 'tag-correction block'), sandbox);
  return Object.assign(sandbox, { store: () => store });
}

test('saveArtistTags overrides the shipped tags and rebuilds reports', async () => {
  const app = load({ tags: { a1: { tags: [['garage', 90], ['edm', 80]] } } });
  await app.saveArtistTags('a1', [['ambient', 70]]);
  assert.deepEqual(own(app.TAGS.a1.tags), [['ambient', 70]], 'the in-memory tag set is replaced');
  assert.deepEqual(own(app.store().a1.tags), [['ambient', 70]], 'and persisted so it survives a reload');
  assert.equal(app.R.builtWith, app.TAGS, 'reports are rebuilt against the corrected tags');
});

test('a correction for one artist does not disturb another', async () => {
  const app = load({ tags: { a1: { tags: [['garage', 90]] }, a2: { tags: [['soul', 60]] } } });
  await app.saveArtistTags('a1', [['ambient', 70]]);
  assert.deepEqual(own(app.TAGS.a2.tags), [['soul', 60]]);
  assert.deepEqual(app.store().a2, undefined, 'only the corrected artist is written to the override store');
});

test('resetArtistTags puts the shipped tags back and drops the override', async () => {
  const app = load({
    tags: { a1: { tags: [['garage', 90]] } },       // already "corrected" once
    rawTags: { a1: { tags: [['downtempo', 55]] } }, // what Last.fm actually shipped
  });
  await app.saveArtistTags('a1', [['garage', 90]]); // simulate the override having been saved previously
  await app.resetArtistTags('a1');
  assert.deepEqual(own(app.TAGS.a1.tags), [['downtempo', 55]], 'back to the shipped value');
  assert.equal(app.store().a1, undefined, 'the override itself is removed, not just overwritten');
});

test('resetting an artist that was never shipped at all clears it to nothing', async () => {
  const app = load({ tags: { a1: { tags: [['made-up', 50]] } }, rawTags: {} });
  await app.resetArtistTags('a1');
  assert.deepEqual(own(app.TAGS.a1.tags), [], 'nothing to fall back to, so it goes empty rather than throwing');
});

test('refetchArtist asks Last.fm again and saves whatever comes back, even fewer tags than before', async () => {
  const app = load({
    tags: { a1: { tags: [['garage', 90], ['edm', 80]] } },
    fetchTags: { toptags: { tag: [{ name: 'Downtempo', count: '42' }, { name: 'noise', count: '3' }] } },
  });
  await app.refetchArtist('a1', 'Old Sport');
  // count >= 10 only — the noise tag is filtered the same way enrichMissing() does.
  assert.deepEqual(own(app.TAGS.a1.tags), [['downtempo', 42]]);
  assert.deepEqual(own(app.store().a1.tags), [['downtempo', 42]]);
});

test('refetchArtist refuses without a Last.fm key rather than failing silently', async () => {
  const app = load({ tags: { a1: { tags: [['garage', 90]] } }, key: null });
  let told = null;
  app.toast = m => { told = m; };
  await app.refetchArtist('a1', 'Old Sport');
  assert.match(told, /Last\.fm key/);
  assert.deepEqual(own(app.TAGS.a1.tags), [['garage', 90]], 'nothing touched');
});

/* ---------- the editor and its wiring ---------- */

test('tagEditorHTML lists every current tag as a removable chip and offers all four actions', () => {
  const app = load({ tags: { a1: { tags: [['garage', 90], ['edm', 80]] } } });
  const html = app.tagEditorHTML('a1', 'Old Sport');
  assert.match(html, /Old Sport/);
  assert.match(html, /data-rmtag="a1\|0"/);
  assert.match(html, /data-rmtag="a1\|1"/);
  assert.match(html, /data-addtag="a1"/);
  assert.match(html, /data-refetchtags="a1"/);
  assert.match(html, /data-resettags="a1"/);
  assert.match(html, /data-closetagedit="1"/);
});

test('an artist with no tags at all still renders an editor, not a blank', () => {
  const app = load({ tags: { a1: { tags: [] } } });
  const html = app.tagEditorHTML('a1', 'Nobody');
  assert.match(html, /No tags/);
  assert.match(html, /data-addtag="a1"/, 'still possible to add one from scratch');
});

test('secMisfile offers "Wrong tags?" per artist on a track, and shows the editor inline', () => {
  const from = BUNDLE.indexOf('function secMisfile()');
  const to = BUNDLE.indexOf('function vTidy()');
  assert.ok(from > 0 && to > from, 'secMisfile not found — rebuild with npm run build:web');
  const body = BUNDLE.slice(from, to);
  assert.match(body, /data-editartist="\$\{esc\(a\.id\)\}"/);
  assert.match(body, /tagEditorHTML\(S\.editingArtist/);
  // Only ever one editor drawn per render, even if the same artist has several
  // misfiled tracks in the list — otherwise duplicate #newTagVal inputs.
  assert.match(body, /editorDrawn/);
});

test('buildReports carries artist ids through to misfiled and backlog rows, not just a display name', () => {
  const from = BUNDLE.indexOf('function buildReports(lib, cfg, tags)');
  const to = BUNDLE.indexOf('function secDupes');
  const body = from > 0 ? BUNDLE.slice(from, to > from ? to : undefined) : '';
  assert.ok(from > 0, 'buildReports not found — rebuild with npm run build:web');
  assert.match(body, /findMisfiled\(lib, tags, targets, profiles, idf, axisOf\)\.map\(m => \(\{[\s\S]*?artists: \(m\.track\.artists \?\? \[\]\)\.filter\(a => a\.id\)/,
    'a misfiled row must carry artist ids, or there is nothing for "Wrong tags?" to point at');
  // Either arrow-body form is fine — what matters is that the row carries ids.
  assert.match(body, /const backlog = unfiled\.map\(t => [({][\s\S]*?artists: \(t\.artists \?\? \[\]\)\.filter\(a => a\.id\)/,
    'a backlog row must carry artist ids, or there is nothing for "Wrong tags?" to point at');
});

test('choosing an axis by hand marks it "set by you" immediately, not just after the next sync', () => {
  const from = BUNDLE.indexOf("const ax = e.target.closest('[data-ax]')");
  const to = BUNDLE.indexOf('async function fileCurrent');
  const body = BUNDLE.slice(from, to);
  assert.match(body, /CFG\[id\]\.axis = ax\.value;\s*\n\s*\/\/[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*CFG\[id\]\.why = 'set by you';/,
    'so a playlist just fixed drops out of "Needs your input" without a reload');
});

test('vLists surfaces playlists classify() defaulted with no real signal, and only those', () => {
  const from = BUNDLE.indexOf('function vLists()');
  const to = BUNDLE.indexOf('function tagCoverage()');
  const body = BUNDLE.slice(from, to);
  assert.match(body, /Needs your input/);
  assert.match(body, /undecided = rows\.filter\(p => p\.why === NO_SIGNAL\)/);
});

test('vLists shows drifting playlists only when findDrift actually found some', () => {
  const from = BUNDLE.indexOf('function vLists()');
  const to = BUNDLE.indexOf('function tagCoverage()');
  const body = BUNDLE.slice(from, to);
  assert.match(body, /\(R\.drift \?\? \[\]\)\.length \?/, 'gated on there being anything to show');
  assert.match(body, /Recently drifting/);
  assert.match(body, /d\.recentTags\.map\(esc\)\.join/, 'shows what the newest additions actually look like');
});

test('buildReports computes drift alongside misfiled, from the same idf table', () => {
  const from = BUNDLE.indexOf('function buildReports(lib, cfg, tags)');
  const to = BUNDLE.indexOf('function secDupes');
  const body = BUNDLE.slice(from, to);
  assert.match(body, /const drift = findDrift\(lib, tags, targets, idf\);/);
  assert.match(body, /return \{ within, across, misfiled, backlog, clusters, drift, profiles, idf \};/);
});

test('enrichMissing covers what you actually listen to first', () => {
  const from = BUNDLE.indexOf('async function enrichMissing()');
  const to = BUNDLE.indexOf("/* ---------- correcting one artist's tags", from);
  const body = BUNDLE.slice(from, to);
  assert.ok(from > 0 && to > from, 'enrichMissing not found — rebuild with npm run build:web');
  assert.match(body, /todo = byListening\(todo, \(await getListening\(\)\)\.weights\)/);
});

test('secMisfile notes when a "misfiled" track is one you actually play a lot, without touching its confidence', () => {
  const from = BUNDLE.indexOf('function secMisfile()');
  const to = BUNDLE.indexOf('function vTidy()');
  const body = BUNDLE.slice(from, to);
  assert.match(body, /recentlyActive\?\.has\(x\.artist\)/);
  assert.match(body, /You play this a lot right now/);
  // The fetch is lazy and must not block the row rendering that's already there.
  assert.match(body, /getListening\(\)\.then\(\(\) => render\(\)\)/);
});
