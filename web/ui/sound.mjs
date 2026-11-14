// The sound layer's renderers — the contract docs/UI-BUILD-PLAN.md §5 freezes.
//
// Every function takes a plain view model and returns an HTML string. None of
// them knows what an AudioRecord is: the audio packages (docs/AUDIO-BUILD-PLAN.md)
// write one adapter from a record to these shapes, and the UI never imports
// core/audio. That is what lets the two builds run in parallel.
//
// The one rule every renderer keeps: **no data, no markup.** null, undefined or
// an empty view model renders '' — never a placeholder, never a dash — so a
// listener who never turns listening on gets exactly the page they had before.
//
// UI-0 ships these as stubs so the page and the tests can depend on the names.
// UI-2 fills them in; UI-3..6 call them from their screens.

export const SOUND_UI_VERSION = 1;

/**
 * @typedef {object} SoundVM   one track
 * @property {number} [bpm]
 * @property {number} [bpmAlt]   set when half/double time is unsure: "87/174"
 * @property {number} [bpmConf]  0–1
 * @property {string} [key]
 * @property {string} [camelot]
 * @property {number} [keyConf]  0–1
 * @property {number} [energy]   0–1, a heuristic
 * @property {'vocal'|'instrumental'|null} [voice]
 * @property {string[]} [moods]   ontology names, already mapped
 * @property {Array<[string, number]>} [styles]  top styles, labels already mapped
 * @property {string[][]} [sections]  per section, top style labels, in time order
 * @property {boolean} [hybrid]
 *
 * @typedef {{ tags?: number, history?: number, sound?: number, learned?: number }} EvidenceVM
 * @typedef {'HIGH'|'LIKELY'|'AMBIGUOUS'|null} BandVM
 * @typedef {{ heard: number, members: number, bpm?: [number, number],
 *             energy?: [number, number], styles?: Array<[string, number]> }} ProfileVM
 * @typedef {{ state: 'off'|'running'|'paused'|'done', done: number, total: number,
 *             reason?: string, missed?: Record<string, number> }} ListenVM
 */

/** @param {SoundVM|null|undefined} vm */
export function soundChip(vm) { return ''; }

/** @param {SoundVM|null|undefined} vm */
export function sectionStrip(vm) { return ''; }

/** @param {EvidenceVM|null|undefined} vm */
export function evidenceBadges(vm) { return ''; }

/** @param {BandVM|undefined} band */
export function bandChip(band) { return ''; }

/** @param {ProfileVM|null|undefined} vm */
export function profileRow(vm) { return ''; }

/** @param {ListenVM|null|undefined} vm */
export function listenPill(vm) { return ''; }

/** @param {ListenVM|null|undefined} vm */
export function listenCard(vm) { return ''; }

/** @param {ListenVM|null|undefined} vm */
export function missedList(vm) { return ''; }
