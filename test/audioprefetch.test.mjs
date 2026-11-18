// SOUND-ENGINE-PLAN L2 (fetch the next track while this one is heard) and L3
// (one download per record for all top-ups). Fake network, fake ear.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runQueue } from '../core/audio/worker.js';
import { createPreviewCache, CACHED_PREVIEW } from '../core/audio/fetch.mjs';
import { createAudioController } from '../web/audio/controller.mjs';
import { N_STYLES, EMB_DIM, CLAP_DIM, makeEar } from '../core/audio/record.mjs';
import { SAMPLE_RATE } from '../core/audio/mel.mjs';
import { DSP_VERSION } from '../core/audio/dsp/combine.mjs';
import { KEYNET_VERSION } from '../core/audio/dsp/keynet.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const tone = Float32Array.from({ length: 10 * SAMPLE_RATE }, (_, i) => 0.2 * Math.sin(i / 7));
const tracks = n => Array.from({ length: n }, (_, i) => ({ id: 't' + i, isrc: 'GBXXX00000' + String(i).padStart(2, '0'), durationMs: 200000 }));

function deps({ lookupMs = 0, fetchMs = 0, earMs = 0, log = [] } = {}) {
  return {
    now: () => 1,
    lookup: async isrc => { log.push('lookup ' + isrc); await sleep(lookupMs); return { deezerId: 9, previewUrl: 'https://x/' + isrc, durationMs: 200000, readable: true }; },
    fetchPreview: async url => { log.push('fetch ' + url.split('/').pop()); await sleep(fetchMs); return { buffers: [new ArrayBuffer(8), new ArrayBuffer(8)], windows: [[0, 8], [8, 8]], total: 16, sliced: false }; },
    decode: async () => tone,
    ear: { run: async (d, n) => { log.push('ear'); await sleep(earMs); return { activations: new Float32Array(n * N_STYLES).fill(0.01), embeddings: new Float32Array(n * EMB_DIM).fill(0.05) }; } },
  };
}
const run = async (d, list, o = {}) => { const out = []; await runQueue(d, list, { onResult: r => out.push(r), ...o }); return out; };

test('L2: records are identical with and without the prefetch, in the same order', async () => {
  const a = await run(deps(), tracks(5), { prefetch: false });
  const b = await run(deps(), tracks(5));
  assert.equal(b.length, 5);
  assert.deepEqual(b, a);
  assert.deepEqual(b.map(r => r.record.id), ['t0', 't1', 't2', 't3', 't4']);
});

test('L2: the next track is fetched while this one is heard, never more than one ahead', async () => {
  const log = [];
  await run(deps({ log, earMs: 10 }), tracks(4));
  const at = s => log.indexOf(s);
  assert.ok(at('lookup GBXXX0000001') < at('ear'), log.join(','));
  const ears = log.map((s, i) => s === 'ear' ? i : -1).filter(i => i >= 0);
  assert.ok(at('lookup GBXXX0000002') > ears[0], 'two ahead would start before the first track is heard');
  assert.ok(at('lookup GBXXX0000003') > ears[1]);
});

test('L2: at least 1.4x tracks a minute when the network and the model can overlap', async () => {
  const d = () => deps({ lookupMs: 15, fetchMs: 35, earMs: 50 });
  const t0 = Date.now(); await run(d(), tracks(8), { prefetch: false }); const serial = Date.now() - t0;
  const t1 = Date.now(); await run(d(), tracks(8)); const ahead = Date.now() - t1;
  console.log(`# L2 scripted run, 8 tracks: serial ${serial} ms, prefetch ${ahead} ms, ${(serial / ahead).toFixed(2)}x`);
  assert.ok(serial / ahead >= 1.4, `serial ${serial} ms, prefetch ${ahead} ms`);
});

test('L2: stop during a prefetch drops it, and the track in flight still finishes', async () => {
  const ac = new AbortController(); const log = [];
  const d = deps({ log, earMs: 30, fetchMs: 5 });
  const ear = d.ear.run; d.ear.run = async (...a) => { ac.abort(); return ear(...a); };
  const out = [];
  const r = await runQueue(d, tracks(5), { signal: ac.signal, onResult: x => out.push(x) });
  assert.deepEqual([r.done, r.stopped, out.length], [1, true, 1]);
  assert.ok(log.filter(s => s.startsWith('lookup')).length <= 2, 'at most one ahead was fetched');
});

