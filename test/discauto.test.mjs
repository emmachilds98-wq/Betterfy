import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// DESIGN-PLAN §7.7 A1 (provisional): Discover looks for new music by itself, at most once a day,
// quietly (no loading screen, no jump to Discover), and a reload opens on the last picks minus
// anything since owned or passed on. The block is lifted out of web/app/discover-engine.js.
const SRC = readFileSync(new URL('../web/app/discover-engine.js', import.meta.url), 'utf8');
const BLOCK = SRC.slice(SRC.indexOf('const DISC_AUTO_KEY'), SRC.indexOf('async function discRun('));
const plain = x => JSON.parse(JSON.stringify(x));

function load({ saved = null, last = null, saveData = false, liked = [], pass = [], log = null, lib = null } = {}) {
  const ls = new Map(last == null ? [] : [['bf_disc_auto', String(last)]]);
  const kv = new Map(saved ? [['disc:picks', saved]] : []);
  const sb = {
    S: {}, LIB: lib ?? { playlists: [{ id: 'p1', tracks: [{ id: 'own1' }] }], liked: liked.map(id => ({ id })) },
    ...(log ? { getLog: async () => log } : {}),
    LS: { getItem: k => ls.get(k) ?? null, setItem: (k, v) => ls.set(k, v) },
    idb: { get: async k => kv.get(k), set: async (k, v) => { kv.set(k, v); } },
    store: { touch() {} }, fire: p => p, stage: () => { sb.staged++; }, staged: 0, runs: [],
    navigator: { connection: { saveData } },
    norm: s => String(s).toLowerCase(),
    discMemory: () => ({ pass, like: [] }),
    ls, kv,
  };
  vm.createContext(sb);
  vm.runInContext(BLOCK + `
    async function discRun(seed, quiet) {
      runs.push({ seed, quiet }); discStage('x', 0);
      S.discover = [{ id: 'n1', artist: 'New' }]; S.discoverFrom = 'everything you listen to'; discSave(); return true;
    }
    globalThis.api = { discAuto, discRestore, runDiscovery, discBusy, discStillNew, discLoadLogged, discAfterChange, discTopUp, discRefilter };`, sb);
  return sb;
}

test('runs quietly at most once a day, and never on Data Saver', async () => {
  const NOW = Date.UTC(2026, 10, 18, 9);
  const a = load();
  assert.equal(await a.api.discAuto({ now: NOW }), true);
  assert.deepEqual(plain(a.runs), [{ seed: null, quiet: true }]);
  assert.equal(a.staged, 0, 'no loading screen over the page');
  assert.equal(a.ls.get('bf_disc_auto'), String(NOW));
  assert.deepEqual(plain(a.kv.get('disc:picks').picks.map(p => p.id)), ['n1'], 'the picks are kept for the next load');
  assert.equal(a.api.discBusy(), false);

  const b = load({ last: NOW - 3600e3 });
  b.S.discover = [1, 2, 3, 4, 5].map(i => ({ id: 'p' + i }));   // a full deck: nothing to top up
  assert.equal(await b.api.discAuto({ now: NOW }), false, 'an hour ago is too soon');
  assert.equal(b.runs.length, 0);
  const c = load({ last: NOW - 25 * 3600e3 });
  assert.equal(await c.api.discAuto({ now: NOW }), true, 'a day on, it looks again');
  const d = load({ saveData: true });
  assert.equal(await d.api.discAuto({ now: NOW }), false);
  assert.equal(d.runs.length, 0);
});

test('a run by hand shows the loading screen as before', async () => {
  const a = load();
  await a.api.runDiscovery('p1');
  assert.deepEqual(plain(a.runs), [{ seed: 'p1', quiet: false }]);
  assert.equal(a.staged, 1);
});

test('a reload opens on the last picks, minus owned tracks and passed-on artists', async () => {
  const saved = { at: 1, from: 'Jungle', picks: [{ id: 'own1', artist: 'A' }, { id: 'lk', artist: 'B' }, { id: 'x', artist: 'Gone' }, { id: 'keep', artist: 'C' }] };
  const a = load({ saved, liked: ['lk'], pass: ['gone'] });
  assert.equal(await a.api.discRestore(), true);
  assert.deepEqual(plain(a.S.discover.map(p => p.id)), ['keep']);
  assert.equal(a.S.discoverFrom, 'Jungle');
  const b = load({ saved });
  b.S.discover = [{ id: 'fresh' }];
  assert.equal(await b.api.discRestore(), false, 'newer picks on the page win');
  assert.deepEqual(plain(b.S.discover.map(p => p.id)), ['fresh']);
});

