// Mood, voice and energy: shown only once they have been checked on real previews.
//
// The heads (WP-F1, core/audio/heads.mjs) already put mood/theme, voice and
// danceability scores into every record, and WP-D4 puts a rough energy into
// `dsp.energy`. None of it has been checked on real Deezer previews, so none
// of it is shown. This file is the check and the switch:
//
//   - reviewSample() picks 30 heard tracks spread across the account's
//     playlists, and reviewVM()/reviewHTML() draw the "Check sound labels"
//     card on Sources, where the listener marks each reading right or wrong.
//   - The verdicts are kept per account (one Spotify user id each), never
//     pooled across accounts (SMARTER-GENRES-PLAN §3).
//   - agreement() turns them into a number per label type, and a label type
//     is shown only when at least AGREE_MIN of at least REVIEW_MIN reviewed
//     tracks were right. Below that it stays hidden, exactly as before.
//
// Everything is off by default: no records, or no verdicts, and every output
// here is null or '' so the page is byte-identical to the one without it.
// `localStorage.bf_audio_labels = '1'` shows all three in one browser (for
// checking the display before the review is done), '0' hides them.
import { moodHints } from '../../core/audio/heads.mjs';

export const LABEL_TYPES = Object.freeze(['mood', 'voice', 'energy']);
/** A label type is shown only when this share of its reviewed tracks was right… */
export const AGREE_MIN = 0.7;
/** …over at least this many reviewed tracks. */
export const REVIEW_MIN = 20;
/** Tracks offered per review. */
export const REVIEW_SIZE = 30;
/** Moods shown per track. */
export const MOOD_TOP = 3;
/** Voice is called vocal at or above this p, instrumental below. */
export const VOICE_CUT = 0.5;
export const LABELS_UI_KEY = 'bf_audio_labels';
/** The page's kv key for the verdicts: { [spotifyUserId]: { [trackId]: Check } }. */
export const CHECKS_KEY = 'labelchecks';

const fin = v => typeof v === 'number' && Number.isFinite(v);

/* ------------------------------------------------------------ readings */

/** The top MOOD_TOP ontology moods (through heads.mjs's MOOD_MAP), or null. */
export function moodsOf(rec) {
  const h = rec && !rec.miss ? rec.heads : null;
  const names = moodHints(h).filter(x => x.facet === 'mood').slice(0, MOOD_TOP).map(x => x.concept);
  return names.length ? names : null;
}

/** 'vocal' | 'instrumental' | null. */
export function voiceOf(rec) {
  const p = rec && !rec.miss ? rec.heads?.voice : null;
  return fin(p) ? (p >= VOICE_CUT ? 'vocal' : 'instrumental') : null;
}

/** D4's energy, 0–1, or null. */
export function energyOf(rec) {
  const e = rec && !rec.miss ? rec.dsp?.energy : null;
  return fin(e) ? Math.max(0, Math.min(1, e)) : null;
}

/** All three readings for one record, whatever the flag says. */
export function readingsOf(rec) {
  return { mood: moodsOf(rec), voice: voiceOf(rec), energy: energyOf(rec) };
}
const hasAny = r => r.mood != null || r.voice != null || r.energy != null;

/* ------------------------------------------------------------ verdicts */

/**
 * The checks for one account. `all` is what is stored under CHECKS_KEY.
 * @returns {{ [trackId: string]: { at: number, seen: object, mood?: boolean, voice?: boolean, energy?: boolean } }}
 */
export function checksFor(all, userId) {
  const c = userId && all && typeof all === 'object' ? all[userId] : null;
  return c && typeof c === 'object' ? c : {};
}

/**
 * One verdict. Returns a new `all`; the input is not changed. `seen` is the
 * reading the listener was shown, kept so a later mapping change can tell
 * which verdicts were about what. `ok` null clears the verdict.
 */
export function withVerdict(all, userId, trackId, type, ok, seen, at = Date.now()) {
  if (!userId || !trackId || !LABEL_TYPES.includes(type)) return all ?? {};
  const mine = { ...checksFor(all, userId) };
  const cur = { ...(mine[trackId] ?? {}), at, seen: { ...(mine[trackId]?.seen ?? {}), [type]: seen ?? null } };
  if (ok === true || ok === false) cur[type] = ok; else delete cur[type];
  mine[trackId] = cur;
  return { ...(all ?? {}), [userId]: mine };
}

