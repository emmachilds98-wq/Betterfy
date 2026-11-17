// Log-frequency spectrogram for the learned key model (key v4, keynet).
//
// 16 kHz mono windows -> frames x KS_BINS log-magnitudes on a quarter-tone
// grid tied to A440, standardised per track. Isomorphic, no dependencies: the
// browser worker computes exactly what scripts/audio-dsp/keynet-features.mjs
// fed the training, so the model sees the same numbers in both places.
//
// Front end in the spirit of Korzeniowski & Widmer, "Genre-agnostic key
// classification with convolutional neural networks" (ISMIR 2018): STFT of
// ~0.5 s frames at 10 per second, triangular filters 24 per octave, log(1+x).
// The grid spans KS_MARGIN extra bins (6 semitones) either side of the
// KS_CROP bins the model reads, so training can transpose by shifting the
// crop; inference reads the centre crop.

export const KS_SR = 16000;
export const KS_N = 8192;          // 0.512 s, 1.95 Hz per bin
export const KS_HOP = 1600;        // 10 frames per second
export const KS_Q_LO = -78;        // quarter tones from A4: 46.2 Hz
export const KS_BINS = 129;        // up to quarter tone +50: 2960 Hz
export const KS_MARGIN = 12;       // ±6 semitones of crop shift
export const KS_CROP = KS_BINS - 2 * KS_MARGIN; // 105 bins, C2 (65.4 Hz) to C7

let tables = null;
function init() {
  if (tables) return tables;
  const N = KS_N, bits = Math.log2(N);
  const rev = new Uint32Array(N);
  for (let i = 0; i < N; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  const cos = new Float64Array(N / 2), sin = new Float64Array(N / 2);
  for (let i = 0; i < N / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / N); sin[i] = -Math.sin(2 * Math.PI * i / N); }
  const hann = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
  // Triangular filters: band b centred on 440·2^((KS_Q_LO+b)/24), feet on its
  // neighbours. Where bins are wider than the band (the bass), fall back to
  // linear interpolation at the centre so no band is empty.
  const binHz = KS_SR / N, filt = [];
  for (let b = 0; b < KS_BINS; b++) {
    const q = KS_Q_LO + b, fc = 440 * 2 ** (q / 24), fl = 440 * 2 ** ((q - 1) / 24), fu = 440 * 2 ** ((q + 1) / 24);
    const ks = [], ws = [];
    for (let k = Math.max(1, Math.floor(fl / binHz)); k <= Math.ceil(fu / binHz); k++) {
      const f = k * binHz;
      const w = f <= fc ? (f - fl) / (fc - fl) : (fu - f) / (fu - fc);
      if (w > 0) { ks.push(k); ws.push(w); }
    }
    let tot = ws.reduce((s, w) => s + w, 0);
    if (ks.length < 2) {
      const x = fc / binHz, k0 = Math.floor(x), t = x - k0;
      ks.length = 0; ws.length = 0; ks.push(k0, k0 + 1); ws.push(1 - t, t); tot = 1;
    }
    filt.push({ ks: Int32Array.from(ks), ws: Float64Array.from(ws, w => w / tot) });
  }
  tables = { rev, cos, sin, hann, filt };
  return tables;
}

function fftMag(re, im, mag, { rev, cos, sin }) {
  const n = KS_N;
  for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { const t = re[i]; re[i] = re[j]; re[j] = t; } im[i] = 0; }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let s = 0; s < n; s += size) for (let k = 0; k < half; k++) {
      const c = cos[k * step], sn = sin[k * step], a = s + k, b = a + half;
      const tr = re[b] * c - im[b] * sn, ti = re[b] * sn + im[b] * c;
      re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
    }
  }
  for (let k = 0; k <= n / 2; k++) mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
}

/**
 * Spectrogram of one or more contiguous 16 kHz windows, frames concatenated
 * in order, standardised over the whole thing (mean 0, sd 1).
 * @param {Float32Array|Float32Array[]} windows
 * @returns {{ data: Float32Array, frames: number, bins: number } | null} row-major [frame][bin]; null if too short or silent
 */
export function keySpec(windows) {
  const parts = (Array.isArray(windows) ? windows : [windows]).filter(w => w && w.length >= KS_N);
  if (!parts.length) return null;
  const t = init();
  const re = new Float64Array(KS_N), im = new Float64Array(KS_N), mag = new Float64Array(KS_N / 2 + 1);
  const rows = [];
  for (const x of parts) {
    const frames = Math.floor((x.length - KS_N) / KS_HOP) + 1;
    for (let f = 0; f < frames; f++) {
      const s = f * KS_HOP;
      for (let i = 0; i < KS_N; i++) re[i] = x[s + i] * t.hann[i];
      fftMag(re, im, mag, t);
      const row = new Float32Array(KS_BINS);
      for (let b = 0; b < KS_BINS; b++) {
        const { ks, ws } = t.filt[b];
        let v = 0; for (let j = 0; j < ks.length; j++) v += mag[ks[j]] * ws[j];
        row[b] = Math.log1p(v);
      }
      rows.push(row);
    }
  }
  const data = new Float32Array(rows.length * KS_BINS);
  rows.forEach((r, i) => data.set(r, i * KS_BINS));
  let m = 0; for (const v of data) m += v; m /= data.length;
  let sd = 0; for (const v of data) sd += (v - m) ** 2; sd = Math.sqrt(sd / data.length);
  if (!(sd > 1e-6)) return null;
  for (let i = 0; i < data.length; i++) data[i] = (data[i] - m) / sd;
  return { data, frames: rows.length, bins: KS_BINS };
}
