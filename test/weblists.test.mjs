import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as SOURCES from '../web/screens/sources.mjs';
import * as LISTS from '../web/screens/lists.mjs';

// UI-3 (docs/UI-BUILD-PLAN.md §6): Playlists is the axes table, the data
// sources live on their own Sources screen, and the sound layer shows up on
// Playlists only when listening has produced something (§3 rule 3).

const BUNDLE = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
function slice(from, to, what) {
  const i = BUNDLE.indexOf(from), j = BUNDLE.indexOf(to, i);
  assert.ok(i > 0 && j > i, `${what} not found — rebuild with node build-web.mjs`);
  return BUNDLE.slice(i, j);
}
const CODE = slice('/* ---------- Playlists: mixes, sound profiles, splits', 'function tagCoverage()', 'Playlists/Sources block');

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
    LIB, CFG, TAGS: {}, R: { drift: [], misfiled: [], clusters: [] }, GAPS: { status: 'idle' },
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
  const jobs = vm.runInContext(CODE + ';({ playlistMixes, listsSplits, LPROF, LISTS_SOUND })', sb);
  Object.assign(sb, jobs, { vLists: () => LISTS.view({ ...sb, store: { touch() {} }, fire() {} }) });
  return sb;
}

const R0 = { drift: [], misfiled: [], clusters: [] };
test('Library without audio: compact rows, no sound strip, and the renderer is never fed a profile', () => {
  const seen = [];
  const html = load({ profileRow: vm => { seen.push(vm); return vm ? '<div class="prof">x</div>' : ''; } }).vLists();
  assert.deepEqual(seen.filter(Boolean), []);
  assert.ok(!html.includes('plspark') && !html.includes('plsugg'), 'nothing without data');
  assert.match(html, /<h1>Library<\/h1>/);
  assert.match(html, /data-act="plopen" data-pl="P1"/);
  assert.ok(!/<table|libnav|data-act="axis"/.test(html), 'the axes table and the Library switch are gone');
  assert.equal(html, load().vLists());
});

test('Library rows say what needs a decision, and Shuffle stays reachable', () => {
  const html = load().vLists();
  assert.match(html, /data-pl="P1"[^]*?<span class="tag ok">files here<\/span>/);
  assert.match(html, /data-pl="P2"[^]*?<span class="tag warn">pick an axis<\/span>/);
  assert.ok(html.includes('data-go="shuffle"') && html.includes('data-go="sources"'));
});

test('the detail sheet keeps the axis and receives-suggestions controls and offers Shuffle', () => {
  const sb = load();
  const sheet = LISTS.sheetHTML({ ...sb, store: { touch() {} }, fire() {}, mixHeardIn: () => 0 }, 'P1');
  assert.match(sheet, /<select data-act="axis" data-ax="P1"/);
  assert.match(sheet, /data-tg="P1" checked/);
  assert.match(sheet, /data-act="plshuffle" data-pl="P1"/);
  assert.ok(!sheet.includes('data-act="pldj"'), 'DJ order only once enough has been heard');
  assert.match(LISTS.sheetHTML({ ...sb, mixHeardIn: () => 9 }, 'P1'), /data-act="pldj"/);
  assert.equal(LISTS.sheetHTML(sb, 'nope'), '');
});

test('Suggested playlists appear only when there are any, from the gaps', () => {
  assert.deepEqual(LISTS.suggestionsOf({ status: 'working' }, R0), []);
  assert.deepEqual(LISTS.suggestionsOf({ status: 'ready', gaps: [], made: new Set() }, R0), []);
  const GAPS = { status: 'ready', made: new Set(['dub']), filed: new Set(['o1']),
    gaps: [{ label: 'Donk', size: 30 }, { label: 'Dub', size: 12 }],
    sound: { orphans: [{ size: 9, suggest: { name: 'Garage' } }, { size: 7 }], hybrids: [{ name: 'Mix', size: 5 }] } };
  const s = LISTS.suggestionsOf(GAPS, { clusters: [{ tags: ['jungle'], size: 4 }] });
  assert.deepEqual(s.map(x => x.title), ['Donk', 'Garage', 'Mix', 'jungle']);
  const sb = load();
  const html = LISTS.view({ ...sb, R: { ...R0, clusters: [{ tags: ['jungle'], size: 4 }] },
    GAPS: { status: 'ready', made: new Set(), gaps: [{ label: 'Donk', size: 30 }] }, store: { touch() {} }, fire() {} });
  assert.match(html, /<h2 id="plsugg-h">Suggested playlists<\/h2>/);
  assert.match(html, /See all 2/);
});

