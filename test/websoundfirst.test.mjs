import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { fixture, FAMILIES } from './fixtures/engine-library.mjs';
import { makeRecord, N_STYLES, EMB_DIM } from '../core/audio/record.mjs';
import { STYLE_LABELS } from '../core/sources/audio-vocab.mjs';

/*
 * Sound-first filing on the File screen (the owner's call, 2026-11-14), run
 * from the real built page against the real engine bundle. A heard track is
 * offered the playlist it sounds like first, even when its artists' tags say
 * otherwise; an unheard one keeps the tag engine's picks, untouched. The stubs
 * are only the app shell: listening's settings and records, and the space the
 * engine section would have built in its worker.
 */
const PAGE = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
const ENGINE = readFileSync(new URL('../docs/engine.js', import.meta.url), 'utf8');

function slice(from, to, what) {
  const i = PAGE.indexOf(from), j = PAGE.indexOf(to, i);
  assert.ok(i > 0 && j > i, `${what} was not found — rebuild with npm run build:web`);
  return PAGE.slice(i, j);
}
const CARD = slice('function artHTML(t', 'function emptyState(', 'the File screen');
const SOUND_CODE = slice(' * Sound-first filing (the owner', '/* ---------- CLAP: names for', 'the sound-first section');

const TARGETS = FAMILIES.map(f => `p-${f}`);
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5;
}
const familyDir = fam => { const r = rng(1 + FAMILIES.indexOf(fam) * 7919); return Float32Array.from({ length: EMB_DIM }, r); };
// What the sound model hears in each family: its Discogs style.
const STYLE = { tech: 'Electronic---Techno', deep: 'Electronic---Deep House', jungle: 'Electronic---Jungle', ambient: 'Electronic---Ambient' };
function recordFor(id, fam, bpm = null, alt = null) {
  const dir = familyDir(fam), r = rng([...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7));
  const activations = new Float32Array(N_STYLES).fill(0.01);
  activations[STYLE_LABELS.indexOf(STYLE[fam])] = 0.8;
  const dsp = bpm ? { bpm, bpmConf: 0.8, octaveAmbiguous: !!alt, ...(alt ? { bpmAlt: alt } : {}) } : null;
  return makeRecord({ id, isrc: 'GBXXX0000001', activations, embeddings: Float32Array.from(dir, v => v + 0.6 * r()),
                      patches: 1, source: { kind: 'deezer-isrc', deezerId: 1, windows: [[0, 165000]], seconds: 10 },
                      mel: '1.0.0', dsp, at: 1000 });
}

// A liked, unfiled track by two tech artists that sounds like jungle: the case
// matching gets wrong.
const NEW = { id: 'new-1', name: 'Rinse', artists: [{ id: 'tech-a0', name: 'tech artist 0' }, { id: 'tech-a1', name: 'tech artist 1' }],
              albumId: 'x', albumType: 'single', albumTracks: 2, trackNo: 1, released: '2020-03-01',
              duration_ms: 6 * 60000, isrc: 'GBAAA2010001', popularity: 45 };
const card = (id = NEW.id) => ({ id, title: 'Rinse', artist: 'tech artist 0', album: 'x', released: '2020', dur: 360000,
  art: null, added: '2025-01-01', tags: [],
  suggest: [{ id: 'p-tech', name: 'tech', axis: 'genre', score: 0.72 }, { id: 'p-deep', name: 'deep', axis: 'genre', score: 0.31 }] });

