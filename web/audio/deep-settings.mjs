// "Deep listen (laptop)" settings: the two Option C ears, MAEST (WP-C1) and
// CLAP (WP-C2), each a large extra download on top of "Listen to my music".
//
// One settings object for both so the page has one block and one writer:
// localStorage `bf_audio_deep` = { maest, clap, memoryOverride }. Both ears are
// on by default (owner's call, 2026-11-16); the Wi-Fi and memory rules below
// still decide whether they may download. Nothing here downloads anything; it only answers "may this ear
// download and run right now?".
//
// The rules (docs/AUDIO-BUILD-PLAN.md, Option C):
//  - each ear has its own switch, on unless the listener unticks it;
//  - Wi-Fi only, always: unlike listening there is no "Wi-Fi only" switch to
//    turn off, because the models are ~90 MB (MAEST) and ~71 MB (CLAP);
//  - MAEST also needs navigator.deviceMemory >= 8, or the listener saying
//    "this computer has the memory" (memoryOverride). deviceMemory is
//    Chromium-only and capped at 8, so a missing value is "unknown", and only
//    the override lets it through. CLAP has no memory rule (its encoder runs
//    fine on smaller machines, measured by WP-C2). Beat This (tempo, ~10 MB)
//    has none either: it only re-listens to tracks whose half/double time the
//    DSP flagged as unsure.
import { connectionVerdict } from './settings.mjs';

export const DEEP_SETTINGS_KEY = 'bf_audio_deep';
export const DEFAULT_DEEP_SETTINGS = Object.freeze({ maest: true, clap: true, beats: false, memoryOverride: false });
export const DEEP_EARS = Object.freeze(['maest', 'clap', 'beats']);
/** GB of device memory MAEST needs (navigator.deviceMemory's top value). */
export const MAEST_MIN_MEMORY_GB = 8;

/** Settings from a localStorage-like store; anything odd falls back to its default. */
export function readDeepSettings(ls) {
  let raw = null;
  try { raw = JSON.parse(ls?.getItem?.(DEEP_SETTINGS_KEY) ?? 'null'); } catch { raw = null; }
  const d = DEFAULT_DEEP_SETTINGS, out = { ...d };
  if (!raw || typeof raw !== 'object') return out;
  for (const k of Object.keys(d)) if (typeof raw[k] === 'boolean') out[k] = raw[k];
  return out;
}

/** Merge a change in and save it. Returns the saved settings. Unknown keys are dropped. */
export function writeDeepSettings(ls, change) {
  const clean = readDeepSettings({ getItem: () => JSON.stringify({ ...readDeepSettings(ls), ...change }) });
  try { ls?.setItem?.(DEEP_SETTINGS_KEY, JSON.stringify(clean)); } catch { /* memory only */ }
  return clean;
}

/**
 * May this ear download and run now?
 *  - 'ok'
 *  - 'off'            its switch is off (or it is not a deep ear)
 *  - 'offline'
 *  - 'low-memory'     MAEST only: deviceMemory below 8 and no override
 *  - 'memory-unknown' MAEST only: the browser does not say, and no override
 *  - 'metered'        cellular or Data Saver: wait for Wi-Fi
 *  - 'unknown'        the browser will not say whether it is on Wi-Fi: ask once
 *
 * @param {'maest'|'clap'|'beats'} ear
 * @param {{ settings?: object, connection?: object, deviceMemory?: number, confirmed?: boolean }} o
 *        connection = navigator.connection, deviceMemory = navigator.deviceMemory,
 *        confirmed = the listener said "I'm on Wi-Fi" this session
 */
export function deepListenAllowed(ear, { settings = DEFAULT_DEEP_SETTINGS, connection = undefined,
                                        deviceMemory = undefined, confirmed = false } = {}) {
  if (!DEEP_EARS.includes(ear) || settings?.[ear] !== true) return 'off';
  if (connection?.type === 'none') return 'offline';
  if (ear === 'maest' && settings.memoryOverride !== true) {
    if (!Number.isFinite(deviceMemory)) return 'memory-unknown';
    if (deviceMemory < MAEST_MIN_MEMORY_GB) return 'low-memory';
  }
  return connectionVerdict(connection, { wifiOnly: true, confirmed });
}

/** Plain-English text for each answer that is not 'ok'. */
export const DEEP_TEXT = Object.freeze({
  off: 'Off.',
  offline: 'Paused: offline.',
  'low-memory': 'This device reports less than 8 GB of memory, so it stays off. If it really has the memory, tick “This computer has the memory”.',
  'memory-unknown': 'This browser doesn’t say how much memory the computer has. Tick “This computer has the memory” if it has 8 GB or more.',
  metered: 'Paused: waiting for Wi-Fi.',
  unknown: 'This browser doesn’t say whether it is on Wi-Fi.',
});
