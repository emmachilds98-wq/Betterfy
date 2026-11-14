import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { join, normalize } from 'node:path';
import { decodeTo16k, downmix, resampledLength, mp3FrameAt, scanFrames, SYNC_RUN } from '../core/audio/decode.mjs';
import { melFrames, frameCount, N_BANDS, SAMPLE_RATE, FRAME_SIZE, HOP_SIZE } from '../core/audio/mel.mjs';

// core/audio/decode.mjs turns Deezer preview bytes (whole, or a Range window
// cut from the middle) into the 16 kHz mono samples the mel front end reads.
// Part 1 holds its pure parts and its use of Web Audio with fake contexts.
// Part 2 runs it in real Chromium on a committed synthetic MP3 and holds the
// mel of the result to a reference decode; it skips when Playwright, Chromium
// or ffmpeg isn't there (CI has none of them).

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MP3_PATH = new URL('./fixtures/synth-stereo-44k.mp3', import.meta.url);
const MP3 = new Uint8Array(readFileSync(MP3_PATH));
// The fixture: synth() at 44.1 kHz, 4 s, stereo, LAME 64 kbps
// (scripts/audio-dsp/make-decode-fixture.mjs).
const FIXTURE_SAMPLES = 44100 * 4;
// Byte windows like the two WP-A1 fetches (one at the start, one centred),
// scaled to the fixture. The mid cut lands inside a frame on purpose.
const HEAD_CUT = [0, 16000];
const MID_CUT = [9001, 25001];

/** Every frame start in the whole fixture, by walking headers from the first frame. */
function frameStarts() {
  const starts = [];
  for (let i = scanFrames(MP3).offset || 20, h; (h = mp3FrameAt(MP3, i)); i += h.frameLength) starts.push(i);
  return starts;
}

// ---------------------------------------------------------------- part 1

test('downmix averages channels into a new array', () => {
  const l = Float32Array.from([1, 0.5, -1]), r = Float32Array.from([0, 0.5, 1]);
  assert.deepEqual([...downmix([l, r])], [0.5, 0.5, 0]);
  assert.deepEqual([...downmix([l, r, Float32Array.from([2, 2, 3])])].map(v => +v.toFixed(6)), [1, 1, 1]);
  const mono = downmix([l]);
  assert.deepEqual([...mono], [...l]);
  assert.notEqual(mono, l, 'mono is copied, not the AudioBuffer\'s own storage');
  assert.equal(downmix([]).length, 0);
  assert.throws(() => downmix([l, new Float32Array(2)]), /differ in length/);
});

test('resampled length rounds down, as Chromium\'s decode resample does', () => {
  assert.equal(resampledLength(FIXTURE_SAMPLES, 44100), 64000);
  assert.equal(resampledLength(76 * 1152, 44100), 31764);   // 31764.8: measured 31764 in Chromium
  assert.equal(resampledLength(48000, 48000), 16000);
  assert.equal(resampledLength(1000, 16000), 1000);
});

test('Layer III headers parse, and anything else is rejected', () => {
  const h = mp3FrameAt(MP3, frameStarts()[1]);
  assert.equal(h.sampleRate, 44100);
  assert.equal(h.samplesPerFrame, 1152);
  assert.ok(h.frameLength === 208 || h.frameLength === 209, `64 kbps @ 44.1 kHz is 208 or 209 bytes, got ${h.frameLength}`);
  const hdr = (b1, b2) => mp3FrameAt(Uint8Array.from([0xff, b1, b2, 0]), 0);
  assert.equal(hdr(0xfb, 0x50).frameLength, 208);           // MPEG-1 L3, 64 kbps, 44.1 kHz
  assert.equal(hdr(0xf3, 0x50).samplesPerFrame, 576);        // MPEG-2 L3
  assert.equal(hdr(0xf3, 0x50).sampleRate, 22050);
  assert.equal(hdr(0xe3, 0x54).sampleRate, 12000);           // MPEG-2.5
  assert.equal(hdr(0xeb, 0x50), null, 'reserved version');
  assert.equal(hdr(0xfd, 0x50), null, 'Layer II');
  assert.equal(hdr(0xfb, 0x00), null, 'free bitrate');
  assert.equal(hdr(0xfb, 0xf0), null, 'bad bitrate');
  assert.equal(hdr(0xfb, 0x5c), null, 'reserved sample rate');
  assert.equal(mp3FrameAt(Uint8Array.from([0xff, 0xfb]), 0), null, 'too short');
  assert.equal(mp3FrameAt(MP3, MP3.length - 2), null);
});

