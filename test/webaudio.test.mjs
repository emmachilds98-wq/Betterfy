import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import vm from 'node:vm';
import { openAudioStore, AUDIO_STORE } from '../web/audio/store.mjs';
import { readAudioSettings, writeAudioSettings, connectionVerdict, scopeIds, DEFAULT_AUDIO_SETTINGS, AUDIO_SETTINGS_KEY } from '../web/audio/settings.mjs';
import { createAudioController, createWorkerEar, listenVM, profileVM, styleName } from '../web/audio/controller.mjs';
import { audioQueue } from '../core/audio/queue.mjs';
import { makeRecord, makeMiss, MISS, N_STYLES, EMB_DIM, validRecord } from '../core/audio/record.mjs';
import { MEL_VERSION, SAMPLE_RATE } from '../core/audio/mel.mjs';
import { assembledTemplate } from '../web/manifest.mjs';

// WP-B2: the page's store, settings and run loop. These are what
// docs/audio.js exposes as BetterfyAudio; the template only renders them.

/* ------------------------------------------------------------ fakes */

/** Just enough IndexedDB for store.mjs: async requests, one keyPath store, oncomplete after the last request. */
function fakeIndexedDB({ failOpen = false } = {}) {
  const dbs = new Map();
  const later = f => setTimeout(f, 0);
  return {
    dbs,
    open(name) {
      const req = {};
      later(() => {
        if (failOpen) { req.error = new Error('denied'); return req.onerror?.(); }
        let db = dbs.get(name), fresh = false;
        if (!db) { fresh = true; db = { stores: new Map() }; dbs.set(name, db); }
        const handle = {
          objectStoreNames: { contains: n => db.stores.has(n) },
          createObjectStore: (n, { keyPath }) => db.stores.set(n, { keyPath, rows: new Map() }),
          transaction(n) {
            const s = db.stores.get(n);
            let pending = 0;
            const tx = {};
            const done = () => { if (--pending === 0) later(() => tx.oncomplete?.()); };
            const op = fn => { pending++; const r = {}; later(() => { r.result = fn(); r.onsuccess?.(); done(); }); return r; };
            tx.objectStore = () => ({
              get: k => op(() => structuredClone(s.rows.get(k))),
              put: v => op(() => { s.rows.set(v[s.keyPath], structuredClone(v)); }),
              getAll: () => op(() => [...s.rows.values()].map(v => structuredClone(v))),
              count: () => op(() => s.rows.size),
              clear: () => op(() => s.rows.clear()),
            });
            return tx;
          },
        };
        req.result = handle;
        if (fresh) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
}

/** A real AudioRecord for track `id`, from deterministic fake model outputs. */
function record(id, { patches = 2, at = 1 } = {}) {
  const activations = new Float32Array(patches * N_STYLES), embeddings = new Float32Array(patches * EMB_DIM);
  const seed = [...id].reduce((s, c) => s + c.charCodeAt(0), 0);
  for (let i = 0; i < activations.length; i++) activations[i] = ((i * 7 + seed) % 97) / 97;
  for (let i = 0; i < embeddings.length; i++) embeddings[i] = Math.sin(i + seed);
  return makeRecord({ id, isrc: 'GB' + id, activations, embeddings, patches,
    source: { kind: 'deezer-isrc', deezerId: 1, windows: [[0, 1000]], seconds: 10 }, mel: MEL_VERSION, at });
}

const memLS = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), m }; };

/* ------------------------------------------------------------ store */

test('a record round-trips through the audio_v1 store unchanged, and outlives the store that wrote it', async () => {
  const idb = fakeIndexedDB();
  const a = openAudioStore({ indexedDB: idb });
  const rec = record('t1'), miss = makeMiss({ id: 't2', isrc: 'X', reason: MISS.NOT_ON_DEEZER, at: 5 });
  assert.equal(await a.put(rec), true);
  assert.equal(await a.put(miss), true);
  assert.deepEqual(await a.get('t1'), rec);
  assert.ok(idb.dbs.get('betterfy-audio').stores.has(AUDIO_STORE), 'stored under audio_v1');

  const b = openAudioStore({ indexedDB: idb });
  assert.deepEqual(await b.get('t1'), rec, 'read back by a fresh open, as after a reload');
  const all = await b.getAll();
  assert.deepEqual([...all.keys()].sort(), ['t1', 't2']);
  assert.equal(all.get('t2').miss, MISS.NOT_ON_DEEZER);
  assert.equal(await b.count(), 2);
  assert.equal(b.durable, true);
});

test('anything validRecord rejects reads back as not heard, and is never written', async () => {
  const idb = fakeIndexedDB();
  const s = openAudioStore({ indexedDB: idb });
  await s.put(record('ok'));
  // Garbage that got into the database some other way: an old shape, a half-written row.
  const rows = idb.dbs.get('betterfy-audio').stores.get(AUDIO_STORE).rows;
  rows.set('old', { v: 0, id: 'old', styles: [[1, 0.5]] });
  rows.set('bad', { ...record('bad'), styles: [[9999, 2]] });
  assert.equal(await s.get('old'), null);
  assert.equal(await s.get('bad'), null);
  assert.deepEqual([...(await s.getAll()).keys()], ['ok']);

  assert.equal(await s.put({ v: 1, id: 'f', miss: MISS.FAILED }), false, 'a dropped request is not an answer');
  assert.equal(await s.put(null), false);
  assert.equal(rows.has('f'), false);
});

test('with no usable IndexedDB the store works in memory for the session', async () => {
  for (const indexedDB of [undefined, fakeIndexedDB({ failOpen: true })]) {
    const s = openAudioStore({ indexedDB });
    await s.put(record('m'));
    assert.deepEqual(await s.get('m'), record('m'));
    assert.equal(await s.count(), 1);
    assert.equal(s.durable, false);
  }
});

/* ------------------------------------------------------------ settings */

test('listening is on by default, Wi-Fi only, scoped to what I play + unfiled', () => {
  assert.deepEqual(DEFAULT_AUDIO_SETTINGS, { on: true, wifiOnly: true, scope: 'playing+unfiled' });
  assert.deepEqual(readAudioSettings(memLS()), DEFAULT_AUDIO_SETTINGS);
  assert.deepEqual(readAudioSettings(null), DEFAULT_AUDIO_SETTINGS);
  const ls = memLS(); ls.setItem(AUDIO_SETTINGS_KEY, '{not json');
  assert.deepEqual(readAudioSettings(ls), DEFAULT_AUDIO_SETTINGS);
  ls.setItem(AUDIO_SETTINGS_KEY, JSON.stringify({ on: 'yes', wifiOnly: 0, scope: 'everything!' }));
  assert.deepEqual(readAudioSettings(ls), DEFAULT_AUDIO_SETTINGS, 'each odd field falls back on its own');
});

test('switching listening off is saved and beats the on-by-default', () => {
  const ls = memLS();
  assert.equal(readAudioSettings(ls).on, true);
  writeAudioSettings(ls, { on: false });
  assert.equal(readAudioSettings(ls).on, false);
  assert.equal(JSON.parse(ls.getItem(AUDIO_SETTINGS_KEY)).on, false);
  assert.equal(JSON.parse(ls.getItem(AUDIO_SETTINGS_KEY)).offChosen, true);
  writeAudioSettings(ls, { scope: 'all' });
  assert.equal(readAudioSettings(ls).on, false, 'a chosen off survives other changes');
  writeAudioSettings(ls, { on: true });
  assert.equal(JSON.parse(ls.getItem(AUDIO_SETTINGS_KEY)).offChosen, undefined);
});

test('an off saved by an older build (off was the default then) reads as on', () => {
  const ls = memLS();
  ls.setItem(AUDIO_SETTINGS_KEY, JSON.stringify({ on: false, wifiOnly: true, scope: 'all' }));
  assert.deepEqual(readAudioSettings(ls), { on: true, wifiOnly: true, scope: 'all' });
});

test('on a computer the default is the whole library; a phone stays narrow; a pick still wins', () => {
  const pc = { computer: true };
  assert.deepEqual(readAudioSettings(memLS(), pc), { on: true, wifiOnly: true, scope: 'all' });
  assert.deepEqual(readAudioSettings(memLS()), DEFAULT_AUDIO_SETTINGS, 'phone');
  // An older build saved the narrow default along with any other change: not a pick.
  const ls = memLS();
  ls.setItem(AUDIO_SETTINGS_KEY, JSON.stringify({ on: true, wifiOnly: true, scope: 'playing+unfiled' }));
  assert.equal(readAudioSettings(ls, pc).scope, 'all');
  // Ticking Wi-Fi only does not pin the scope either.
  writeAudioSettings(ls, { wifiOnly: false }, pc);
  assert.equal(readAudioSettings(ls, pc).scope, 'all');
  assert.equal(readAudioSettings(ls).scope, 'playing+unfiled', 'the same save on a phone is still narrow');
  // Picking the narrow scope on a computer is kept, through later changes too.
  writeAudioSettings(ls, { scope: 'playing+unfiled' }, pc);
  assert.equal(readAudioSettings(ls, pc).scope, 'playing+unfiled');
  writeAudioSettings(ls, { wifiOnly: true }, pc);
  assert.equal(readAudioSettings(ls, pc).scope, 'playing+unfiled');
  assert.equal(JSON.parse(ls.getItem(AUDIO_SETTINGS_KEY)).scopeChosen, true);
  // The whole library, picked on a phone, is kept there.
  const ph = memLS();
  writeAudioSettings(ph, { scope: 'all' });
  assert.equal(readAudioSettings(ph).scope, 'all');
});

test('the page reads a computer as whole-library before audio.js loads, and a picked narrow scope wins', () => {
  const tpl = assembledTemplate();
  const i = tpl.indexOf('function audioSettings()'), j = tpl.indexOf('const audioModelUrl');
  const ls = memLS();
  const sb = { LS: ls, globalThis: {}, navigator: { maxTouchPoints: 0 }, matchMedia: () => ({ matches: true }) };
  vm.createContext(sb);
  vm.runInContext(tpl.slice(i, j) + '\nthis.audioSettings = audioSettings; this.audioSettingsWrite = audioSettingsWrite;', sb);
  assert.equal(sb.audioSettings().scope, 'all');
  sb.audioSettingsWrite({ wifiOnly: false });
  assert.equal(sb.audioSettings().scope, 'all', 'another change does not pin the scope');
  sb.audioSettingsWrite({ scope: 'playing+unfiled' });
  assert.equal(sb.audioSettings().scope, 'playing+unfiled');
  sb.navigator.maxTouchPoints = 5;
  ls.setItem('bf_audio', 'null');
  assert.equal(sb.audioSettings().scope, 'playing+unfiled', 'a touch screen is not a computer');
});

test('settings changes merge and persist', () => {
  const ls = memLS();
  assert.deepEqual(writeAudioSettings(ls, { on: true }), { on: true, wifiOnly: true, scope: 'playing+unfiled' });
  writeAudioSettings(ls, { scope: 'all' });
  writeAudioSettings(ls, { scope: 'nonsense' });
  assert.deepEqual(readAudioSettings(ls), { on: true, wifiOnly: true, scope: 'playing+unfiled' });
  writeAudioSettings(ls, { wifiOnly: false, scope: 'all' });
  assert.deepEqual(readAudioSettings(ls), { on: true, wifiOnly: false, scope: 'all' });
});

test('the page template falls back to the same defaults before audio.js has loaded', () => {
  const tpl = assembledTemplate(); // the template with web/app/ and web/screens/ put back
  const i = tpl.indexOf('function audioSettings()'), j = tpl.indexOf('const audioModelUrl');
  assert.ok(i > 0 && j > i, 'audioSettings() not found in the template');
  const ls = memLS();
  const sb = { LS: ls, globalThis: {} };
  vm.createContext(sb);
  vm.runInContext(tpl.slice(i, j) + '\nthis.audioSettings = audioSettings;', sb);
  assert.deepEqual({ ...sb.audioSettings() }, DEFAULT_AUDIO_SETTINGS);
  ls.setItem('bf_audio', JSON.stringify({ on: true, wifiOnly: false, scope: 'all' }));
  assert.deepEqual({ ...sb.audioSettings() }, { on: true, wifiOnly: false, scope: 'all' });
  ls.setItem('bf_audio', JSON.stringify({ on: false, offChosen: true }));
  assert.equal(sb.audioSettings().on, false, 'a chosen off wins before audio.js loads too');
  ls.setItem('bf_audio', JSON.stringify({ on: false }));
  assert.equal(sb.audioSettings().on, true, 'an old build\'s off, never chosen, reads as on');
});

test('Wi-Fi only waits on cellular and Data Saver, and asks when the browser will not say', () => {
  assert.equal(connectionVerdict({ type: 'wifi' }), 'ok');
  assert.equal(connectionVerdict({ type: 'ethernet' }), 'ok');
  assert.equal(connectionVerdict({ type: 'cellular' }), 'metered');
  assert.equal(connectionVerdict({ type: 'wifi', saveData: true }), 'metered');
  assert.equal(connectionVerdict(undefined), 'unknown', 'Safari and Firefox have no navigator.connection');
  assert.equal(connectionVerdict({ effectiveType: '4g' }), 'unknown', 'desktop Chromium has no type');
  assert.equal(connectionVerdict(undefined, { confirmed: true }), 'ok');
  assert.equal(connectionVerdict({ type: 'cellular' }, { wifiOnly: false }), 'ok');
  assert.equal(connectionVerdict({ type: 'none' }, { wifiOnly: false }), 'offline');
});

test('the default scope is played tracks, unfiled liked songs and genre-playlist examples', () => {
  const t = (id, artist) => ({ id, artists: [{ id: 'a' + artist, name: artist }] });
  const big = Array.from({ length: 30 }, (_, i) => t('g' + i, 'Quiet'));
  const lib = {
    liked: [t('u1', 'Quiet'), t('g0', 'Quiet'), t('p1', 'Loud')],
    playlists: [{ id: 'G', tracks: big }, { id: 'M', tracks: [t('m1', 'Quiet'), t('m2', 'Loud')] }],
  };
  const listening = { weights: new Map([['Loud', 5]]), recentlyActive: new Set() };
  const ids = scopeIds(lib, { listening, targets: ['G'] });
  assert.ok(ids.has('u1'), 'unfiled liked');
  assert.ok(ids.has('p1'), 'liked and played');
  assert.ok(ids.has('m2'), 'by an artist being played');
  assert.ok(!ids.has('m1'), 'not played, not unfiled, not an example');
  assert.equal(big.filter(x => ids.has(x.id)).length, 20, '20 examples from the genre playlist');
  assert.equal(scopeIds(lib, { scope: 'all' }), null);
});

/* ------------------------------------------------------------ controller */

/** Fake pipeline: every stage counts its calls; samples are long enough for 2 patches. */
function fakePipeline() {
  const calls = { lookup: [], ear: 0 };
  return {
    calls,
    lookup: async (isrc) => { calls.lookup.push(isrc);
      return isrc === 'NONE' ? { miss: MISS.NOT_ON_DEEZER } : { deezerId: 1, previewUrl: 'https://cdn/x.mp3', durationMs: 1000, readable: true }; },
    fetchPreview: async () => ({ buffers: [new ArrayBuffer(8)], windows: [[0, 8]], total: 8, sliced: false }),
    decode: async () => new Float32Array(SAMPLE_RATE * 3),
    loadEar: async () => ({ ear: { run: async (data, n) => { calls.ear++;
      const activations = new Float32Array(n * N_STYLES).fill(0.1); activations[3] = 0.9;
      return { activations, embeddings: new Float32Array(n * EMB_DIM).fill(0.5) }; } } }),
  };
}

test('a run stops mid-queue after the track in flight, and a second run resumes without re-hearing anything', async () => {
  const lib = { liked: ['a', 'b', 'c', 'd', 'e', 'f'].map(id => ({ id, isrc: id === 'e' ? 'NONE' : 'I' + id, duration_ms: 1000, artists: [] })), playlists: [] };
  const store = openAudioStore({ indexedDB: fakeIndexedDB() });
  const p = fakePipeline();
  const seen = [];
  let ctrl, stopAt = 2;
  ctrl = createAudioController({ store, ...p, onChange: v => {
    seen.push(v.state);
    if (v.done === stopAt && v.state === 'running') { stopAt = -1; ctrl.stop(); }
  } });
  const tracksFor = async () => {
    const recs = await store.getAll();
    return audioQueue(lib, { store: recs, mel: MEL_VERSION }).map(id => lib.liked.find(t => t.id === id))
      .map(t => ({ id: t.id, isrc: t.isrc, durationMs: t.duration_ms }));
  };

  const first = await ctrl.start(await tracksFor());
  assert.deepEqual(first, { done: 2, stopped: true });
  assert.equal(ctrl.vm().state, 'paused');
  assert.equal(await store.count(), 2, 'both finished tracks were stored');

  const rest = await tracksFor();
  assert.deepEqual(rest.map(t => t.id), ['c', 'd', 'e', 'f'], 'the queue skips what was heard');
  const second = await ctrl.start(rest);
  assert.deepEqual(second, { done: 4, stopped: false });
  assert.equal(ctrl.vm().state, 'done');
  assert.deepEqual(p.calls.lookup, ['Ia', 'Ib', 'Ic', 'Ic', 'Id', 'NONE', 'If'], 'every track looked up once, except c: it was fetched ahead (L2) when the run stopped, so that fetch was dropped and redone');

  const all = await ctrl.refresh();
  assert.equal(all.size, 6);
  assert.ok([...all.values()].every(validRecord));
  assert.deepEqual(ctrl.vm().missed, { NOT_ON_DEEZER: 1 });
  assert.equal(ctrl.vm().heard, 5);
  assert.deepEqual(await tracksFor(), [], 'nothing left to hear');
  assert.ok(seen.includes('running') && seen.includes('paused'));
});

test('L1: the controller times each stage per track, hands the samples to onTiming, and stores the same records', async () => {
  const tracks = ['a', 'b', 'c'].map(id => ({ id, isrc: 'I' + id, durationMs: 1000 }));
  const run = async extra => {
    const store = openAudioStore({ indexedDB: fakeIndexedDB() });
    const snaps = [];
    const ctrl = createAudioController({ store, ...fakePipeline(), ...extra, onTiming: s => snaps.push(s) });
    await ctrl.start(tracks);
    return { all: [...(await store.getAll()).values()].map(r => ({ ...r, at: 0 })), snaps, ctrl };
  };
  let t = 0;
  const a = await run({ timerNow: () => (t += 5) }), b = await run({});
  assert.deepEqual(a.all, b.all, 'timing changes nothing that is stored');
  assert.equal(a.snaps.length, 1);
  assert.equal(a.snaps[0].track.length, 3, 'one sample per track');
  // L2: the next track's lookup and download land in the sample of the track being heard, so the last has none.
  assert.ok(a.snaps[0].track.slice(0, 2).every(s => s.lookup > 0 && s.download > 0 && s.decode > 0 && s.model > 0));
  assert.equal(a.ctrl.timing().track.length, 3);
});

test('a failed download is counted for the session but never stored, so it is tried again', async () => {
  const store = openAudioStore({ indexedDB: fakeIndexedDB() });
  const p = fakePipeline();
  p.fetchPreview = async () => ({ miss: MISS.FAILED, detail: 'network' });
  const ctrl = createAudioController({ store, ...p });
  await ctrl.start([{ id: 'x', isrc: 'Ix', durationMs: 1000 }]);
  assert.equal(await store.count(), 0);
  assert.deepEqual(ctrl.vm().missed, { FAILED: 1 });
});

test('a model that will not load pauses the run with a reason, and the next start tries again', async () => {
  const store = openAudioStore({ indexedDB: fakeIndexedDB() });
  const p = fakePipeline();
  let tries = 0;
  const loadEar = p.loadEar;
  p.loadEar = async () => { if (++tries === 1) throw new Error('404'); return loadEar(); };
  const ctrl = createAudioController({ store, ...p });
  const tracks = [{ id: 'x', isrc: 'Ix', durationMs: 1000 }];
  assert.deepEqual(await ctrl.start(tracks), { done: 0, stopped: true });
  assert.match(ctrl.vm().reason, /couldn’t load the model: 404/);
  assert.deepEqual(await ctrl.start(tracks), { done: 1, stopped: false });
  assert.equal(await store.count(), 1);
});

test('the worker ear proxies runs, transfers the mel buffer, and fails pending calls if the worker dies', async () => {
  const posted = [];
  const listeners = {};
  const worker = {
    addEventListener: (k, f) => { listeners[k] = f; },
    postMessage: (m, transfer) => {
      posted.push({ m, transfer });
      setTimeout(() => {
        if (m.op === 'init') listeners.message({ data: { id: m.id, ok: true, result: { heads: ['danceability'] } } });
        if (m.op === 'ear') listeners.message({ data: { id: m.id, ok: true, result: { activations: new Float32Array(N_STYLES), embeddings: new Float32Array(EMB_DIM) } } });
        if (m.op === 'heads') listeners.error({ message: 'boom' });
      }, 0);
    },
  };
  const w = createWorkerEar(worker, { modelUrl: 'm.onnx' });
  assert.deepEqual(await w.ready, { heads: ['danceability'] });
  const data = new Float32Array(10);
  const out = await w.ear.run(data, 1);
  assert.equal(out.activations.length, N_STYLES);
  const earMsg = posted.find(x => x.m.op === 'ear');
  assert.deepEqual(earMsg.transfer, [data.buffer]);
  await assert.rejects(w.heads.run(new Float32Array(EMB_DIM), 1), /boom/);
});

test('view models for sound.mjs: off unless switched on, and a playlist’s heard count and styles', async () => {
  assert.equal(listenVM(null, { on: false }).state, 'off');
  const recs = new Map([['a', record('a')], ['b', makeMiss({ id: 'b', reason: MISS.NO_PREVIEW })]]);
  const labels = Array.from({ length: N_STYLES }, (_, i) => `Electronic---Style${i}`);
  const vmp = profileVM({ tracks: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'a' }] }, recs, labels);
  assert.equal(vmp.heard, 1);
  assert.equal(vmp.members, 3);
  assert.match(vmp.styles[0][0], /^Style\d+$/);
  assert.equal(styleName('Electronic---Bassline'), 'Bassline');
});

