import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lookup, identityOk, windows, fetchWindows, fetchPreview, totalFromContentRange, WINDOW_BYTES } from '../core/audio/fetch.mjs';
import { MISS, CACHEABLE_MISS } from '../core/audio/record.mjs';

const hit = { id: 3135556, isrc: 'GBDUW0000059', duration: 207, readable: true, preview: 'https://cdnt-preview.dzcdn.net/x.mp3?hdnea=exp=1' };
const jsonpOf = body => async url => { jsonpOf.last = url; if (body instanceof Error) throw body; return body; };

test('a hit returns the preview, keyed by the exact ISRC', async () => {
  const r = await lookup('GB-DUW-00-00059', { jsonp: jsonpOf(hit), spotifyDurationMs: 206500 });
  assert.deepEqual(r, { deezerId: 3135556, previewUrl: hit.preview, durationMs: 207000, readable: true });
  assert.equal(jsonpOf.last, 'https://api.deezer.com/track/isrc:GBDUW0000059');
});

test('no ISRC is a miss before any request', async () => {
  let asked = false;
  assert.equal((await lookup('', { jsonp: async () => { asked = true; } })).miss, MISS.NO_ISRC);
  assert.equal(asked, false, 'never guesses by name');
});

test('Deezer {error} 800 is NOT_ON_DEEZER (cacheable); quota and others are FAILED (never cached)', async () => {
  const none = await lookup('X', { jsonp: jsonpOf({ error: { code: 800, message: 'no data' } }) });
  assert.equal(none.miss, MISS.NOT_ON_DEEZER);
  assert.ok(CACHEABLE_MISS.has(none.miss));
  const quota = await lookup('X', { jsonp: jsonpOf({ error: { code: 4 } }) });
  assert.equal(quota.miss, MISS.FAILED);
  assert.ok(!CACHEABLE_MISS.has(quota.miss));
});

test('readable:false and no preview are NO_PREVIEW', async () => {
  assert.equal((await lookup(hit.isrc, { jsonp: jsonpOf({ ...hit, readable: false }) })).miss, MISS.NO_PREVIEW);
  assert.equal((await lookup(hit.isrc, { jsonp: jsonpOf({ ...hit, preview: '' }) })).miss, MISS.NO_PREVIEW);
});

test('a duration mismatch or a different ISRC is IDENTITY', async () => {
  assert.equal((await lookup('GBDUW0000059', { jsonp: jsonpOf(hit), spotifyDurationMs: 215000 })).miss, MISS.IDENTITY);
  assert.equal((await lookup('USXXX0000001', { jsonp: jsonpOf(hit) })).miss, MISS.IDENTITY);
  assert.ok(identityOk(207000, 204000));
  assert.ok(!identityOk(207000, 203999));
  assert.ok(!identityOk(NaN, 1000));
});

test('a network failure is FAILED, never a cacheable miss', async () => {
  const r = await lookup('X', { jsonp: jsonpOf(new Error('timeout')) });
  assert.equal(r.miss, MISS.FAILED);
  assert.ok(!CACHEABLE_MISS.has(r.miss));
});

test('windows: one at the start and one centred, 165,000 bytes each', () => {
  assert.deepEqual(windows(479827), [[0, WINDOW_BYTES], [157413, WINDOW_BYTES]]);
  const [, [s, l]] = windows(479827);
  assert.ok(Math.abs((s + l / 2) - 479827 / 2) <= 1, 'second window is centred');
  assert.deepEqual(windows(300000), [[0, 300000]], 'too small for two: one range covering it');
  assert.deepEqual(windows(0), []);
});

function fakeFetch({ status = 206, size = 479827, fail = false } = {}) {
  const file = Uint8Array.from({ length: size }, (_, i) => i & 0xff);
  const calls = [];
  const f = async (url, init) => {
    calls.push(init?.headers?.Range);
    if (fail) throw new Error('network down');
    if (status !== 206 && status !== 200) return { status, arrayBuffer: async () => new ArrayBuffer(0), headers: { get: () => null } };
    if (status === 200) return { status, arrayBuffer: async () => file.slice().buffer, headers: { get: () => null } };
    const [, a, b] = /bytes=(\d+)-(\d+)/.exec(init.headers.Range).map(Number);
    return { status: 206, arrayBuffer: async () => file.slice(a, b + 1).buffer, headers: { get: h => h === 'content-range' ? `bytes ${a}-${b}/${size}` : null } };
  };
  return Object.assign(f, { calls, file });
}

test('fetchWindows uses Range and gets 206 parts', async () => {
  const f = fakeFetch();
  const out = await fetchWindows('u', windows(479827), { fetch: f });
  assert.equal(out.length, 2);
  assert.equal(out.sliced, false);
  assert.deepEqual(f.calls, ['bytes=0-164999', 'bytes=157413-322412']);
  assert.equal(new Uint8Array(out[1])[0], 157413 & 0xff);
});

test('a 200 instead of 206 is sliced locally, and says so', async () => {
  const f = fakeFetch({ status: 200 });
  const out = await fetchWindows('u', windows(479827), { fetch: f });
  assert.equal(out.sliced, true);
  assert.equal(f.calls.length, 1, 'the whole file came once; no second request');
  assert.equal(out[1].byteLength, WINDOW_BYTES);
  assert.equal(new Uint8Array(out[1])[0], 157413 & 0xff);
});

test('fetchWindows rejects on HTTP errors; fetchPreview turns that into FAILED', async () => {
  await assert.rejects(fetchWindows('u', [[0, 10]], { fetch: fakeFetch({ status: 403 }) }));
  assert.equal((await fetchPreview('u', { fetch: fakeFetch({ fail: true }) })).miss, MISS.FAILED);
  assert.equal((await fetchPreview('u', { fetch: fakeFetch({ status: 403 }) })).miss, MISS.FAILED);
});

test('fetchPreview learns the size from the first part and centres the second', async () => {
  const f = fakeFetch();
  const r = await fetchPreview('u', { fetch: f });
  assert.deepEqual(r.windows, [[0, WINDOW_BYTES], [157413, WINDOW_BYTES]]);
  assert.equal(r.total, 479827);
  assert.equal(f.calls.length, 2);
  const small = await fetchPreview('u', { fetch: fakeFetch({ size: 200000 }) });
  assert.equal(small.buffers.length, 1);
  assert.equal(small.buffers[0].byteLength, 200000, 'a small file is fetched whole, in two requests');
  const whole = await fetchPreview('u', { fetch: fakeFetch({ status: 200 }) });
  assert.equal(whole.sliced, true);
  assert.equal(whole.buffers.length, 2);
  assert.equal(totalFromContentRange('bytes 0-9/480'), 480);
  assert.equal(totalFromContentRange(null), null);
});
