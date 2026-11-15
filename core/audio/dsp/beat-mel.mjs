// The log-mel front end for Beat This (core/audio/dsp/beats.mjs), in plain JS.
//
// Beat This (Foscarin, Schlüter, Widmer, ISMIR 2024; MIT code and weights)
// was trained on one exact spectrogram, beat_this/preprocessing.py
// LogMelSpect, which is torchaudio's MelSpectrogram with:
//   22050 Hz mono · n_fft 1024 · hop 441 (50 frames/s) · periodic Hann
//   · center=True with reflect padding · |STFT| / sqrt(n_fft) (normalized=
//   "frame_length", power 1) · 128 Slaney-mel triangles, 30–11000 Hz, no
//   area normalisation · log1p(1000·x)
// A front end that is only roughly right still gives beats, just worse ones,
// so this file is held to torchaudio's own output by test/audiobeats.test.mjs
// (fixture: scripts/audio-dsp/make-beat-mel-fixture.py).
//
// Betterfy decodes previews to 16 kHz (core/audio/decode.mjs), so the input
// is upsampled to 22050 Hz here with a windowed-sinc resampler. Nothing above
// 8 kHz exists after that, so the top ~20 of the 128 bands stay near zero;
// docs/models/beat-this.md has the measured cost of that (it is small).
//
// Isomorphic: no DOM, no Node APIs, no dependencies.

export const BEAT_MEL_VERSION = '1.0.0';
export const BEAT_SR = 22050;
export const BEAT_NFFT = 1024;
export const BEAT_HOP = 441;
export const BEAT_BANDS = 128;
/** Spectrogram (and model output) frames per second. */
export const BEAT_FPS = BEAT_SR / BEAT_HOP; // 50

const F_MIN = 30, F_MAX = 11000, LOG_MULT = 1000;
const N_BINS = BEAT_NFFT / 2 + 1;

// --- Slaney mel scale, as torchaudio's mel_scale="slaney" ---
const LOG_STEP = Math.log(6.4) / 27;
const hzToMel = f => (f < 1000 ? f / (200 / 3) : 15 + Math.log(f / 1000) / LOG_STEP);
const melToHz = m => (m < 15 ? m * (200 / 3) : 1000 * Math.exp((m - 15) * LOG_STEP));

/** torchaudio.functional.melscale_fbanks(513, 30, 11000, 128, 22050, norm=None, 'slaney'), sparse. */
function buildFilterbank() {
  const lo = hzToMel(F_MIN), hi = hzToMel(F_MAX);
  const f = Array.from({ length: BEAT_BANDS + 2 }, (_, i) => melToHz(lo + (hi - lo) * i / (BEAT_BANDS + 1)));
  const bands = [];
  for (let b = 0; b < BEAT_BANDS; b++) {
    const w = [];
    let start = -1;
    for (let k = 0; k < N_BINS; k++) {
      const hz = k * (BEAT_SR / 2) / (N_BINS - 1);
      const down = (hz - f[b]) / (f[b + 1] - f[b]);
      const up = (f[b + 2] - hz) / (f[b + 2] - f[b + 1]);
      const v = Math.max(0, Math.min(down, up));
      if (v > 0) { if (start < 0) start = k; w[k - start] = v; }
      else if (start >= 0) break;
    }
    bands.push({ start: Math.max(0, start), w: Float64Array.from(w.map(x => x ?? 0)) });
  }
  return bands;
}

let FB = null, WIN = null, TW = null, REV = null;
function init() {
  if (FB) return;
  FB = buildFilterbank();
  // periodic Hann (torch.hann_window default)
  WIN = new Float64Array(BEAT_NFFT);
  for (let i = 0; i < BEAT_NFFT; i++) WIN[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / BEAT_NFFT);
  TW = new Float64Array(BEAT_NFFT);
  for (let i = 0; i < BEAT_NFFT / 2; i++) { TW[2 * i] = Math.cos(-2 * Math.PI * i / BEAT_NFFT); TW[2 * i + 1] = Math.sin(-2 * Math.PI * i / BEAT_NFFT); }
  REV = new Uint32Array(BEAT_NFFT);
  const bits = Math.log2(BEAT_NFFT);
  for (let i = 0; i < BEAT_NFFT; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); REV[i] = r; }
}

