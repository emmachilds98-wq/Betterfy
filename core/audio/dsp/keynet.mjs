// Key v4: a small learned key model, blended with the v3 chroma key.
//
// Why: v3 (key.mjs, hand-built chroma + a linear key model) is saturated at
// 55% exact on the held-out half of the Beatport EDM Key set, so only keys at
// keyConf >= 0.65 were shown (53% of tracks). The two make different
// mistakes, so blending them gives a confidence that is right more often:
// at the same bar (>= 60% exact, >= 70% MIREX) the key is now sure on 85% of
// tracks. Measured, and how it was trained: docs/BUILD-5-PROGRESS.md
// "Key v4".
//
// The model (docs/models/keynet-v4.onnx, ~1 MB, trained here, CC BY-SA 4.0
// like the dataset it learned from; see docs/models/LICENSE-KEYNET) is five small all-convolutional nets (after
// Korzeniowski & Widmer, ISMIR 2018), one per training fold, averaged inside
// the graph. It reads keyspec.mjs's log-frequency spectrogram of the preview
// windows and gives 24 log-probabilities (class = mode·12 + tonic, major
// 0–11, minor 12–23). The blend adds KEYNET_DSP_W × the v3 log-probabilities.
//
// keyConf on a v4 reading is the blended best probability rescaled so that
// KEYNET_SURE_P lands exactly on match.mjs's KEY_MIN_CONF (0.65): every
// consumer keeps its one threshold, and "sure" means the measured gate.
//
// `ort` is injected, as in beats.mjs.

import { keySpec, KS_BINS, KS_MARGIN, KS_CROP } from './keyspec.mjs';
import { chromagram, rankKeys, CAMELOT, pitchClass, toCamelot } from './key.mjs';

export const KEYNET_VERSION = '4.0.0';
export const KEYNET_MODEL_FILE = 'keynet-v4.onnx';
/** Weight of the v3 chroma key's log-probabilities in the blend (fitted on half A). */
export const KEYNET_DSP_W = 0.5;
/** Blended best probability at which a key counts as sure (picked on half A: the lowest that clears the bar + 4 points). */
export const KEYNET_SURE_P = 0.4;
/** keyConf that means sure (match.mjs KEY_MIN_CONF, dsp-view.mjs KEY_MIN_CONF). */
const SURE_CONF = 0.65;
/** Heard records given v4 per start(); ~0.3 s each on a laptop. */
export const KEYNET_FILL_PER_RUN = 60;

/** Class index (mode·12 + pc) → Camelot code. */
export const CLASS_CAMELOT = Object.freeze(Array.from({ length: 24 }, (_, i) => toCamelot(i % 12, i < 12 ? 'major' : 'minor')));
const classOf = camelot => { const k = CAMELOT[camelot]; return (k.mode === 'minor' ? 12 : 0) + pitchClass(k.tonic); };
const r3 = x => Math.round(x * 1000) / 1000;

/** The centre crop of a keySpec, as the model reads it: Float32Array [frames × KS_CROP]. */
export function centreCrop(spec) {
  const out = new Float32Array(spec.frames * KS_CROP);
  for (let f = 0; f < spec.frames; f++) out.set(spec.data.subarray(f * KS_BINS + KS_MARGIN, f * KS_BINS + KS_MARGIN + KS_CROP), f * KS_CROP);
  return out;
}

/** v3's 24 log-probabilities (class order) for the same windows. */
export function dspLogProbs(windows) {
  const lp = new Float64Array(24).fill(Math.log(1e-6));
  for (const r of rankKeys(chromagram(windows).chroma)) lp[classOf(r.camelot)] = Math.log(Math.max(1e-6, r.p));
  return lp;
}

/**
 * Blend the model's and v3's log-probabilities into one key reading.
 * @param {ArrayLike<number>} netLogp  24
 * @param {ArrayLike<number>} dspLogp  24
 * @returns {{ key: string, camelot: string, keyConf: number, keyP: number, keyAlt: string }}
 */
