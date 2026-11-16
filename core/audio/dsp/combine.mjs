// Tempo, key and loudness for one track, measured per preview window and
// combined (WP-D4, docs/AUDIO-BUILD-PLAN.md).
//
// Why per window: fetch.mjs takes two windows from a 30 s preview and the
// worker joins them for the model. The join is a hard cut in the middle of
// the audio, so a beat tracker or chroma run over the joined samples sees a
// skipped beat and possibly a different section of the song. Each window is
// contiguous audio, so each is measured on its own and the two answers are
// reconciled here:
//   - tempo: within ±BPM_AGREE the two agree and the answer is their
//     confidence-weighted mean; a 2:1 ratio is the half/double-time failure
//     that matters (music-dna.mjs measured()), so it keeps the more confident
//     window, lowers the confidence and marks the result octave-ambiguous with
//     the other reading as `bpmAlt`; any other disagreement keeps the more
//     confident window and lowers the confidence. D1's own `octaveAmbiguous`
//     on the kept window is never dropped.
//   - key: the same key agrees; otherwise the more confident window wins and
//     its confidence is lowered.
//   - loudness: averaged in the power domain, energy averaged. Energy is
//     stored but not shown (unchecked on real previews).
//
// Every estimator runs under its own try: one that throws leaves only its own
// fields out, never the others, and never fails the track (DSP is a bonus).
//
// Not measured on real music yet. The page shows none of this until the
// Rekordbox comparison is in AUDIO-ANALYSIS-PLAN.md §0 and passes (see
// web/audio/dsp-view.mjs, DSP_UI_DEFAULT).

import { tempo as tempoOf, TEMPO_VERSION } from './tempo.mjs';
import { key as keyOf, KEY_VERSION } from './key.mjs';
import { loudness as loudnessOf, LOUDNESS_VERSION } from './loudness.mjs';

export const COMBINE_VERSION = '1.1.0';
/** Stored as `dsp.v`; a record whose dsp.v differs is re-measured lazily, never invalidated. */
export const DSP_VERSION = `${COMBINE_VERSION}+t${TEMPO_VERSION}+k${KEY_VERSION}+l${LOUDNESS_VERSION}`;

/**
 * A combined tempo under this many BPM is read at double time (×2, while that
 * stays ≤ 200). The D1 search spans 60–200 with a prior at 120, and its most
 * common octave error on dance music is a 124–145 track heard at half time
 * (64 for house, 70 for dubstep). Fitted on the Beatport EDM Key set's half A
 * (scripts/audio-dsp/keytempo-lab.mjs); on the held-out half B (n=387) it
 * takes ±1 BPM from 80.9% (±3.9) to 88.9% (±3.1), octave errors 50 → 19
 * (docs/BUILD-5-PROGRESS.md, 2026-11-16). Only slow readings are moved: a
 * DnB 174 stays 174.
 */
export const SLOW_FOLD = 74;
/** Two windows within this many BPM agree. */
export const BPM_AGREE = 1;
/** How far a ratio may sit from exactly 2 (in BPM at the slower tempo) and still count as half/double time. */
const OCTAVE_SLACK = 1.5;
/** Confidence multiplier when the windows disagree. */
export const DISAGREE_PENALTY = 0.5;
/** Confidence multiplier when they disagree by an octave: the tempo family is right, the level unsure. */
export const OCTAVE_PENALTY = 0.75;

const r1 = x => Math.round(x * 10) / 10;
const r2 = x => Math.round(x * 100) / 100;
const r3 = x => Math.round(x * 1000) / 1000;
const ok = x => typeof x === 'number' && Number.isFinite(x);

/** Is b half or double a (within slack)? */
function octaveApart(a, b) {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return Math.abs(hi - 2 * lo) <= OCTAVE_SLACK;
}

/**
 * Reconcile per-window tempo results (tempo.mjs shape).
 * @param {Array<{ bpm: number|null, confidence: number, alternates?: {bpm:number,score:number}[], octaveAmbiguous?: boolean }>} ws
 * @returns {{ bpm: number, bpmConf: number, octaveAmbiguous: boolean, bpmAlt?: number, agree: boolean|null } | null}
 */
