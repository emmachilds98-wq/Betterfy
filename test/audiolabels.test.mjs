import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
  LABEL_TYPES, AGREE_MIN, REVIEW_MIN, REVIEW_SIZE, LABELS_UI_KEY, readingsOf, checksFor, withVerdict, agreement,
  labelsShown, labelSoundVM, mergeSoundVM, withProfileEnergy, reviewSample, reviewVM, reviewHTML, seenOf, moodsOf, voiceOf,
} from '../web/audio/labels-view.mjs';
import { dspSoundVM } from '../web/audio/dsp-view.mjs';
import { soundChip, profileRow } from '../web/ui/sound.mjs';

// Mood, voice and energy: hidden until checked on the listener's own previews.

const BUNDLE = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
const between = (from, to) => {
  const i = BUNDLE.indexOf(from), j = BUNDLE.indexOf(to, i);
  assert.ok(i > 0 && j > i, `${from} not found — rebuild with node build-web.mjs`);
  return BUNDLE.slice(i, j);
};
const memLS = (init = {}) => { const m = new Map(Object.entries(init)); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), m }; };

/** A stored-record shape with only what this file reads. */
const rec = (id, { moods = [['dark', 0.6], ['film', 0.5], ['energetic', 0.4], ['happy', 0.3], ['calm', 0.2]], voice = 0.8, energy = 0.62, dsp = true } = {}) =>
  ({ v: 1, id, heads: moods || voice != null ? { v: '1.0.0', ...(moods ? { moods } : {}), ...(voice != null ? { voice } : {}) } : null,
     dsp: dsp ? { bpm: 174, bpmConf: 0.9, key: 'A minor', camelot: '8A', keyConf: 0.8, ...(energy != null ? { energy } : {}) } : null });
const ALL_ON = { mood: true, voice: true, energy: true }, ALL_OFF = { mood: false, voice: false, energy: false };

/* ---------------------------------------------------- byte-identical without records (written first) */

test('Sources with no audio is byte-identical to main before this change', () => {
  const CODE = between('const AXES = ', 'function tagCoverage()');
  const LIB = { user: { id: 'u1' }, playlists: [{ id: 'P1', name: 'Jungle', tracks: [{ id: 'a' }] }], liked: [] };
  const sb = { LIB, CFG: { P1: { axis: 'genre', target: true, tracks: 1, why: 'x' } }, TAGS: {}, R: { drift: [] },
    NO_SIGNAL: 'n', MIN_FOR_TARGET: 12, facetMix: () => ({ tracks: 1, genre: 0.9, mood: 0.1 }), isMirrorPlaylist: () => false,
    tagCoverage: () => ({ total: 10, have: 9, missing: 1, pct: 90 }), esc: s => String(s ?? ''), LS: { getItem: () => '' },
    AUDIO: { records: null, labels: null }, profileRow: () => '', audioPanelHTML: () => '<div id="audioPanel">panel</div>' };
  vm.createContext(sb);
  vm.runInContext(between('let LABELCHECKS = null;', '/** The heard tracks for the engine') + CODE + ';globalThis.out = vSources();', sb);
  assert.equal(sb.out, readFileSync(new URL('./fixtures/labels/sources-no-audio.html', import.meta.url), 'utf8'));
});

test('with the flag off, every adapter returns exactly what it did before', () => {
  for (const r of [null, undefined, { id: 'x', miss: 'NO_ISRC' }, rec('a'), rec('b', { moods: null, voice: null, dsp: false })]) {
    assert.equal(labelSoundVM(r, ALL_OFF), null);
    assert.equal(labelSoundVM(r, null), null);
    const d = dspSoundVM(r, { show: true });
    assert.equal(mergeSoundVM(d, labelSoundVM(r, ALL_OFF)), d);       // the same object, not a copy
  }
  const prof = { heard: 3, members: 4 };
  assert.equal(withProfileEnergy(prof, { tracks: [{ id: 'a' }] }, new Map([['a', rec('a')]]), ALL_OFF), prof);
  assert.equal(withProfileEnergy(null, null, null, ALL_ON), null);
  assert.equal(soundChip({ bpm: 174 }), soundChip({ bpm: 174, moods: [] }));
});

test('the flag is off by default: no verdicts, no override', () => {
  assert.deepEqual(labelsShown({}, memLS()), ALL_OFF);
  assert.deepEqual(labelsShown(undefined, null), ALL_OFF);
  assert.deepEqual(labelsShown({}, { getItem() { throw new Error('private mode'); } }), ALL_OFF);
});