test('L2: a prefetched failure or miss lands on its own track, in order', async () => {
  const d = deps();
  d.lookup = async isrc => isrc.endsWith('1') ? { miss: 'NOT_ON_DEEZER' } : isrc.endsWith('2') ? Promise.reject(new Error('boom')) : { deezerId: 1, previewUrl: 'u', durationMs: 200000 };
  const out = await run(d, tracks(4));
  assert.deepEqual(out.map(r => Object.keys(r)[0]), ['record', 'miss', 'failed', 'record']);
  assert.equal(out[1].miss.id, 't1'); assert.equal(out[2].failed.id, 't2');
});

test('L3: the cache answers a second ask without the network, with fresh buffers, and never keeps the URL', async () => {
  let looks = 0, gets = 0;
  const pc = createPreviewCache({
    lookup: async () => (looks++, { deezerId: 5, previewUrl: 'https://signed/x?sig=1', durationMs: 1 }),
    fetchPreview: async () => (gets++, { buffers: [new Uint8Array([1, 2, 3]).buffer], windows: [[0, 3]], total: 3, sliced: false }),
  });
  const f1 = await pc.lookup('I1'); const g1 = await pc.fetchPreview(f1.previewUrl);
  structuredClone(g1.buffers[0], { transfer: [g1.buffers[0]] });   // decoding detaches the buffer it is given
  const f2 = await pc.lookup('I1'); const g2 = await pc.fetchPreview(f2.previewUrl);
  assert.deepEqual([looks, gets, f2.deezerId, f2.previewUrl.startsWith(CACHED_PREVIEW)], [1, 1, 5, true]);
  assert.deepEqual([...new Uint8Array(g2.buffers[0])], [1, 2, 3]);
  assert.ok(!JSON.stringify(f2).includes('signed'));
  pc.clear();
  await pc.lookup('I1'); assert.equal(looks, 2);
});

test('L3: top-ups download a record once, and the records are the same as without the cache', async () => {
  const mk = () => ['1', '2', '3', '4', '5'].map(id => ({ id, isrc: 'GBXXX000000' + id, source: { deezerId: 7 }}));
  const memStore = init => { const m = new Map(init.map(r => [r.id, r])); return { m, getAll: async () => new Map(m), get: async id => m.get(id), put: async r => { m.set(r.id, r); return true; }, count: async () => m.size }; };
  const go = async max => {
    let gets = 0;
    const store = memStore(mk());
    const ctrl = createAudioController({ store, previewCacheMax: max,
      lookup: async () => ({ deezerId: 7, previewUrl: 'u' }),
      fetchPreview: async () => (gets++, { buffers: [new ArrayBuffer(8), new ArrayBuffer(8)] }),
      decode: async () => tone,
      dsp: () => ({ v: DSP_VERSION, bpm: 124, bpmConf: 0.5, key: 'C major', camelot: '8B', keyConf: 0.2 }),
      clapOn: () => true, loadClap: async () => ({ decode: async () => tone, embed: async () => makeEar('clap', { embedding: new Float32Array(CLAP_DIM).fill(0.1) }) }),
      loadEar: async () => { throw new Error('none'); },
      loadKeyNet: async () => ({ logp: async () => Float32Array.from({ length: 24 }, (_, i) => Math.log(i === 21 ? 0.9 : 0.1 / 23)) }) });
    await ctrl.start([]);
    return { gets, store: [...store.m.values()], stats: ctrl.topupDownloads() };
  };
  const off = await go(0), on = await go(64);
  assert.ok(on.store.every(r => r.dsp?.keyNetV === KEYNET_VERSION && r.clap), 'both top-ups ran');
  assert.deepEqual(on.store, off.store, 'records identical');
  assert.equal(off.gets, 10, 'without the cache: one download a record per top-up');
  assert.equal(on.gets, 5);
  assert.ok(on.stats.downloads / on.stats.records <= 1.1, JSON.stringify(on.stats));
});
