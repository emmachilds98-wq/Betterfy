// Compressed preview bytes -> 16 kHz mono samples, the input core/audio/mel.mjs
// expects. Browser main thread only: OfflineAudioContext does not exist in
// workers, so the page decodes and posts the samples to the audio worker.
//
// How, and why this way (measured in test/audiodecode.test.mjs, numbers in
// docs/AUDIO-ANALYSIS-PLAN.md §0):
//
// - decodeAudioData runs on an OfflineAudioContext created AT 16 kHz, so the
//   browser's own resampler (a windowed-sinc in Chromium) does 44.1 -> 16 kHz
//   inside the decode. The obvious alternative — decode at the native rate,
//   then render an AudioBufferSourceNode through a 16 kHz OfflineAudioContext
//   — is three times further from the reference in Chromium, because a
//   buffer source converts rate by linear interpolation with no anti-alias
//   filter: noise above 8 kHz folds back into the top mel bands.
// - Channels are averaged ((L+R)/2), as Essentia's MonoLoader mixes. Not the
//   context's own downmix and not ffmpeg's `-ac 1`, which is (L+R)/√2.
// - A Range window cut from the middle of an MP3 starts mid-frame. It is
//   trimmed to the first run of chained Layer III frame headers before
//   decoding, so no browser has to rely on its demuxer's sync search. The
//   decoder still outputs ~80 ms of silence first (the bit reservoir the first
//   frames point into was cut off) — the same as ffmpeg/Essentia give for the
//   same bytes, so phase 0's partial-download numbers already include it.
//
// Pure helpers (downmix, frame scan, length maths) are exported so Node tests
// can hold them without a browser.

import { SAMPLE_RATE } from './mel.mjs';

export const DECODE_VERSION = '1.0.0';

// --- MPEG audio Layer III frame headers ---------------------------------

const BITRATES = {               // kbps by bitrate index; 0 (free) and 15 are invalid
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],   // MPEG-1 L3
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],       // MPEG-2/2.5 L3
};
const RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/**
 * Parse a Layer III frame header at byte `i`, or null if there isn't one.
 * @param {Uint8Array} u8
 * @returns {null | { version: number, sampleRate: number, frameLength: number, samplesPerFrame: number }}
 */
export function mp3FrameAt(u8, i) {
  if (i < 0 || i + 4 > u8.length) return null;
  const b1 = u8[i + 1], b2 = u8[i + 2];
  if (u8[i] !== 0xff || (b1 & 0xe0) !== 0xe0) return null;   // 11-bit sync
  const version = (b1 >> 3) & 3;                               // 3 = MPEG-1, 2 = MPEG-2, 0 = 2.5, 1 reserved
  if (version === 1 || ((b1 >> 1) & 3) !== 1) return null;      // Layer III only
  const bitrate = BITRATES[version === 3 ? 1 : 2][b2 >> 4];
  const rateIdx = (b2 >> 2) & 3;
  if (!bitrate || (b2 >> 4) === 15 || rateIdx === 3) return null;
  const sampleRate = RATES[version][rateIdx];
  const pad = (b2 >> 1) & 1;
  const mpeg1 = version === 3;
  const frameLength = Math.floor((mpeg1 ? 144000 : 72000) * bitrate / sampleRate) + pad;
  return { version, sampleRate, frameLength, samplesPerFrame: mpeg1 ? 1152 : 576 };
}

/** Frames that must chain (header -> next header) before an offset counts as in sync. */
export const SYNC_RUN = 3;

/**
 * Find where real MP3 frames start in a byte window, and count the complete
 * frames from there. A window starting with an ID3 tag, or already on a frame
 * boundary, gives offset 0. A false sync inside frame data has to survive
 * SYNC_RUN chained headers with the same version and sample rate, which
 * random bytes essentially never do.
 * @param {Uint8Array} u8
 * @returns {{ offset: number, frames: number, sampleRate: number, samplesPerFrame: number } | null}
 *   null when the bytes are not Layer III (or too short to tell); decode them untouched.
 */
