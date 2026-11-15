import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mixOrder, mixStats, mixable, mixIndex, stepOf, energyTarget, MIN_MIX, ARCS } from '../core/audio/order.mjs';
import { makeRecord, N_STYLES, EMB_DIM } from '../core/audio/record.mjs';

/* ---------- fixtures: heard tracks with chosen sound, tempo and energy ---------- */

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5;
}
const hash = s => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const dirOf = fam => { const r = rng(hash(fam)); return Float32Array.from({ length: EMB_DIM }, r); };

function rec(id, { fam = 'x', bpm = 124, conf = 0.8, alt = null, energy = null, miss = false } = {}) {
  if (miss) return { v: 2, id, miss: 'no-preview', at: 1000 };
  const d = dirOf(fam), r = rng(hash(id));
  const emb = Float32Array.from({ length: EMB_DIM }, (_, i) => d[i] + 0.4 * r());
  const dsp = bpm ? { bpm, bpmConf: conf, octaveAmbiguous: !!alt, ...(alt ? { bpmAlt: alt } : {}),
                      ...(energy !== null ? { energy, loudness: -9 } : {}) } : null;
  return makeRecord({ id, isrc: 'GBXXX0000001', activations: new Float32Array(N_STYLES).fill(0.001), embeddings: emb,
                      patches: 1, source: { kind: 'deezer-isrc', deezerId: 1, windows: [[0, 165000]], seconds: 10 },
                      mel: '1.0.0', dsp, at: 1000 });
}
const track = (id, artist = 'A ' + id) => ({ id, name: 'T ' + id, artists: [{ name: artist }] });

/** A playlist and its index from [id, recOpts, artist?] rows. */
function setup(rows) {
  const records = new Map(rows.map(([id, o]) => [id, rec(id, o)]));
  return { tracks: rows.map(([id, , artist]) => track(id, artist)), index: mixIndex(records) };
}

/* ---------- what can be mixed ---------- */

test('only heard tracks with a sure tempo are placed; the rest come back in input order', () => {
  const { tracks, index } = setup([
    ['a', { bpm: 124 }], ['u', { miss: true }], ['b', { bpm: 126 }], ['q', { bpm: 125, conf: 0.1 }],
    ['n', { bpm: null }], ['c', { bpm: 123 }],
  ]);
  const plus = [...tracks, track('never-heard'), tracks[0]];
  const { heard, rest } = mixable(plus, index);
  assert.deepEqual(heard.map(t => t.id), ['a', 'b', 'c']);
  assert.deepEqual(rest.map(t => t.id), ['u', 'q', 'n', 'never-heard'], 'a repeat of a placed track is dropped');
  const m = mixOrder(plus, index);
  assert.equal(m.order.length, 3);
  assert.deepEqual(m.rest.map(t => t.id), ['u', 'q', 'n', 'never-heard']);
  assert.equal(m.steps.length, 2);
});

test('nothing heard: an empty mix and every track handed back', () => {
  const tracks = [track('x'), track('y')];
  const m = mixOrder(tracks, new Map());
  assert.deepEqual(m.order, []);
  assert.deepEqual(m.rest, tracks);
  assert.equal(mixStats(tracks, new Map()).share, null);
  assert.ok(MIN_MIX >= 2 && ARCS.includes('flat'));
});

/* ---------- the mix itself ---------- */

test('every heard track is placed exactly once', () => {
  const rows = Array.from({ length: 120 }, (_, i) => [`t${i}`, { bpm: [122, 128, 140, 174, 87][i % 5] + (i % 3), fam: 'f' + (i % 4) }]);
  const { tracks, index } = setup(rows);
  const { order } = mixOrder(tracks, index, { seed: 7 });
  assert.equal(order.length, 120);
  assert.equal(new Set(order.map(t => t.id)).size, 120);
});

test('the same seed gives the same mix; another seed may start elsewhere', () => {
  const rows = Array.from({ length: 40 }, (_, i) => [`t${i}`, { bpm: 120 + (i % 10), fam: 'f' + (i % 3) }]);
  const { tracks, index } = setup(rows);
  const a = mixOrder(tracks, index, { seed: 3 }).order.map(t => t.id);
  const b = mixOrder(tracks, index, { seed: 3 }).order.map(t => t.id);
  assert.deepEqual(a, b);
  const starts = new Set([1, 2, 3, 4, 5, 6, 7, 8].map(seed => mixOrder(tracks, index, { seed }).order[0].id));
  assert.ok(starts.size > 1, '"Shuffle again" must be able to give a different mix');
});

