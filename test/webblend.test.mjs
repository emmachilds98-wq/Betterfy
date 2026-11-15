import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import * as Blend from '../core/intrinsic/blend.mjs';
import * as Bridge from '../core/intrinsic/bridge.mjs';
import { buildSpace, placements } from '../core/intrinsic/space.mjs';
import { buildProfiles, rank } from '../profile.mjs';

/*
 * docs/SMARTER-GENRES-PLAN.md phase 1, on the File screen, run out of the real
 * built page. The plan's gate for this phase: with no stored score, or no
 * similar artists remembered, the File screen is byte-identical to today. And
 * once this account's Score says the blend is ahead, untagged tracks get picks.
 */

const PAGE = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
const between = (from, to, what) => {
  const i = PAGE.indexOf(from), j = PAGE.indexOf(to, i);
  assert.ok(i > 0 && j > i, `${what} not found — rebuild with node build-web.mjs`);
  return PAGE.slice(i, j);
};
const INBOX = between('function artHTML(t', 'function vTidy()', 'vInbox');
const BLEND_SRC = between('/* ======================= tags and the engine, blended on File', '/* ---------- CLAP: names for', 'app/blend.js');

/* A library: two genre playlists of core artists, a newcomer nobody has tagged
 * whose similar artists are the jungle core, and a tagged garage track. */
const FAMS = ['jungle', 'garage'];
function library() {
  const playlists = FAMS.map((fam, fi) => ({ id: `p-${fam}`, name: fam === 'jungle' ? 'Jungle & Breaks' : 'UK Garage',
    tracks: Array.from({ length: 10 }, (_, i) => ({ id: `${fam}-t${i}`, name: `${fam} ${i}`,
      artists: [{ id: `${fam}Core${i % 4}`.padEnd(22, 'x'), name: `${fam} core ${i % 4}` }],
      albumType: 'single', albumTracks: 2, trackNo: 1, released: '2021-01-01', duration_ms: 300000, popularity: 40,
      isrc: `GB${'AB'[fi]}XX21${String(10000 + i).slice(0, 5)}`, added_at: '2025-01-01T00:00:00Z' })) }));
  const newcomer = { id: 'u-new', name: 'Fresh', artists: [{ id: 'freshNew0'.padEnd(22, 'x'), name: 'Fresh Face' }],
    albumType: 'single', albumTracks: 2, trackNo: 1, released: '2021-01-01', duration_ms: 300000, popularity: 40,
    isrc: 'ZZAGG2110000', added_at: '2025-02-01T00:00:00Z' };
  const tagged = { id: 'u-tag', name: 'Known', artists: [{ id: 'garageCore1'.padEnd(22, 'x'), name: 'garage core 1' }],
    albumType: 'single', albumTracks: 2, trackNo: 1, released: '2021-01-01', duration_ms: 300000, popularity: 40,
    isrc: 'GBBXX2110099', added_at: '2025-02-02T00:00:00Z' };
  return { playlists, liked: [newcomer, tagged] };
}
const TAGS_OF = lib => {
  const tags = {};
  for (const p of lib.playlists) for (const t of p.tracks) for (const a of t.artists)
    tags[a.id] = { tags: [[p.id.slice(2), 100], ['electronic', 40]] };
  return tags;
};
const RAW = { ['freshNew0'.padEnd(22, 'x')]: { deezerId: 1, deezerAt: Date.now(), mbidAt: Date.now(),
  deezer: [0, 1, 2, 3].map(i => ({ id: 100 + i, name: `jungle core ${i}` })) } };

function load({ stored = null, raw = null, bridgeOff = false, blend = true, listening = null } = {}) {
  const lib = library(), tags = TAGS_OF(lib);
  const targets = new Set(['p-jungle', 'p-garage']);
  const { profiles, idf } = buildProfiles(lib, tags, targets);
  const store = new Map();
  if (stored) store.set('engine-blend', stored);
  if (raw) store.set('bridge-raw', { at: 1, raw });
  const calls = { engineLoad: 0, gather: [], fired: [], renders: 0 };
  const row = (t, suggest) => ({ id: t.id, title: t.name, artist: t.artists[0].name, album: 'A', released: '2021',
    dur: 300000, art: null, added: '2025-02-01', tags: [], artists: t.artists, suggest });
  const backlog = [
    // Untagged: today's engine has nothing for it.
    row(lib.liked[0], []),
    row(lib.liked[1], rank(lib.liked[1], tags, profiles, idf, { top: 3 }).map(b => ({ ...b, axis: 'genre', via: 'tags' }))),
  ];
  const sandbox = {
    LIB: lib, TAGS: tags, R: { backlog, profiles, idf }, FB: {},
    S: { inboxAt: 0, fileSel: new Set(), fileSelFor: null },
    CFG: { 'p-jungle': { name: 'Jungle & Breaks', target: true, axis: 'genre' },
           'p-garage': { name: 'UK Garage', target: true, axis: 'genre' } },
    view: 'inbox', ENG: { space: null, valRunning: false },
    LS: { getItem: k => (k === 'bf_bridge_off' && bridgeOff ? '1' : null) },
    idb: { get: async k => store.get(k), set: async (k, v) => { store.set(k, v); }, del: async k => { store.delete(k); } },
    BRIDGE_KEY: 'bridge-raw',
    engineTargets: () => [...targets].sort(),
    engineLoad: async () => { calls.engineLoad++; },
    engineSpace: async () => ({ space: buildSpace(lib, { targets }) }),
    fire: p => { calls.fired.push(Promise.resolve(p)); },
    render: () => { calls.renders++; },
    rank, gateTags: t => t, tagGate: () => null,
    fetchListeningRaw: async () => listening ?? { topWindows: [], recentArtists: [] },
    deezerJsonp: async () => { throw new Error('no network in tests'); },
    corsJson: async () => { throw new Error('no network in tests'); },
    BetterfyBlend: Blend, BetterfyBridge: Bridge,
    BetterfyIntrinsic: { placements },
    BetterfyPersist: { ENGINE_STAMP: 'stamp' },
    BetterfyBridgeFetch: { TTL_MS: 60 * 864e5,
      gatherBridge: async (artists, { cache }) => { calls.gather.push([...artists.keys()]); return { raw: { ...cache }, stats: {} }; } },
    matchMedia: () => ({ matches: false }),
    esc: s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    mmss: ms => `${Math.floor(ms / 60000)}:00`, hueOf: () => 200, ICON_PLAY: '<svg></svg>',
    console,
  };
  sandbox.bridgeOn = () => sandbox.LS.getItem('bf_bridge_off') !== '1';
  vm.createContext(sandbox);
  vm.runInContext(INBOX, sandbox);
  if (blend) vm.runInContext(BLEND_SRC, sandbox);
  return Object.assign(sandbox, { calls, store, lib });
}
/** Let everything blendWarm started finish (it may start more as it goes). */
async function settle(app) {
  for (let n = 0; n < 10 && app.calls.fired.length; n++) {
    const all = app.calls.fired.splice(0);
    await Promise.all(all);
  }
}
const STAMP = `${Blend.BLEND_VERSION}/stamp`;
const BEATS = { stamp: STAMP, targets: ['p-garage', 'p-jungle'], weight: 0.6, beatsTags: true, withBridge: true };
/** Every card on the File screen, rendered after the background work has settled. */
async function screens(app) {
  app.vInbox(); await settle(app);
  return app.R.backlog.map((_, i) => { app.S.inboxAt = i; return app.vInbox(); });
}

