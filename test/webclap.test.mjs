import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { soundLibrary } from './fixtures/sound-library.mjs';
import { table, clapField, resetSeed } from './fixtures/clap-fixture.mjs';
import { DISCOVER, renderDiscover, GOLDEN } from './ui4-cards.mjs';
import { assertSameHTML } from './golden.mjs';
import { addStore } from './fixtures/page-store.mjs';

/*
 * WP-C3 in the real built page: suggested names on New playlists' "new
 * genre?" cards, and Discover's "sounds like" search, run from docs/index.html
 * against docs/engine.js and docs/audio.js. The rule first: with no CLAP
 * records, both screens are byte-identical to what they drew before.
 */
const read = f => readFileSync(new URL(`../docs/${f}`, import.meta.url), 'utf8');
const PAGE = read('index.html'), ENGINE = read('engine.js'), AUDIOJS = read('audio.js');

function slice(from, to) {
  const i = PAGE.indexOf(from), j = PAGE.indexOf(to, i);
  assert.ok(i > 0 && j > i, `${from} not found — rebuild with node build-web.mjs`);
  return PAGE.slice(i, j);
}
const GAPS_CODE = slice('/* ======================= gaps: docs/SMARTER-GENRES-PLAN.md, phase 3',
                        '/* ---------- shuffle: spacing, not randomness');
const EMPTY = slice('function emptyState(', '/* The misfile confidence tiers');
const CLAP_CODE = slice('/* ---------- CLAP: names for "new genre?" groups', '/** Redraw only the panel');