test('playlist health: from misfiles, drift, a second genre and an undecided axis; nothing for tiny lists', () => {
  assert.equal(LISTS.playlistHealth({ tracks: 5 }), null);
  const clean = LISTS.playlistHealth({ tracks: 40 });
  assert.deepEqual([clean.score, clean.word, clean.notes], [100, 'Healthy', []]);
  const bad = LISTS.playlistHealth({ tracks: 20, misfiled: 4, drifting: true, split: true, undecided: true });
  assert.ok(bad.score < 40 && bad.word === 'Needs a look' && bad.notes.length === 4);
  assert.ok(LISTS.playlistHealth({ tracks: 10, misfiled: 10 }).score >= 55, 'misfiles alone are capped');
});

test('the sound strip: styles first, else the energy range, else nothing', () => {
  assert.equal(LISTS.sparkHTML(null), '');
  assert.equal(LISTS.sparkHTML({ heard: 3 }), '');
  assert.match(LISTS.sparkHTML({ styles: [['House', 0.6], ['Techno', 0.3]] }), /class="sp0" style="flex:0.6"[^]*class="sp1"/);
  assert.match(LISTS.sparkHTML({ energy: [0.5, 0.9] }), /plspark-e/);
});

test('the sheet Shuffle and DJ order point the Shuffle screen at the playlist, close the sheet and go', () => {
  const seen = [], kept = new Map();
  const c = { S: {}, LS: { setItem: (k, v) => kept.set(k, v) }, MIX_MODES: { flat: 'DJ order', build: 'x' },
    closePlSheet: () => seen.push('close'), go: v => seen.push(v), openPlSheet: id => seen.push('open ' + id) };
  LISTS.actions.plopen(c, { dataset: { pl: 'P1' } });
  LISTS.actions.pldj(c, { dataset: { pl: 'P1' } });
  assert.deepEqual([c.S.shufPl, c.S.shufMode, kept.get('bf_shuf_mode')], ['P1', 'flat', 'flat']);
  LISTS.actions.plshuffle(c, { dataset: { pl: 'P2' } });
  assert.deepEqual([c.S.shufPl, c.S.shufMode], ['P2', '']);
  assert.deepEqual(seen, ['open P1', 'close', 'shuffle', 'close', 'shuffle']);
});

test('Sources holds the three genre sources and the Listening card', () => {
  const sb = load();
  const html = SOURCES.view({ lfmKey: () => '', ...sb, playlistMixes: vm.runInContext('playlistMixes', sb) });
  for (const id of ['lfmKey', 'saveLfm', 'enrich', 'fillWikidata', 'discogsKey', 'saveDiscogs']) assert.ok(html.includes(`id="${id}"`), id);
  assert.match(html, /<button class="b p" id="enrich" data-act="enrich" disabled>/); // no key yet
  assert.match(html, /<section class="srccard srclisten" id="src-listening" aria-labelledby="src-listening-h"><div id="audioPanel">panel<\/div><\/section>/);
});

test('Sources actions: saving a key stores it, clearing removes it, and both redraw', () => {
  const kept = new Map(), said = [];
  let drawn = 0;
  const c = { LS: { setItem: (k, v) => kept.set(k, v), removeItem: k => kept.delete(k) },
              $: sel => ({ value: sel === '#lfmKey' ? '  abc  ' : '' }),
              toast: m => said.push(m), render: () => drawn++ };
  SOURCES.actions.saveLfm(c);
  assert.equal(kept.get('bf_lfm'), 'abc');
  SOURCES.actions.saveDiscogs(c);
  assert.ok(!kept.has('bf_discogs'));
  assert.deepEqual(said, ['Key saved.', 'Token cleared.']);
  assert.equal(drawn, 2);
  const seen = [];
  SOURCES.actions.enrich({ enrichMissing: () => seen.push('enrich') });
  SOURCES.actions.fillWikidata({ fillFromWikidata: () => seen.push('wikidata') });
  assert.deepEqual(seen, ['enrich', 'wikidata']);
});