function page({ on = true, heardNew = true, fb = {}, nudge = null, bpm = false } = {}) {
  const base = fixture();
  // Tempo per family, so the card has a BPM and something to mix with.
  const BPM = { tech: 128, deep: 122, jungle: 172, ambient: 90 };
  const lib = { ...base, liked: [...base.all, NEW] };
  const records = new Map(base.all.map(t => [t.id, recordFor(t.id, t.id.split('-')[0], bpm ? BPM[t.id.split('-')[0]] : null)]));
  if (heardNew) records.set(NEW.id, recordFor(NEW.id, 'jungle', bpm ? 87 : null, bpm ? 174 : null));
  const ls = new Map(nudge ? [['bf_sound_nudge', nudge]] : []);
  const s = {
    console, atob, btoa,
    LIB: lib, FB: fb, TAGS: {}, isMirrorPlaylist: () => false, view: 'inbox', R: { backlog: [card(), card('tech-t0')] },
    S: { inboxAt: 0, fileSel: new Set(), fileSelFor: null },
    CFG: Object.fromEntries(lib.playlists.map(p => [p.id, { name: p.name, target: TARGETS.includes(p.id), axis: 'genre' }])),
    LS: { getItem: k => ls.get(k) ?? null, setItem: (k, v) => ls.set(k, v) },
    AUDIO: { records },
    matchMedia: () => ({ matches: false }),
    esc: x => String(x ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    mmss: () => '6:00', hueOf: () => 200, ICON_PLAY: '<svg></svg>',
    bandChip: b => `<i data-band="${b}"></i>`, evidenceBadges: e => `<i data-ev="${Object.keys(e).filter(k => e[k] > 0).join(',')}"></i>`,
    renders: 0, builds: 0, pending: [],
  };
  s.fire = p => { s.pending.push(Promise.resolve(p)); };
  s.render = () => { s.renders++; };
  s.store = { get() {}, on() {}, set() { s.render(); }, touch() { s.render(); } };
  s.audioSettings = () => ({ on, wifiOnly: true, scope: 'playing+unfiled' });
  s.engineTargets = () => [...TARGETS].sort();
  s.engineLoad = async () => true;
  s.yieldToPaint = async () => {};
  // What engineSpace() hands back: a space built with the genre-only graph and
  // the heard records, as the worker and withAudioLayer would.
  s.engineSpace = async () => {
    s.builds++;
    const audio = [...s.AUDIO.records.values()].filter(r => !r.miss);
    return { space: s.BetterfyIntrinsic.buildSpace(s.LIB, { targets: s.engineTargets(), audio, genreGraph: true }) };
  };
  vm.createContext(s);
  vm.runInContext(ENGINE, s);
  vm.runInContext(CARD, s);
  vm.runInContext('/*' + SOUND_CODE, s);
  return s;
}
const settle = async s => { while (s.pending.length) await s.pending.shift(); };
const picksOf = html => [...html.matchAll(/data-selfile="([^"]+)"/g)].map(m => m[1]);

test('a heard track is offered the playlist it sounds like first, with the tag engine one key away', async () => {
  const s = page();
  const first = vm.runInContext('vInbox()', s);
  assert.deepEqual(picksOf(first).slice(0, 2), ['p-tech', 'p-deep'], 'before the space is ready: the tag picks, as before');
  assert.match(first, /Learning how your playlists sound/);
  await settle(s);
  const html = vm.runInContext('vInbox()', s);
  const picks = picksOf(html);
  assert.equal(picks[0], 'p-jungle', 'it sounds like jungle, so jungle leads, whatever its artists are tagged');
  assert.ok(picks.includes('p-tech'), 'the tag engine’s pick stays on the card as a second opinion');
  assert.ok(picks.length <= 3);
  assert.match(html, /sounds like this playlist/);
  assert.match(html, /data-best="p-jungle"/, 'Enter and a right swipe file the sound pick');
  assert.match(html, /data-ev="sound/, 'the evidence says it is sound');
  assert.doesNotMatch(html, /sndnote/, 'nothing to explain when the picks are by sound');
  assert.equal(vm.runInContext('filePicks(R.backlog[0])[0].id', s), 'p-jungle', 'the keys read the same picks');
});

test('an unheard track keeps the tag engine’s picks and says why', async () => {
  const s = page({ heardNew: false });
  vm.runInContext('vInbox()', s);
  await settle(s);
  const html = vm.runInContext('vInbox()', s);
  assert.deepEqual(picksOf(html), ['p-tech', 'p-deep']);
  assert.match(html, /Not heard yet\. Picks are from tags until it is\./);
});

test('a track heard after the space was built is placed by sound without a rebuild', async () => {
  const s = page({ heardNew: false });
  vm.runInContext('vInbox()', s);
  await settle(s);
  assert.equal(s.builds, 1);
  s.AUDIO.records.set(NEW.id, recordFor(NEW.id, 'jungle'));
  const html = vm.runInContext('vInbox()', s);
  await settle(s);
  assert.equal(picksOf(html)[0], 'p-jungle');
  assert.equal(s.builds, 1, 'one more heard track is not worth retraining for');
});

test('a sound pick you rejected is not offered again', async () => {
  const s = page({ fb: { [NEW.id]: { rejected: ['p-jungle'] } } });
  vm.runInContext('vInbox()', s);
  await settle(s);
  assert.ok(!picksOf(vm.runInContext('vInbox()', s)).includes('p-jungle'));
});

test('listening off: the tag picks, untouched, and one line offering to listen', async () => {
  const s = page({ on: false, heardNew: false });
  s.AUDIO.records = null;
  const html = vm.runInContext('vInbox()', s);
  await settle(s);
  assert.equal(s.builds, 0, 'nothing is built for someone who has not switched listening on');
  assert.deepEqual(picksOf(html), ['p-tech', 'p-deep']);
  assert.match(html, /These picks come from artist tags\./);
  assert.match(html, /data-soundon/);
  const quiet = page({ on: false, heardNew: false, nudge: 'no' });
  quiet.AUDIO.records = null;
  assert.doesNotMatch(vm.runInContext('vInbox()', quiet), /sndnote/, '"Not now" is remembered');
});

test('a changed set of genre playlists rebuilds the space; renders alone do not', async () => {
  const s = page();
  vm.runInContext('vInbox()', s);
  await settle(s);
  vm.runInContext('vInbox()', s); vm.runInContext('vInbox()', s);
  await settle(s);
  assert.equal(s.builds, 1);
  s.engineTargets = () => TARGETS.filter(id => id !== 'p-ambient').sort();
  vm.runInContext('vInbox()', s);
  await settle(s);
  assert.equal(s.builds, 2);
});

test('a heard track says what it sounds like: genre, sub-genre and tempo, with why and what it mixes with', async () => {
  const s = page({ bpm: true });
  vm.runInContext('vInbox()', s);
  await settle(s);
  const html = vm.runInContext('vInbox()', s);
  assert.match(html, /<div class="sndid">/);
  assert.match(html, /Sounds like<\/span> <b class="sndid-path">Drum &amp; Bass<span class="sep">›<\/span>Jungle<\/b>/,
    'drum & bass, and jungle: the model hears jungle and the tracks it sounds like are in your jungle playlist');
  assert.match(html, /174 BPM/, 'read as 87 or 174, settled by the genre it sounds like');
  assert.match(html, /tracks it sounds most like, mostly in jungle, are Drum &amp; Bass/);
  assert.match(html, /<h4>Sounds like<\/h4><ol><li>jungle track/);
  assert.match(html, /<h4>Mixes with<\/h4><ol><li>jungle track \d+<span class="sub"> — [^<]+<\/span> <span class="sub mono">172 BPM<\/span>/);
  assert.doesNotMatch(html.split('<h4>Mixes with')[1], /(tech|deep|ambient) track/, 'nothing at 128, 122 or 90 mixes with 174');
});

test('no "sounds like" line for an unheard track, or before the sound space is ready', async () => {
  const s = page({ heardNew: false, bpm: true });
  assert.doesNotMatch(vm.runInContext('vInbox()', s), /class="sndid"/, 'not ready yet');
  await settle(s);
  assert.doesNotMatch(vm.runInContext('vInbox()', s), /class="sndid"/, 'ready, but this track has not been heard');
});
