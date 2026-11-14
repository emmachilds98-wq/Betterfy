import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyseOne, analyseSamples, runQueue } from '../core/audio/worker.js';
import { MISS, N_STYLES, EMB_DIM, validRecord, CACHEABLE_MISS } from '../core/audio/record.mjs';
import { SAMPLE_RATE, MEL_VERSION } from '../core/audio/mel.mjs';

const tone = secs => Float32Array.from({ length: Math.round(secs * SAMPLE_RATE) }, (_, i) => 0.2 * Math.sin(i / 7));

function deps(over = {}) {
  const seen = { decoded: [], earPatches: 0, urls: [] };
  const d = {
    seen,
    now: () => 5000,
    lookup: async (isrc, o) => { seen.lookup = [isrc, o]; return { deezerId: 42, previewUrl: 'https://cdnt-preview.dzcdn.net/p.mp3', durationMs: 200000, readable: true }; },
    fetchPreview: async url => { seen.urls.push(url); return { buffers: [new ArrayBuffer(8), new ArrayBuffer(8)], windows: [[0, 165000], [157413, 165000]], total: 479827, sliced: false }; },
    decode: async buf => { seen.decoded.push(buf.byteLength); return tone(10); },
    ear: { run: async (data, n) => { seen.earPatches = n; const a = new Float32Array(n * N_STYLES).fill(0.01); for (let p = 0; p < n; p++) a[p * N_STYLES + 3] = 0.7; return { activations: a, embeddings: new Float32Array(n * EMB_DIM).fill(0.05) }; } },
    ...over,
  };
  return d;
}
const track = { id: 'sp1', isrc: 'GBXXX0000001', durationMs: 199000 };

test('a hit goes all the way to a valid record, with no audio or URL kept', async () => {
  const d = deps();
  const r = await analyseOne(d, track);
  assert.ok(r.record, JSON.stringify(r).slice(0, 200));
  assert.ok(validRecord(r.record));
  assert.equal(r.record.mel, MEL_VERSION);
  assert.equal(r.record.styles[0][0], 3);
  assert.deepEqual(d.seen.lookup, ['GBXXX0000001', { spotifyDurationMs: 199000 }]);
  assert.deepEqual(d.seen.decoded, [8, 8], 'each window decoded separately');
  assert.equal(d.seen.earPatches, 19, 'two 10 s windows: 128-frame (~2 s) patches at a ~1 s hop');
  assert.deepEqual(r.record.source, { kind: 'deezer-isrc', deezerId: 42, windows: [[0, 165000], [157413, 165000]], seconds: 20 });
  const json = JSON.stringify(r.record);
  assert.ok(!json.includes('dzcdn'), 'the signed preview URL is never stored');
});

test('no ISRC is a cacheable miss without any request', async () => {
  const d = deps({ lookup: async () => { throw new Error('should not be called'); } });
  const r = await analyseOne(d, { id: 'x' });
  assert.equal(r.miss.miss, MISS.NO_ISRC);
});

for (const reason of [MISS.NOT_ON_DEEZER, MISS.NO_PREVIEW, MISS.IDENTITY]) {
  test(`lookup ${reason} is a cacheable miss`, async () => {
    const r = await analyseOne(deps({ lookup: async () => ({ miss: reason }) }), track);
    assert.equal(r.miss.miss, reason);
    assert.ok(CACHEABLE_MISS.has(r.miss.miss));
    assert.equal(r.miss.at, 5000);
  });
}

test('every failure stage is `failed`, never a storable miss', async () => {
  const cases = {
    lookup: deps({ lookup: async () => ({ miss: MISS.FAILED, detail: 'quota' }) }),
    lookupThrow: deps({ lookup: async () => { throw new Error('jsonp timeout'); } }),
    download: deps({ fetchPreview: async () => ({ miss: MISS.FAILED, detail: 'preview answered 403' }) }),
    decode: deps({ decode: async () => { throw new Error('bad mp3'); } }),
    infer: deps({ ear: { run: async () => { throw new Error('oom'); } } }),
  };
  const stages = {};
  for (const [k, d] of Object.entries(cases)) {
    const r = await analyseOne(d, track);
    assert.ok(r.failed && !r.miss && !r.record, k);
    stages[k] = r.failed.stage;
  }
  assert.deepEqual(stages, { lookup: 'lookup', lookupThrow: 'lookup', download: 'download', decode: 'decode', infer: 'infer' });
});

test('too little audio for one patch is TOO_SHORT', async () => {
  const r = await analyseOne(deps({ decode: async () => tone(0.5), fetchPreview: async () => ({ buffers: [new ArrayBuffer(4)], windows: [[0, 4]], sliced: false }) }), track);
  assert.equal(r.miss.miss, MISS.TOO_SHORT);
});

test('heads and DSP are optional and never fail a track', async () => {
  const withHeads = await analyseOne(deps({ heads: { run: async (e, n) => ({ voice: n }) }, summariseHeads: (h, n) => ({ v: 1, voice: 0.9, n }), dsp: () => ({ bpm: 128 }) }), track);
  assert.deepEqual(withHeads.record.heads, { v: 1, voice: 0.9, n: 19 });
  assert.deepEqual(withHeads.record.dsp, { bpm: 128 });
  const broken = await analyseOne(deps({ heads: { run: async () => { throw new Error('x'); } }, dsp: () => { throw new Error('y'); } }), track);
  assert.ok(broken.record);
  assert.equal(broken.record.heads, null);
  assert.equal(broken.record.dsp, null);
});

test('compressed buffers are released after decoding', async () => {
  let held;
  const d = deps({ fetchPreview: async () => (held = { buffers: [new ArrayBuffer(8), new ArrayBuffer(8)], windows: [[0, 8], [8, 8]], sliced: true }) });
  const r = await analyseOne(d, track);
  assert.deepEqual(held.buffers, [null, null]);
  assert.equal(r.record.source.sliced, true, 'a 200-sliced download is recorded');
});

test('analyseSamples runs the worker half from decoded samples', async () => {
  const r = await analyseSamples(deps(), { id: 'a', isrc: 'I', samples: tone(30), source: { kind: 'deezer-isrc', deezerId: 1, windows: [[0, 1]], seconds: 30 } });
  assert.ok(validRecord(r.record));
});

test('runQueue goes one at a time, reports each result, and stops cleanly mid-queue', async () => {
  const ctl = new AbortController();
  const got = [];
  const tracks = [{ id: 'a', isrc: 'A' }, { id: 'b', isrc: 'B' }, { id: 'c', isrc: 'C' }];
  const res = await runQueue(deps(), tracks, { signal: ctl.signal, onResult: (r, t) => { got.push(t.id); if (t.id === 'b') ctl.abort(); } });
  assert.deepEqual(got, ['a', 'b']);
  assert.deepEqual(res, { done: 2, stopped: true });
  const all = await runQueue(deps(), tracks, {});
  assert.deepEqual(all, { done: 3, stopped: false });
});
