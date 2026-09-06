import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Discovery seeds decide what the whole run is about. "Everything I listen to"
// has to mean listening — an artist played all month outranking one filed years
// ago and never played — while a playlist seed stays that playlist's radio and
// nothing else.

const BUNDLE = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');

function load({ top = {}, recent = [], playlists = [] } = {}) {
  const i = BUNDLE.indexOf('async function listeningSeeds()');
  const j = BUNDLE.indexOf('async function runDiscovery(');
  assert.ok(i > 0 && j > i, 'seed block not found — rebuild with npm run build:web');
  // listeningSeeds() calls listeningWeights(), so the profile.mjs bundle has
  // to come along too.
  const p = BUNDLE.indexOf('/* ---- profile.mjs ---- */');
  const pEnd = BUNDLE.indexOf('/* ============', p);
  assert.ok(p > 0 && pEnd > p, 'profile.mjs block not found — rebuild with npm run build:web');
  const calls = [];
  const sandbox = {
    LIB: { playlists },
    sp: async path => {
      calls.push(path);
      const m = path.match(/time_range=(\w+)/);
      if (m) return { items: (top[m[1]] ?? []).map(name => ({ name })) };
      if (path.startsWith('/me/player/recently-played'))
        return { items: recent.map(name => ({ track: { artists: [{ name }] } })) };
      return null;
    },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(BUNDLE.slice(p, pEnd), sandbox);
  vm.runInContext(BUNDLE.slice(i, j), sandbox);
  const run = expr => vm.runInContext(expr, sandbox);
  return { calls, sandbox, run,
    seeds: async () => run('listeningSeeds()').then(w => run('rankSeeds')(w)) };
}

// Arrays built inside the vm carry that realm's prototype; bring them home
// before comparing.
const own = x => JSON.parse(JSON.stringify(x));

const filed = (name, n) => ({ id: 'p' + name, name, tracks: Array.from({ length: n }, () => ({ artists: [{ name }] })) });

test('all three listening windows and the recent plays are asked for', async () => {
  const app = load({ top: { short_term: ['A'] } });
  await app.seeds();
  assert.ok(app.calls.some(c => c.includes('time_range=short_term')));
  assert.ok(app.calls.some(c => c.includes('time_range=medium_term')));
  assert.ok(app.calls.some(c => c.includes('time_range=long_term')));
  assert.ok(app.calls.some(c => c.startsWith('/me/player/recently-played')));
});

test('what you actually play outranks what merely sits in a playlist', async () => {
  // "Filed Once" has a whole 200-track playlist to itself and is never played;
  // "On Repeat" is this month's top artist and owns four tracks.
  const app = load({ top: { short_term: ['On Repeat'] },
                     playlists: [filed('Filed Once', 200), filed('On Repeat', 4)] });
  const seeds = await app.seeds();
  assert.equal(seeds[0].name, 'On Repeat');
});

test('a long-standing favourite still counts, it just counts for less', async () => {
  const app = load({ top: { short_term: ['New Thing'], long_term: ['Old Faithful'] } });
  const seeds = await app.seeds();
  const names = own(seeds.map(s => s.name));
  assert.ok(names.includes('Old Faithful'), 'the long window is not thrown away');
  assert.ok(names.indexOf('New Thing') < names.indexOf('Old Faithful'), 'but this month leads');
});

test('recent plays count even for an artist in no top list at all', async () => {
  const app = load({ recent: ['Just Heard'] });
  const seeds = await app.seeds();
  assert.deepEqual(own(seeds.map(s => s.name)), ['Just Heard']);
});

test('the library alone still seeds a run, for an account with no listening history', async () => {
  const app = load({ playlists: [filed('Only Filed', 3)] });
  const seeds = await app.seeds();
  assert.deepEqual(own(seeds.map(s => s.name)), ['Only Filed']);
});

test('a listening endpoint that fails does not take the run down with it', async () => {
  const app = load({ playlists: [filed('Still Here', 2)] });
  vm.runInContext('sp = async () => { throw new Error("403 forbidden"); }', app.sandbox);
  const seeds = await app.seeds();
  assert.deepEqual(own(seeds.map(s => s.name)), ['Still Here'], 'falls back to the filed library');
});

test('every seed carries weight, so the fortieth is not worth nothing', async () => {
  const app = load({ top: { short_term: Array.from({ length: 50 }, (_, i) => 'A' + i) } });
  const seeds = await app.seeds();
  assert.equal(seeds.length, 40, 'capped at forty');
  assert.ok(seeds.every(s => s.w >= 0.35 && s.w <= 1), 'weights stay in range');
  assert.ok(seeds[0].w > seeds.at(-1).w, 'and still rank');
});

test('a playlist seed is that playlist and nothing else', () => {
  const app = load({ top: { short_term: ['Not This One'] }, playlists: [filed('Jungle Emma', 5)] });
  const seeds = app.run('rankSeeds')(app.run('playlistSeeds')({
    tracks: [{ artists: [{ name: 'Tim Reaper' }] }, { artists: [{ name: 'Tim Reaper' }] },
             { artists: [{ name: 'dwarde' }] }] }));
  assert.deepEqual(own(seeds.map(s => s.name)), ['Tim Reaper', 'dwarde']);
  assert.ok(seeds[0].w > seeds[1].w, 'the artist you have most of leads its own radio');
});

test('playlist radio asks Spotify nothing about your listening', () => {
  const app = load({ top: { short_term: ['Elsewhere'] } });
  app.run('rankSeeds')(app.run('playlistSeeds')({ tracks: [{ artists: [{ name: 'X' }] }] }));
  assert.deepEqual(app.calls, [], 'a playlist seed is local, and costs no requests');
});