test('no stored score: File is byte-identical to today, and nothing is fetched', async () => {
  const today = await screens(load({ blend: false, raw: RAW }));
  const app = load({ raw: RAW });
  assert.deepEqual(await screens(app), today);
  assert.equal(app.calls.engineLoad, 0, 'not even the engine bundle');
  assert.equal(app.calls.gather.length, 0, 'and no lookups');
});

test('a stored score the blend did not win: byte-identical, nothing fetched', async () => {
  const today = await screens(load({ blend: false, raw: RAW }));
  for (const stored of [{ ...BEATS, beatsTags: false }, { ...BEATS, withBridge: false },
                        { ...BEATS, targets: ['p-other'] }]) {
    const app = load({ stored, raw: RAW });
    assert.deepEqual(await screens(app), today, JSON.stringify(stored));
    assert.equal(app.calls.engineLoad, 0);
  }
});

test('the blend won, but no similar artists are remembered: byte-identical (lookups start in the background)', async () => {
  const today = await screens(load({ blend: false }));
  const app = load({ stored: BEATS, raw: null });
  assert.deepEqual(await screens(app), today);
  assert.equal(app.calls.gather.length, 1, 'the background lookups did start');
});

test('the blend won but similar artists are switched off: byte-identical', async () => {
  const today = await screens(load({ blend: false, raw: RAW, bridgeOff: true }));
  const app = load({ stored: BEATS, raw: RAW, bridgeOff: true });
  assert.deepEqual(await screens(app), today);
  assert.equal(app.calls.engineLoad, 0);
});

test('a score stamped by another engine version is not used', async () => {
  const today = await screens(load({ blend: false, raw: RAW }));
  assert.deepEqual(await screens(load({ stored: { ...BEATS, stamp: 'old' }, raw: RAW })), today);
});

test('blend on: an untagged track gets picks from the engine and similar artists', async () => {
  const app = load({ stored: BEATS, raw: RAW });
  const [untagged, tagged] = await screens(app);
  assert.match(untagged, /data-selfile="p-jungle"/, 'its similar artists all live in Jungle');
  assert.match(untagged, /where you file this artist and ones like them/);
  assert.doesNotMatch(untagged, /No confident suggestion/);
  // A tagged track still leads with what its tags and filing agree on.
  assert.match(tagged, /class="pick best" data-selfile="p-garage"/);
  assert.match(tagged, /tags, and where you file/);
});

test('blend on: a playlist rejected for the track is never offered', async () => {
  const app = load({ stored: BEATS, raw: RAW });
  await screens(app);
  app.FB['u-new'] = { rejected: ['p-jungle'] };
  app.S.inboxAt = 0;
  assert.doesNotMatch(app.vInbox(), /data-selfile="p-jungle"/);
});

test('blend off hands back the very array it was given', async () => {
  const app = load({ raw: RAW });
  await screens(app);
  const picks = [{ id: 'p-garage', name: 'UK Garage', score: 0.5 }];
  assert.equal(app.blendPicks({ id: 'u-tag' }, picks), picks);
});

test('background lookups ask about the artists you play first', async () => {
  const listening = { topWindows: [{ range: 'short_term', weight: 3, items: ['garage core 1'] }], recentArtists: [] };
  const app = load({ stored: BEATS, raw: null, listening });
  await screens(app);
  assert.equal(app.calls.gather.length, 1);
  assert.equal(app.calls.gather[0][0], 'garageCore1'.padEnd(22, 'x'), 'the played artist before the queue order');
});

test('a new Score run that drops the blend puts File back to today', async () => {
  const today = await screens(load({ blend: false, raw: RAW }));
  const app = load({ stored: BEATS, raw: RAW });
  assert.notDeepEqual(await screens(app), today);
  await app.blendRemember({ blend: null });
  assert.equal(app.store.has('engine-blend'), false);
  assert.deepEqual(await screens(app), today);
});