test('tempo groups are kept together: far more beatmatchable moves than a shuffle', () => {
  // Three scenes at three tempos, dealt out round-robin so input order is the worst case.
  const rows = [];
  for (let i = 0; i < 30; i++) {
    rows.push([`h${i}`, { bpm: 122 + (i % 5), fam: 'house' }]);
    rows.push([`d${i}`, { bpm: 172 + (i % 4), fam: 'dnb' }]);
    rows.push([`g${i}`, { bpm: 132 + (i % 5), fam: 'garage' }]);
  }
  const { tracks, index } = setup(rows);
  const before = mixStats(tracks, index);
  const { order } = mixOrder(tracks, index, { seed: 1 });
  const after = mixStats(order, index);
  assert.ok(before.share < 0.1, `input order is unmixable (${before.share})`);
  assert.ok(after.share >= 0.95, `the mix should be nearly all beatmatchable, got ${after.share}`);
  assert.ok(after.sim > before.sim, 'and neighbours sound more alike');
});

test('half and double time count as a mix, so 87 and 174 sit together', () => {
  const rows = [];
  for (let i = 0; i < 6; i++) rows.push([`half${i}`, { bpm: 86 + (i % 2), fam: 'dnb' }]);
  for (let i = 0; i < 6; i++) rows.push([`full${i}`, { bpm: 172 + (i % 3), fam: 'dnb' }]);
  for (let i = 0; i < 6; i++) rows.push([`house${i}`, { bpm: 124, fam: 'house' }]);
  const { tracks, index } = setup(rows);
  const { order, steps } = mixOrder(tracks, index, { seed: 2 });
  const isDnb = t => !t.id.startsWith('house');
  // The DnB tracks (at either octave) form one run, broken by house at most once.
  let changes = 0;
  for (let i = 1; i < order.length; i++) if (isDnb(order[i]) !== isDnb(order[i - 1])) changes++;
  assert.equal(changes, 1, order.map(t => t.id).join(' '));
  assert.equal(steps.filter(s => s.rel === null).length, 1, 'the only unmixable move is the change of scene');
  assert.ok(['half', 'double'].includes(stepOf('half0', 'full0', index).rel), '86 → 172 is a half/double-time mix');
});

test('within one tempo, it moves between tracks that sound alike', () => {
  const rows = [];
  for (let i = 0; i < 10; i++) { rows.push([`a${i}`, { bpm: 124, fam: 'A' }]); rows.push([`b${i}`, { bpm: 124, fam: 'B' }]); }
  const { tracks, index } = setup(rows);
  const { order } = mixOrder(tracks, index, { seed: 5 });
  let changes = 0;
  for (let i = 1; i < order.length; i++) if (order[i].id[0] !== order[i - 1].id[0]) changes++;
  assert.ok(changes <= 2, `two sounds should be two runs, got ${changes} changes`);
});

test('the same artist does not play twice running when there is a choice', () => {
  const rows = [];
  for (let i = 0; i < 24; i++) rows.push([`t${i}`, { bpm: 124, fam: 'same' }, 'Artist ' + (i % 4)]);
  const { tracks, index } = setup(rows);
  const { order } = mixOrder(tracks, index, { seed: 9 });
  for (let i = 1; i < order.length; i++)
    assert.notEqual(order[i].artists[0].name, order[i - 1].artists[0].name, `back to back at ${i}`);
});

/* ---------- energy arcs ---------- */

test('energy targets: a build rises, a peak rises then falls, flat has none', () => {
  assert.equal(energyTarget('flat', 0.5), null);
  assert.ok(energyTarget('build', 0) < energyTarget('build', 0.5) && energyTarget('build', 0.5) < energyTarget('build', 1));
  assert.ok(energyTarget('peak', 0.7) > energyTarget('peak', 0.1) && energyTarget('peak', 0.7) > energyTarget('peak', 1));
});

const corr = (xs) => {
  const n = xs.length, ys = xs.map((_, i) => i), mx = xs.reduce((a, b) => a + b) / n, my = (n - 1) / 2;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  return sxy / Math.sqrt(sxx * syy);
};