test('the review card draws nothing with no records, no labels, or no account', () => {
  assert.deepEqual(reviewSample({ playlists: [] }, new Map()), []);
  assert.deepEqual(reviewSample({ playlists: [{ id: 'p', tracks: [{ id: 'a' }] }] }, null), []);
  const bare = new Map([['a', rec('a', { moods: null, voice: null, dsp: false })]]);
  const s = reviewSample({ playlists: [{ id: 'p', name: 'P', tracks: [{ id: 'a' }] }] }, bare);
  assert.deepEqual(s, []);
  assert.equal(reviewVM(s, bare, {}), null);
  assert.equal(reviewHTML(null), '');

  // The page's own helper, lifted from the bundle.
  const sb = { AUDIO: { records: null }, LIB: { user: { id: 'u1' }, playlists: [] }, LS: memLS(), isMirrorPlaylist: () => false };
  vm.createContext(sb);
  vm.runInContext(between('let LABELCHECKS = null;', '/** The heard tracks for the engine') + ';globalThis.h = labelCheckHTML; globalThis.shown = labelsShownNow;', sb);
  assert.equal(sb.h(), '');
  assert.equal(sb.shown(), null);
});

/* ---------------------------------------------------- readings */

test('readings: top-3 ontology moods through MOOD_MAP, voice at 0.5, energy clamped', () => {
  assert.deepEqual(moodsOf(rec('a')), ['dark', 'energetic', 'uplifting']);  // film is null-mapped
  assert.equal(voiceOf(rec('a', { voice: 0.5 })), 'vocal');
  assert.equal(voiceOf(rec('a', { voice: 0.49 })), 'instrumental');
  assert.equal(readingsOf(rec('a', { energy: 1.4 })).energy, 1);
  assert.deepEqual(readingsOf({ id: 'm', miss: 'NO_PREVIEW' }), { mood: null, voice: null, energy: null });
  // party/summer are contexts, not moods: left out of the mood reading
  assert.equal(moodsOf(rec('a', { moods: [['party', 0.9], ['summer', 0.8]] })), null);
});

/* ---------------------------------------------------- thresholds */

const checksWith = (type, right, wrong) => {
  const c = {};
  for (let i = 0; i < right; i++) c[`r${i}`] = { [type]: true };
  for (let i = 0; i < wrong; i++) c[`w${i}`] = { [type]: false };
  return c;
};

test(`thresholds: on at ≥ ${AGREE_MIN * 100}% over ≥ ${REVIEW_MIN} reviewed, per label type`, () => {
  assert.equal(AGREE_MIN, 0.7); assert.equal(REVIEW_MIN, 20); assert.equal(REVIEW_SIZE, 30);
  assert.equal(agreement(checksWith('mood', 19, 0)).mood.on, false);          // too few, though all right
  assert.equal(agreement(checksWith('mood', 14, 6)).mood.on, true);           // exactly 70% of 20
  assert.equal(agreement(checksWith('mood', 13, 7)).mood.on, false);          // 65%
  assert.equal(agreement(checksWith('voice', 21, 9)).voice.on, true);         // 70% of 30
  assert.equal(agreement(checksWith('voice', 20, 10)).voice.on, false);       // 66.7%
  const a = agreement(checksWith('energy', 16, 4));
  assert.deepEqual(a.energy, { reviewed: 20, right: 16, rate: 0.8, on: true });
  assert.equal(a.mood.on, false); assert.equal(a.voice.on, false);            // types are independent
  assert.deepEqual(agreement({}).mood, { reviewed: 0, right: 0, rate: null, on: false });
});

test('labelsShown follows agreement; the per-browser override wins either way', () => {
  const c = { ...checksWith('voice', 18, 2) };
  assert.deepEqual(labelsShown(c, memLS()), { mood: false, voice: true, energy: false });
  assert.deepEqual(labelsShown(c, memLS({ [LABELS_UI_KEY]: '0' })), ALL_OFF);
  assert.deepEqual(labelsShown({}, memLS({ [LABELS_UI_KEY]: '1' })), ALL_ON);
});

/* ---------------------------------------------------- per account */

