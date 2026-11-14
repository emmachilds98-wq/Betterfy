import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/*
 * The New playlists screen's gaps and splits (docs/SMARTER-GENRES-PLAN.md,
 * phase 3), run from the real built page against the real engine bundle. The
 * stubs are only the app shell: the library, tags, which playlists take
 * suggestions, listening, and the two Spotify calls a create makes.
 */
const PAGE = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
const ENGINE = readFileSync(new URL('../docs/engine.js', import.meta.url), 'utf8');

function slice(from, to) {
  const i = PAGE.indexOf(from), j = PAGE.indexOf(to, i);
  assert.ok(i > 0 && j > i, 'the gaps screen code was not found — rebuild with npm run build:web');
  return PAGE.slice(i, j);
}
const CODE = slice('/* ======================= gaps: docs/SMARTER-GENRES-PLAN.md, phase 3',
                   '/* ---------- shuffle: spacing, not randomness');

let n = 0;
const tracks = (artist, k) => Array.from({ length: k }, () => ({ id: `t${n++}`, name: `Track ${n}`,
  artists: [{ id: `${artist}-${n % 3}`, name: `${artist} ${n % 3}` }] }));
const TAGS = {
  bl: [['bassline', 100]], ukg: [['uk garage', 100]], dnb: [['drum and bass', 100]],
  donk: [['donk', 100], ['hard house', 40]], moody: [['british', 100], ['chill', 50]],
};

function library() {
  return {
    liked: [...tracks('donk', 15), ...tracks('moody', 5)],
    playlists: [
      { id: 'p-dnb', name: 'Drum & Bass', tracks: tracks('dnb', 30) },
      { id: 'p-bass', name: 'Bass', tracks: [...tracks('ukg', 16), ...tracks('bl', 12)] },
      { id: 'p-sun', name: 'Sunday', tracks: tracks('dnb', 4) },
    ],
  };
}