export function blendKey(netLogp, dspLogp, w = KEYNET_DSP_W) {
  const s = Array.from({ length: 24 }, (_, i) => netLogp[i] + w * dspLogp[i]);
  const mx = Math.max(...s);
  const p = s.map(v => Math.exp(v - mx)); const z = p.reduce((a, b) => a + b, 0);
  const order = p.map((v, i) => [v / z, i]).sort((a, b) => b[0] - a[0]);
  const [best, i] = order[0];
  const camelot = CLASS_CAMELOT[i];
  return { key: CAMELOT[camelot].key, camelot, keyP: r3(best), keyConf: r3(Math.min(1, best * SURE_CONF / KEYNET_SURE_P)),
           keyAlt: CLASS_CAMELOT[order[1][1]] };
}

/**
 * Load the model on an ONNX session.
 * @returns {Promise<{ logp(windows: Float32Array[]): Promise<Float32Array|null>, release(): Promise<void> }>}
 */
export async function createKeyNet({ ort, modelUrl = `models/${KEYNET_MODEL_FILE}`, sessionOptions } = {}) {
  if (!ort?.InferenceSession) throw new Error('createKeyNet needs ort');
  const session = await ort.InferenceSession.create(modelUrl, sessionOptions ?? { executionProviders: ['wasm'] });
  return {
    async logp(windows) {
      const spec = keySpec(windows);
      if (!spec) return null;
      const res = await session.run({ spec: new ort.Tensor('float32', centreCrop(spec), [1, spec.frames, KS_CROP]) });
      return Float32Array.from(res.logp.data);
    },
    async release() { await session.release?.(); },
  };
}

/**
 * Wrap a dsp (combine.mjs measureWindows, or withBeats's) so the key is v4's.
 * The result is the same `dsp` with key, camelot, keyConf and keyAlt from the
 * blend, `keyNetV`, and v3's own reading kept as keyV3 / keyV3Conf. If the
 * model fails or hears nothing, the dsp comes back as it was, without
 * keyNetV, so a later run tries again (needsKeyNet()).
 * @param {(windows: Float32Array[]) => object|null|Promise<object|null>} dsp
 * @param {{ logp(windows: Float32Array[]): Promise<ArrayLike<number>|null> } | null} net
 */
export function withKeyNet(dsp, net) {
  return async windows => {
    const d = await dsp(windows);
    if (!d || !net) return d;
    const f = await keyNetFields(net, windows, d);
    return f ? { ...d, ...f } : d;
  };
}

/**
 * Just the key fields v4 sets, for windows whose dsp is `d` (v3's reading
 * is kept from it). null when the model fails or hears nothing.
 */
export async function keyNetFields(net, windows, d = null) {
  let lp;
  try { lp = await net.logp(windows); } catch { return null; }
  if (!lp || lp.length !== 24) return null;
  const b = blendKey(lp, dspLogProbs(windows));
  const v3 = d?.keyNetV ? (d.keyV3 ? { keyV3: d.keyV3, keyV3Conf: d.keyV3Conf } : {})
                        : (d?.camelot ? { keyV3: d.camelot, keyV3Conf: d.keyConf } : {});
  return { key: b.key, camelot: b.camelot, keyConf: b.keyConf, keyAlt: b.keyAlt, keyNetV: KEYNET_VERSION, ...v3 };
}

const KEY_FIELDS = ['key', 'camelot', 'keyConf', 'keyAlt', 'keyAgree', 'keyNetV', 'keyV3', 'keyV3Conf'];
/**
 * A re-measured dsp (Beat This, a new DSP_VERSION) made without the model
 * loses v4's key; the recording is the same, so carry v4's key over from
 * the dsp it replaces.
 */
export function keepKeyNet(oldDsp, newDsp) {
  if (!newDsp || newDsp.keyNetV || oldDsp?.keyNetV !== KEYNET_VERSION) return newDsp;
  const out = { ...newDsp };
  for (const k of KEY_FIELDS) { if (k in oldDsp) out[k] = oldDsp[k]; else delete out[k]; }
  return out;
}

/** Does this record have a dsp whose key v4 hasn't heard yet? */
export function needsKeyNet(rec) {
  return !!rec?.dsp && !rec.miss && rec.dsp.keyNetV !== KEYNET_VERSION;
}