test('a tagged whole file scans from offset 0 and counts every frame', () => {
  const s = scanFrames(MP3);
  assert.equal(s.offset, 0, 'ID3 start is left for the demuxer');
  assert.equal(s.frames, frameStarts().length);
  assert.equal(s.sampleRate, 44100);
});

test('a window cut anywhere re-syncs to the next real frame boundary', () => {
  const starts = frameStarts();
  for (let from = 1000; from < 30000; from += 997) {
    const s = scanFrames(MP3.subarray(from, from + 16000));
    const next = starts.find(b => b >= from);
    assert.equal(s.offset, next - from, `cut at ${from}`);
    const complete = starts.filter(b => b >= from && b + mp3FrameAt(MP3, b).frameLength <= from + 16000).length;
    assert.equal(s.frames, complete, `complete frames in the cut at ${from}`);
  }
  const s = scanFrames(MP3.subarray(...MID_CUT));
  assert.equal(s.frames, 76);
});

test('bytes that are not Layer III scan to null and are decoded untouched', () => {
  let st = 1;
  const noise = Uint8Array.from({ length: 20000 }, () => (st = (st * 1103515245 + 12345) >>> 0) >>> 24);
  assert.equal(scanFrames(noise), null);
  assert.equal(scanFrames(new TextEncoder().encode('RIFF....WAVEfmt ')), null);
  // Fewer than SYNC_RUN complete frames is not enough evidence.
  const starts = frameStarts();
  assert.equal(scanFrames(MP3.subarray(starts[5], starts[5 + SYNC_RUN - 1] + 3)), null);
});

/** A fake AudioBuffer of 16 kHz stereo; each channel a constant. */
const fakeBuffer = (values, sampleRate = SAMPLE_RATE, n = 4) => ({
  sampleRate, numberOfChannels: values.length, length: n,
  getChannelData: c => new Float32Array(n).fill(values[c]),
});

function fakeOffline({ buffer = fakeBuffer([0.2, 0.6]), fail, callbackOnly } = {}) {
  const log = [];
  class Offline {
    constructor(...args) { log.push({ ctor: args }); }
    decodeAudioData(buf, ok, err) {
      log.push({ bytes: new Uint8Array(buf).slice(0, 4), length: buf.byteLength });
      if (callbackOnly) { setTimeout(() => (fail ? err(new Error(fail)) : ok(buffer))); return undefined; }
      return fail ? Promise.reject(new DOMException(fail, 'EncodingError')) : Promise.resolve(buffer);
    }
  }
  return { Offline, log };
}

test('decodes on a 16 kHz OfflineAudioContext and averages the channels', async () => {
  const { Offline, log } = fakeOffline();
  const out = await decodeTo16k(MP3.slice().buffer, { offlineContextCtor: Offline });
  assert.deepEqual(log[0].ctor, [1, 1, SAMPLE_RATE]);
  assert.equal(log[1].length, MP3.length, 'a whole file goes in as-is');
  assert.ok(out instanceof Float32Array);
  assert.deepEqual([...out].map(v => +v.toFixed(6)), [0.4, 0.4, 0.4, 0.4]);
});

test('a mid-file window is trimmed to its first frame before decoding', async () => {
  const { Offline, log } = fakeOffline();
  const cut = MP3.slice(...MID_CUT).buffer;
  await decodeTo16k(cut, { offlineContextCtor: Offline });
  const { offset } = scanFrames(MP3.subarray(...MID_CUT));
  assert.ok(offset > 0);
  assert.equal(log[1].length, MID_CUT[1] - MID_CUT[0] - offset);
  assert.deepEqual([...log[1].bytes.slice(0, 2)], [0xff, 0xfb]);
});