function screen({ lib = library(), listening = null, listeningFails = false } = {}) {
  const calls = [];
  const tagTable = {};
  for (const p of [...lib.playlists.flatMap(p => p.tracks), ...lib.liked])
    for (const a of p.artists) tagTable[a.id] = { tags: TAGS[a.id.split('-')[0]] ?? [] };
  const s = {
    console, Set, Map,
    LIB: lib, TAGS: tagTable, R: { clusters: [] },
    CFG: { 'p-dnb': { target: true }, 'p-bass': { target: true }, 'p-sun': { target: false } },
    esc: x => String(x ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    isMirrorPlaylist: () => false,
    renders: 0, toasts: [], calls,
    pending: [],
  };
  s.fire = p => { s.pending.push(Promise.resolve(p)); };
  s.render = () => { s.renders++; };
  s.toast = m => s.toasts.push(m);
  s.engineLoad = async () => true;
  s.engineTargets = () => Object.entries(s.CFG).filter(([, v]) => v.target).map(([id]) => id).sort();
  s.getListening = async () => { if (listeningFails) throw new Error('offline'); return listening; };
  s.sp = async (path, init) => { calls.push(['sp', path, init?.method ?? 'GET', init?.body ?? null]); return { id: 'new-pl' }; };
  s.addTracks = async (id, ids) => { calls.push(['add', id, ids.length]); };
  vm.createContext(s);
  vm.runInContext(ENGINE, s);
  vm.runInContext(CODE, s);
  return s;
}
const settle = async s => { while (s.pending.length) await s.pending.shift(); };

test('opening the screen works the gaps out once, then shows them', async () => {
  const s = screen();
  const first = vm.runInContext('vNew()', s);
  assert.match(first, /Looking for genres you have no playlist for/);
  vm.runInContext('vNew()', s);
  assert.equal(s.pending.length, 1, 'a second render while working must not start a second run');
  await settle(s);
  const html = vm.runInContext('vNew()', s);
  assert.match(html, /Genres with no playlist/);
  assert.match(html, /Donk <span class="tag">15 tracks/);
  assert.match(html, /data-gap="0"/);
  // "Bass" is UK garage and bassline: offered as a split, with the original left alone.
  assert.match(html, /Playlists that are two genres/);
  assert.match(html, /Bassline 12/);
  assert.match(html, /the rest of UK Garage 16/);
  assert.match(html, /Bass stays as it is/);
  // The backlog clusters this screen always had are still there.
  assert.match(html, /Groups in your backlog/);
});

test('artists with no genre in their tags are counted and said, not guessed', async () => {
  const s = screen();
  vm.runInContext('vNew()', s);
  await settle(s);
  assert.match(vm.runInContext('vNew()', s), /5 of the \d+ tracks\s+outside your genre playlists have no genre/);
});

test('what you are playing puts a gap first and says so', async () => {
  const lib = library();
  lib.liked.push(...tracks('ukg', 20).map(t => ({ ...t, artists: [{ id: 'ukg-9', name: 'ukg 9' }] })));
  const s = screen({ lib, listening: { recentlyActive: new Set(['donk 0', 'donk 1', 'donk 2']) } });
  vm.runInContext('vNew()', s);
  await settle(s);
  const gaps = JSON.parse(vm.runInContext('JSON.stringify(GAPS.gaps)', s));
  assert.equal(gaps[0].label, 'Donk', 'fifteen tracks being played beat twenty that are not');
  assert.match(vm.runInContext('vNew()', s), /15 you're playing/);
});

test('no listening history still works: it only changes the order', async () => {
  const s = screen({ listeningFails: true });
  vm.runInContext('vNew()', s);
  await settle(s);
  assert.equal(vm.runInContext('GAPS.status', s), 'ready');
  assert.ok(vm.runInContext('GAPS.gaps.length', s) > 0);
});

test('creating makes one private playlist with exactly those tracks, and touches nothing else', async () => {
  const s = screen();
  vm.runInContext('vNew()', s);
  await settle(s);
  const ids = vm.runInContext('GAPS.gaps[0].ids', s);
  await vm.runInContext('gapsCreate("Donk", GAPS.gaps[0].ids)', s);
  assert.deepEqual(s.calls, [
    ['sp', '/me/playlists', 'POST', JSON.stringify({ name: 'Donk', public: false })],
    ['add', 'new-pl', ids.length],
  ]);
  assert.match(vm.runInContext('vNew()', s), /<span class="tag ok">created<\/span>/);
});

test('making one half of a split copies that half and never edits the playlist being split', async () => {
  const s = screen();
  vm.runInContext('vNew()', s);
  await settle(s);
  const part = JSON.parse(vm.runInContext('JSON.stringify(GAPS.splits[0].parts[1])', s));
  await vm.runInContext('gapsCreate(GAPS.splits[0].parts[1].label, GAPS.splits[0].parts[1].ids)', s);
  assert.equal(s.calls.length, 2);
  assert.ok(!s.calls.some(([, path]) => String(path).includes('p-bass')), 'the original playlist is never sent anything');
  assert.deepEqual(s.calls[1], ['add', 'new-pl', part.size]);
  assert.match(vm.runInContext('vNew()', s), new RegExp(`${part.label} created`));
});

test('a rebuilt library is worked out again', async () => {
  const s = screen();
  vm.runInContext('vNew()', s);
  await settle(s);
  // Marking Bass as not a genre playlist rebuilds the reports, so R changes.
  vm.runInContext('CFG["p-bass"].target = false; R = { clusters: [] }', s);
  vm.runInContext('vNew()', s);
  await settle(s);
  const splits = JSON.parse(vm.runInContext('JSON.stringify(GAPS.splits)', s));
  assert.deepEqual(splits, [], 'Bass is no longer a genre playlist, so it is no longer a split');
  const gaps = JSON.parse(vm.runInContext('JSON.stringify(GAPS.gaps.map(g => g.label))', s));
  assert.ok(gaps.includes('Bassline') || gaps.includes('UK Garage'), 'and its tracks have become gaps');
});

test('an engine that cannot be fetched leaves a retry, not a dead screen', async () => {
  const s = screen();
  s.engineLoad = async () => { throw new Error('could not fetch engine.js'); };
  vm.runInContext('vNew()', s);
  await settle(s);
  const html = vm.runInContext('vNew()', s);
  assert.match(html, /Couldn't work out the gaps: could not fetch engine.js/);
  assert.match(html, /data-gapsretry/);
});

test('names from a library are escaped', async () => {
  const lib = library();
  lib.playlists[1].name = '<b>Bass</b>';
  const s = screen({ lib });
  vm.runInContext('vNew()', s);
  await settle(s);
  const html = vm.runInContext('vNew()', s);
  assert.ok(!html.includes('<b>Bass</b>'));
  assert.match(html, /&lt;b&gt;Bass&lt;\/b&gt;/);
});
