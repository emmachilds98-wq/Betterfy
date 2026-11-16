import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import * as Bridge from '../core/intrinsic/bridge.mjs';
import { buildSpace, placements } from '../core/intrinsic/space.mjs';
import { enrichOrder, listenedWeights } from '../core/personal/relevance.mjs';
import { bridgeVerdict } from '../web/screens/engine.mjs';
import { helperRows } from '../web/screens/helpers.mjs';

/*
 * docs/NEXT-WORKPLAN.md package 2, run out of the real built page: similar
 * artists are gathered in the background after load, for the whole library,
 * artists waiting to be filed first, and File uses them straight away, with
 * no Score run. A Score run that says they don't help switches File's use off.
 */

const PAGE = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
const between = (from, to, what) => {
  const i = PAGE.indexOf(from), j = PAGE.indexOf(to, i);
  assert.ok(i > 0 && j > i, `${what} not found — rebuild with node build-web.mjs`);
  return PAGE.slice(i, j);
};
const WARM_SRC = between('/* ======================= similar artists, fetched in the background', '/* ---------- the teach queue on File', 'app/bridgewarm.js');
const ENRICH_ORDER = between('/* Listening-weighted enrichment', '/** Fill tag gaps', 'app/sync-tags.js');
const FILE_PICKS = between('function filePicks(t) {', '/* The band the File card shows', 'filePicks');

const id22 = s => s.padEnd(22, 'x');
const FAMS = ['jungle', 'garage'];
function library() {
  const playlists = FAMS.map((fam, fi) => ({ id: `p-${fam}`, name: fam,
    tracks: Array.from({ length: 8 }, (_, i) => ({ id: `${fam}-t${i}`, name: `${fam} ${i}`,
      artists: [{ id: id22(`${fam}Core${i % 4}`), name: `${fam} core ${i % 4}` }],
      albumType: 'single', albumTracks: 2, trackNo: 1, released: '2021-01-01', duration_ms: 300000, popularity: 40,
      isrc: `GB${'AB'[fi]}XX21${String(10000 + i).slice(0, 5)}`, added_at: '2025-01-01T00:00:00Z' })) }));
  const newcomer = { id: 'u-new', name: 'Fresh', artists: [{ id: id22('freshNew0'), name: 'Fresh Face' }],
    albumType: 'single', albumTracks: 2, trackNo: 1, released: '2021-01-01', duration_ms: 300000, popularity: 40,
    isrc: 'ZZAGG2110000', added_at: '2025-02-01T00:00:00Z' };
  return { playlists, liked: [newcomer, ...playlists[1].tracks.slice(0, 2)] };
}
const NOW = Date.now();
const RAW = { [id22('freshNew0')]: { deezerId: 1, deezerAt: NOW, mbidAt: NOW,
  deezer: [0, 1, 2, 3].map(i => ({ id: 100 + i, name: `jungle core ${i}` })) } };

