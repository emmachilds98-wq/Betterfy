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

function load({ saved = null, last = null, saveData = false, liked = [], pass = [] } = {}) {
  const ls = new Map(last == null ? [] : [['bf_disc_auto', String(last)]]);
  const kv = new Map(saved ? [['disc:picks', saved]] : []);
  const sb = {
    S: {}, LIB: { playlists: [{ id: 'p1', tracks: [{ id: 'own1' }] }], liked: liked.map(id => ({ id })) },
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
    globalThis.api = { discAuto, discRestore, runDiscovery, discBusy };`, sb);
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
