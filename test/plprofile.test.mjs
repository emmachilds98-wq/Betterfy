import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createProfiler, playlistProfiles, separation, splitName, MIN_HEARD } from '../core/audio/plprofile.mjs';
import { audioIndex } from '../core/intrinsic/audio.mjs';
import { identify } from '../core/audio/identify.mjs';
import { genreMembership, filedNeighbours } from '../core/audio/match.mjs';
import { makeRecord, N_STYLES, EMB_DIM } from '../core/audio/record.mjs';
import { STYLE_LABELS } from '../core/sources/audio-vocab.mjs';

/* ---------- fixtures: records with chosen styles, sound and tempo (as soundid.test.mjs) ---------- */

const S = l => { const i = STYLE_LABELS.indexOf(`Electronic---${l}`); assert.ok(i >= 0, l); return i; };
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5;
}
const hash = s => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const dirOf = fam => { const r = rng(hash(fam)); return Float32Array.from({ length: EMB_DIM }, r); };

function rec(id, { fam = 'x', styles = [], bpm = null, conf = 0.8 } = {}) {
  const act = new Float32Array(N_STYLES).fill(0.001);
  for (const [l, v] of styles) act[S(l)] = v;
  const d = dirOf(fam), r = rng(hash(id));
  const emb = new Float32Array(EMB_DIM);
  for (let i = 0; i < EMB_DIM; i++) emb[i] = d[i] + 0.5 * r();
  const dsp = bpm ? { bpm, bpmConf: conf, octaveAmbiguous: false } : null;
  return makeRecord({ id, isrc: 'GBXXX0000001', activations: act, embeddings: emb, patches: 1,
                      source: { kind: 'deezer-isrc', deezerId: 1, windows: [[0, 165000]], seconds: 10 },
                      mel: '1.0.0', dsp, at: 1000 });
}

const HOUSE = { fam: 'house', styles: [['House', 0.6], ['Deep House', 0.3]], bpm: 124 };
const JUNGLE = { fam: 'jungle', styles: [['Jungle', 0.6], ['Drum n Bass', 0.3]], bpm: 172 };
const TECHNO = { fam: 'techno', styles: [['Techno', 0.7]], bpm: 132 };
// Jungle the sound model can't call: the library has to.
const VAGUE_JUNGLE = { fam: 'jungle', styles: [['House', 0.3], ['Jungle', 0.3]], bpm: 172 };

const records = new Map();
const tracks = (prefix, n, kind) => Array.from({ length: n }, (_, i) => {
  const id = `${prefix}${i}`;
  if (kind) records.set(id, rec(id, kind));
  return { id, name: id, artists: [{ id: 'a-' + id }] };
});

const LIB = { playlists: [
  { id: 'house', name: 'House', tracks: [...tracks('h', 12, HOUSE), ...tracks('hj', 8, VAGUE_JUNGLE)] },
  { id: 'jungle', name: 'Jungle', tracks: tracks('j', 12, JUNGLE) },
  { id: 'techno', name: 'Techno', tracks: [...tracks('t', 12, TECHNO), ...tracks('tu', 6, null)] },
  { id: 'both', name: 'Jungle & House', tracks: [...tracks('bh', 6, HOUSE), ...tracks('bj', 6, JUNGLE)] },
  { id: 'few', name: 'Few', tracks: [...tracks('f', 2, HOUSE), ...tracks('fu', 10, null)] },
  { id: 'none', name: 'Nothing heard', tracks: tracks('n', 5, null) },
] };
const TARGETS = ['house', 'jungle', 'techno', 'both'];

const profiles = playlistProfiles(LIB, records, { targets: TARGETS });

/* ---------- the profile ---------- */

test('a playlist’s profile: heard of members, genre mix and BPM range', () => {
  const t = profiles.get('techno');
  assert.equal(t.heard, 12);
  assert.equal(t.members, 18);
  assert.equal(t.pending, 0);
  assert.equal(t.genres[0].slug, 'techno');
  assert.equal(t.genres[0].share, 1);
  assert.deepEqual(t.bpm, [132, 132]);
  assert.equal(t.split, null, 'one genre is not two');
});

test('nothing heard, nothing said; too few heard, no mix or range', () => {
  const none = profiles.get('none');
  assert.equal(none.heard, 0);
  assert.deepEqual(none.genres, []);
  assert.equal(none.bpm, null);
  assert.equal(none.split, null);
  const few = profiles.get('few');
  assert.equal(few.heard, 2);
  assert.ok(few.heard < MIN_HEARD);
  assert.deepEqual(few.genres, []);
  assert.equal(few.bpm, null);
});

test('no records at all: every playlist has an empty profile', () => {
  const out = playlistProfiles(LIB, new Map(), { targets: TARGETS });
  for (const p of out.values()) { assert.equal(p.heard, 0); assert.equal(p.split, null); assert.deepEqual(p.mix, []); }
});

/* ---------- two genres in one playlist ---------- */