/** In-place radix-2 complex FFT of length BEAT_NFFT. */
function fft(re, im) {
  const n = BEAT_NFFT;
  for (let i = 0; i < n; i++) { const j = REV[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let size = 2; size <= n; size *= 2) {
    const half = size / 2, step = n / size;
    for (let s = 0; s < n; s += size) {
      for (let k = 0; k < half; k++) {
        const wr = TW[2 * k * step], wi = TW[2 * k * step + 1];
        const a = s + k, b = a + half;
        const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
      }
    }
  }
}

/** Number of frames torchaudio gives for n samples with center=True. */
export const beatFrameCount = n => (n > 0 ? 1 + Math.floor(n / BEAT_HOP) : 0);

/**
 * Log-mel spectrogram of 22050 Hz mono samples, row-major [frames × 128].
 * @param {Float32Array|number[]} x
 * @returns {{ frames: number, data: Float32Array }}
 */
export function beatMel(x) {
  init();
  const n = x.length, pad = BEAT_NFFT / 2;
  if (n <= pad) return { frames: 0, data: new Float32Array(0) };
  const frames = beatFrameCount(n);
  // reflect padding (torch: no edge repeat)
  const at = i => (i < 0 ? x[-i] : i >= n ? x[2 * (n - 1) - i] : x[i]);
  const out = new Float32Array(frames * BEAT_BANDS);
  const re = new Float64Array(BEAT_NFFT), im = new Float64Array(BEAT_NFFT), mag = new Float64Array(N_BINS);
  const norm = 1 / Math.sqrt(BEAT_NFFT);
  for (let f = 0; f < frames; f++) {
    const s0 = f * BEAT_HOP - pad;
    for (let i = 0; i < BEAT_NFFT; i++) { re[i] = at(s0 + i) * WIN[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k < N_BINS; k++) mag[k] = Math.hypot(re[k], im[k]) * norm;
    const o = f * BEAT_BANDS;
    for (let b = 0; b < BEAT_BANDS; b++) {
      const { start, w } = FB[b];
      let s = 0;
      for (let j = 0; j < w.length; j++) s += w[j] * mag[start + j];
      out[o + b] = Math.log1p(LOG_MULT * s);
    }
  }
  return { frames, data: out };
}

// --- 16 kHz → 22050 Hz: windowed-sinc (Blackman), cutoff just under 8 kHz ---
const RS_HALF = 16; // taps each side, at the input rate

/**
 * Resample mono audio between rates with a Blackman-windowed sinc.
 * Upsampling keeps everything below the source Nyquist; downsampling
 * low-passes at the target Nyquist.
 * @param {Float32Array|number[]} x
 * @param {number} from
 * @param {number} to
 * @returns {Float32Array}
 */
export function resampleSinc(x, from, to) {
  if (from === to) return Float32Array.from(x);
  const n = Math.floor(x.length * to / from), out = new Float32Array(n);
  const ratio = from / to;                       // input samples per output sample
  const cut = Math.min(1, 1 / ratio) * 0.97;     // fraction of input Nyquist
  const half = Math.ceil(RS_HALF / Math.min(1, cut));
  for (let i = 0; i < n; i++) {
    const p = i * ratio, c = Math.floor(p);
    let s = 0, ws = 0;
    for (let j = c - half + 1; j <= c + half; j++) {
      const t = p - j;
      const u = t / (half + 1);
      if (u <= -1 || u >= 1) continue;
      const win = 0.42 + 0.5 * Math.cos(Math.PI * u) + 0.08 * Math.cos(2 * Math.PI * u);
      const a = Math.PI * cut * t;
      const h = (a === 0 ? 1 : Math.sin(a) / a) * win;
      ws += h;
      if (j >= 0 && j < x.length) s += x[j] * h;
    }
    out[i] = ws ? s / ws : 0;
  }
  return out;
}