test('works with the callback-only decodeAudioData of older Safari', async () => {
  const { Offline } = fakeOffline({ callbackOnly: true, buffer: fakeBuffer([1]) });
  assert.deepEqual([...await decodeTo16k(MP3.slice().buffer, { offlineContextCtor: Offline })], [1, 1, 1, 1]);
  const bad = fakeOffline({ callbackOnly: true, fail: 'nope' });
  await assert.rejects(decodeTo16k(MP3.slice().buffer, { offlineContextCtor: bad.Offline }), /nope/);
});

test('a decode error rejects (the worker maps it to FAILED)', async () => {
  const { Offline } = fakeOffline({ fail: 'Unable to decode audio data' });
  await assert.rejects(decodeTo16k(new ArrayBuffer(10), { offlineContextCtor: Offline }), /Unable to decode/);
});

test('a context that ignores the requested rate is an error, not silently wrong audio', async () => {
  const { Offline } = fakeOffline({ buffer: fakeBuffer([0.1], 44100) });
  await assert.rejects(decodeTo16k(MP3.slice().buffer, { offlineContextCtor: Offline }), /44100 Hz/);
});

test('without OfflineAudioContext it uses a 16 kHz AudioContext and closes it', async () => {
  const log = [];
  class Live {
    constructor(opts) { log.push(opts); }
    decodeAudioData() { return Promise.resolve(fakeBuffer([0.5, 0.5, -1])); }
    close() { log.push('closed'); return Promise.resolve(); }
  }
  const out = await decodeTo16k(MP3.slice().buffer, { audioContextCtor: Live });
  assert.deepEqual(log, [{ sampleRate: SAMPLE_RATE }, 'closed']);
  assert.deepEqual([...out], [0, 0, 0, 0]);
  await assert.rejects(decodeTo16k(new ArrayBuffer(4), {}), /no Web Audio context/);
});

// ---------------------------------------------------------------- part 2

// The reference is ffmpeg's decoder and resampler (`-ar 16000`, channels
// averaged here). The plan names Essentia's MonoLoader, but Essentia can't be
// installed where this was written; MonoLoader decodes with the same FFmpeg
// MP3 decoder and resamples with libsamplerate, so ffmpeg is the nearest
// available stand-in. Channels are averaged by hand because ffmpeg's `-ac 1`
// is (L+R)/√2, not MonoLoader's (L+R)/2.
//
// Tolerances, from what was measured (docs/AUDIO-ANALYSIS-PLAN.md §0):
// - below 4 kHz (bands 0–73) the browser and ffmpeg agree to ~3e-3;
// - the top bands differ by up to ~2.5 log-mel units where the sweep crosses
//   8 kHz, because each resampler's anti-alias filter rolls off differently
//   (Chromium's short sinc kernel starts rolling off around 4–5 kHz; ffmpeg's
//   cuts off at 0.97 of Nyquist). Two reference-grade resamplers (ffmpeg's
//   swr vs soxr) differ by 3.7 in those bands on this same file, so the top
//   bands get a loose bound and the mean carries the check.
const LOW_BANDS = 74;           // band 73's centre is just under 4 kHz
const TOL = { lowMax: 0.01, allMean: 0.05, allMax: 3.5 };

let skip = false;
let chromium;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { skip = 'Playwright not installed'; }
if (!skip && spawnSync('ffmpeg', ['-version']).status !== 0) skip = 'ffmpeg not installed';

/**
 * ffmpeg's 16 kHz decode of these bytes, channels averaged. From a file, not
 * a pipe: on a pipe ffmpeg can't apply the Info tag's end padding.
 */
function ffmpegRef(bytes) {
  const dir = mkdtempSync(join(tmpdir(), 'betterfy-decode-')), file = join(dir, 'in.mp3');
  writeFileSync(file, bytes);
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'f32le', '-ar', '16000', '-ac', '2', 'pipe:1'], { maxBuffer: 1 << 26 });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 0, String(r.stderr));
  const st = new Float32Array(r.stdout.buffer.slice(r.stdout.byteOffset, r.stdout.byteOffset + r.stdout.length));
  const out = new Float32Array(st.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = (st[2 * i] + st[2 * i + 1]) / 2;
  return out;
}