test('a House playlist that is a third jungle by sound is flagged, and the jungle half is what moves', () => {
  const h = profiles.get('house');
  assert.ok(h.split, JSON.stringify(h.genres));
  assert.equal(h.split.keep.slug, 'house', 'the half the name owns stays');
  assert.equal(h.split.move.slug, 'drum-and-bass');
  assert.equal(h.split.move.n, 8);
  assert.deepEqual(h.split.move.ids.sort(), Array.from({ length: 8 }, (_, i) => `hj${i}`).sort());
  assert.ok(h.split.sep > 0 && h.split.clean >= 0.75);
  assert.equal(splitName('House', h.split), 'House — Drum & Bass');
});

test('a playlist does not vouch for its own misfiles: sound-alikes in it are left out of its members’ library votes', () => {
  // Jungle the model can't call (no tempo, half house half jungle styles) filed
  // in House. Read naively, its sound-alikes are mostly the other misfiles, all
  // filed as "house". With House left out, the few in Jungle decide.
  const recs = new Map();
  const mk = (p, n, kind) => Array.from({ length: n }, (_, i) => { recs.set(p + i, rec(p + i, kind)); return { id: p + i }; });
  const vague = { fam: 'jungle', styles: [['House', 0.3], ['Jungle', 0.3]] };
  const lib = { playlists: [
    { id: 'h', name: 'House', tracks: [...mk('vh', 10, { ...HOUSE, bpm: null }), ...mk('vj', 8, vague)] },
    { id: 'j', name: 'Jungle', tracks: mk('vjj', 4, { ...JUNGLE, bpm: null }) },
  ] };
  const index = audioIndex(recs), memb = genreMembership(lib, { targets: ['h', 'j'] });
  const naive = identify(recs.get('vj0'), { neighbours: filedNeighbours('vj0', index, memb, { k: 12 }) });
  assert.equal(naive.genre.slug, 'house', 'the self-vouching reading this avoids');
  const p = playlistProfiles(lib, recs, { targets: ['h', 'j'] }).get('h');
  assert.equal(p.genres.find(g => g.slug === 'drum-and-bass')?.n, 8, JSON.stringify(p.genres));
  assert.equal(p.split?.move.slug, 'drum-and-bass');
});

test('a playlist named for both genres is a mix on purpose, not a split', () => {
  const b = profiles.get('both');
  assert.equal(b.genres.length, 2);
  assert.equal(b.split, null);
});

test('two genre names but one sound: not flagged', () => {
  // Same embedding family, styles half house half techno: the names differ,
  // the sound doesn't, so there's nothing to pull apart.
  const recs = new Map(records);
  const one = [];
  for (let i = 0; i < 6; i++) { recs.set(`sa${i}`, rec(`sa${i}`, { fam: 'same', styles: [['House', 0.7]], bpm: 126 })); one.push({ id: `sa${i}` }); }
  for (let i = 0; i < 6; i++) { recs.set(`sb${i}`, rec(`sb${i}`, { fam: 'same', styles: [['Techno', 0.7]], bpm: 128 })); one.push({ id: `sb${i}` }); }
  const lib = { playlists: [{ id: 'mixed', name: 'Warehouse', tracks: one }] };
  const p = playlistProfiles(lib, recs, { targets: [] }).get('mixed');
  assert.equal(p.genres.length, 2, JSON.stringify(p.genres));
  assert.equal(p.split, null);
});

test('separation: apart groups score high and clean, one group split in two scores about nothing', () => {
  const index = audioIndex(records);
  const h = Array.from({ length: 12 }, (_, i) => `h${i}`), j = Array.from({ length: 12 }, (_, i) => `j${i}`);
  const apart = separation(h, j, index);
  assert.ok(apart.sep > 0.1 && apart.clean === 1, JSON.stringify(apart));
  const same = separation(h.slice(0, 6), h.slice(6), index);
  assert.ok(same.sep < 0.04, JSON.stringify(same));
  assert.equal(separation([], j, index), null);
});

/* ---------- a few at a time ---------- */

test('worked out a few tracks at a time, the answer is the same; unfinished playlists are never flagged', () => {
  const pr = createProfiler(LIB, records, { targets: TARGETS });
  assert.ok(pr.total > 0);
  pr.step(5);
  const part = pr.result().get('house');
  assert.ok(part.pending > 0);
  assert.equal(part.split, null, 'no split on half the evidence');
  let steps = 1;
  while (!pr.step(5)) steps++;
  assert.ok(steps > 3);
  assert.equal(pr.done, pr.total);
  assert.deepEqual(JSON.stringify([...pr.result()]), JSON.stringify([...profiles]));
});

test('`playlists` limits which get a profile; tags count for a little', () => {
  const out = playlistProfiles(LIB, records, { targets: TARGETS, playlists: ['techno'], tagsOf: () => ['techno'] });
  assert.deepEqual([...out.keys()], ['techno']);
  assert.equal(out.get('techno').genres[0].slug, 'techno');
});

/* ---------- the Playlists screen (the built page's vLists slice, in a sandbox) ---------- */

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as PlProfile from '../core/audio/plprofile.mjs';
import * as LISTS from '../web/screens/lists.mjs';