test('a building mix starts calm and ends at its most energetic', () => {
  const rows = Array.from({ length: 40 }, (_, i) => [`t${i}`, { bpm: 124 + (i % 3), fam: 'one', energy: ((i * 37) % 40) / 40 }]);
  const { tracks, index } = setup(rows);
  const flat = mixStats(mixOrder(tracks, index, { arc: 'flat', seed: 4 }).order, index);
  const build = mixStats(mixOrder(tracks, index, { arc: 'build', seed: 4 }).order, index);
  assert.ok(corr(build.energy) > 0.8, `energy should rise through a build: ${build.energy.join(' ')}`);
  assert.ok(corr(build.energy) > corr(flat.energy));
  assert.ok(build.share >= 0.95, 'and it is still beatmatchable throughout');
});

test('a peak mix is highest about two-thirds in, and calmer at both ends', () => {
  const rows = Array.from({ length: 50 }, (_, i) => [`t${i}`, { bpm: 126, fam: 'one', energy: ((i * 23) % 50) / 50 }]);
  const { tracks, index } = setup(rows);
  const { energy } = mixStats(mixOrder(tracks, index, { arc: 'peak', seed: 1 }).order, index);
  const top = energy.indexOf(Math.max(...energy)) / (energy.length - 1);
  assert.ok(top > 0.45 && top < 0.9, `peak at ${top}: ${energy.join(' ')}`);
  assert.ok(energy[0] < 0.5 && energy.at(-1) < Math.max(...energy) - 0.2);
});

test('an arc with no energy readings falls back to a flat mix rather than failing', () => {
  const rows = Array.from({ length: 12 }, (_, i) => [`t${i}`, { bpm: 124 }]);
  const { tracks, index } = setup(rows);
  const m = mixOrder(tracks, index, { arc: 'peak', seed: 1 });
  assert.equal(m.order.length, 12);
  assert.deepEqual(mixStats(m.order, index).energy, []);
});

/* ---------- stats ---------- */

test('stats count only moves between heard tracks, and report pitch change and tempo range', () => {
  const { tracks, index } = setup([['a', { bpm: 124 }], ['b', { bpm: 126 }], ['c', { bpm: 174 }]]);
  const s = mixStats([tracks[0], tracks[1], track('gap'), tracks[2]], index);
  assert.equal(s.moves, 1, 'a → b only: the unheard track breaks the run');
  assert.equal(s.mixed, 1);
  assert.ok(Math.abs(s.shift - 2 / 124) < 1e-3);
  assert.deepEqual(s.bpm, [124, 174]);
});

/* ---------- scale ---------- */

test('a library-sized mix finishes in reasonable time', () => {
  const records = new Map();
  const tracks = [];
  for (let i = 0; i < 3000; i++) {
    const id = 't' + i;
    records.set(id, rec(id, { bpm: 80 + (i * 7919) % 100, fam: 'f' + (i % 12), energy: (i % 17) / 17 }));
    tracks.push(track(id, 'Artist ' + (i % 700)));
  }
  const index = mixIndex(records);
  const t0 = Date.now();
  const { order } = mixOrder(tracks, index, { arc: 'peak' });
  const ms = Date.now() - t0;
  assert.equal(order.length, 3000);
  assert.ok(ms < 3000, `mixOrder took ${ms}ms for 3,000 heard tracks: the candidate window is not bounding the work`);
});

/* ---------- the Shuffle screen, from the real built page and engine bundle ---------- */

import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const PAGE = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
const ENGINE = readFileSync(new URL('../docs/engine.js', import.meta.url), 'utf8');