test('verdicts are kept per account and never mix', () => {
  let all = {};
  all = withVerdict(all, 'emma', 't1', 'mood', true, 'dark,energetic', 5);
  all = withVerdict(all, 'emma', 't1', 'voice', false, 'vocal', 6);
  all = withVerdict(all, 'sam', 't1', 'mood', false, 'dark', 7);
  assert.deepEqual(checksFor(all, 'emma').t1, { at: 6, seen: { mood: 'dark,energetic', voice: 'vocal' }, mood: true, voice: false });
  assert.deepEqual(checksFor(all, 'sam').t1, { at: 7, seen: { mood: 'dark' }, mood: false });
  assert.deepEqual(checksFor(all, 'nobody'), {});
  assert.deepEqual(checksFor(all, null), {});
  // clearing one verdict leaves the other
  all = withVerdict(all, 'emma', 't1', 'voice', null, 'vocal', 8);
  assert.equal('voice' in checksFor(all, 'emma').t1, false);
  assert.equal(checksFor(all, 'emma').t1.mood, true);
  // nonsense in, nothing changed
  assert.equal(withVerdict(all, 'emma', 't1', 'bpm', true), all);
  assert.equal(withVerdict(all, null, 't1', 'mood', true), all);
});

/* ---------------------------------------------------- the review */

function library(nPlaylists = 5, perPlaylist = 40) {
  const playlists = [], records = new Map();
  for (let p = 0; p < nPlaylists; p++) {
    const tracks = [];
    for (let i = 0; i < perPlaylist; i++) {
      const id = `p${p}t${i}`;
      tracks.push({ id, name: `Track ${i} <${p}>`, artists: [{ name: `Artist ${p}` }] });
      records.set(id, rec(id, { voice: (i % 3) / 2 }));
    }
    playlists.push({ id: `P${p}`, name: `List ${p}`, tracks });
  }
  return { lib: { user: { id: 'emma' }, playlists, liked: [] }, records };
}

test('the sample: 30 tracks spread evenly across playlists, deterministic, skipping checked and mirror playlists', () => {
  const { lib, records } = library(5, 40);
  const s = reviewSample(lib, records, { seed: 3 });
  assert.equal(s.length, 30);
  const per = {};
  for (const x of s) per[x.playlist.id] = (per[x.playlist.id] ?? 0) + 1;
  assert.deepEqual(Object.values(per), [6, 6, 6, 6, 6]);
  assert.deepEqual(reviewSample(lib, records, { seed: 3 }).map(x => x.track.id), s.map(x => x.track.id));
  assert.notDeepEqual(reviewSample(lib, records, { seed: 4 }).map(x => x.track.id), s.map(x => x.track.id));
  assert.equal(new Set(s.map(x => x.track.id)).size, 30);

  const checks = Object.fromEntries(s.map(x => [x.track.id, { mood: true }]));
  const again = reviewSample(lib, records, { seed: 3, checks });
  assert.equal(again.length, 30);
  assert.ok(again.every(x => !checks[x.track.id]));

  const noMirror = reviewSample(lib, records, { skip: p => p.id === 'P0' });
  assert.ok(noMirror.every(x => x.playlist.id !== 'P0'));

  // a track in two playlists is offered once; a small library gives what it has
  const shared = { playlists: [{ id: 'A', name: 'A', tracks: [{ id: 'p0t0' }] }, { id: 'B', name: 'B', tracks: [{ id: 'p0t0' }, { id: 'p0t1' }] }] };
  assert.deepEqual(reviewSample(shared, records).map(x => x.track.id).sort(), ['p0t0', 'p0t1']);
});