const BUNDLE = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
const SLICE = (() => {
  const i = BUNDLE.indexOf('/* ---------- Playlists: mixes, sound profiles, splits'), j = BUNDLE.indexOf('function tagCoverage()', i);
  assert.ok(i > 0 && j > i, 'Playlists block not found — rebuild with node build-web.mjs');
  return BUNDLE.slice(i, j);
})();

function page({ recs = records, withEngine = true } = {}) {
  const CFG = Object.fromEntries(LIB.playlists.map(p => [p.id, { axis: p.id === 'none' ? 'mood' : 'genre',
    target: TARGETS.includes(p.id), tracks: p.tracks.length, why: 'from the name' }]));
  const calls = [], renders = [];
  const sb = {
    LIB: { ...LIB, captured_at: 't0', liked: [] }, CFG, TAGS: {}, R: { drift: [] }, view: 'lists',
    NO_SIGNAL: 'none', MIN_FOR_TARGET: 12,
    facetMix: () => ({ tracks: 1, genre: 1 }), isMirrorPlaylist: () => false,
    tagCoverage: () => ({ total: 1, have: 1, missing: 0, pct: 100 }),
    esc: s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]),
    LS: { getItem: () => '' },
    AUDIO: { records: recs, labels: null },
    BetterfyAudio: { profileVM: p => ({ heard: 1, members: p.tracks.length }) },
    BetterfyPlProfile: withEngine ? PlProfile : undefined,
    engineTargets: () => TARGETS, engineLoad: async () => {},
    profileRow: v => (v ? `<div class="prof">${v.bpm ? v.bpm.join('-') : ''}|${(v.styles ?? []).map(s => s[0]).join(',')}</div>` : ''),
    audioPanelHTML: () => '', labelCheckHTML: () => '',
    fire: p => Promise.resolve(p).catch(() => {}),
    render: () => renders.push(1), store: { get() {}, on() {}, set: () => renders.push(1), touch: () => renders.push(1) }, toast: m => calls.push(['toast', m]),
    sp: async (path, o) => { calls.push(['sp', path, JSON.parse(o.body)]); return { id: 'NEW' }; },
    addTracks: async (id, ids) => calls.push(['add', id, ids]),
    setTimeout, Date,
  };
  vm.createContext(sb);
  sb.jobs = vm.runInContext(SLICE + ';({ playlistMixes, listsSplits, listsSplitMake, LPROF, LISTS_SOUND })', sb);
  Object.assign(sb, { LPROF: sb.jobs.LPROF, listsSplitMake: sb.jobs.listsSplitMake, vLists: () => LISTS.view({ ...sb, ...sb.jobs }) });
  return { sb, calls, renders };
}
const settle = async sb => { for (let i = 0; i < 200 && (sb.LPROF.busy || !sb.LPROF.out); i++) await new Promise(r => setTimeout(r, 0)); };

test('Playlists: once worked out, the profile shows the genre mix and BPM range, and House offers its split', async () => {
  const { sb, renders } = page();
  const first = sb.vLists();
  assert.ok(!first.includes('Two genres by sound'), 'nothing claimed before it is worked out');
  await settle(sb);
  assert.ok(renders.length >= 1, 'the screen redraws when it is done');
  const html = sb.vLists();
  assert.match(html, /<h2>Two genres by sound<\/h2>/);
  assert.match(html, /data-lsplit="house">Make “House — Drum &amp; Bass”/);
  assert.match(html, /<b>12<\/b> sound like House · <b>8<\/b> sound like Drum &amp; Bass/);
  assert.ok(!html.includes('data-lsplit="both"') && !html.includes('data-lsplit="techno"'));
  assert.match(html, /<div class="prof">132-132\|Techno<\/div>/);
});

test('Playlists: the split makes a private playlist of the half that moves, and takes nothing out', async () => {
  const { sb, calls } = page();
  sb.vLists(); await settle(sb);
  await sb.listsSplitMake('house');
  const [create, add] = calls;
  assert.deepEqual(create, ['sp', '/me/playlists', { name: 'House — Drum & Bass', public: false }]);
  assert.equal(add[1], 'NEW');
  assert.deepEqual([...add[2]].sort(), Array.from({ length: 8 }, (_, i) => `hj${i}`).sort());
  assert.ok(!calls.some(c => c[0] === 'sp' && /tracks/.test(c[1]) ), 'nothing removed');
  assert.match(sb.vLists(), /<span class="tag ok">Made<\/span>/);
  await sb.listsSplitMake('house');
  assert.equal(calls.filter(c => c[0] === 'sp').length, 1, 'only once');
});

test('Playlists without records: no sound at all; before the engine is loaded: the plain profile, no split', () => {
  const off = page({ recs: null }).sb.vLists();
  assert.ok(!off.includes('Two genres') && !off.includes('lsplit') && !off.includes('axprof'));
  const loading = page({ withEngine: false }).sb.vLists();
  assert.ok(!loading.includes('Two genres'));
  assert.match(loading, /<div class="prof">\|<\/div>/, 'the profile as it was, nothing added');
});
