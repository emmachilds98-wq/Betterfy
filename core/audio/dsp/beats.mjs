// Beats, downbeats and a beat-derived tempo from Beat This, and the
// half/double-time decision D1 can't make on its own (BUILD-5-PLAN §6.2).
//
// D1 (tempo.mjs) is right to ±1 BPM on 80% of the Beatport set, and most of
// what it gets wrong is the octave: 87 for 174, 140 for 70. The periodicity
// of a pulse train really is the same at T and T/2, so no autocorrelation
// can settle it; a model that has heard where people tap can. Beat This
// (Foscarin, Schlüter, Widmer, ISMIR 2024; MIT code and weights, `small0`
// checkpoint, ~10 MB as ONNX) gives a beat and a downbeat activation per
// 20 ms frame, and the spacing of its beats is the tempo level it heard.
//
// So the two are combined, each for what it is good at:
//   - D1 keeps the number (its ±1 BPM precision comes from every harmonic in
//     the autocorrelation; 20 ms beat frames are coarser than that);
//   - Beat This picks the level: when its beats are clearly at D1's tempo ×2
//     or ×½ the record moves there, and when they agree with D1 the
//     ambiguity flag is cleared.
// Measured on the Beatport set before it shipped: docs/models/beat-this.md.
//
// Pipeline per preview window (contiguous 16 kHz audio, as combine.mjs
// gets it): upsample to 22050 Hz → beat-mel.mjs → the ONNX graph (zero-padded
// by BORDER frames each side, as beat_this/inference.py does) → peak picking
// exactly as beat_this's "minimal" postprocessor (max over ±3 frames, logit
// above 0, adjacent peaks merged, downbeats snapped to the nearest beat).
//
// `ort` is injected, as in infer.mjs: onnxruntime-web in the page,
// onnxruntime-node in scripts, a fake session in tests. The model URL is
// configurable (BEAT_MODEL_URL is only the default), so the file can be
// hosted anywhere.

import { beatMel, resampleSinc, BEAT_SR, BEAT_FPS, BEAT_BANDS } from './beat-mel.mjs';
import { SAMPLE_RATE } from '../mel.mjs';

export const BEATS_VERSION = '1.0.0';
/** Default model location, relative to the page (docs/). Override with createBeatTracker({ modelUrl }). */
export const BEAT_MODEL_URL = 'models/beat-this-small0.onnx';
/** The file under models/ (self-hosted, MIT, ~10 MB), as the other ears' *_FILE constants. */
export const BEAT_MODEL_FILE = 'beat-this-small0.onnx';
/** Flagged records given Beat This per start(): ~1 s each on a laptop, so a run stays short. */
export const BEATS_FILL_PER_RUN = 40;
/** Frames of zero padding each side; the model was not trained on its edges. */
export const BORDER = 6;
/** Beats within this fraction of a level count as that level. */
export const LEVEL_TOL = 0.04;
/** Fewer beats than this in a window: no beat tempo. */
const MIN_BEATS = 6;
/** Share of inter-beat intervals near the median below this: too irregular to judge. */
const MIN_REGULARITY = 0.6;

const r1 = x => Math.round(x * 10) / 10;
const r3 = x => Math.round(x * 1000) / 1000;
const ok = x => typeof x === 'number' && Number.isFinite(x);

/**
 * beat_this "minimal" postprocessing for one piece.
 * @param {Float32Array|number[]} beat      logits per frame
 * @param {Float32Array|number[]} downbeat  logits per frame
 * @param {number} [fps]
 * @returns {{ beats: number[], downbeats: number[] }} times in seconds
 */
export function pickBeats(beat, downbeat, fps = BEAT_FPS) {
  const frames = l => {
    const n = l.length, idx = [];
    for (let i = 0; i < n; i++) {
      const v = l[i];
      if (!(v > 0)) continue;
      let m = -Infinity;
      for (let j = Math.max(0, i - 3); j <= Math.min(n - 1, i + 3); j++) if (l[j] > m) m = l[j];
      if (v === m) idx.push(i);
    }
    // merge runs of adjacent frames into their running mean (deduplicate_peaks, width 1)
    const out = [];
    let p = null, c = 0;
    for (const q of idx) {
      if (p !== null && q - p <= 1) { c++; p += (q - p) / c; }
      else { if (p !== null) out.push(p); p = q; c = 1; }
    }
    if (p !== null) out.push(p);
    return out;
  };
  const beats = frames(beat).map(f => f / fps);
  let downbeats = frames(downbeat).map(f => f / fps);
  if (beats.length) {
    downbeats = downbeats.map(d => {
      let best = beats[0];
      for (const b of beats) if (Math.abs(b - d) < Math.abs(best - d)) best = b;
      return best;
    });
    downbeats = [...new Set(downbeats)].sort((a, b) => a - b);
  }
  return { beats, downbeats };
}

