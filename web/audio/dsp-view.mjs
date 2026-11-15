// AudioRecord.dsp → the BPM/key part of web/ui/sound.mjs's SoundVM (WP-D4).
//
// Measured 2026-11-14 on 400 tracks of the Beatport EDM Key Dataset
// (scripts/audio-dsp/beatport-eval.mjs, numbers in AUDIO-ANALYSIS-PLAN.md §0):
//  - tempo: 80% within ±1 BPM overall, 86% when confidence ≥ 0.3, and most
//    octave errors are flagged. Shown by default at confidence ≥ BPM_MIN_CONF,
//    with "87/174?" when half/double time is unsure.
//  - key: v1 30% exact; v3 (learned weights, 2026-11-15) 55.3% exact on the
//    held-out half (61.8% at confidence ≥ 0.3). Still under the 60% bar, so
//    hidden by default.
// `localStorage.bf_audio_dsp = '1'` shows key too (for checking), '0' hides
// everything.
//
// Energy is never put in the view model yet: D3's weights are hand-picked and
// unchecked on real previews.

export const DSP_UI_DEFAULT = false;       // key (and everything) — off until key passes
export const BPM_UI_DEFAULT = true;        // tempo alone — on, measured above
/** Tempo shown by default only at or above this confidence (86% within ±1 BPM there). */
export const BPM_MIN_CONF = 0.3;
export const DSP_UI_KEY = 'bf_audio_dsp';

/** Below this confidence a reading is not shown at all. */
export const MIN_SHOW_CONF = 0.15;

/** The per-browser override: '1' → true, '0' → false, otherwise null. */
function override(ls) {
  try {
    const v = ls?.getItem?.(DSP_UI_KEY);
    if (v === '1') return true;
    if (v === '0') return false;
  } catch { /* private mode: use the default */ }
  return null;
}

/** Is the full BPM/key display on? A per-browser override beats the default. */
export function dspShown(ls = globalThis.localStorage) {
  return override(ls) ?? DSP_UI_DEFAULT;
}

/** Is tempo shown on its own? Off only when the browser override says '0'. */
export function bpmShown(ls = globalThis.localStorage) {
  return override(ls) !== false && BPM_UI_DEFAULT;
}

/**
 * @param {object|null|undefined} record  a stored AudioRecord (or miss)
 * @param {{ show?: boolean, bpm?: boolean }} [o]  show: everything (default dspShown());
 *        bpm: tempo alone at BPM_MIN_CONF (default bpmShown())
 * @returns {{ bpm?: number, bpmAlt?: number, bpmConf?: number, key?: string, camelot?: string, keyConf?: number } | null}
 */
export function dspSoundVM(record, { show = dspShown(), bpm = bpmShown() } = {}) {
  if (!show && !bpm) return null;
  const d = record && !record.miss ? record.dsp : null;
  if (!d || typeof d !== 'object') return null;
  const vm = {};
  if (Number.isFinite(d.bpm) && d.bpm > 0 && (d.bpmConf ?? 0) >= (show ? MIN_SHOW_CONF : BPM_MIN_CONF)) {
    vm.bpm = Math.round(d.bpm);
    vm.bpmConf = d.bpmConf;
    if (d.octaveAmbiguous && Number.isFinite(d.bpmAlt) && d.bpmAlt > 0) vm.bpmAlt = Math.round(d.bpmAlt);
  }
  if (show && typeof d.key === 'string' && d.key && (d.keyConf ?? 0) >= MIN_SHOW_CONF) {
    vm.key = d.key;
    if (typeof d.camelot === 'string') vm.camelot = d.camelot;
    vm.keyConf = d.keyConf;
  }
  return Object.keys(vm).length ? vm : null;
}
