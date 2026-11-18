// @bundle screens settings 42
/* The Settings sheet's structure (DESIGN-PLAN L5, owner's ask 2026-11-18: "refurbish the
 * settings area"). One list of sections, top to bottom, each collapsible, each with a
 * one-line status that shows when it is closed. This file is only the words and the
 * markup: web/app/shell.js holds which are open and paints them. Plain listener words;
 * nothing here names an internal state. */

/** Every section in order. `mod` is the screen module whose actions its controls use
 *  (the sheet finds them through the [data-uh] wrapper); `fixed` sections are markup in
 *  the page template, wired once, and only shown or hidden. */
export const SECTIONS = [
  { id: 'engine', title: 'Your score & how it picks', mod: 'engine' },
  { id: 'sources', title: 'Listening', mod: 'sources' },
  { id: 'helpers', title: 'What’s helping your picks', mod: 'sources' },
  { id: 'data', title: 'Your data', mod: 'sources' },
  { id: 'history', title: 'History', mod: 'history' },
  { id: 'appearance', title: 'Appearance', fixed: true },
  { id: 'about', title: 'About & updates', fixed: true },
];

/** Section ids that open by default: the one people come for. */
export const OPEN_BY_DEFAULT = ['sources'];

const num = x => (Number.isFinite(x) ? Math.round(x).toLocaleString('en-GB') : '0');

/** A raw failure turned into something a listener can act on. Never shows a stack or a URL. */
export function plainProblem(raw) {
  const s = String(raw ?? '').replace(/https?:\/\/\S+/g, '').trim();
  if (!s) return '';
  if (/dynamically imported|failed to fetch|networkerror|load failed|net::|timed? ?out|no answer/i.test(s))
    return 'couldn’t download the listening model, so it will try again later';
  if (/memory|allocation|out of/i.test(s)) return 'this device ran out of memory';
  if (/wasm|webassembly|onnx|runtime/i.test(s)) return 'this browser couldn’t run the listening model';
  return s.slice(0, 80);
}

/** "Listening: on, heard 7,161 of 9,000": the closed line. */
export function listeningSummary({ on = false, state = null, reason = null, done = 0, total = 0, heard = 0, library = 0 } = {}) {
  if (!on) return 'Off';
  const h = heard ? `heard ${num(heard)}${library >= heard ? ` of ${num(library)}` : ''}` : 'nothing heard yet';
  if (state === 'running') return total ? `On, listening ${num(Math.min(done, total))} of ${num(total)} · ${h}` : `On, starting · ${h}`;
  if (reason === 'waiting for Wi-Fi') return `On, waiting for Wi-Fi · ${h}`;
  if (reason === 'offline') return `On, offline · ${h}`;
  return `On, ${h}`;
}

/** "Your score": the last Score run, or what it is waiting for. */
export function scoreSummary({ top1 = null, running = false } = {}) {
  if (running) return 'Scoring now…';
  if (Number.isFinite(top1)) return `Right first time on ${Math.round(top1 * 100)}% of what you filed`;
  return 'Not scored yet. It scores itself once you have filed enough';
}

export function dataSummary({ playlists = 0 } = {}) {
  return `Kept on this device${playlists ? ` · ${num(playlists)} playlists to back up` : ''}`;
}

export function historySummary({ count = null } = {}) {
  return Number.isFinite(count) && count > 0
    ? `${num(count)} thing${count === 1 ? '' : 's'} Betterfy wrote to Spotify, each with undo`
    : 'Everything Betterfy wrote to Spotify, with undo';
}

const MODES = { dark: 'Nightshift', light: 'Daylight', system: 'System' };
export function appearanceSummary({ mode = 'dark', accent = null } = {}) {
  return `${MODES[mode] ?? MODES.dark}${accent ? ` · ${accent}` : ''}`;
}

export function aboutSummary({ build = '' } = {}) {
  return build && !String(build).startsWith('__') ? `Build ${build} · updates and library re-read` : 'Updates and library re-read';
}

/** Each section's closed line, from one plain snapshot of the page. */
export function sectionSummaries(s = {}) {
  return {
    engine: scoreSummary(s.score), sources: listeningSummary(s.listening), helpers: s.helpers ?? '',
    data: dataSummary(s.data), history: historySummary(s.history),
    appearance: appearanceSummary(s.appearance), about: aboutSummary(s.about),
  };
}

/** One section's header (a button, aria-expanded) and, when open, its body. */
export function sectionHTML({ id, title, summary, open, body = '', mod = null, esc = x => String(x ?? '') }) {
  return `<div class="uh${open ? ' open' : ''}" data-uhsec="${esc(id)}">
    <button class="uhhead" type="button" id="uh-${esc(id)}-h" data-uhtoggle="${esc(id)}" aria-expanded="${!!open}" aria-controls="uh-${esc(id)}-b">
      <span class="uht"><b>${esc(title)}</b><span class="uhs">${esc(summary)}</span></span><span class="chev" aria-hidden="true"></span>
    </button>${open ? `<div class="uhbody" id="uh-${esc(id)}-b" role="region" aria-labelledby="uh-${esc(id)}-h"${mod ? ` data-uh="${esc(mod)}"` : ''}>${body}</div>` : ''}</div>`;
}