/* ------------------------------------------------------------ build */

const DOCS = new URL('../docs/', import.meta.url);
const read = f => readFileSync(new URL(f, DOCS), 'utf8');

test('the audio bundle is its own lazy file, and the page only knows how to fetch it', () => {
  const page = read('index.html'), audio = read('audio.js');
  const sb = {}; vm.createContext(sb); vm.runInContext(audio, sb);
  for (const k of ['openAudioStore', 'createAudioController', 'audioQueue', 'lookup', 'fetchPreview', 'decodeTo16k', 'analyseOne', 'readAudioSettings'])
    assert.equal(typeof sb.BetterfyAudio[k], 'function', k);
  assert.equal(typeof sb.BetterfyDeezer.isDeezerApiUrl, 'function');
  assert.ok(!page.includes('function createAudioController'), 'core/audio is not inlined into every page load');
  assert.ok(page.includes("'audio.js?v="));
  assert.ok(page.includes('id="audioPanel"') || page.includes('id=\\"audioPanel\\"') || page.includes('<div id="audioPanel">'));
  assert.match(page, /CC BY-NC-SA 4\.0/, 'the model attribution is on the page');
});

test('the inference worker pins onnxruntime-web 1.31.1, WASM only, one thread', () => {
  const w = read('audio-worker.js');
  assert.match(w, /onnxruntime-web@1\.31\.1\/dist\//);
  assert.match(w, /numThreads = 1/);
  assert.match(w, /executionProviders: \['wasm'\]/);
  assert.ok(!/webgpu|jsep/i.test(w));
  assert.match(w, /BetterfyInfer\.createEar/);
  assert.match(w, /BetterfyHeads\.createHeads/);
});

test('the models ship under docs/models with their licence', () => {
  for (const f of ['discogs-effnet-bsdynamic-1.onnx', 'mtg_jamendo_moodtheme-discogs-effnet-1.onnx',
                   'voice_instrumental-discogs-effnet-1.onnx', 'danceability-discogs-effnet-1.onnx', 'discogs-effnet-bsdynamic-1.json']) {
    const u = new URL('models/' + f, DOCS);
    assert.ok(existsSync(u) && statSync(u).size > 1000, f);
  }
  const lic = read('models/LICENSE');
  assert.match(lic, /Attribution-NonCommercial-ShareAlike 4\.0 International/);
  assert.match(lic, /Music Technology Group/);
  // The page refers to every file it loads by the names that are actually there.
  const page = read('index.html');
  for (const f of page.match(/[a-z_]+-discogs-effnet-1\.onnx|discogs-effnet-bsdynamic-1\.onnx/g))
    assert.ok(existsSync(new URL('models/' + f, DOCS)), f);
});

test('the mood head’s class order matches its metadata', async () => {
  const { MOOD_LABELS, HEADS } = await import('../core/audio/heads.mjs');
  const meta = n => JSON.parse(read(`models/${n}-discogs-effnet-1.json`)).classes;
  assert.deepEqual(meta('mtg_jamendo_moodtheme'), [...MOOD_LABELS]);
  assert.deepEqual(meta('voice_instrumental'), [...HEADS.voice_instrumental.classes]);
  assert.deepEqual(meta('danceability'), [...HEADS.danceability.classes]);
});