export function combineTempo(ws) {
  const good = (ws ?? []).filter(w => w && ok(w.bpm) && w.bpm > 0 && ok(w.confidence));
  if (!good.length) return null;
  const partnerOf = w => {
    const p = (w.alternates ?? []).find(a => ok(a?.bpm) && octaveApart(w.bpm, a.bpm));
    return p ? p.bpm : null;
  };
  const finish = (w, bpm, conf, octave, alt, agree) => {
    let a = octave ? alt ?? partnerOf(w) : null;
    if (bpm < SLOW_FOLD && bpm * 2 <= 200) { a = octave ? bpm : null; bpm *= 2; }
    const out = { bpm: r1(bpm), bpmConf: r3(Math.max(0, Math.min(1, conf))), octaveAmbiguous: !!octave, agree };
    if (octave && ok(a)) out.bpmAlt = r1(a);
    return out;
  };
  if (good.length === 1) { const w = good[0]; return finish(w, w.bpm, w.confidence, w.octaveAmbiguous, null, null); }

  const [a, b] = [...good].sort((x, y) => y.confidence - x.confidence); // a: more confident
  if (Math.abs(a.bpm - b.bpm) <= BPM_AGREE) {
    const wa = Math.max(a.confidence, 1e-6), wb = Math.max(b.confidence, 1e-6);
    const bpm = (a.bpm * wa + b.bpm * wb) / (wa + wb);
    return finish(a, bpm, a.confidence, a.octaveAmbiguous || b.octaveAmbiguous, partnerOf(a) ?? partnerOf(b), true);
  }
  if (octaveApart(a.bpm, b.bpm))
    return finish(a, a.bpm, a.confidence * OCTAVE_PENALTY, true, b.bpm, false);
  return finish(a, a.bpm, a.confidence * DISAGREE_PENALTY, a.octaveAmbiguous, null, false);
}

/**
 * Reconcile per-window key results (key.mjs shape).
 * @returns {{ key: string, camelot: string, keyConf: number, keyAlt?: string, agree: boolean|null } | null}
 */
export function combineKey(ws) {
  const good = (ws ?? []).filter(w => w && w.key && w.camelot && ok(w.confidence));
  if (!good.length) return null;
  const out = (w, conf, agree, alt) => ({ key: w.key, camelot: w.camelot, keyConf: r3(Math.max(0, Math.min(1, conf))), agree,
                                          ...(alt ? { keyAlt: alt } : {}) });
  if (good.length === 1) return out(good[0], good[0].confidence, null);
  const [a, b] = [...good].sort((x, y) => y.confidence - x.confidence);
  if (a.camelot === b.camelot) return out(a, a.confidence, true);
  return out(a, a.confidence * DISAGREE_PENALTY, false, b.camelot);
}

function keyPooled(parts) {
  let r; try { r = keyOf(parts); } catch { return null; }
  if (!r?.key || !r.camelot || !ok(r.confidence)) return null;
  return { key: r.key, camelot: r.camelot, keyConf: r3(Math.max(0, Math.min(1, r.confidence))), agree: null,
           ...(r.alternates?.[0] ? { keyAlt: r.alternates[0].camelot } : {}) };
}

/** Power-mean loudness and mean energy (loudness.mjs shape). */
export function combineLoudness(ws) {
  const good = (ws ?? []).filter(w => w && ok(w.loudness) && ok(w.energy));
  if (!good.length) return null;
  const p = good.reduce((s, w) => s + 10 ** (w.loudness / 10), 0) / good.length;
  return { loudness: r2(10 * Math.log10(p)), energy: r3(good.reduce((s, w) => s + w.energy, 0) / good.length) };
}

/**
 * Measure each window and combine: the `dsp` the worker stores in a record.
 * Estimators are injectable for tests.
 *
 * @param {Float32Array[]} windows  contiguous 16 kHz mono parts, in time order
 * @param {{ tempo?: Function, key?: Function, loudness?: Function }} [est]
 * @returns {object|null} null when nothing could be measured
 */
export function measureWindows(windows, est = {}) {
  const tempo = est.tempo ?? tempoOf, key = est.key ?? keyOf, loudness = est.loudness ?? loudnessOf;
  const parts = (windows ?? []).filter(w => w && w.length > 0);
  if (!parts.length) return null;
  const each = f => parts.map(w => { try { return f(w); } catch { return null; } });
  const t = combineTempo(each(tempo));
  // The default key estimator pools both windows into one chroma (as
  // measured for key v3); an injected one is run per window and reconciled.
  const k = est.key ? combineKey(each(key)) : keyPooled(parts);
  const l = combineLoudness(each(loudness));
  if (!t && !k && !l) return null;
  const out = { v: DSP_VERSION, windows: parts.length };
  if (t) Object.assign(out, { bpm: t.bpm, bpmConf: t.bpmConf, octaveAmbiguous: t.octaveAmbiguous,
                              ...(t.bpmAlt != null ? { bpmAlt: t.bpmAlt } : {}), ...(t.agree != null ? { bpmAgree: t.agree } : {}) });
  if (k) Object.assign(out, { key: k.key, camelot: k.camelot, keyConf: k.keyConf,
                              ...(k.keyAlt ? { keyAlt: k.keyAlt } : {}), ...(k.agree != null ? { keyAgree: k.agree } : {}) });
  if (l) Object.assign(out, l);
  return out;
}

/** Does this record still need its dsp measured (absent, or from an older DSP_VERSION)? */
export function needsDsp(rec) {
  return !!rec && !rec.miss && (!rec.dsp || rec.dsp.v !== DSP_VERSION);
}
