import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { soundLibrary } from './fixtures/sound-library.mjs';

/*
 * The New playlists screen's proposals by sound (docs/AUDIO-BUILD-PLAN.md
 * WP-H2), run from the real built page against the real engine bundle, as
 * test/webgaps.test.mjs does for the tag-based half of the same screen.
 */
const PAGE = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
const ENGINE = readFileSync(new URL('../docs/engine.js', import.meta.url), 'utf8');
const NO_AUDIO = readFileSync(new URL('./fixtures/vnew-no-audio.html', import.meta.url), 'utf8');

function slice(from, to) {
  const i = PAGE.indexOf(from), j = PAGE.indexOf(to, i);
  assert.ok(i > 0 && j > i, 'the gaps screen code was not found — rebuild with npm run build:web');
  return PAGE.slice(i, j);
}
const CODE = slice('/* ======================= gaps: docs/SMARTER-GENRES-PLAN.md, phase 3',
                   '/* ---------- shuffle: spacing, not randomness');

const TAGS = {
  bl: [['bassline', 100]], ukg: [['uk garage', 100]], dnb: [['drum and bass', 100]],
  donk: [['donk', 100], ['hard house', 40]], moody: [['british', 100], ['chill', 50]],
};

/** A fixed library: ids and names depend on nothing but this function. */
function library() {
  let n = 0;
  const tracks = (artist, k) => Array.from({ length: k }, () => ({ id: `t${n++}`, name: `Track ${n}`,
    artists: [{ id: `${artist}-${n % 3}`, name: `${artist} ${n % 3}` }] }));
  return {
    liked: [...tracks('donk', 15), ...tracks('moody', 5), ...tracks('moody', 24)],
    playlists: [
      { id: 'p-dnb', name: 'Drum & Bass', tracks: tracks('dnb', 30) },
      { id: 'p-bass', name: 'Bass', tracks: [...tracks('ukg', 16), ...tracks('bl', 12)] },
      { id: 'p-sun', name: 'Sunday', tracks: tracks('dnb', 4) },
    ],
  };
}

function screen({ lib = library(), records = null, cfg = null } = {}) {
  const calls = [];
  const tagTable = {};
  for (const p of [...lib.playlists.flatMap(p => p.tracks), ...lib.liked])
    for (const a of p.artists) tagTable[a.id] = { tags: TAGS[a.id.split('-')[0]] ?? [] };
  const s = {
    console, Set, Map, atob, btoa,
    LIB: lib, TAGS: tagTable, R: { clusters: [] },
    CFG: cfg ?? { 'p-dnb': { target: true }, 'p-bass': { target: true }, 'p-sun': { target: false } },
    esc: x => String(x ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    isMirrorPlaylist: () => false,
    renders: 0, toasts: [], calls, pending: [],
  };
  s.fire = p => { s.pending.push(Promise.resolve(p)); };
  s.render = () => { s.renders++; };
  s.toast = m => s.toasts.push(m);
  s.engineLoad = async () => true;
  s.engineTargets = () => Object.entries(s.CFG).filter(([, v]) => v.target).map(([id]) => id).sort();
  s.getListening = async () => null;
  if (records) s.engineAudio = async () => records;
  s.sp = async (path, init) => { calls.push(['sp', path, init?.method ?? 'GET', init?.body ?? null]); return { id: 'new-pl' }; };
  s.addTracks = async (id, ids) => { calls.push(['add', id, ids.length]); };
  vm.createContext(s);
  vm.runInContext(ENGINE, s);
  vm.runInContext(CODE, s);
  return s;
}
const settle = async s => { while (s.pending.length) await s.pending.shift(); };
async function ready(s) { vm.runInContext('vNew()', s); await settle(s); return vm.runInContext('vNew()', s); }

test('with no audio records the screen is byte-identical to the one before sound proposals', async () => {
  const html = await ready(screen());
  assert.equal(html, NO_AUDIO);
});

function soundScreen(kinds) {
  const { lib, records } = soundLibrary(kinds ? { kinds } : {});
  return screen({ lib, records, cfg: { 'p-x': { target: true }, 'p-y': { target: true }, 'p-z': { target: true } } });
}

test('records that propose nothing add nothing to the screen', async () => {
  const html = await ready(soundScreen(['inside']));
  assert.doesNotMatch(html, /By sound|by sound/);
});

test('each proposal by sound renders as its own card, each saying "by sound"', async () => {
  const s = soundScreen();
  const html = await ready(s);
  assert.match(html, /<h2[^>]*>By sound<\/h2>/);
  assert.equal(html.match(/<span class="tag snd">by sound<\/span>/g).length, 3);
  // Hybrid: named from its top two styles, between two playlists.
  assert.match(html, /class="row prop prop-hybrid"/);
  assert.match(html, /Bassline \/ Dubstep <span class="tag snd">by sound<\/span> <span class="tag">10 tracks/);
  assert.match(html, /Sounds between your (Dubstep|Bass) and (Bass|Dubstep) playlists/);
  assert.match(html, /10 of them change style partway through/);
  assert.match(html, /id="sndh0"[^>]*value="Bassline \/ Dubstep"/);
  // New genre?: unnamed, so the name box is empty.
  assert.match(html, /class="row prop prop-new"/);
  assert.match(html, /New genre\? <span class="tag snd">by sound/);
  assert.match(html, /id="sndo0"[^>]*placeholder="Name it">/);
  // Pick one of these two.
  assert.match(html, /class="row prop prop-pick"/);
  assert.match(html, /Drum &amp; Bass or Bass\? <span class="tag snd">by sound<\/span> <span class="tag">4 tracks/);
  assert.match(html, /data-sndp="0:0">Add to Drum &amp; Bass<\/button> <button class="b sm" data-sndp="0:1">Add to Bass</);
  // The tag-based sections are still there, unchanged in shape.
  assert.match(html, /Genres with no playlist/);
});

test('picking one adds the tracks to that playlist only, and the offer closes', async () => {
  const s = soundScreen(['pick']);
  await ready(s);
  const ids = vm.runInContext('GAPS.sound.pick[0].ids', s);
  await vm.runInContext('gapsFile(GAPS.sound.pick[0].between[1].id, "Bass", GAPS.sound.pick[0].ids, "p0:1")', s);
  assert.deepEqual(s.calls, [['add', 'p-y', ids.length]], 'one add, to the chosen playlist, and nothing else');
  const html = vm.runInContext('vNew()', s);
  assert.match(html, /<span class="tag ok">added to Bass<\/span>/);
  assert.doesNotMatch(html, /data-sndp=/);
});

test('creating a hybrid makes one private playlist with exactly its tracks', async () => {
  const s = soundScreen(['hybrid']);
  await ready(s);
  await vm.runInContext('gapsCreate("Bassline / Dubstep", GAPS.sound.hybrids[0].ids)', s);
  assert.deepEqual(s.calls, [
    ['sp', '/me/playlists', 'POST', JSON.stringify({ name: 'Bassline / Dubstep', public: false })],
    ['add', 'new-pl', 10],
  ]);
  assert.match(vm.runInContext('vNew()', s), /<span class="tag ok">created<\/span>/);
});

test('records that cannot be read leave the screen as it was', async () => {
  const s = screen();
  s.engineAudio = async () => { throw new Error('no store'); };
  assert.equal(await ready(s), NO_AUDIO);
});