export function scanFrames(u8) {
  if (u8.length >= 3 && u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33) {   // "ID3"
    // Tagged start: the browser's demuxer handles it; count frames after the tag.
    const size = u8.length >= 10 ? ((u8[6] & 0x7f) << 21 | (u8[7] & 0x7f) << 14 | (u8[8] & 0x7f) << 7 | (u8[9] & 0x7f)) + 10 : 0;
    const after = scanFrom(u8, size);
    return after && { ...after, offset: 0 };
  }
  return scanFrom(u8, 0);
}

function scanFrom(u8, from) {
  for (let i = from; i + 4 <= u8.length; i++) {
    const h = mp3FrameAt(u8, i);
    if (!h) continue;
    let j = i, run = 0;
    for (let f = h; f && f.version === h.version && f.sampleRate === h.sampleRate; f = mp3FrameAt(u8, j)) {
      j += f.frameLength; run++;
      if (j > u8.length) { run--; break; }       // last frame cut short: not complete
    }
    if (run >= SYNC_RUN) return { offset: i, frames: run, sampleRate: h.sampleRate, samplesPerFrame: h.samplesPerFrame };
  }
  return null;
}

// --- length maths and the downmix ------------------------------------------

/** Samples after converting `n` samples from `fromRate` (rounded down, as Chromium's decode resample does). */
export function resampledLength(n, fromRate, toRate = SAMPLE_RATE) {
  return Math.floor(n * toRate / fromRate);
}

/**
 * Average any number of equal-length channels into one new Float32Array.
 * @param {ArrayLike<number>[]} channels
 */
export function downmix(channels) {
  if (!channels.length) return new Float32Array(0);
  const n = channels[0].length, out = new Float32Array(n);
  if (channels.length === 1) { out.set(channels[0]); return out; }
  for (const ch of channels) {
    if (ch.length !== n) throw new Error('downmix: channels differ in length');
    for (let i = 0; i < n; i++) out[i] += ch[i];
  }
  const k = 1 / channels.length;
  for (let i = 0; i < n; i++) out[i] *= k;
  return out;
}

/** decodeAudioData in its promise form, falling back to the callback form older Safari has. */
function decodeOn(ctx, buf) {
  return new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(buf, resolve, reject);
    if (p && typeof p.then === 'function') p.then(resolve, reject);
  });
}

/**
 * Decode compressed audio (a whole file or a Range window of one) to 16 kHz
 * mono. The ArrayBuffer is handed to decodeAudioData, which detaches it:
 * don't use it afterwards.
 *
 * @param {ArrayBuffer} arrayBuffer
 * @param {{ audioContextCtor?: Function, offlineContextCtor?: Function }} [ctors]
 *   Injected for tests; default to the page's globals. The 16 kHz decode runs
 *   on an OfflineAudioContext; an AudioContext (constructed at 16 kHz and
 *   closed afterwards) is used only when no OfflineAudioContext is available.
 * @returns {Promise<Float32Array>}
 */
export async function decodeTo16k(arrayBuffer, { audioContextCtor, offlineContextCtor } = {}) {
  const Offline = offlineContextCtor ?? globalThis.OfflineAudioContext ?? globalThis.webkitOfflineAudioContext;
  const Live = audioContextCtor ?? globalThis.AudioContext ?? globalThis.webkitAudioContext;
  if (!Offline && !Live) throw new Error('decodeTo16k: no Web Audio context available');

  const scan = scanFrames(new Uint8Array(arrayBuffer));
  const bytes = scan && scan.offset > 0 ? arrayBuffer.slice(scan.offset) : arrayBuffer;

  let ctx, live = false;
  if (Offline) ctx = new Offline(1, 1, SAMPLE_RATE);
  else { ctx = new Live({ sampleRate: SAMPLE_RATE }); live = true; }
  try {
    const audio = await decodeOn(ctx, bytes);
    if (audio.sampleRate !== SAMPLE_RATE) throw new Error(`decodeTo16k: decoded at ${audio.sampleRate} Hz, not ${SAMPLE_RATE}`);
    const channels = [];
    for (let c = 0; c < audio.numberOfChannels; c++) channels.push(audio.getChannelData(c));
    return downmix(channels);
  } finally {
    if (live && typeof ctx.close === 'function') Promise.resolve(ctx.close()).catch(() => {});
  }
}