/** Lag of b against a that maximises their correlation over the first `span` samples. */
function bestLag(a, b, maxLag = 2000, span = 8000) {
  let best = -Infinity, lag = 0;
  for (let L = -maxLag; L <= maxLag; L++) {
    let s = 0;
    for (let i = Math.max(0, -L); i < span && i < a.length && i + L < b.length; i++) s += a[i] * b[i + L];
    if (s > best) { best = s; lag = L; }
  }
  return lag;
}

/**
 * Log-mel error of `x` against `ref` over the frames whose whole 512-sample
 * window lies inside both. A cut's last frame runs past its end into zero
 * padding where the longer reference still has audio: that's the end of the
 * window, not a decoding difference.
 */
function melError(x, ref) {
  const a = melFrames(x), b = melFrames(ref);
  const frames = Math.min(a.frames, b.frames, Math.floor((Math.min(x.length, ref.length) - FRAME_SIZE) / HOP_SIZE) + 1);
  let lowMax = 0, allMax = 0, sum = 0;
  for (let f = 0; f < frames; f++)
    for (let k = 0; k < N_BANDS; k++) {
      const d = Math.abs(a.data[f * N_BANDS + k] - b.data[f * N_BANDS + k]);
      sum += d; allMax = Math.max(allMax, d);
      if (k < LOW_BANDS) lowMax = Math.max(lowMax, d);
    }
  return { frames, lowMax, allMax, allMean: sum / (frames * N_BANDS) };
}

const fmt = e => `low-band max ${e.lowMax.toExponential(2)}, all-band max ${e.allMax.toFixed(3)}, mean ${e.allMean.toFixed(4)} over ${e.frames} frames`;