test('discStillNew drops a logged add, a name|artist match under another id, and a passed artist', async () => {
  const lib = { playlists: [{ id: 'p1', tracks: [{ id: 'relinked', name: 'Same Song', artists: [{ name: 'Some Artist' }] }] }], liked: [] };
  const log = [{ op: 'add', at: 't1', trackIds: ['logged'] }, { op: 'add', at: 't2', trackIds: ['undone'], undoneAt: 'x' },
               { op: 'add-liked', at: 't3', trackIds: ['likedlog'] }, { op: 'remove', at: 't4', trackIds: ['rm'] }];
  const a = load({ lib, log, pass: ['gone'] });
  await a.api.discLoadLogged();
  const picks = [{ id: 'logged', artist: 'A', track: 'x' }, { id: 'new-id', artist: 'Some Artist', track: 'same song' },
    { id: 'undone', artist: 'B', track: 'y' }, { id: 'likedlog', artist: 'C', track: 'z' }, { id: 'rm', artist: 'D', track: 'w' },
    { id: 'g', artist: 'Gone', track: 'q' }, { id: 'ok', artist: 'E', track: 'v' }];
  assert.deepEqual(plain(a.api.discStillNew(picks).map(p => p.id)), ['undone', 'rm', 'ok']);
});

test('a reload does not bring back a pick that History says was added', async () => {
  const saved = { at: 1, picks: [{ id: 'added', artist: 'A', track: 't' }, { id: 'keep', artist: 'B', track: 'u' }] };
  const a = load({ saved, log: [{ op: 'add', at: 't1', trackIds: ['added'] }] });
  assert.equal(await a.api.discRestore(), true);
  assert.deepEqual(plain(a.S.discover.map(p => p.id)), ['keep']);
});

test('the deck refills quietly when low or stale, but not on Data Saver, and the card stays put', async () => {
  const NOW = Date.UTC(2026, 10, 18, 9);
  const a = load({ last: NOW - 3600e3 });
  a.S.discover = [{ id: 'a', artist: 'A' }, { id: 'b', artist: 'B' }];
  assert.equal(await a.api.discAuto({ now: NOW }), true, 'two left: top up');
  assert.deepEqual(plain(a.runs), [{ seed: null, quiet: true }]);
  const full = load({ last: NOW - 3600e3 });
  full.S.discover = [1, 2, 3, 4, 5].map(i => ({ id: 'p' + i }));
  assert.equal(await full.api.discAuto({ now: NOW }), false, 'a full, fresh deck is left alone');
  const stale = load({ last: NOW - 3600e3, saved: { at: NOW - 13 * 3600e3, picks: [1, 2, 3, 4, 5].map(i => ({ id: 'p' + i, artist: 'X' + i, track: 't' })) } });
  assert.equal(await stale.api.discAuto({ now: NOW }), true, 'picks older than 12 h are topped up');
  const saver = load({ last: NOW - 3600e3, saveData: true });
  saver.S.discover = [{ id: 'a' }];
  assert.equal(await saver.api.discAuto({ now: NOW }), false);
  assert.equal(saver.runs.length, 0);
});

test('discAfterChange saves the deck now', async () => {
  const a = load();
  a.S.discover = [1, 2, 3, 4, 5].map(i => ({ id: 'p' + i }));
  a.api.discAfterChange();
  assert.deepEqual(plain(a.kv.get('disc:picks').picks.map(p => p.id)), ['p1', 'p2', 'p3', 'p4', 'p5']);
});

test('discAdd saves the shortened deck', async () => {
  const src = readFileSync(new URL('../web/screens/discover.mjs', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('async function discAdd('), src.indexOf('\n}\n', src.indexOf('async function discAdd(')) + 3);
  let saved = 0;
  const ctx = { S: { discover: [{ id: 'a', track: 'A' }, { id: 'b', track: 'B' }], discAt: 0 }, CFG: { pl: { name: 'PL' } }, LIB: null,
    addTracks: async () => {}, logAction: async () => {}, getLog: async () => [{ at: 'w' }], toast() {}, undoAction: async () => {},
    render() {}, discRemember() {}, discAfterChange: () => { saved++; } };
  const f = vm.runInNewContext('(' + fn.replace('async function discAdd', 'async function') + ')');
  await f(ctx, 'pl');
  assert.equal(saved, 1);
  assert.deepEqual(ctx.S.discover.map(p => p.id), ['b']);
});