/**
 * Tempo from beat times: the median two-beat span, halved, refined by a
 * least-squares line through the beats that sit on its grid.
 * @param {number[]} beats seconds, ascending
 * @returns {{ bpm: number|null, regularity: number, n: number }}
 *   `regularity` is the share of intervals within 10% of the median (0–1).
 */
export function tempoFromBeats(beats) {
  const b = (beats ?? []).filter(ok);
  if (b.length < MIN_BEATS) return { bpm: null, regularity: 0, n: b.length };
  const ibi = [], two = [];
  for (let i = 1; i < b.length; i++) ibi.push(b[i] - b[i - 1]);
  for (let i = 2; i < b.length; i++) two.push((b[i] - b[i - 2]) / 2);
  // median of two-beat spans: robust to swing (long-short pairs) as well as
  // to a missed or doubled beat
  const med = two.sort((x, y) => x - y)[Math.floor(two.length / 2)];
  if (!(med > 0)) return { bpm: null, regularity: 0, n: b.length };
  const regularity = ibi.filter(d => Math.abs(d - med) <= 0.1 * med).length / ibi.length;
  // fit t = a + k·P on the beats within a quarter period of their grid slot,
  // re-assigning grid slots from the last fit
  let P = med, a = b[0];
  for (let pass = 0; pass < 3; pass++) {
    const pts = [];
    for (const t of b) { const k = Math.round((t - a) / P); if (Math.abs(t - (a + k * P)) <= 0.25 * P) pts.push([k, t]); }
    if (pts.length < MIN_BEATS) break;
    const n = pts.length, mk = pts.reduce((s, p) => s + p[0], 0) / n, mt = pts.reduce((s, p) => s + p[1], 0) / n;
    let sxy = 0, sxx = 0;
    for (const [k, t] of pts) { sxy += (k - mk) * (t - mt); sxx += (k - mk) ** 2; }
    if (!(sxx > 0)) break;
    P = sxy / sxx; a = mt - P * mk;
  }
  return { bpm: r1(60 / P), regularity: r3(regularity), n: b.length };
}

/**
 * Combine per-window beat tempi: windows that agree (within LEVEL_TOL) pool;
 * otherwise the more regular window wins.
 * @param {{ bpm: number|null, regularity: number }[]} ws
 * @returns {{ bpm: number, regularity: number } | null}
 */
export function combineBeatTempo(ws) {
  const good = (ws ?? []).filter(w => w && ok(w.bpm) && w.regularity >= MIN_REGULARITY);
  if (!good.length) return null;
  good.sort((a, b) => b.regularity - a.regularity);
  const a = good[0];
  const same = good.filter(w => Math.abs(w.bpm / a.bpm - 1) <= LEVEL_TOL);
  const bpm = same.reduce((s, w) => s + w.bpm, 0) / same.length;
  return { bpm: r1(bpm), regularity: a.regularity, windows: same.length };
}

/**
 * The half/double-time decision. `dsp` is combine.mjs's output (bpm,
 * bpmConf, octaveAmbiguous, bpmAlt); `beat` is combineBeatTempo()'s.
 * Returns a new dsp: the same object when Beat This has nothing to say.
 *
 *   beats at D1's level         → kept; octaveAmbiguous cleared
 *   beats at ×2 or ×½ D1's      → bpm moves to that level (bpmAlt when it is
 *                                  that partner, else exactly ×2/×½); the old
 *                                  value becomes bpmAlt; octaveAmbiguous cleared
 *   anything else               → unchanged
 * `onlyAmbiguous` restricts changes to records D1 already flagged.
 */
export function resolveOctave(dsp, beat, { onlyAmbiguous = false } = {}) {
  if (!dsp || !ok(dsp.bpm) || !beat || !ok(beat.bpm)) return dsp;
  if (onlyAmbiguous && !dsp.octaveAmbiguous) return dsp;
  const near = (x, y) => Math.abs(x / y - 1) <= LEVEL_TOL;
  const out = { ...dsp, beatBpm: beat.bpm };
  if (near(beat.bpm, dsp.bpm)) {
    out.octaveAmbiguous = false;
    out.octaveBy = 'beats';
    return out;
  }
  for (const k of [2, 0.5]) {
    const level = dsp.bpm * k;
    if (!near(beat.bpm, level)) continue;
    const alt = ok(dsp.bpmAlt) && near(dsp.bpmAlt, level) ? dsp.bpmAlt : r1(level);
    out.bpmAlt = dsp.bpm;
    out.bpm = alt;
    out.octaveAmbiguous = false;
    out.octaveBy = 'beats';
    return out;
  }
  return dsp;
}

