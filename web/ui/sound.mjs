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
// This file is bundled into the page and its exports become globals (see
// build-web.mjs), so everything that is not part of the contract stays private
// and the one extra export, soundStyleMark, carries a prefix no screen uses.
//
// Styling: the band chip (.band, .pct) and evidence badges (.evs, .ev) are
// styled by UI-1 in web/styles/50-components.css; every other class here is
// prefixed snd- and styled in web/styles/90-sound.css.

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

// ---- private helpers -------------------------------------------------------

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const h = s => String(s ?? '').replace(/[&<>"']/g, c => ESC[c]);
const num = v => typeof v === 'number' && Number.isFinite(v);
const unit = v => Math.min(1, Math.max(0, v));
const pct = v => `${Math.round(unit(v) * 100)}%`;
const count = n => Math.max(0, Math.round(n)).toLocaleString('en-US');
const str = v => typeof v === 'string' && v.trim() !== '';
/** Below this a BPM or key reads as a guess and is drawn dimmer. */
const UNSURE = 0.5;

/** Five level bars, `on` of them lit — the mark's shape, used as a meter. */
function meter(on, label) {
  let bars = '';
  for (let i = 0; i < 5; i++) bars += `<i${i < on ? ' class="on"' : ''}></i>`;
  return `<span class="snd-meter" role="img" aria-label="${h(label)}">${bars}</span>`;
}

/** The mark's five bars in their own colours: the listening motif. */
function bars(state) {
  let b = '';
  for (let i = 0; i < 5; i++) b += `<i class="snd-b${i}"></i>`;
  return `<span class="snd-bars snd-${state}" aria-hidden="true">${b}</span>`;
}

// ---- style family → mark colour --------------------------------------------
//
// The section strip and profile chips colour a style label with one of the
// mark's five colours (--m0..--m4), which never turn with the accent and are
// the same in both themes. Families, so related styles agree: every kind of
// house is one colour, every breakbeat-and-bass style another. A label no
// family claims gets a colour from a hash of the label, so it is still the same
// colour every time it appears.

const FAMILIES = [
  // m0 amber — groove and voice: hip hop, soul, funk, jazz, reggae
  [0, /hip ?hop|rap|trap|grime|drill|boom ?bap|soul|funk|jazz|r&b|rnb|gospel|blues|reggae|dancehall|dub(?!step)|afro|latin|reggaeton|swing/],
  // m1 orange — guitars and songs: rock, punk, metal, indie, folk, country, pop
  [1, /rock|punk|metal|core\b|grunge|emo|indie|shoegaze|folk|country|singer|songwriter|acoustic|pop/],
  // m2 magenta — four-on-the-floor: house, disco, garage, dance
  [2, /house|disco|garage|ukg|2[ -]?step|speed garage|dance(?!hall)|eurodance|nu ?disco|balearic|edm|electro ?pop|synth ?pop/],
  // m3 violet — machines and space: techno, trance, ambient, electronica, experimental
  [3, /techno|trance|minimal|industrial|ebm|acid|hard ?style|gabber|ambient|drone|downtempo|chill|idm|electronica|experimental|noise|classical|modern classical|new age|soundtrack|score/],
  // m4 blue — breaks and bass: drum and bass, jungle, breaks, dubstep, bass music
  [4, /drum ?(and|n|&|'n'?) ?bass|dnb|d&b|jungle|breakbeat|breaks|footwork|juke|dubstep|bass|halftime|neurofunk|liquid|riddim|donk|bassline|electro(?! ?pop)\b/],
];

/**
 * Which of the mark's five colours a style label is drawn in: 0–4, stable per
 * label. Families first (in the order breaks → house → techno → hip hop → rock,
 * so "acid house" is house rather than techno and "drum and bass" is not hip hop),
 * then a hash so an unknown label is still always the same colour.
 * @param {string} label
 * @returns {0|1|2|3|4}
 */
export function soundStyleMark(label) {
  const s = String(label ?? '').toLowerCase();
  for (const i of [4, 2, 3, 0, 1]) if (FAMILIES[i][1].test(s)) return FAMILIES[i][0];
  let x = 0;
  for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) >>> 0;
  return /** @type {0|1|2|3|4} */ (x % 5);
}

// ---- per track -------------------------------------------------------------

/**
 * One compact row: `174 BPM · 8A · energy ▮▮▮▯▯ · vocal`. Octave-unsure tempo
 * reads `87/174 BPM`; a low-confidence BPM or key is drawn dimmer and says so
 * on hover. Every piece is optional and a missing piece leaves no gap.
 * @param {SoundVM|null|undefined} vm
 */
export function soundChip(vm) {
  if (!vm || typeof vm !== 'object') return '';
  const parts = [];
  if (num(vm.bpm) && vm.bpm > 0) {
    const a = Math.round(vm.bpm), b = num(vm.bpmAlt) && vm.bpmAlt > 0 ? Math.round(vm.bpmAlt) : null;
    const text = b && b !== a ? `${Math.min(a, b)}/${Math.max(a, b)}` : String(a);
    const unsure = (b && b !== a) || (num(vm.bpmConf) && vm.bpmConf < UNSURE);
    const tip = b && b !== a ? 'Half or double time — not sure which' : unsure ? 'Tempo is a rough guess' : '';
    parts.push(`<span class="snd-bpm${unsure ? ' snd-unsure' : ''}"${tip ? ` title="${h(tip)}"` : ''}>${h(text)} <small>BPM</small></span>`);
  }
  const key = str(vm.camelot) ? vm.camelot : str(vm.key) ? vm.key : null;
  if (key) {
    const unsure = num(vm.keyConf) && vm.keyConf < UNSURE;
    const tip = [str(vm.camelot) && str(vm.key) ? vm.key : '', unsure ? 'key is a rough guess' : ''].filter(Boolean).join(' · ');
    parts.push(`<span class="snd-key${unsure ? ' snd-unsure' : ''}"${tip ? ` title="${h(tip)}"` : ''}>${h(key)}</span>`);
  }
  if (num(vm.energy)) {
    const on = Math.round(unit(vm.energy) * 5);
    parts.push(`<span class="snd-energy">energy ${meter(on, `energy ${on} of 5`)}</span>`);
  }
  if (vm.voice === 'vocal' || vm.voice === 'instrumental') parts.push(`<span class="snd-voice">${vm.voice}</span>`);
  if (vm.hybrid === true) parts.push('<span class="snd-hybrid">hybrid</span>');
  const moods = Array.isArray(vm.moods) ? vm.moods.filter(str).slice(0, 2) : [];
  if (moods.length) parts.push(`<span class="snd-mood">${moods.map(h).join(', ')}</span>`);
  if (!parts.length) return '';
  return `<span class="snd-chip">${parts.join('<span class="snd-sep" aria-hidden="true">·</span>')}</span>`;
}

/**
 * A thin bar split into the clip's sections, each in its top style's mark
 * colour, so a hybrid track looks hybrid at a glance. Sections are drawn equal
 * width: the view model carries their order, not their length.
 * @param {SoundVM|null|undefined} vm
 */
export function sectionStrip(vm) {
  if (!vm || !Array.isArray(vm.sections)) return '';
  const secs = vm.sections.map(s => Array.isArray(s) ? s.filter(str) : []);
  if (!secs.some(s => s.length)) return '';
  const segs = secs.map(s => s.length
    ? `<i class="snd-m${soundStyleMark(s[0])}" title="${h(s.join(', '))}"></i>`
    : '<i class="snd-none" title="unclear"></i>').join('');
  const tops = secs.map(s => s[0] || 'unclear');
  const label = `Sections: ${tops.join(' → ')}${vm.hybrid === true ? ' (hybrid)' : ''}`;
  return `<div class="snd-strip${vm.hybrid === true ? ' snd-strip-hybrid' : ''}" role="img" aria-label="${h(label)}">${segs}</div>`;
}

// ---- per suggestion --------------------------------------------------------

const EVIDENCE = ['tags', 'history', 'sound', 'learned'];

/**
 * What a suggestion is made of: up to four badges, always in the same order,
 * only for sources that contributed. --w draws each one's strength; the title
 * lists the numbers for whoever hovers or long-presses.
 * @param {EvidenceVM|null|undefined} vm
 */
export function evidenceBadges(vm) {
  if (!vm || typeof vm !== 'object') return '';
  const got = EVIDENCE.filter(k => num(vm[k]) && vm[k] > 0);
  if (!got.length) return '';
  const tip = got.map(k => `${k} ${pct(vm[k])}`).join(' · ');
  const badges = got.map(k => `<span class="ev ev-${k}" style="--w:${unit(vm[k]).toFixed(2)}">${k}</span>`).join('');
  return `<span class="evs" title="${h(tip)}" aria-label="${h('Based on ' + tip)}">${badges}</span>`;
}

const BANDS = { HIGH: ['sure', 'Sure'], LIKELY: ['likely', 'Likely'], AMBIGUOUS: ['unsure', 'Unsure'] };

/**
 * The confidence headline: Sure / Likely / Unsure. The raw percentage, when
 * given as the optional second argument (0–1), rides along small.
 * @param {BandVM|undefined} band
 * @param {number} [p]
 */
export function bandChip(band, p) {
  const b = typeof band === 'string' && Object.hasOwn(BANDS, band) ? BANDS[band] : null;
  if (!b) return '';
  return `<span class="band band-${b[0]}">${b[1]}${num(p) ? ` <span class="pct">${pct(p)}</span>` : ''}</span>`;
}

// ---- per playlist ----------------------------------------------------------

/**
 * A playlist's sound: how many members have been heard, typical BPM, energy
 * spread and top styles. Nothing until at least one member has been heard.
 * @param {ProfileVM|null|undefined} vm
 */
export function profileRow(vm) {
  if (!vm || !num(vm.heard) || vm.heard <= 0) return '';
  const parts = [];
  const members = num(vm.members) && vm.members >= vm.heard ? vm.members : null;
  parts.push(`<span class="snd-heard">Heard ${count(vm.heard)}${members != null ? ` of ${count(members)}` : ''}</span>`);
  const pair = r => Array.isArray(r) && r.length === 2 && num(r[0]) && num(r[1]) ? [Math.min(r[0], r[1]), Math.max(r[0], r[1])] : null;
  const bpm = pair(vm.bpm);
  if (bpm && bpm[1] > 0) {
    const [lo, hi] = bpm.map(Math.round);
    parts.push(`<span class="snd-bpm">${lo === hi ? lo : `${lo}–${hi}`} <small>BPM</small></span>`);
  }
  const en = pair(vm.energy);
  if (en) {
    const [lo, hi] = en.map(unit);
    parts.push(`<span class="snd-energy">energy <span class="snd-range" role="img" aria-label="energy ${pct(lo)} to ${pct(hi)}"><i style="left:${pct(lo)};width:${pct(hi - lo)}"></i></span></span>`);
  }
  const styles = Array.isArray(vm.styles) ? vm.styles.filter(s => Array.isArray(s) && str(s[0])).slice(0, 3) : [];
  if (styles.length) {
    parts.push(`<span class="snd-styles">${styles.map(([l, p]) =>
      `<span class="snd-style snd-m${soundStyleMark(l)}"${num(p) ? ` title="${pct(p)}"` : ''}>${h(l)}</span>`).join('')}</span>`);
  }
  return `<div class="snd-profile">${parts.join('')}</div>`;
}

// ---- background job --------------------------------------------------------

const missTotal = vm => vm && vm.missed && typeof vm.missed === 'object'
  ? Object.values(vm.missed).reduce((a, n) => a + (num(n) && n > 0 ? Math.round(n) : 0), 0) : 0;
const listenable = vm => vm && typeof vm === 'object' && ['off', 'running', 'paused', 'done'].includes(vm.state);
const heardOf = vm => Math.max(0, (num(vm.done) ? Math.round(vm.done) : 0) - missTotal(vm));

/**
 * The glanceable status for the top bar and above the phone tab bar: the
 * mark's bars as a level meter while listening runs, still when paused or done.
 * Nothing when listening is off. The caller's slot makes it a link to Sources.
 * @param {ListenVM|null|undefined} vm
 */
export function listenPill(vm) {
  if (!listenable(vm) || vm.state === 'off') return '';
  const done = num(vm.done) ? vm.done : 0, total = num(vm.total) ? vm.total : 0;
  let text;
  if (vm.state === 'running') text = `Listening · ${count(done)} / ${count(total)}`;
  else if (vm.state === 'paused') text = `Paused${str(vm.reason) ? ` · ${h(vm.reason)}` : ''}`;
  else text = heardOf(vm) > 0 ? `Heard ${count(heardOf(vm))}` : 'Couldn’t hear any';
  return `<span class="snd-pill snd-pill-${vm.state}" role="status">${bars(vm.state)}<span>${text}</span></span>`;
}

const STATE_WORD = { off: 'Off', running: 'Listening', paused: 'Paused', done: 'Done' };

/**
 * The body of the Listening card on Sources: state, progress, heard and
 * couldn't-hear counts. Controls are not drawn here; WP-B2 supplies them.
 * @param {ListenVM|null|undefined} vm
 */
export function listenCard(vm) {
  if (!listenable(vm)) return '';
  const done = num(vm.done) ? Math.max(0, vm.done) : 0, total = num(vm.total) ? Math.max(0, vm.total) : 0;
  const miss = missTotal(vm), heard = heardOf(vm);
  const lines = [];
  lines.push(`<div class="snd-state">${bars(vm.state)}<b>${STATE_WORD[vm.state]}</b>${
    vm.state === 'paused' && str(vm.reason) ? `<span class="snd-reason"> · ${h(vm.reason)}</span>` : ''}</div>`);
  if (total > 0 && vm.state !== 'off') {
    const f = unit(done / total);
    lines.push(`<div class="snd-progress" role="progressbar" aria-valuemin="0" aria-valuemax="${Math.round(total)}" aria-valuenow="${Math.round(Math.min(done, total))}"><i style="width:${pct(f)}"></i></div>`);
    lines.push(`<div class="snd-counts"><span>${count(done)} of ${count(total)} tracks checked</span>${
      done > 0 ? `<span>${heard > 0 ? `heard ${count(heard)}` : 'heard none'}${miss > 0 ? ` · couldn’t hear ${count(miss)}` : ''}</span>` : ''}</div>`);
  } else if (vm.state === 'off') {
    lines.push(`<div class="snd-counts"><span>${done > 0 ? `${count(heard)} heard so far. Turn listening on to hear the rest.` : 'Nothing heard yet.'}</span></div>`);
  }
  return `<div class="snd-card snd-card-${vm.state}">${lines.join('')}</div>`;
}

/** Why a track could not be heard, in listener words. Keys are core/audio's MISS values. */
const MISS_WORDS = {
  NO_ISRC: 'Spotify gave no ISRC',
  NOT_ON_DEEZER: 'Not on Deezer',
  NO_PREVIEW: 'No preview to listen to',
  IDENTITY: 'Preview was a different recording',
  TOO_SHORT: 'Preview too short',
  FAILED: 'Couldn’t load — will try again',
};

/**
 * The honest "couldn't hear N tracks" list, biggest reason first.
 * @param {ListenVM|null|undefined} vm
 */
export function missedList(vm) {
  if (!vm || !vm.missed || typeof vm.missed !== 'object') return '';
  const rows = Object.entries(vm.missed).filter(([, n]) => num(n) && Math.round(n) > 0)
    .map(([k, n]) => [k, Math.round(n)])
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (!rows.length) return '';
  const total = rows.reduce((a, [, n]) => a + n, 0);
  const items = rows.map(([k, n]) =>
    `<li><span>${h(MISS_WORDS[k] || k)}</span><b>${count(n)}</b></li>`).join('');
  return `<div class="snd-missed"><div class="snd-missed-h">Couldn’t hear ${count(total)} ${total === 1 ? 'track' : 'tracks'}</div><ul>${items}</ul></div>`;
}