/**
 * Agreement per label type over one account's checks.
 * @returns {{ [type: string]: { reviewed: number, right: number, rate: number|null, on: boolean } }}
 */
export function agreement(checks) {
  const out = {};
  for (const type of LABEL_TYPES) {
    let reviewed = 0, right = 0;
    for (const c of Object.values(checks ?? {})) {
      if (c?.[type] === true) { reviewed++; right++; } else if (c?.[type] === false) reviewed++;
    }
    const rate = reviewed ? right / reviewed : null;
    out[type] = { reviewed, right, rate, on: reviewed >= REVIEW_MIN && rate >= AGREE_MIN };
  }
  return out;
}

/** Which label types are shown: the per-browser override, else what agreement() says. */
export function labelsShown(checks, ls = globalThis.localStorage) {
  let v = null;
  try { v = ls?.getItem?.(LABELS_UI_KEY) ?? null; } catch { v = null; }
  if (v === '1') return { mood: true, voice: true, energy: true };
  if (v === '0') return { mood: false, voice: false, energy: false };
  const a = agreement(checks);
  return { mood: a.mood.on, voice: a.voice.on, energy: a.energy.on };
}

/* ------------------------------------------------------------ view models */

/** The mood/voice/energy part of a SoundVM, for the types shown, or null. */
export function labelSoundVM(rec, shown) {
  if (!shown || !rec || rec.miss) return null;
  const r = readingsOf(rec), vm = {};
  if (shown.mood && r.mood) vm.moods = r.mood;
  if (shown.voice && r.voice) vm.voice = r.voice;
  if (shown.energy && r.energy != null) vm.energy = r.energy;
  return Object.keys(vm).length ? vm : null;
}

/** dspSoundVM's result plus the labels. Either may be null; both null is null. */
export function mergeSoundVM(dspVM, labelVM) {
  if (!labelVM) return dspVM ?? null;
  if (!dspVM) return labelVM;
  return { ...dspVM, ...labelVM };
}

/** A ProfileVM with the playlist's energy spread (10th–90th percentile), when energy is shown and 3+ members have one. */
export function withProfileEnergy(vm, playlist, records, shown) {
  if (!vm || !shown?.energy) return vm;
  const es = [];
  for (const t of playlist?.tracks ?? []) {
    const e = energyOf(records?.get?.(t?.id));
    if (e != null) es.push(e);
  }
  if (es.length < 3) return vm;
  es.sort((a, b) => a - b);
  const q = f => es[Math.min(es.length - 1, Math.max(0, Math.round(f * (es.length - 1))))];
  return { ...vm, energy: [+q(0.1).toFixed(2), +q(0.9).toFixed(2)] };
}

/* ------------------------------------------------------------ the review */

/** A small deterministic PRNG, so one seed always gives the same sample. */
function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s = Math.imul(s ^ (s >>> 15), 2246822507); s = Math.imul(s ^ (s >>> 13), 3266489909); s ^= s >>> 16; return (s >>> 0) / 4294967296; };
}

/**
 * Up to `n` heard tracks with at least one reading, spread across playlists:
 * one from each playlist in turn (each playlist's tracks shuffled by `seed`),
 * so a big playlist cannot fill the review alone. Tracks already checked are
 * left out, so a second review adds new ones. Liked songs come last.
 *
 * @param {{ playlists?: object[], liked?: object[] }} lib
 * @param {Map<string, object>} records
 * @returns {{ track: object, playlist: { id: string, name: string }|null }[]}
 */
export function reviewSample(lib, records, { n = REVIEW_SIZE, seed = 1, checks = {}, skip = () => false } = {}) {
  if (!records?.size) return [];
  const rand = rng(seed);
  const usable = t => t?.id && !checks[t.id] && hasAny(readingsOf(records.get(t.id)));
  const pools = [];
  for (const p of lib?.playlists ?? []) {
    if (skip(p)) continue;
    const ts = (p.tracks ?? []).filter(usable);
    if (!ts.length) continue;
    for (let i = ts.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [ts[i], ts[j]] = [ts[j], ts[i]]; }
    pools.push({ p: { id: p.id, name: p.name }, ts });
  }
  const liked = (lib?.liked ?? []).filter(usable);
  if (liked.length) pools.push({ p: null, ts: liked });
  const out = [], seen = new Set(), at = pools.map(() => 0);
  while (out.length < n) {
    let any = false;
    pools.forEach(({ p, ts }, k) => {
      if (out.length >= n) return;
      while (at[k] < ts.length && seen.has(ts[at[k]].id)) at[k]++;
      const t = ts[at[k]++];
      if (!t) return;
      seen.add(t.id); out.push({ track: t, playlist: p }); any = true;
    });
    if (!any) break;
  }
  return out;
}