const esc = x => String(x ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** A sandbox with the gaps screen, and (unless `bare`) audio.js and the CLAP block. */
function screen({ lib, records, bare = false, tableJson = table() }) {
  const calls = [], fetched = [], db = new Map();
  const s = {
    console, Set, Map, atob, btoa, Promise, URL,
    LIB: lib, TAGS: {}, R: { clusters: [] },
    CFG: { 'p-x': { target: true }, 'p-y': { target: true }, 'p-z': { target: true } },
    esc, isMirrorPlaylist: () => false, renders: 0, toasts: [], calls, fetched, db, pending: [],
    AUDIO: { records: new Map(records.map(r => [r.id, r])) },
    audioModelUrl: f => `https://x.test/models/${f}`,
    idb: { get: async k => db.get(k) ?? null, set: async (k, v) => { db.set(k, v); } },
    syncStamped: async () => false,
  };
  s.fire = p => { s.pending.push(Promise.resolve(p)); };
  s.render = () => { s.renders++; };
  s.toast = m => s.toasts.push(m);
  s.engineLoad = async () => true;
  s.engineTargets = () => Object.keys(s.CFG).sort();
  s.getListening = async () => null;
  s.engineAudio = async () => records;
  s.sp = async (path, init) => { calls.push(['sp', path, init?.method ?? 'GET', init?.body ?? null]); return { id: 'new-pl' }; };
  s.addTracks = async (id, ids) => { calls.push(['add', id, ids.length]); };
  s.fetch = async url => { fetched.push(url); return tableJson ? { ok: true, json: async () => tableJson } : { ok: false, status: 404 }; };
  vm.createContext(s);
  addStore(s);
  vm.runInContext(ENGINE, s);
  if (!bare) vm.runInContext(AUDIOJS, s);
  vm.runInContext(EMPTY, s);
  vm.runInContext(GAPS_CODE, s);
  if (!bare) vm.runInContext(CLAP_CODE, s);
  return s;
}
const settle = async s => { while (s.pending.length) await s.pending.shift(); };
async function vNew(s) { vm.runInContext('vNew()', s); await settle(s); return vm.runInContext('vNew()', s); }

/** soundLibrary's records; with `clap`, the orphan group and the playlists heard by CLAP too. */
function withClap(clap) {
  resetSeed();
  const { lib, records } = soundLibrary({ kinds: ['orphan', 'hybrid'] });
  if (!clap) return { lib, records };
  const lean = { or: { phonk: 1 }, x: { dnb: 1 }, y: { bass: 1 }, z: { jersey: 0.3, bass: 0.7 }, hy: { bass: 0.6, dnb: 0.4 } };
  return { lib, records: records.map(r => ({ ...r, clap: clapField(lean[r.id.replace(/\d+$/, '')] ?? { euphoric: 1 }) })) };
}

test('no CLAP records: New playlists is byte-identical, and the phrase list is never fetched', async () => {
  const { lib, records } = withClap(false);
  const before = await vNew(screen({ lib, records, bare: true }));
  const s = screen({ lib, records });
  assert.equal(await vNew(s), before);
  assert.match(before, /New genre\? <span class="tag snd">by sound/);
  assert.deepEqual(s.fetched, []);
  // Nothing at all asked of Discover's card either.
  assert.equal(vm.runInContext('soundSearchHTML()', s), '');
  s.AUDIO.records = null;
  assert.equal(vm.runInContext('soundSearchHTML()', s), '');
  assert.deepEqual(s.fetched, []);
});

test('no CLAP records: the Discover card matches its pre-slot golden with the search code present', () => {
  // The golden harness has no soundSearchHTML; give it one that sees records without CLAP.
  for (const [name, t] of Object.entries(DISCOVER)) {
    const golden = readFileSync(new URL(`discover-${name}.html`, GOLDEN), 'utf8');
    const html = renderDiscover(t, { renderers: { soundSearchHTML: () => '' } });
    assertSameHTML(html, golden);
  }
});

test('a heard "new genre?" group gets a suggested name, with a question mark and a way to keep it', async () => {
  const { lib, records } = withClap(true);
  const s = screen({ lib, records });
  const html = await vNew(s);
  assert.deepEqual(s.fetched, ['https://x.test/models/clap-text-table.json']);
  assert.match(html, /class="row prop prop-new"/);
  assert.match(html, /<div class="ttl">phonk\? <span class="tag snd">by sound/);
  assert.match(html, /They sound most like phonk[^:]*: a guess by sound until you say so\./);
  assert.match(html, /id="sndo0"[^>]*value="phonk">/);
  assert.match(html, /data-sndn="0">That’s it<\/button>/);
  // The hybrid card is untouched: naming is for "new genre?" only.
  assert.doesNotMatch(html, /data-sndn="1"/);
});

test('a confirmed or renamed name is stored for the account and shown without the question mark', async () => {
  const { lib, records } = withClap(true);
  const s = screen({ lib, records });
  await vNew(s);
  const ids = vm.runInContext('GAPS.sound.orphans[0].ids', s);
  await vm.runInContext(`clapConfirm(GAPS.sound.orphans[0].ids, 'Drift phonk')`, s);
  const stored = s.db.get('cluster_names');
  assert.equal(Object.keys(stored).length, 1);
  assert.equal(Object.values(stored)[0].name, 'Drift phonk');
  assert.equal(JSON.stringify(Object.values(stored)[0].ids), JSON.stringify([...ids].sort()));
  // Worked out again (a new sync, a fresh screen): the name holds.
  vm.runInContext(`GAPS.status = 'idle'; CLAPS.names = null`, s);
  const html = await vNew(s);
  assert.match(html, /<div class="ttl">Drift phonk <span class="tag snd">by sound/);
  assert.match(html, /You named this group\./);
  assert.match(html, /id="sndo0"[^>]*value="Drift phonk">/);
  assert.doesNotMatch(html, /data-sndn=|phonk\?/);
});

test('a missing phrase list leaves the cards unnamed, exactly as without CLAP', async () => {
  const { lib, records } = withClap(true);
  const plain = await vNew(screen({ lib, records, bare: true }));
  const s = screen({ lib, records, tableJson: null });
  assert.equal(await vNew(s), plain);
});

/** Discover's card, alone, with records already in AUDIO. */
async function search(q, { records, lib }) {
  const s = screen({ lib, records });
  vm.runInContext('soundSearchHTML()', s);
  await settle(s);
  if (q != null) await vm.runInContext(`clapSearch(${JSON.stringify(q)})`, s);
  return { s, html: vm.runInContext('soundSearchHTML()', s) };
}

test('Discover: the card offers the phrase list once CLAP has heard something', async () => {
  const { html } = await search(null, withClap(true));
  assert.match(html, /<div class="card sndsearch" id="sndSearch">/);
  assert.match(html, /Find tracks that sound like… <span class="tag snd">by sound/);
  assert.match(html, /<input id="sndq" list="sndqList"[^>]*placeholder="e\.g\. dark rolling bassline" value="">/);
  assert.equal((html.match(/<option value=/g) ?? []).length, table().prompts.length);
  assert.match(html, /Ranks the \d+ tracks listening has heard by how they sound/);
  assert.doesNotMatch(html, /<ol/);
});

test('Discover: a prompt ranks the library by sound, best first, and can become a playlist', async () => {
  const lib = withClap(true);
  const { s, html } = await search('Phonk', lib);
  const items = [...html.matchAll(/<li><b>([^<]*)<\/b>/g)].map(m => m[1]);
  // The ten phonk-leaning tracks first; only what sits above the library's average after them.
  assert.ok(items.length >= 10 && items.length < 20, String(items.length));
  assert.ok(items.slice(0, 10).every(t => t.startsWith('or track')), items.join(' | '));
  assert.match(html, /value="Phonk"/);
  assert.match(html, new RegExp(`data-sndqmake>Make a playlist of these ${items.length}</button>`));
  assert.match(html, /href="https:\/\/open\.spotify\.com\/track\/or\d+"/);
  assert.equal(vm.runInContext('CLAPS.res.prompt.label', s), 'phonk');
});

test('Discover: text that is not a prompt gets the nearest prompts, or a plain empty state', async () => {
  const lib = withClap(true);
  let { html } = await search('bass', lib);
  assert.match(html, /Nothing in the list is “bass”/);
  assert.match(html, /data-sndqpick="bassline">bassline<\/button> <button class="b sm" data-sndqpick="drum and bass">/);
  ({ html } = await search('qqq', lib));
  assert.match(html, /class="empty-state compact"/);
  assert.match(html, /Start typing and pick one from it\./);
  assert.doesNotMatch(html, /data-sndqpick/);
  // Typed text is escaped wherever it comes back.
  ({ html } = await search('<b>x</b>', lib));
  assert.doesNotMatch(html, /<b>x<\/b>/);
});

test('Discover: a phrase list that will not load says so, with a retry', async () => {
  const s = screen({ ...withClap(true), tableJson: null });
  vm.runInContext('soundSearchHTML()', s);
  await settle(s);
  const html = vm.runInContext('soundSearchHTML()', s);
  assert.match(html, /The phrase list didn’t load/);
  assert.match(html, /data-sndqretry>Try again/);
  // No refetch loop on redraw.
  vm.runInContext('soundSearchHTML()', s);
  await settle(s);
  assert.equal(s.fetched.length, 1);
});
