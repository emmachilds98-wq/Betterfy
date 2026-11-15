import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// UI-3 (docs/UI-BUILD-PLAN.md §6): Playlists is the axes table, the data
// sources live on their own Sources screen, and the sound layer shows up on
// Playlists only when listening has produced something (§3 rule 3).

const BUNDLE = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
function slice(from, to, what) {
  const i = BUNDLE.indexOf(from), j = BUNDLE.indexOf(to, i);
  assert.ok(i > 0 && j > i, `${what} not found — rebuild with node build-web.mjs`);
  return BUNDLE.slice(i, j);
}
const CODE = slice('const AXES = ', 'function tagCoverage()', 'Playlists/Sources block');

const tr = (id, n) => Array.from({ length: n }, (_, i) => ({ id: id + i, artists: [{ id: 'a' + i }] }));
const LIB = { captured_at: 't0', liked: [], playlists: [
  { id: 'P1', name: 'Rollers', tracks: tr('r', 20) },
  { id: 'P2', name: 'Sunday', tracks: tr('s', 4) },
] };
const CFG = {
  P1: { axis: 'genre', target: true, tracks: 20, why: '“rollers” in the name' },
  P2: { axis: 'genre', target: false, tracks: 4, why: 'no genre in the name — not filed into until you say so' },
};

function load({ records = null, profileRow = () => '', panel = '<div id="audioPanel">panel</div>' } = {}) {
  const sb = {
    LIB, CFG, TAGS: {}, R: { drift: [] },
    NO_SIGNAL: 'no genre in the name — not filed into until you say so', MIN_FOR_TARGET: 12,
    facetMix: () => ({ tracks: 1, genre: 0.9, mood: 0.1 }),
    isMirrorPlaylist: () => false,
    tagCoverage: () => ({ total: 10, have: 9, missing: 1, pct: 90 }),
    esc: s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]),
    LS: { getItem: () => '' }, lfmKey: () => null,
    AUDIO: { records, labels: null },
    BetterfyAudio: records ? { profileVM: p => ({ heard: 3, members: p.tracks.length }) } : undefined,
    profileRow, audioPanelHTML: () => panel, labelCheckHTML: () => '',
  };
  vm.createContext(sb);
  vm.runInContext(CODE + ';globalThis.vLists = vLists; globalThis.vSources = vSources;', sb);
  return sb;
}

test('Playlists without audio: no expander, no profile row, and the renderer is never fed a profile', () => {
  const seen = [];
  const html = load({ profileRow: vm => { seen.push(vm); return vm ? '<div class="prof">x</div>' : ''; } }).vLists();
  assert.deepEqual(seen.filter(Boolean), []);
  assert.ok(!html.includes('axexp') && !html.includes('axprof'));
  // Byte-identical whether the sound renderer is the UI-0 stub or a real one.
  assert.equal(html, load().vLists());
});

test('Playlists with audio: a profile row and its expander under each playlist', () => {
  const html = load({ records: new Map([['x', {}]]), profileRow: vm => vm ? `<div class="prof">${vm.heard}/${vm.members}</div>` : '' }).vLists();
  assert.match(html, /data-axexp="P1"[^>]*aria-controls="axprof-P1"/);
  assert.match(html, /<tr class="axprof" id="axprof-P1" hidden><td colspan="5"><div class="prof">3\/20<\/div><\/td><\/tr>/);
});

test('Playlists keeps every control id and handler hook it had, and leaves the sources and listening to Sources', () => {
  const html = load().vLists();
  assert.match(html, /<select data-ax="P1"/);
  assert.match(html, /data-tg="P1" checked/);
  assert.match(html, /data-tg="P2"[^>]*disabled/);
  assert.match(html, /<h2>Needs your input<\/h2>/);
  assert.ok(html.includes('data-go="sources"'));
  for (const id of ['lfmKey', 'enrich', 'fillWikidata', 'discogsKey', 'audioPanel']) assert.ok(!html.includes(`id="${id}"`), id);
});

test('Sources holds the three genre sources and the Listening card', () => {
  const html = load().vSources();
  for (const id of ['lfmKey', 'saveLfm', 'enrich', 'fillWikidata', 'discogsKey', 'saveDiscogs']) assert.ok(html.includes(`id="${id}"`), id);
  assert.match(html, /<button class="b p" id="enrich" disabled>/); // no key yet
  assert.match(html, /<section class="srccard srclisten" id="src-listening" aria-labelledby="src-listening-h"><div id="audioPanel">panel<\/div><\/section>/);
});