/** Static server for the repo, so the page can import core/audio/*.mjs. */
function serve() {
  const srv = createServer((req, res) => {
    const path = normalize(join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
    if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<!doctype html><title>decode</title>'); }
    if (!path.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    try {
      const body = readFileSync(path);
      res.writeHead(200, { 'content-type': path.endsWith('.mjs') ? 'text/javascript' : 'application/octet-stream' });
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  return new Promise(ok => srv.listen(0, '127.0.0.1', () => ok(srv)));
}

test('Chromium decodes the synthetic MP3, whole and cut, to the reference mel', { skip, timeout: 120000 }, async t => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip(`Chromium would not launch: ${e.message.split('\n')[0]}`); return; }
  const srv = await serve();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${srv.address().port}/`);
    const got = await page.evaluate(async ({ head, mid }) => {
      const { decodeTo16k } = await import('/core/audio/decode.mjs');
      const whole = await (await fetch('/test/fixtures/synth-stereo-44k.mp3')).arrayBuffer();
      // The rejected alternative: decode at the native rate, then let a
      // 16 kHz OfflineAudioContext resample by rendering a buffer source.
      async function renderPath(buf) {
        const decoded = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(buf);
        const oc = new OfflineAudioContext(1, Math.floor(decoded.length * 16000 / decoded.sampleRate), 16000);
        const src = oc.createBufferSource(); src.buffer = decoded; src.connect(oc.destination); src.start();
        return (await oc.startRendering()).getChannelData(0);
      }
      const arr = x => Array.from(x);
      return {
        whole: arr(await decodeTo16k(whole.slice(0))),
        head: arr(await decodeTo16k(whole.slice(...head))),
        mid: arr(await decodeTo16k(whole.slice(...mid))),
        // The same window without decode.mjs's re-sync, left to Chromium's demuxer.
        midUntrimmed: await (async () => {
          const d = await new OfflineAudioContext(1, 1, 16000).decodeAudioData(whole.slice(...mid));
          const l = d.getChannelData(0), r = d.getChannelData(1);
          return Array.from(l, (v, i) => (v + r[i]) / 2);
        })(),
        renderWhole: arr(await renderPath(whole.slice(0))),
      };
    }, { head: HEAD_CUT, mid: MID_CUT });

    // Whole file: LAME's encoder delay and padding are in its Info tag, and
    // both decoders honour it, so the output is the original 4 s exactly.
    const whole = Float32Array.from(got.whole), refWhole = ffmpegRef(MP3);
    assert.equal(whole.length, resampledLength(FIXTURE_SAMPLES, 44100), 'gapless: encoder delay and padding trimmed');
    assert.equal(refWhole.length, whole.length);
    assert.equal(bestLag(whole, refWhole), 0, 'no offset against the reference');
    assert.equal(melFrames(whole).frames, frameCount(64000));
    const eWhole = melError(whole, refWhole);
    t.diagnostic(`whole file: ${fmt(eWhole)}`);

    // Cuts: no Info tag to trim by, so the decoder emits every complete frame
    // (the cut's last, partial frame is dropped; ffmpeg's CLI decodes it, so
    // its reference runs ~1 frame longer and the comparison uses the common
    // part). Cross-correlation confirms both start on the same sample.
    const cuts = {};
    for (const [name, [from, to]] of [['head', HEAD_CUT], ['mid', MID_CUT]]) {
      const x = Float32Array.from(got[name]), bytes = MP3.slice(from, to), ref = ffmpegRef(bytes);
      const s = scanFrames(bytes);
      if (name === 'mid') assert.equal(x.length, resampledLength(s.frames * s.samplesPerFrame, s.sampleRate), 'mid cut: complete frames × 1152, resampled');
      assert.ok(ref.length >= x.length && ref.length - x.length <= 420, `${name}: reference is at most one MP3 frame longer (${ref.length} vs ${x.length})`);
      assert.equal(bestLag(x, ref), 0, `${name}: aligned`);
      cuts[name] = melError(x, ref);
      t.diagnostic(`${name} cut bytes ${from}–${to}: ${x.length} samples, ${fmt(cuts[name])}`);
    }

    // The mid cut starts with decoder silence (its bit reservoir was cut
    // off), then matches the whole file at the offset cross-correlation finds.
    const mid = Float32Array.from(got.mid);
    let lead = 0; while (lead < mid.length && mid[lead] === 0) lead++;
    // A long span: with noise up to 8 kHz, a short one can peak a few samples off.
    const from = lead + 2048, span = 16000;
    let best = -Infinity, off = 0;
    for (let L = 0; L + span <= refWhole.length; L++) {
      let s = 0; for (let i = 0; i < span; i++) s += mid[from + i] * refWhole[L + i];
      if (s > best) { best = s; off = L - from; }
    }
    const steady = melError(mid.subarray(lead + 2048), refWhole.subarray(off + lead + 2048, off + mid.length));
    t.diagnostic(`mid cut: ${lead} leading zero samples (${(lead / 16).toFixed(0)} ms), sits ${(off / SAMPLE_RATE).toFixed(4)} s into the file; after warm-up vs the whole-file reference: ${fmt(steady)}`);
    assert.ok(lead < resampledLength(4 * 1152, 44100), 'warm-up silence is under four MP3 frames');
    assert.ok(steady.lowMax < 0.03, 'after warm-up the cut is the same audio as the whole file');
    // Chromium would have re-synced on its own; the trim is for decoders that don't, and changes nothing here.
    assert.equal(got.midUntrimmed.length, got.mid.length);
    assert.ok(got.midUntrimmed.every((v, i) => Math.abs(v - got.mid[i]) < 1e-6), 'trimmed and untrimmed decode identically');

    const eRender = melError(Float32Array.from(got.renderWhole), refWhole);
    t.diagnostic(`rejected render-resample path, whole file: ${fmt(eRender)}`);
    assert.ok(eRender.allMean > 2 * eWhole.allMean, 'decoding at 16 kHz beats rendering through a buffer source');

    for (const e of [eWhole, cuts.head, cuts.mid]) {
      assert.ok(e.lowMax < TOL.lowMax, `below 4 kHz: ${fmt(e)}`);
      assert.ok(e.allMean < TOL.allMean, `mean: ${fmt(e)}`);
      assert.ok(e.allMax < TOL.allMax, `max: ${fmt(e)}`);
    }
  } finally {
    await browser.close();
    srv.close();
  }
});
