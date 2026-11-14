// AudioRecord.dsp → the BPM/key part of web/ui/sound.mjs's SoundVM (WP-D4).
//
// Hidden by default. Tempo and key are only checked on synthetic audio so
// far; per the build plan (§0 rule 7) they show only once the Rekordbox
// comparison is in AUDIO-ANALYSIS-PLAN.md §0 and passes. Until then
// DSP_UI_DEFAULT stays false and dspSoundVM() returns null, so every
// renderer that takes its output draws nothing. Turning it on is a one-line
// change here once the numbers pass; `localStorage.bf_audio_dsp = '1'` turns
// it on for one browser, for checking the display before then.
//
// Energy is never put in the view model yet: D3's weights are hand-picked and
// unchecked on real previews.

export const DSP_UI_DEFAULT = false;
export const DSP_UI_KEY = 'bf_audio_dsp';

/** Below this confidence a reading is not shown at all. */
export const MIN_SHOW_CONF = 0.15;

/** Is the BPM/key display on? A per-browser override beats the default. */
export function dspShown(ls = globalThis.localStorage) {
  try {
    const v = ls?.getItem?.(DSP_UI_KEY);
    if (v === '1') return true;
    if (v === '0') return false;
  } catch { /* private mode: use the default */ }
  return DSP_UI_DEFAULT;
}

/**
 * @param {object|null|undefined} record  a stored AudioRecord (or miss)
 * @param {{ show?: boolean }} [o]          default dspShown()
 * @returns {{ bpm?: number, bpmAlt?: number, bpmConf?: number, key?: string, camelot?: string, keyConf?: number } | null}
 */
export function dspSoundVM(record, { show = dspShown() } = {}) {
  if (!show) return null;
  const d = record && !record.miss ? record.dsp : null;
  if (!d || typeof d !== 'object') return null;
  const vm = {};
  if (Number.isFinite(d.bpm) && d.bpm > 0 && (d.bpmConf ?? 0) >= MIN_SHOW_CONF) {
    vm.bpm = Math.round(d.bpm);
    vm.bpmConf = d.bpmConf;
    if (d.octaveAmbiguous && Number.isFinite(d.bpmAlt) && d.bpmAlt > 0) vm.bpmAlt = Math.round(d.bpmAlt);
  }
  if (typeof d.key === 'string' && d.key && (d.keyConf ?? 0) >= MIN_SHOW_CONF) {
    vm.key = d.key;
    if (typeof d.camelot === 'string') vm.camelot = d.camelot;
    vm.keyConf = d.keyConf;
  }
  return Object.keys(vm).length ? vm : null;
}
