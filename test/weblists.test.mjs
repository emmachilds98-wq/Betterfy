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
  assert.match(html, /data-pl="P1"[^]*?<span class="plscore plh-ok"[^>]*><b class="mono">100<\/b><span>Healthy<\/span>/);
  assert.match(html, /data-pl="P2"[^]*?<span class="tag warn">what kind\?<\/span>/);
  assert.ok(html.includes('data-go="shuffle"') && html.includes('data-go="sources"'));
  assert.match(html, /How well it knows you[^]*data-go="engine"|data-go="engine"[^]*How well it knows you/, 'Engine is reached from Library now');
  assert.match(html, /Not measured yet/);
});

test('Library rows: misfiled, waiting, BPM range and top style; the ones needing a look come first', () => {
  const sb = load();
  const R = { drift: [], clusters: [], misfiled: Array.from({ length: 5 }, () => ({ currentPlaylistId: 'P3' })),
    backlog: [{ suggest: [{ id: 'P1' }] }, { suggest: [{ id: 'P1' }] }, { suggest: [{ id: 'P3' }, { id: 'P1' }] }, { suggest: [] }] };
  const CFG2 = { ...CFG, P3: { axis: 'genre', target: true, tracks: 12, why: 'x' } };
  const LIB2 = { ...LIB, playlists: [...LIB.playlists, { id: 'P3', name: 'Halftime', tracks: tr('h', 12) }] };
  const html = LISTS.view({ ...sb, R, CFG: CFG2, LIB: LIB2, store: { touch() {} }, fire() {} });
  assert.ok(html.indexOf('data-pl="P3"') < html.indexOf('data-pl="P1"'), 'the misfiled playlist is listed first, although it is smaller');
  assert.match(html, /data-pl="P3"[^]*?<span class="tag warn">5 misfiled<\/span> <span class="tag ok">1 to file<\/span>/);
  assert.match(html, /data-pl="P1"[^]*?<span class="tag ok">2 to file<\/span>/);
  assert.match(html, /1 playlist could use a look, listed first/);

  assert.deepEqual(LISTS.rowFacts({ misfiled: 0, waiting: 0, vm: { bpm: [124, 129.6], styles: [['Tech House', 0.6], ['Techno', 0.2]] } }).map(f => f.text),
    ['124–130 BPM', 'Tech House']);
  assert.deepEqual(LISTS.rowFacts({ vm: { bpm: 172 } }).map(f => f.text), ['172 BPM']);
  assert.deepEqual(LISTS.rowFacts({ vm: { bpm: null, styles: [] } }), [], 'nothing invented without a profile');
  assert.deepEqual([...LISTS.waitingCounts(R.backlog)], [['P1', 2], ['P3', 1]]);
});

test('"How well it knows you" says the last measured score in words, or that there is none', () => {
  assert.match(LISTS.knowsYouLine(null), /Not measured yet/);
  const now = Date.parse('2026-11-16T12:00:00Z');
  assert.equal(LISTS.knowsYouLine({ top1: 0.58, top3: 0.79, scored: 1412, at: now - 3 * 864e5 }, now),
    'Right first time on 58% of your filed tracks, and in its top three on 79% (1,412 tracks, checked 3 days ago).');
  assert.equal(LISTS.knowsYouLine({ top1: 0.5, at: now }, now), 'Right first time on 50% of your filed tracks (checked today).');
});

test('the detail sheet keeps the axis and receives-suggestions controls and offers Shuffle', () => {
  const sb = load();
  const sheet = LISTS.sheetHTML({ ...sb, store: { touch() {} }, fire() {}, mixHeardIn: () => 0 }, 'P1');
  assert.ok(!/>receives suggestions|>Axis /.test(sheet), 'in plain words (USER-REVIEW item 8)');
  assert.match(sheet, /Suggest new tracks for it/);
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
  assert.match(html, /data-lfmconnect/, 'Last.fm connects through the one shared sheet');
  for (const id of ['enrich', 'fillWikidata', 'discogsKey', 'saveDiscogs']) assert.ok(html.includes(`id="${id}"`), id);
  assert.match(html, /<button class="b p" id="enrich" data-act="enrich" disabled>/); // no key yet
  assert.match(html, /<section class="srccard srclisten" id="src-listening" aria-labelledby="src-listening-h"><div id="audioPanel">panel<\/div><\/section>/);
});

test('Sources actions: the Discogs token clears and redraws', () => {
  const kept = new Map(), said = [];
  let drawn = 0;
  const c = { LS: { setItem: (k, v) => kept.set(k, v), removeItem: k => kept.delete(k) },
              $: sel => ({ value: sel === '#lfmKey' ? '  abc  ' : '' }),
              toast: m => said.push(m), render: () => drawn++ };
  // The Last.fm key is saved by the shared connect sheet (app/sheet.js), not here.
  assert.equal(SOURCES.actions.saveLfm, undefined);
  SOURCES.actions.saveDiscogs(c);
  assert.ok(!kept.has('bf_discogs'));
  assert.deepEqual(said, ['Token cleared.']);
  assert.equal(drawn, 1);
  const seen = [];
  SOURCES.actions.enrich({ enrichMissing: () => seen.push('enrich') });
  SOURCES.actions.fillWikidata({ fillFromWikidata: () => seen.push('wikidata') });
  assert.deepEqual(seen, ['enrich', 'wikidata']);
});