/**
 * The card's view model. `sample` is reviewSample()'s, `checks` the account's.
 * Null when there is nothing to check and nothing checked: then the card is not drawn.
 */
export function reviewVM(sample, records, checks) {
  const items = (sample ?? []).map(({ track, playlist }) => {
    const r = readingsOf(records?.get?.(track.id));
    return {
      id: track.id, name: track.name ?? '', artists: (track.artists ?? []).map(a => a?.name).filter(Boolean).join(', '),
      playlist: playlist?.name ?? null, readings: r, verdict: checks?.[track.id] ?? null,
    };
  }).filter(x => hasAny(x.readings));
  const agree = agreement(checks);
  const reviewed = LABEL_TYPES.some(t => agree[t].reviewed > 0);
  if (!items.length && !reviewed) return null;
  return { items, agree };
}

const esc = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const TYPE_NAME = { mood: 'Mood', voice: 'Voice', energy: 'Energy' };
const showReading = (type, v) => type === 'mood' ? v.join(', ')
  : type === 'energy' ? `${Math.round(v * 5)} of 5` : v;
export const seenOf = (type, v) => type === 'mood' ? v.join(',') : type === 'energy' ? +v.toFixed(2) : v;

function agreeLine(type, a) {
  const st = a.on ? 'shown' : a.reviewed < REVIEW_MIN ? `${REVIEW_MIN - a.reviewed} more to go` : 'hidden';
  return `<li class="lck-agree lck-${a.on ? 'on' : 'off'}"><b>${TYPE_NAME[type]}</b> ${a.reviewed
    ? `${a.right} of ${a.reviewed} right (${Math.round(a.rate * 100)}%)` : 'not checked yet'} · <span class="lck-st">${st}</span></li>`;
}

/** The "Check sound labels" card on Sources. '' for a null view model. */
export function reviewHTML(vm) {
  if (!vm) return '';
  const rows = vm.items.map(it => {
    const cells = LABEL_TYPES.filter(t => it.readings[t] != null).map(t => {
      const v = it.verdict?.[t];
      const btn = (ok, word) => `<button class="b sm lck-b${v === ok ? ' lck-sel' : ''}" data-lchk="${esc(it.id)}" data-lt="${t}" data-lok="${ok ? 1 : 0}" aria-pressed="${v === ok}">${word}</button>`;
      return `<div class="lck-cell"><span class="lck-t">${TYPE_NAME[t]}</span> <span class="lck-v">${esc(showReading(t, it.readings[t]))}</span>
        <span class="lck-btns">${btn(true, 'Right')}${btn(false, 'Wrong')}</span></div>`;
    }).join('');
    return `<li class="lck-row"><div class="lck-name"><a href="https://open.spotify.com/track/${encodeURIComponent(it.id)}" target="_blank" rel="noopener"><b>${esc(it.name)}</b></a>${it.artists ? ` <span class="sub">${esc(it.artists)}</span>` : ''}${
      it.playlist ? ` <span class="lck-pl">${esc(it.playlist)}</span>` : ''}</div>${cells}</li>`;
  }).join('');
  return `<div id="labelCheck">
    <div class="srchead"><h2 id="src-labels-h">Check sound labels</h2></div>
    <p class="srcline">Listening also guesses each track’s mood, whether it has vocals, and its energy. None of it is shown until you’ve checked it:
      open a few of these in Spotify and say whether each guess is right. A label type appears in the app once ${Math.round(AGREE_MIN * 100)}% of at least ${REVIEW_MIN} tracks are right.</p>
    <ul class="lck-sum">${LABEL_TYPES.map(t => agreeLine(t, vm.agree[t])).join('')}</ul>
    ${rows ? `<ol class="lck-list">${rows}</ol>` : '<p class="sub">Nothing new to check. Listen to more tracks and come back.</p>'}
    <div class="rowbtns"><button class="b sm" id="labelCheckMore">Show other tracks</button></div>
  </div>`;
}