function load({ raw = null, off = false, gate = null, saveData = false } = {}) {
  const lib = library(), targets = new Set(['p-jungle', 'p-garage']);
  const store = new Map(), ls = new Map();
  if (raw) store.set('bridge-raw', { at: 1, raw });
  if (off) ls.set('bf_bridge_off', '1');
  if (gate) ls.set('bf_bridge_gate', JSON.stringify(gate));
  const calls = { gather: [], fired: [], renders: 0 };
  const sandbox = {
    LIB: lib, TAGS: {}, R: { backlog: [{ id: 'u-new' }] }, FB: {},
    CFG: { 'p-jungle': { name: 'Jungle', target: true, axis: 'genre' }, 'p-garage': { name: 'Garage', target: true, axis: 'genre' } },
    view: 'inbox', ENG: { space: null, valRunning: false, status: 'idle' }, SOUND: { space: null, memo: null },
    LS: { getItem: k => ls.get(k) ?? null, setItem: (k, v) => ls.set(k, String(v)) },
    idb: { get: async k => store.get(k), set: async (k, v) => { store.set(k, v); } },
    BRIDGE_KEY: 'bridge-raw',
    navigator: { connection: { saveData } },
    engineTargets: () => [...targets].sort(),
    engineLoad: async () => {},
    engineSpace: async () => ({ space: buildSpace(lib, { targets }) }),
    fire: p => { calls.fired.push(Promise.resolve(p)); },
    render: () => { calls.renders++; },
    fetchListeningRaw: async () => ({ topWindows: [], recentArtists: [] }),
    deezerJsonp: async () => { throw new Error('no network'); }, corsJson: async () => { throw new Error('no network'); },
    BetterfyBridge: Bridge, BetterfyIntrinsic: { placements },
    BetterfyBridgeFetch: { TTL_MS: 60 * 864e5,
      gatherBridge: async (artists, { cache }) => {
        calls.gather.push([...artists.keys()]);
        const out = { ...cache };
        // Answers for every artist asked: the newcomer's neighbours are the jungle core.
        for (const sid of artists.keys()) out[sid] = sid === id22('freshNew0') ? RAW[sid]
          : { ...(cache?.[sid] ?? {}), deezerId: null, deezer: [], deezerAt: Date.now(), mbidAt: Date.now() };
        return { raw: out, stats: {} };
      } },
    SCREEN_MODS: { engine: { bridgeVerdict } },
    console, enrichOrder, listenedWeights, globalThis: null,
  };
  sandbox.globalThis = sandbox;
  sandbox.bridgeOn = () => sandbox.LS.getItem('bf_bridge_off') !== '1';
  vm.createContext(sandbox);
  vm.runInContext(ENRICH_ORDER, sandbox);
  vm.runInContext(WARM_SRC, sandbox);
  vm.runInContext(FILE_PICKS, sandbox);
  return Object.assign(sandbox, { calls, store, ls, lib });
}
async function settle(app) {
  for (let n = 0; n < 10 && app.calls.fired.length; n++) await Promise.all(app.calls.fired.splice(0));
}
/** File's picks for the untagged, unheard newcomer once background work is done. */
async function picksFor(app) {
  app.filePicks({ id: 'u-new', artists: app.lib.liked[0].artists, suggest: [] });
  await settle(app);
  return app.filePicks({ id: 'u-new', artists: app.lib.liked[0].artists, suggest: [] });
}

test('no Score run, nothing remembered: the background lookups start, artists waiting to be filed first', async () => {
  const app = load();
  await app.bridgeWarm();
  assert.ok(app.calls.gather.length >= 1);
  assert.equal(app.calls.gather[0][0], id22('freshNew0'), 'the unfiled song\'s artist is asked first');
  const asked = new Set(app.calls.gather.flat());
  for (const p of app.lib.playlists) for (const t of p.tracks) assert.ok(asked.has(t.artists[0].id), 'filed artists are asked too');
  assert.ok(app.store.get('bridge-raw').raw[id22('freshNew0')], 'saved for the next load');
  const st = app.bridgeWarmState();
  assert.equal(st.total, 9); assert.equal(st.asked, 9); assert.equal(st.running, false);
});

test('File uses them straight away: an untagged, unheard newcomer gets picks from where its similar artists are filed', async () => {
  const app = load();
  assert.deepEqual(await picksFor(app), [], 'nothing before the lookups');
  await app.bridgeWarm();
  const picks = await picksFor(app);
  assert.equal(picks[0]?.id, 'p-jungle', JSON.stringify(picks));
  assert.equal(picks[0].via, 'blend'); assert.equal(picks[0].similar, true);
  // A rejected playlist is never offered.
  app.FB['u-new'] = { rejected: ['p-jungle'] };
  assert.ok(!(await picksFor(app)).some(p => p.id === 'p-jungle'));
});

test('what is remembered is used on the next load without asking again', async () => {
  const app = load({ raw: { ...RAW, ...Object.fromEntries(library().playlists.flatMap(p => p.tracks).map(t =>
    [t.artists[0].id, { deezerId: null, deezer: [], deezerAt: NOW, mbidAt: NOW }])) } });
  await app.bridgeWarm();
  assert.equal(app.calls.gather.length, 0, 'everything fresh: nothing asked');
  assert.equal((await picksFor(app))[0]?.id, 'p-jungle');
});