/**
 * Create a beat tracker on an ONNX session.
 * @param {{ ort: { InferenceSession: { create(url: string|Uint8Array, opts?: object): Promise<any> }, Tensor: any },
 *           modelUrl?: string|Uint8Array, sessionOptions?: object }} o
 * @returns {Promise<{ run(samples16k: Float32Array, sampleRate?: number): Promise<{ beats: number[], downbeats: number[], tempo: object }>,
 *                     measure(windows: Float32Array[]): Promise<object|null>, release(): Promise<void> }>}
 */
export async function createBeatTracker({ ort, modelUrl = BEAT_MODEL_URL, sessionOptions } = {}) {
  if (!ort?.InferenceSession) throw new Error('createBeatTracker needs ort');
  const session = await ort.InferenceSession.create(modelUrl, sessionOptions ?? { executionProviders: ['wasm'] });
  const inName = session.inputNames?.[0] ?? 'input_spectrogram';
  const run = async (samples, sampleRate = SAMPLE_RATE) => {
    const x = resampleSinc(samples, sampleRate, BEAT_SR);
    const { frames, data } = beatMel(x);
    if (frames < 2 * BEAT_FPS) return { beats: [], downbeats: [], tempo: { bpm: null, regularity: 0, n: 0 } };
    const T = frames + 2 * BORDER;
    const padded = new Float32Array(T * BEAT_BANDS);
    padded.set(data, BORDER * BEAT_BANDS);
    const res = await session.run({ [inName]: new ort.Tensor('float32', padded, [1, T, BEAT_BANDS]) });
    const beat = res.beat.data.subarray(BORDER, BORDER + frames);
    const down = res.downbeat.data.subarray(BORDER, BORDER + frames);
    const picked = pickBeats(beat, down);
    return { ...picked, tempo: tempoFromBeats(picked.beats) };
  };
  return {
    run,
    /** Beat tempo over preview windows (combine.mjs's input), combined. */
    async measure(windows) {
      const ts = [];
      for (const w of windows ?? []) {
        if (!w?.length) continue;
        try { ts.push((await run(w)).tempo); } catch { /* one bad window never fails the track */ }
      }
      return combineBeatTempo(ts);
    },
    async release() { await session.release?.(); },
  };
}

/**
 * Wrap a synchronous dsp (combine.mjs measureWindows) so Beat This settles
 * the tempo level. The result is still the record's `dsp` (same `v`), with
 * `beatsV` once Beat This has listened, and `beatBpm` / `octaveBy: 'beats'`
 * when it had something to say. If the tracker throws (no model, no WASM),
 * the result is exactly what `dsp` returned, without `beatsV`, so a later
 * run tries again (needsBeats()).
 * @param {(windows: Float32Array[]) => object|null} dsp
 * @param {{ measure(windows: Float32Array[]): Promise<object|null> } | null} tracker
 * @param {{ onlyAmbiguous?: boolean }} [opts]
 * @returns {(windows: Float32Array[]) => Promise<object|null>}
 */
export function withBeats(dsp, tracker, opts) {
  return async windows => {
    const d = await dsp(windows);   // may itself be async (keynet.mjs withKeyNet)
    if (!d || !ok(d.bpm) || !tracker) return d;
    let beat;
    try { beat = await tracker.measure(windows); } catch { return d; }
    return { ...resolveOctave(d, beat, opts), beatsV: BEATS_VERSION };
  };
}

/**
 * Beat This runs only where the DSP is unsure of the half/double-time level
 * (BUILD-5-PROGRESS.md: flagged-only 82.7% ±1 BPM, 43 octave errors, against the
 * DSP's 80.9% / 50; run on every record it was 81.1% / 49). Needs it: a tempo
 * flagged octave-ambiguous that Beat This hasn't listened to yet.
 */
export function needsBeatsFlagged(rec) {
  return needsBeats(rec) && rec.dsp.octaveAmbiguous === true;
}

/** Does this record have a tempo that Beat This hasn't listened to yet (this BEATS_VERSION)? */
export function needsBeats(rec) {
  return !!rec?.dsp && ok(rec.dsp.bpm) && rec.dsp.beatsV !== BEATS_VERSION;
}