function shufflePage({ records = null, mode = undefined, energyShown = false, engine = true } = {}) {
  const i = PAGE.indexOf('const rnd = a =>'), j = PAGE.indexOf('/* ---------- discovery: new by construction');
  assert.ok(i > 0 && j > i, 'Shuffle block not found — rebuild with npm run build:web');
  const tracks = Array.from({ length: 30 }, (_, k) => track('s' + k, 'Artist ' + (k % 9)));
  const store = new Map(mode === undefined ? [] : [['bf_shuf_mode', mode]]);
  const sandbox = {
    console, Math, Promise, Date, Float32Array, Int32Array, Map, Set, atob, btoa,
    LIB: { playlists: [{ id: 'pl', name: 'Rollers', tracks }], liked: [], user: { id: 'me' } },
    S: {}, AUDIO: { records }, view: 'shuffle', loads: 0,
    LS: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
    dedupe: x => x, isMirrorPlaylist: () => false, labelsShownNow: () => ({ energy: energyShown }),
    render: () => {}, fire: p => p,
    esc: s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    engineLoad: () => { sandbox.loads++; return new Promise(() => {}); },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  if (engine) vm.runInContext(ENGINE, sandbox);
  vm.runInContext(PAGE.slice(i, j).replace('const ALL_SONGS_NAME', 'var ALL_SONGS_NAME')
, sandbox);
  // The shared empty state (UI-1), which the mix's loading and error boxes use.
  const e = PAGE.indexOf('function emptyState('), f = PAGE.indexOf('/* ---------- Tidy by sound', e);
  vm.runInContext(PAGE.slice(e, f), sandbox);
  return sandbox;
}
const heardRecords = (n, o = {}) => new Map(Array.from({ length: n }, (_, k) =>
  ['s' + k, rec('s' + k, { bpm: [124, 172, 132][k % 3] + (k % 2), fam: ['h', 'd', 'g'][k % 3], energy: (k % 10) / 10, ...o })]));

test('with nothing heard the Shuffle screen offers no DJ order and draws as before', () => {
  for (const records of [null, new Map(), heardRecords(5)]) {
    const app = shufflePage({ records, mode: 'peak' });
    const html = vm.runInContext('vShuffle()', app);
    assert.doesNotMatch(html, /shufMode|mx-|DJ order/, 'no control and no mix until enough is heard');
    assert.match(html, /Spotify's shuffle/);
    assert.equal(vm.runInContext('S.shufOrder.length', app), 30, 'the spaced shuffle is what gets written');
    assert.equal(vm.runInContext('S.shufOrderMode', app), null);
  }
});

test('once enough is heard the order picker appears, still on the spaced shuffle by default', () => {
  const app = shufflePage({ records: heardRecords(12) });
  const html = vm.runInContext('vShuffle()', app);
  assert.match(html, /<select id="shufMode"[^>]*><option value="" selected>Spaced shuffle<\/option>/);
  assert.match(html, /Spotify's shuffle/);
  assert.doesNotMatch(html, /mx-order/);
});

test('DJ order: heard tracks first in a beatmatched mix, the unheard after them, and stats against a shuffle', () => {
  const app = shufflePage({ records: heardRecords(18), mode: 'flat' });
  const html = vm.runInContext('vShuffle()', app);
  assert.match(html, /<option value="flat" selected>DJ order<\/option>/);
  assert.match(html, /class="order mx-order"/);
  assert.match(html, /18 heard tracks in the mix · 124–173 BPM · 12 not heard yet follow in the spaced shuffle/);
  assert.match(html, /<span class="mx-bpm"[^>]*>1\d\d<\/span>/);
  const order = vm.runInContext('S.shufOrder.map(t => t.id)', app);
  assert.equal(order.length, 30);
  assert.equal(new Set(order).size, 30);
  assert.ok(order.slice(0, 18).every(id => +id.slice(1) < 18), 'heard first');
  assert.equal(vm.runInContext('S.shufOrderMode', app), 'flat', 'so the written playlist is the DJ one');
  const share = +html.match(/<div class="good">[\s\S]*?<div class="n">(\d+)%/)[1];
  assert.ok(share >= 85, `three tempo groups should mix almost throughout, got ${share}%`);
  assert.doesNotMatch(html, /mx-arc/, 'energy stays hidden until its labels are checked');
});

test('the energy arc is drawn once energy labels are shown, and a redraw keeps the same mix', () => {
  const app = shufflePage({ records: heardRecords(20), mode: 'peak', energyShown: true });
  const a = vm.runInContext('vShuffle()', app);
  assert.match(a, /class="mx-arc"/);
  const first = vm.runInContext('S.shufOrder.map(t => t.id).join()', app);
  vm.runInContext('vShuffle()', app);
  assert.equal(vm.runInContext('S.shufOrder.map(t => t.id).join()', app), first, 'an unrelated redraw must not re-roll it');
  vm.runInContext('S.shufCache = null; vShuffle()', app);
  assert.equal(vm.runInContext('S.shufOrder.length', app), 30, '"Shuffle again" re-rolls the mix with the shuffle');
});

test('before engine.js has loaded the mix says it is working, loads it once, and writes nothing yet', () => {
  const app = shufflePage({ records: heardRecords(12), mode: 'build', engine: false });
  const html = vm.runInContext('vShuffle()', app);
  assert.match(html, /Working out the mix/);
  assert.match(html, /id="shufApply" disabled/);
  assert.equal(vm.runInContext('S.shufOrder.length', app), 0);
  assert.equal(vm.runInContext('loads', app), 1);
});