test('health also reads twins, repeats and staleness, and says nothing without them', () => {
  const h = LISTS.playlistHealth({ tracks: 30, twins: ['Tech House B'], repeats: 2, staleDays: 800 });
  assert.equal(h.notes.length, 3);
  assert.match(h.notes.join(' '), /Tech House B/);
  assert.match(h.notes.join(' '), /2 repeated tracks/);
  assert.match(h.notes.join(' '), /nothing added in 2\+ years/);
  assert.equal(LISTS.playlistHealth({ tracks: 30, staleDays: 800 }).score, 100, 'age is a note, not a cost: health is fit');
  assert.equal(LISTS.playlistHealth({ tracks: 30, staleDays: null }).notes.length, 0);
  assert.equal(LISTS.repeatCount([{ id: 'a' }, { id: 'a' }, { id: 'b' }, {}]), 1);
  assert.equal(LISTS.staleDays([{ name: 'no date' }]), null);
  assert.equal(LISTS.staleDays([{ added_at: '2024-01-01T00:00:00Z' }, { added_at: '2024-01-11T00:00:00Z' }], Date.parse('2024-01-21T00:00:00Z')), 10);
  const twins = LISTS.twinsOf([{ verdict: 'indistinguishable', a: { id: 'x', name: 'X' }, b: { id: 'y', name: 'Y' } },
    { verdict: 'view', a: { id: 'x', name: 'X' }, b: { id: 'z', name: 'Z' } }]);
  assert.deepEqual([...twins], [['x', ['Y']], ['y', ['X']]]);
  assert.equal(LISTS.twinsOf(null).size, 0);
});

test('genre ticks: from the facet mix, or a weaker mix plus one style; never over your own choice', () => {
  const mixes = new Map([['a', { tracks: 20, genre: 0.7 }], ['b', { tracks: 20, genre: 0.35 }], ['c', { tracks: 20, genre: 0.35 }],
    ['d', { tracks: 20, genre: 0.9 }], ['e', { tracks: 20, genre: 0.9 }], ['f', { tracks: 0 }]]);
  const rows = [{ id: 'a', name: 'A', axis: 'mood', tracks: 20 }, { id: 'b', name: 'B', axis: 'mood', tracks: 20 },
    { id: 'c', name: 'C', axis: 'mood', tracks: 20 }, { id: 'd', name: 'D', axis: 'genre', tracks: 20 },
    { id: 'e', name: 'E', axis: 'mood', tracks: 20, why: 'set by you' }, { id: 'f', name: 'F', axis: 'mood', tracks: 20 }];
  const out = LISTS.genreTickSuggestions(rows, mixes, id => id === 'b' ? { styles: [['House', 0.6]] } : null);
  assert.deepEqual(out.map(x => x.id), ['a', 'b']);
});

test('cold start offers name sound clusters first, need four tracks, and write nothing', () => {
  const offers = LISTS.coldStartOffers({
    clusters: [{ ids: ['1', '2', '3', '4'], suggest: { name: 'Garage' }, tracks: [{ name: 'x' }] }, { ids: ['1', '2'] }],
    proposals: [{ kind: 'artist', label: 'Busy Producer', ids: ['a', 'b', 'c', 'd', 'e'], examples: [{ name: 'T1' }] }, { kind: 'shape', label: 'x', ids: ['q'] }],
  });
  assert.deepEqual(offers.map(o => [o.title, o.n]), [['Garage', 4], ['Busy Producer', 5]]);
  assert.deepEqual(LISTS.coldStartOffers(), []);
});

test('new genres: unsure clusters ranked by what you play, named by sound when CLAP has a name', () => {
  const t = a => ({ artists: [a] });
  const out = LISTS.newGenreOffers([
    { ids: ['1', '2', '3', '4', '5', '6'], tracks: [t('Z')] },
    { ids: ['7', '8', '9', '10'], tracks: [t('Hot'), t('Hot')], suggest: { name: 'Donk' } },
    { ids: ['x'], tracks: [] }], new Set(['Hot']));
  assert.deepEqual(out.map(o => [o.title, o.played]), [['Donk?', 2], ['New genre?', 0]]);
});

test('the Library view offers genre ticks and cold start; nothing without them', () => {
  const sb = load();
  const base = { ...sb, store: { touch() {} }, fire() {}, GAPS: { status: 'idle' },
    CFG: { P1: { name: 'Hardcore', axis: 'mood', why: 'x', tracks: 20 } },
    playlistMixes: () => ({ mix: new Map([['P1', { tracks: 20, genre: 0.8 }]]) }) };
  const html = LISTS.view({ ...base, coldKick: () => {}, COLD: { status: 'ready', made: new Set(), newGenre: [], found: { clusters: [],
    proposals: [{ kind: 'artist', label: 'Busy Producer', ids: ['a', 'b', 'c', 'd'], examples: [] }] } } });
  assert.match(html, /These look like genre playlists/);
  assert.match(html, /Start these playlists/);
  assert.match(html, /Busy Producer/);
  const none = LISTS.view({ ...base, playlistMixes: () => ({ mix: new Map() }), COLD: { status: 'idle' } });
  assert.doesNotMatch(none, /genre playlists<\/h2>|Start these/);
});
