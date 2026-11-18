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
// UI-0 shipped these as stubs so the page and the tests could depend on the names.
// UI-2 fills them in (WP-D4 writes soundChip); UI-3..6 call them from their screens.

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
 * @typedef {{ heard: number, members: number, bpm?: [number, number], tempo?: [number, number],
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
    const title = [alt != null ? `${bpm} BPM, but it could be ${lo} or ${hi}` : `${bpm} BPM`,
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
  // Moods (F1, mapped to ontology names): only reach a SoundVM once checked (web/audio/labels-view.mjs).
  const moods = Array.isArray(vm.moods) ? vm.moods.filter(m => typeof m === 'string' && m.trim()).slice(0, 3) : [];
  if (moods.length) parts.push(item('mood', esc(moods.join(', ')), 'mood, as heard in the preview'));
  if (!parts.length) return '';
  return `<span class="snd">${parts.join('<span class="snd-dot" aria-hidden="true">·</span>')}</span>`;
}

// ---------------------------------------------------------------------------
// Everything below is UI-2's. Helper names are prefixed so they never collide
// with soundChip's own helpers above, and only the renderers (plus soundMark)
// are exported, because build-web.mjs turns every export into a page global.

const sEsc = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const sNum = v => typeof v === 'number' && Number.isFinite(v);
const sClamp = v => Math.max(0, Math.min(1, v));
const sPct = v => `${Math.round(sClamp(v) * 100)}%`;
const sInt = v => Math.round(v).toLocaleString('en-GB');
const sPlural = (n, one, many = one + 's') => `${sInt(n)} ${n === 1 ? one : many}`;
const sLabel = v => typeof v === 'string' && v.trim() ? v.trim() : null;

/* ---------- style family → mark colour ----------
 * The section strip colours each section by its top style, using the mark's
 * five colours (--m0..--m4) so the strip reads as the logo's bars laid flat.
 * Five colours cannot name 400 styles, so they name families: a listener sees
 * "house-ish then bass-ish" at a glance, and the label is in the tooltip.
 * The first family whose word appears in the label wins; anything unmatched
 * gets a hash of its label, so the same label is always the same colour. */
const SOUND_FAMILIES = [
  // m1: bass, breaks and the fast end
  [1, ['drum n bass', 'drum and bass', 'drum & bass', 'dnb', 'jungle', 'breakbeat', 'breaks', 'dubstep', 'grime', 'bass music',
       'hardcore', 'gabber', 'donk', 'bounce', 'footwork', 'juke', 'trap', 'drill', 'halftime', 'neurofunk', 'liquid', 'dub']],
  // m0: house, garage and the four-to-the-floor warm end
  [0, ['house', 'garage', 'bassline', 'speed garage', '2-step', 'disco', 'funk', 'soul', 'boogie', 'italo', 'balearic', 'afro']],
  // m2: techno, trance, electro, hard dance
  [2, ['techno', 'trance', 'electro', 'minimal', 'hardstyle', 'hard dance', 'eurodance', 'edm', 'big room', 'industrial', 'ebm', 'acid', 'idm']],
  // m3: voices first — hip hop, r&b, pop
  [3, ['hip hop', 'hip-hop', 'rap', 'r&b', 'rnb', 'pop', 'reggae', 'dancehall', 'ska', 'latin', 'reggaeton', 'gospel', 'vocal']],
  // m4: bands, acoustic, ambient and the rest
  [4, ['rock', 'indie', 'punk', 'metal', 'folk', 'country', 'jazz', 'blues', 'classical', 'ambient', 'downtempo', 'chill',
       'lo-fi', 'new age', 'soundtrack', 'score', 'experimental', 'shoegaze', 'post-', 'acoustic']],
];

/**
 * The mark colour (0–4, i.e. var(--m0)..var(--m4)) for one style label. Stable:
 * the same label always gets the same colour, on every screen and every run.
 * "Electronic---Bassline" and "Bassline" are the same style.
 * @param {string} label
 * @returns {0|1|2|3|4|null}
 */
export function soundMark(label) {
  const l = sLabel(label);
  if (!l) return null;
  const s = l.toLowerCase();
  const [parent, child = parent] = s.includes('---') ? s.split('---') : [s];
  for (const part of [child, parent])
    for (const [m, words] of SOUND_FAMILIES) if (words.some(w => part.includes(w))) return /** @type any */ (m);
  let h = 2166136261;                                   // FNV-1a over the child label
  for (let i = 0; i < child.length; i++) h = Math.imul(h ^ child.charCodeAt(i), 16777619);
  return /** @type any */ ((h >>> 0) % 5);
}
const sShort = label => { const l = sLabel(label); if (!l) return null; const i = l.indexOf('---'); return i >= 0 ? l.slice(i + 3) : l; };

/**
 * A thin bar split into the clip's sections, each coloured by its top style
 * (§2.2), so a hybrid track looks hybrid. Sections are equal width: they are
 * the clip's analysis windows, not the track's timeline.
 * @param {SoundVM|null|undefined} vm
 */
export function sectionStrip(vm) {
  if (!vm || !Array.isArray(vm.sections)) return '';
  const secs = vm.sections.map(s => (Array.isArray(s) ? s : [s]).map(sShort).filter(Boolean)).filter(s => s.length);
  if (!secs.length) return '';
  const tops = secs.map(s => s[0]);
  const distinct = [...new Set(tops)];
  const hybrid = vm.hybrid === true || distinct.length > 1;
  const said = distinct.length === 1 ? distinct[0] : `${distinct.slice(0, -1).join(', ')} then ${distinct[distinct.length - 1]}`;
  const aria = `${vm.hybrid === true ? 'Hybrid: ' : ''}${secs.length === 1 ? 'one section' : `${secs.length} sections`}, ${said}`;
  const cells = secs.map((s, i) => `<i class="m${soundMark(s[0])}" title="${sEsc(`Section ${i + 1}: ${s.slice(0, 3).join(', ')}`)}"></i>`).join('');
  return `<div class="sstrip${hybrid ? ' sstrip-hybrid' : ''}" role="img" aria-label="${sEsc(aria)}">${cells}</div>`;
}

const SOUND_EVIDENCE = [
  ['tags', 'tags', 'what Last.fm, Wikidata and Discogs call the artist'],
  ['history', 'history', 'where you have filed this artist before'],
  ['sound', 'sound', 'what the track sounds like next to your playlists'],
  ['learned', 'learned', 'what it learned from your accepts and rejects'],
];

/**
 * What a suggestion is made of: the same four badges on every screen (§2.3).
 * Each value is that source's contribution, 0–1; zero or missing is left out.
 * The bar under each badge (--w) is its share, and the title says it in words.
 * @param {EvidenceVM|null|undefined} vm
 */
export function evidenceBadges(vm) {
  if (!vm || typeof vm !== 'object') return '';
  const items = SOUND_EVIDENCE.filter(([k]) => sNum(vm[k]) && vm[k] > 0);
  if (!items.length) return '';
  const total = items.reduce((s, [k]) => s + vm[k], 0);
  const list = items.map(([k, word]) => `${word} ${sPct(vm[k] / total)}`).join(', ');
  return `<span class="evs" role="group" aria-label="${sEsc(`Based on ${list}`)}">${items.map(([k, word, why]) =>
    `<span class="ev ev-${k}" style="--w:${+(sClamp(vm[k] / total)).toFixed(2)}" title="${sEsc(`${word}: ${sPct(vm[k] / total)} of this suggestion — ${why}`)}">${word}</span>`).join('')}</span>`;
}

/**
 * @typedef {object} WhyVM   the reason under File's top pick, in words (BUILD-7 U1)
 * @property {string} playlist          the pick's playlist name
 * @property {'tags'|'history'|'sound'|'blend'|string} [via]
 * @property {number} [count]           history: this artist's other tracks already there
 * @property {number} [total]           history: this artist's other filed tracks
 * @property {string[]} [tags]          the track's own top tags
 * @property {boolean} [sound]          sound is part of the pick
 * @property {boolean} [tagsAgree]      a sound pick the tags name too
 * @property {boolean} [learned]        the learned part is part of the pick
 * @property {boolean} [similar]        blend: where you file artists like this
 * @property {boolean} [untagged]       blend: the artist has no tags
 */

/**
 * Why the top pick, in words, never a percentage (USER-REVIEW item 5): e.g.
 * "4 of 5 other tracks by this artist are already here · tags say liquid dnb ·
 * not heard yet". Each part only when the pick really carries it.
 * @param {WhyVM|null|undefined} vm
 * @returns {string[]}
 */
export function evidenceWords(vm) {
  const name = vm && typeof vm === 'object' ? sLabel(vm.playlist) : null;
  if (!name) return [];
  const out = [];
  const tags = (Array.isArray(vm.tags) ? vm.tags : []).map(sLabel).filter(Boolean).slice(0, 2);
  if (vm.via === 'history' && sNum(vm.count) && sNum(vm.total))
    out.push(`${sInt(vm.count)} of ${sInt(vm.total)} other tracks by this artist are already here`);
  if (vm.sound || vm.via === 'sound') out.push(`sounds like your ${name}`);
  if (vm.via === 'blend') out.push(vm.untagged ? 'where you file this artist and ones like them'
    : vm.similar ? 'tags, and where you file artists like this' : 'tags, and where you file this kind of record');
  if (vm.via === 'sound' && vm.tagsAgree) out.push('tags agree');
  else if (vm.via !== 'history' && vm.via !== 'blend')
    out.push(tags.length ? `tags say ${tags.join(', ')}` : 'its tags fit here');
  if (vm.learned) out.push('learned from what you filed');
  if (!vm.sound && vm.via !== 'sound') out.push('not heard yet');
  return out;
}

/** The evidence line itself: one quiet line of words, '' with nothing to say. */
export function evidenceLine(vm) {
  const w = evidenceWords(vm);
  return w.length ? `<span class="ax evline">${w.map(sEsc).join(' · ')}</span>` : '';
}

/* The engine's bands, plus Tidy's high/medium/low, mapped onto one chip. */
const SOUND_BANDS = {
  HIGH: ['sure', 'Sure'], LIKELY: ['likely', 'Likely'], AMBIGUOUS: ['unsure', 'Unsure'],
  high: ['sure', 'Sure'], medium: ['likely', 'Likely'], low: ['unsure', 'Unsure'],
};

/**
 * One confidence chip, three states (§2.4). The percentage, when given, stays
 * on the chip but smaller, for whoever wants it.
 * @param {BandVM|'high'|'medium'|'low'|undefined} band
 * @param {number} [p]  0–1, optional
 */
export function bandChip(band, p) {
  const b = typeof band === 'string' ? SOUND_BANDS[band] : null;
  if (!b) return '';
  const pct = sNum(p) ? `<span class="pct">${sPct(p)}</span>` : '';
  return `<span class="band band-${b[0]}"${pct ? ` title="${sEsc(`${b[1]}, ${sPct(p)}`)}"` : ''}>${b[1]}${pct}</span>`;
}

const sRange = r => Array.isArray(r) && r.length === 2 && sNum(r[0]) && sNum(r[1]) ? [Math.min(r[0], r[1]), Math.max(r[0], r[1])] : null;

/**
 * A playlist's sound profile (§2.7): how many members have been heard, its
 * BPM range, energy spread and top styles. Nothing until one member is heard.
 * @param {ProfileVM|null|undefined} vm
 */
export function profileRow(vm) {
  if (!vm || typeof vm !== 'object' || !sNum(vm.heard) || vm.heard <= 0) return '';
  const parts = [];
  const members = sNum(vm.members) && vm.members >= vm.heard ? vm.members : null;
  parts.push(`<span class="sprof-heard">${members != null ? `${sInt(vm.heard)} of ${sPlural(members, 'track')} heard` : `${sPlural(vm.heard, 'track')} heard`}</span>`);
  const bpm = sRange(vm.bpm);
  if (bpm && bpm[1] > 0) {
    const [lo, hi] = bpm.map(Math.round);
    const tight = sRange(vm.tempo);
    const title = tight && tight[1] > 0 ? ` title="${sEsc(`most of this playlist is ${Math.round(tight[0])}–${Math.round(tight[1])} BPM`)}"` : '';
    parts.push(`<span class="sprof-bpm"${title}>${lo === hi ? lo : `${lo}–${hi}`} <span class="sprof-unit">BPM</span></span>`);
    if (tight && tight[1] > 0) parts.push(`<span class="sprof-tempo">most is ${Math.round(tight[0])}–${Math.round(tight[1])}</span>`);
  }
  const en = sRange(vm.energy);
  if (en) {
    const [lo, hi] = en.map(sClamp);
    const cells = Array.from({ length: 5 }, (_, i) => { const c = (i + .5) / 5; return `<i${c >= lo - .1 && c <= hi + .1 ? ' class="on"' : ''}></i>`; }).join('');
    parts.push(`<span class="sprof-energy" title="${sEsc(`energy from ${Math.round(lo * 5)} to ${Math.round(hi * 5)} of 5 (a rough measure)`)}">energy <span class="sprof-bars" aria-hidden="true">${cells}</span></span>`);
  }
  const styles = (Array.isArray(vm.styles) ? vm.styles : [])
    .filter(s => Array.isArray(s) && sLabel(s[0])).slice(0, 3);
  if (styles.length) parts.push(`<span class="sprof-styles">${styles.map(([l, p]) => {
    const n = sShort(l);
    return `<span class="sprof-style"><i class="m${soundMark(l)}" aria-hidden="true"></i>${sEsc(n)}${sNum(p) ? ` <span class="sprof-p">${sPct(p)}</span>` : ''}</span>`;
  }).join('')}</span>`);
  return `<div class="sprof" aria-label="How it sounds">${parts.join('<span class="sprof-dot" aria-hidden="true">·</span>')}</div>`;
}

/* Why a run is paused, in a few words (the controller's reasons). */
const sPauseWhy = reason => {
  if (!sLabel(reason) || reason === 'stopped') return null;
  if (reason === 'ask') return 'waiting for you to say it’s Wi-Fi';
  return reason;
};
/* The pill's version: a few words at most, never an error message. The full
 * reason (a failed model load, say) is on the Listening card in Settings, which
 * tapping the pill opens. */
const sPillWhy = reason => {
  const why = sPauseWhy(reason);
  if (!why) return null;
  if (why === 'waiting for you to say it’s Wi-Fi') return 'Wi-Fi?';
  if (/wi-?fi|metered|cellular/i.test(why)) return 'no Wi-Fi';
  if (/offline/i.test(why)) return 'offline';
  if (/couldn|fail|error/i.test(why)) return 'tap for details';
  return null;
};
/* The tidy-up after a run's songs (DESIGN-PLAN L0): the controller's
 * vm.tidy = { step, done, total }. Each step in the listener's words. */
const TIDY_WORDS = { dsp: 'tempo and key', clap: 'describing', beats: 'tempo', keys: 'keys' };
const sTidy = vm => (vm?.state === 'running' && vm.tidy && typeof vm.tidy === 'object' && sNum(vm.tidy.total) && vm.tidy.total > 0 ? vm.tidy : null);

/**
 * The tidy-up step a running ListenVM is on, in a few words ("tempo 3 of 12"),
 * or '' when it is not tidying up. `sep` joins the count ("of", or "/" for the pill).
 * @param {object|null|undefined} vm
 */
export function listenTidyText(vm, sep = 'of') {
  const t = sTidy(vm);
  if (!t) return '';
  const done = sNum(t.done) ? Math.min(t.done, t.total) : 0;
  return `${TIDY_WORDS[t.step] ?? 'finishing'} ${sInt(done)} ${sep} ${sInt(t.total)}`;
}

const sBars = () => `<span class="lp-bars" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>`;
const sIsListen = vm => vm && typeof vm === 'object' && ['running', 'paused', 'done'].includes(vm.state);

/**
 * The listening indicator (§2.5): the mark's five bars as a level meter while
 * a run is going, still bars and the reason when paused. Off renders nothing.
 * The caller decides what tapping it does (UI-5 opens Sources).
 * @param {(ListenVM & { heard?: number })|null|undefined} vm
 */
export function listenPill(vm) {
  if (!sIsListen(vm)) return '';
  const done = sNum(vm.done) ? vm.done : 0, total = sNum(vm.total) ? vm.total : 0;
  let text;
  const tidy = listenTidyText(vm, '/');
  if (tidy) text = `Tidying up · ${tidy}`;
  else if (vm.state === 'running') text = total ? `Listening · ${sInt(Math.min(done, total))} / ${sInt(total)}` : 'Listening…';
  else if (vm.state === 'paused') { const why = sPillWhy(vm.reason); text = `Paused${why ? ` · ${why}` : ''}`; }
  else text = sNum(vm.heard) && vm.heard > 0 ? `Listened · ${sPlural(vm.heard, 'track')} heard` : 'Listened · up to date';
  return `<span class="lpill lpill-${vm.state}" role="status">${sBars()}<span class="lp-txt">${sEsc(text)}</span></span>`;
}

/* The miss reasons, in plain English. B2's MISS_TEXT wins when the audio
 * bundle is loaded; this copy is only so the renderer works on its own. */
const SOUND_MISS_TEXT = {
  NO_ISRC: 'Spotify gave no recording code (ISRC), so there is nothing safe to look up',
  NOT_ON_DEEZER: 'not on Deezer',
  NO_PREVIEW: 'on Deezer, but with no preview to listen to',
  IDENTITY: 'Deezer’s version is a different length, so probably a different recording',
  TOO_SHORT: 'the preview was too short to hear',
  FAILED: 'a download or decode failed this session (it will be tried again)',
};
const sMissed = vm => Object.entries(vm?.missed && typeof vm.missed === 'object' ? vm.missed : {})
  .filter(([, n]) => sNum(n) && n > 0).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));