test('review flow on fixtures: card shows each reading with Right/Wrong, verdicts move the numbers, 20 right turns a type on', () => {
  const { lib, records } = library(5, 40);
  let all = {};
  const sample = reviewSample(lib, records, { seed: 1 });
  let html = reviewHTML(reviewVM(sample, records, checksFor(all, 'emma')));
  assert.match(html, /<h2 id="src-labels-h">Check sound labels<\/h2>/);
  assert.equal((html.match(/class="lck-row"/g) ?? []).length, 30);
  assert.equal((html.match(/data-lok="1"/g) ?? []).length, 90);             // three readings each
  assert.match(html, /Track \d+ &lt;\d&gt;/);                                // escaped
  assert.match(html, /<b>Mood<\/b> not checked yet · <span class="lck-st">20 more to go/);
  assert.match(html, /dark, energetic, uplifting/);
  assert.match(html, /3 of 5/);                                              // energy 0.62 → 3 of 5

  // she marks voice right on 20, wrong on 5; mood wrong on 25
  sample.slice(0, 25).forEach(({ track }, i) => {
    const r = readingsOf(records.get(track.id));
    all = withVerdict(all, 'emma', track.id, 'voice', i < 20, seenOf('voice', r.voice));
    all = withVerdict(all, 'emma', track.id, 'mood', false, seenOf('mood', r.mood));
  });
  const mine = checksFor(all, 'emma');
  assert.deepEqual(labelsShown(mine, memLS()), { mood: false, voice: true, energy: false });
  html = reviewHTML(reviewVM(sample, records, mine));
  assert.match(html, /<b>Voice<\/b> 20 of 25 right \(80%\) · <span class="lck-st">shown/);
  assert.match(html, /<b>Mood<\/b> 0 of 25 right \(0%\) · <span class="lck-st">hidden/);
  assert.match(html, /lck-sel" data-lchk="[^"]+" data-lt="voice" data-lok="1" aria-pressed="true"/);

  // once voice is on, the chip says vocal/instrumental and nothing else new
  const r = records.get(sample[0].track.id);
  const vmc = mergeSoundVM(dspSoundVM(r, { show: false }), labelSoundVM(r, labelsShown(mine, memLS())));
  assert.deepEqual(Object.keys(vmc), ['voice']);
  assert.match(soundChip(vmc), /<span class="snd-voice">(vocal|instrumental)<\/span>/);
});

test('the page: tapping Right stores the verdict for this account, tapping it again clears it', async () => {
  const { lib, records } = library(2, 30);
  const kv = new Map();
  const A = await import('../web/audio/labels-view.mjs');
  const sb = {
    AUDIO: { records }, LIB: lib, LS: memLS(), isMirrorPlaylist: () => false,
    BetterfyAudio: { ...A },
    idb: { get: async k => kv.get(k) ?? null, set: async (k, v) => { kv.set(k, structuredClone(v)); } },
    document: { getElementById: () => null },
  };
  vm.createContext(sb);
  vm.runInContext(between('let LABELCHECKS = null;', '/** The heard tracks for the engine')
    + ';LABELCHECKS = {}; globalThis.api = { labelCheckHTML, labelVerdict, labelsShownNow, get all() { return LABELCHECKS; } };', sb);
  const html = sb.api.labelCheckHTML();
  assert.match(html, /^<section class="srccard srclabels" id="src-labels" aria-labelledby="src-labels-h"><div id="labelCheck">/);
  const id = html.match(/data-lchk="([^"]+)" data-lt="energy" data-lok="1"/)[1];
  const btn = { dataset: { lchk: id, lt: 'energy', lok: '1' } };
  await sb.api.labelVerdict(btn);
  assert.equal(kv.get('labelchecks').emma[id].energy, true);
  assert.equal(kv.get('labelchecks').emma[id].seen.energy, 0.62);
  await sb.api.labelVerdict(btn);
  assert.equal('energy' in kv.get('labelchecks').emma[id], false);
  assert.deepEqual(sb.api.labelsShownNow(), ALL_OFF);
});

/* ---------------------------------------------------- display once on */

test('once shown: the chip carries moods, voice and energy; the profile row an energy spread', () => {
  const r = rec('a');
  const vmc = mergeSoundVM(dspSoundVM(r, { show: true }), labelSoundVM(r, ALL_ON));
  assert.deepEqual(vmc.moods, ['dark', 'energetic', 'uplifting']);
  assert.equal(vmc.voice, 'vocal'); assert.equal(vmc.energy, 0.62); assert.equal(vmc.bpm, 174);
  const chip = soundChip(vmc);
  assert.match(chip, /<span class="snd-voice">vocal<\/span>/);
  assert.match(chip, /<span class="snd-mood" title="mood, as heard in the preview">dark, energetic, uplifting<\/span>/);
  assert.match(chip, /energy <span class="snd-bars"/);
  assert.match(soundChip({ moods: ['<x>'] }), /&lt;x&gt;/);

  const tracks = [0.2, 0.3, 0.5, 0.7, 0.9].map((e, i) => ({ id: `e${i}`, e }));
  const records = new Map(tracks.map(t => [t.id, rec(t.id, { energy: t.e })]));
  const prof = withProfileEnergy({ heard: 5, members: 5 }, { tracks }, records, { energy: true });
  assert.deepEqual(prof.energy, [0.2, 0.9]);
  assert.match(profileRow(prof), /sprof-energy/);
  // fewer than three with energy: no spread
  assert.equal(withProfileEnergy({ heard: 2, members: 2 }, { tracks: tracks.slice(0, 2) }, records, { energy: true }).energy, undefined);
  for (const t of LABEL_TYPES) assert.ok(t in ALL_ON);
});
