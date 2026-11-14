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

const esc = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const num = v => typeof v === 'number' && Number.isFinite(v);
const pct = v => `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`;
/** A reading under this confidence is drawn as unsure (dimmer, with a "?"). */
export const SURE_CONF = 0.5;

/**
 * One compact row per track (§2.1): `174 BPM · 8A A minor · energy ▮▮▮▯▯ · vocal`.
 * `87/174 BPM` when half/double time is unsure. Unsure readings (conf below
 * SURE_CONF) are dimmed and end in "?"; every confidence is in the title.
 * Written by WP-D4 (the UI-2 owner handed this one renderer over).
 * @param {SoundVM|null|undefined} vm
 */
export function soundChip(vm) {
  if (!vm || typeof vm !== 'object') return '';
  const parts = [];
  const unsure = c => num(c) && c < SURE_CONF;
  const item = (cls, html, title, conf) =>
    `<span class="snd-${cls}${unsure(conf) ? ' snd-unsure' : ''}"${title ? ` title="${esc(title)}"` : ''}>${html}${unsure(conf) ? '<span class="snd-q">?</span>' : ''}</span>`;

  if (num(vm.bpm) && vm.bpm > 0) {
    const bpm = Math.round(vm.bpm), alt = num(vm.bpmAlt) && vm.bpmAlt > 0 ? Math.round(vm.bpmAlt) : null;
    const [lo, hi] = alt == null ? [bpm, null] : [Math.min(bpm, alt), Math.max(bpm, alt)];
    const title = [alt != null ? `${bpm} BPM, but half/double time is unsure (${lo} or ${hi})` : `${bpm} BPM`,
                   num(vm.bpmConf) ? `confidence ${pct(vm.bpmConf)}` : null].filter(Boolean).join(' · ');
    parts.push(item('bpm', `${alt != null ? `${lo}/${hi}` : bpm} <span class="snd-unit">BPM</span>`, title, vm.bpmConf));
  }
  if ((typeof vm.camelot === 'string' && vm.camelot) || (typeof vm.key === 'string' && vm.key)) {
    const cam = typeof vm.camelot === 'string' && vm.camelot ? vm.camelot : null;
    const name = typeof vm.key === 'string' && vm.key ? vm.key : null;
    const html = cam && name ? `${esc(cam)} <span class="snd-sub">${esc(name)}</span>` : esc(cam ?? name);
    const title = [name, cam ? `Camelot ${cam}` : null, num(vm.keyConf) ? `confidence ${pct(vm.keyConf)}` : null].filter(Boolean).join(' · ');
    parts.push(item('key', html, title, vm.keyConf));
  }
  if (num(vm.energy)) {
    const n = Math.round(Math.max(0, Math.min(1, vm.energy)) * 5);
    const bars = Array.from({ length: 5 }, (_, i) => `<i${i < n ? ' class="on"' : ''}></i>`).join('');
    parts.push(item('energy', `energy <span class="snd-bars" aria-hidden="true">${bars}</span>`, `energy ${n} of 5 (a rough measure)`));
  }
  if (vm.voice === 'vocal' || vm.voice === 'instrumental') parts.push(item('voice', vm.voice));
  if (!parts.length) return '';
  return `<span class="snd">${parts.join('<span class="snd-dot" aria-hidden="true">·</span>')}</span>`;
}

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