/**
 * The body of the Listening card on Sources (§2.6). B2 draws the controls
 * (switches, scope, Listen now); this is the status under them: where the run
 * is, how many have been heard, and what couldn't be.
 * @param {(ListenVM & { heard?: number })|null|undefined} vm
 */
export function listenCard(vm) {
  if (!vm || typeof vm !== 'object') return '';
  const heard = sNum(vm.heard) && vm.heard > 0 ? vm.heard : 0;
  const missed = sMissed(vm).reduce((s, [, n]) => s + n, 0);
  if (!sIsListen(vm) && !heard) return '';
  const done = sNum(vm.done) ? vm.done : 0, total = sNum(vm.total) ? vm.total : 0;
  let head;
  const tidy = sTidy(vm);
  if (tidy) head = `Tidying up: ${listenTidyText(vm)}`;
  else if (vm.state === 'running') head = total ? `Listening to ${sInt(Math.min(done, total))} of ${sInt(total)} this run` : 'Starting…';
  else if (vm.state === 'paused') { const why = sPauseWhy(vm.reason); head = why ? `Paused: ${why}` : 'Paused. It carries on where it left off.'; }
  else if (vm.state === 'done') head = 'Up to date for this scope';
  else head = 'Off';
  const stats = [];
  if (heard) stats.push(`<span class="lc-stat"><b>${sInt(heard)}</b> heard</span>`);
  if (missed) stats.push(`<span class="lc-stat"><b>${sInt(missed)}</b> couldn’t be heard</span>`);
  const allMiss = !heard && missed > 0 && vm.state !== 'running';
  const [mDone, mTotal] = tidy ? [sNum(tidy.done) ? tidy.done : 0, tidy.total] : [done, total];
  const meter = vm.state === 'running' && mTotal
    ? `<div class="lc-meter" role="progressbar" aria-valuemin="0" aria-valuemax="${mTotal}" aria-valuenow="${Math.min(mDone, mTotal)}" aria-label="${tidy ? 'Tidying up' : 'This run'}"><i style="width:${sPct(Math.min(mDone, mTotal) / mTotal)}"></i></div>` : '';
  return `<div class="lcard lcard-${sIsListen(vm) ? vm.state : 'off'}">
    <div class="lc-head">${sIsListen(vm) ? `<span class="lpill lpill-${vm.state} lc-bars">${sBars()}</span>` : ''}<span class="lc-title">${sEsc(head)}</span></div>
    ${meter}${stats.length ? `<div class="lc-stats">${stats.join('')}</div>` : ''}
    ${allMiss ? `<p class="lc-note">None of these could be heard yet. The reasons are below; most are tracks Deezer has no preview for.</p>` : ''}
    ${missedList(vm)}
  </div>`;
}

/**
 * The "couldn't be heard" list: one line per reason, most common first.
 * @param {ListenVM|null|undefined} vm
 */
export function missedList(vm) {
  const missed = sMissed(vm);
  if (!missed.length) return '';
  const text = { ...SOUND_MISS_TEXT, ...(globalThis.BetterfyAudio?.MISS_TEXT ?? {}) };
  const n = missed.reduce((s, [, k]) => s + k, 0);
  return `<details class="smiss"><summary>${sPlural(n, 'track')} couldn’t be heard</summary>
    <ul>${missed.map(([k, c]) => `<li><b>${sInt(c)}</b> ${sEsc(text[k] ?? k)}</li>`).join('')}</ul></details>`;
}