test('tags or sound picks are left alone', async () => {
  const app = load({ raw: RAW });
  await app.bridgeWarm();
  const tagPicks = [{ id: 'p-garage', name: 'Garage', score: 0.4 }];
  const t = { id: 'u-new', artists: app.lib.liked[0].artists, suggest: tagPicks };
  assert.equal(app.filePicks(t), tagPicks, 'the very array tags gave');
});

test('switched off, or data saver: nothing asked', async () => {
  for (const opts of [{ off: true }, { saveData: true }]) {
    const app = load(opts);
    await app.bridgeWarm();
    assert.equal(app.calls.gather.length, 0, JSON.stringify(opts));
  }
  const off = load({ raw: RAW, off: true });
  await off.bridgeWarm();
  assert.deepEqual(await picksFor(off), [], 'and File uses nothing');
});

test('a Score run that says they do not help switches File\'s use off; one that clears the bar keeps it', async () => {
  const fail = load({ raw: RAW, gate: { pass: false } });
  await fail.bridgeWarm();
  assert.deepEqual(await picksFor(fail), []);
  assert.equal(fail.bridgeWarmState().gate, false);

  const app = load({ raw: RAW });
  await app.bridgeWarm();
  const run = ok => ({ mine: { top1: 0.5, neverFiled: { top1: 0.1, scored: 40 },
    withBridge: { top1: ok ? 0.52 : 0.45, neverFiled: { top1: 0.4 } } } });
  app.bridgeGateRemember(run(false));
  assert.equal(JSON.parse(app.ls.get('bf_bridge_gate')).pass, false, 'costs overall: off');
  assert.deepEqual(await picksFor(app), []);
  app.bridgeGateRemember(run(true));
  assert.equal(JSON.parse(app.ls.get('bf_bridge_gate')).pass, true);
  assert.equal((await picksFor(app))[0]?.id, 'p-jungle');
  app.bridgeGateRemember({ mine: { top1: 0.5 } });
  assert.equal(JSON.parse(app.ls.get('bf_bridge_gate')).pass, true, 'a run without similar artists keeps the last verdict');
});

test('the sound space gets a copy with the bridge; the shared one is left alone', async () => {
  const app = load({ raw: RAW });
  await app.bridgeWarm();
  const space = buildSpace(app.lib, { targets: new Set(['p-jungle', 'p-garage']) });
  const b = app.bridgedSpace(space);
  assert.notEqual(b, space); assert.ok(b.bridge?.size); assert.equal(space.bridge, undefined);
  assert.equal(app.bridgedSpace(space), b, 'kept until something changes');
  vm.runInContext('bridgeSpaceStale()', app);
  assert.notEqual(app.bridgedSpace(space), b);
  assert.equal(app.bridgedSpace(null), null);
});

test('Settings: the similar-artists row reads as on, with how many artists are looked up', () => {
  const by = s => Object.fromEntries(helperRows(s).map(r => [r.id, r]));
  const on = by({ bridge: { on: true, warm: { asked: 120, total: 300, running: true } } }).similar;
  assert.equal(on.on, true); assert.equal(on.status, 'On · looking up');
  assert.match(on.did, /Similar artists: 120 of 300 artists looked up/);
  assert.match(on.did, /no Score run needed/);
  assert.equal(by({ bridge: { on: true, warm: { gate: false } } }).similar.status, 'On · not used');
  assert.equal(by({ bridge: { on: false } }).similar.status, 'Off');
});

test('the page wires it: started after the tag lookups, used by sound picks, gated by the Score run', () => {
  assert.match(PAGE, /await enrichMissing\(\{ quiet: true \}\)[^]*?await bridgeWarm\(\)/);
  assert.match(PAGE, /const space = typeof bridgedSpace === 'function' \? bridgedSpace\(SOUND\.space\) : SOUND\.space;/);
  assert.match(PAGE, /bridgeGateRemember\(ENG\.val\)/);
});
