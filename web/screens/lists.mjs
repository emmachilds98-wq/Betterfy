// @bundle screens lists 50
/* The Library tab (docs/archive/BUILD-5-PLAN.md A4, UI-E): compact playlist rows, a Suggested playlists section, and a detail sheet per playlist. Was the Playlists screen: an ES module. Reaches nothing but `ctx`;
 * SCREEN_CTX.lists in app/screens.js builds it. playlistMixes, tagCoverage, the sound profiles
 * and the split job stay classic in app/screenjobs.js. */

import { mergePlan, splitPlan, partsFromSound, partsFromTags, moveTrack, renamePart, includePart, writesOf,
  twinOffers, offerKey, readMeasure, recordOffer } from '../../core/playlists/mergesplit.mjs';
import { weakWords } from '../../core/review/weakwords.mjs';

const AXES = ['genre','mood','era','event','djset','context','inbox'];
/** The axis names in plain words, for the sheet's picker (USER-REVIEW item 8). The values stay the axis ids. */
const AXIS_WORDS = { genre: 'genre', mood: 'mood', era: 'era or year', event: 'an event', djset: 'a DJ set',
  context: 'a time or place', inbox: 'an inbox to sort later' };

/** The proposals worth a line at the top of Library: genres with no playlist, hybrids and new
 *  genres by sound, backlog groups. Nothing until the gaps are worked out; nothing already made.
 *  Same data the New playlists screen draws in full. */
export function suggestionsOf(GAPS, R) {
  if (!GAPS || GAPS.status !== 'ready') return [];
  const made = n => GAPS.made?.has(String(n).toLowerCase());
  const out = [];
  for (const g of GAPS.gaps ?? []) if (!made(g.label)) out.push({ title: g.label, n: g.size, why: 'genre with no playlist' });
  for (const [i, o] of (GAPS.sound?.orphans ?? []).entries())
    if (!GAPS.filed?.has('o' + i)) out.push({ title: o.confirmed ?? o.suggest?.name ?? 'New genre?', n: o.size, why: 'new genre, by sound' });
  for (const h of GAPS.sound?.hybrids ?? []) if (!made(h.name)) out.push({ title: h.name, n: h.size, why: 'sits between two of yours' });
  for (const x of R?.clusters ?? []) out.push({ title: x.tags?.[0] ?? 'Unfiled group', n: x.size, why: 'unfiled tracks that sit together' });
  return out;
}

/** Tracks that appear more than once in a playlist (same Spotify id): the surplus copies. */
export function repeatCount(tracks) {
  const seen = new Set(); let n = 0;
  for (const t of tracks ?? []) { if (!t?.id) continue; if (seen.has(t.id)) n++; else seen.add(t.id); }
  return n;
}

/** Days since the newest track was added, or null when no track says when (nothing is guessed). */
export function staleDays(tracks, now = Date.now()) {
  let newest = -Infinity;
  for (const t of tracks ?? []) { const x = Date.parse(t?.added_at); if (Number.isFinite(x) && x > newest) newest = x; }
  return Number.isFinite(newest) ? Math.max(0, Math.floor((now - newest) / 864e5)) : null;
}

/** Playlists the engine could not tell apart (bucketPairs' "indistinguishable" verdict), by playlist id: the names of its twins. */
export function twinsOf(pairs) {
  const out = new Map();
  for (const p of Array.isArray(pairs) ? pairs : []) {
    if (p?.verdict !== 'indistinguishable' || !p.a?.id || !p.b?.id) continue;
    for (const [x, y] of [[p.a, p.b], [p.b, p.a]]) out.set(x.id, [...(out.get(x.id) ?? []), y.name ?? y.id]);
  }
  return out;
}

/** 0-100 and the reasons, from what Betterfy already knows about one playlist: misfiled tracks,
 *  drift, a second genre, a twin it cannot be told from, repeats, an axis nobody has settled.
 *  The score is about fit, not age (USER-REVIEW item 8): an old playlist that holds together is
 *  healthy, so staleness is said as a note and costs nothing, while any misfiled track costs at
 *  least 5, so strays show up sooner than their share alone would say. Null under eight tracks (too few to
 *  judge). Every input is optional: no data, no mark. */
export function playlistHealth({ tracks = 0, misfiled = 0, drifting = false, split = false, undecided = false,
                                 twins = [], repeats = 0, staleDays: stale = null } = {}) {
  if (tracks < 8) return null;
  const notes = [];
  let score = 100;
  if (misfiled) { score -= Math.min(45, 5 + Math.round(misfiled / tracks * 150)); notes.push(`${misfiled} track${misfiled === 1 ? '' : 's'} look${misfiled === 1 ? 's' : ''} misfiled`); }
  if (drifting) { score -= 15; notes.push('newest additions read differently from the rest'); }
  if (split) { score -= 20; notes.push('sounds like two genres'); }
  if (twins?.length) { score -= 10; notes.push(`hard to tell apart from ${twins.slice(0, 2).join(' and ')}`); }
  if (repeats > 0) { score -= Math.min(15, repeats * 3); notes.push(`${repeats} repeated track${repeats === 1 ? '' : 's'}`); }
  if (stale !== null && stale >= 365) { notes.push(`nothing added in ${Math.floor(stale / 365)}+ year${stale >= 730 ? 's' : ''}`); }
  if (undecided) { score -= 10; notes.push('no axis decided yet'); }
  score = Math.max(0, score);
  return { score, word: score >= 85 ? 'Healthy' : score >= 65 ? 'Fine' : 'Needs a look', notes };
}

/** "These look like genre playlists": playlists not yet called genre (and not set by you) whose tags are mostly
 *  genre, or somewhat genre with a sound profile that is mostly one style. One tap to confirm, none to ignore. */
export function genreTickSuggestions(rows, mixes, sounds) {
  const out = [];
  for (const p of rows ?? []) {
    if (p.axis === 'genre' || p.why === 'set by you' || !(p.tracks >= 8) || p.mirror) continue;
    const mix = mixes?.get?.(p.id);
    if (!mix?.tracks) continue;
    const topStyle = sounds?.(p.id)?.styles?.[0]?.[1] ?? 0;
    const g = mix.genre ?? 0;
    if (g >= 0.5 || (g >= 0.3 && topStyle >= 0.5))
      out.push({ id: p.id, name: p.name, why: `${Math.round(g * 100)}% of its tags are genre${g < 0.5 ? ' and it sounds like one style' : ''}` });
  }
  return out;
}

/** "Start these playlists" for an account with no genre playlist: groups made only of what Spotify gives
 *  (artist/format/era, plus unnamed sound clusters named by sound ID when the engine and CLAP have run). Nothing is made until tapped. */
export function coldStartOffers({ proposals = [], clusters = [] } = {}, limit = 6) {
  const out = [];
  for (const c of clusters) {
    const ids = c.ids ?? (c.tracks ?? []).map(t => t.id);
    if (ids.length < 4) continue;
    const name = c.confirmed ?? c.suggest?.name ?? null;
    out.push({ title: name ?? 'Group that sounds alike', named: !!name, n: ids.length, ids, why: 'sounds alike',
      eg: (c.tracks ?? []).slice(0, 3).map(t => t.name).filter(Boolean) });
  }
  for (const p of proposals)
    if ((p.ids?.length ?? 0) >= 4) out.push({ title: p.label, named: false, n: p.ids.length, ids: p.ids,
      why: p.kind === 'artist' ? 'one artist you collect' : 'same era and length',
      eg: (p.examples ?? []).slice(0, 3).map(e => e.name).filter(Boolean) });
  return out.slice(0, limit);
}

/** New-genre candidates: clusters of the tracks the calibration is "unsure" about, most listened-to first
 *  (artists in `active`, Spotify's recent and short-term top), each named by sound ID where CLAP has a name. */
export function newGenreOffers(clusters, active) {
  const played = c => (c.tracks ?? []).filter(t => (t.artists ?? []).some(a => active?.has?.(a))).length;
  return (clusters ?? []).map(c => ({ ...c, ids: c.ids ?? (c.tracks ?? []).map(t => t.id), played: played(c) }))
    .filter(c => c.ids.length >= 4)
    .sort((a, b) => b.played - a.played || b.ids.length - a.ids.length)
    .map(c => { const name = c.confirmed ?? c.suggest?.name ?? null;
      return { title: name ? `${name}?` : 'New genre?', n: c.ids.length, ids: c.ids, played: c.played, named: !!name,
        why: 'tracks Betterfy is unsure where to file, sitting together' }; });
}

/** A thin strip of how a playlist sounds: its top styles as a stacked bar, else its energy range. '' without a profile. */
export function sparkHTML(vm) {
  const styles = (Array.isArray(vm?.styles) ? vm.styles : []).filter(s => Array.isArray(s) && s[1] > 0).slice(0, 3);
  if (styles.length) return `<span class="plspark" aria-hidden="true">${styles.map(([, p], i) =>
    `<i class="sp${i}" style="flex:${Math.max(0.05, p)}"></i>`).join('')}</span>`;
  const en = vm?.energy;
  if (Array.isArray(en) && en.length === 2 && en.every(Number.isFinite)) {
    const [lo, hi] = [Math.min(...en), Math.max(...en)];
    return `<span class="plspark plspark-e" aria-hidden="true">${Array.from({ length: 5 }, (_, i) => {
      const c = (i + .5) / 5; return `<i${c >= lo - .1 && c <= hi + .1 ? ' class="on"' : ''}></i>`; }).join('')}</span>`;
  }
  return '';
}

/** Unfiled tracks whose first pick is each playlist: what is waiting to be filed there, by playlist id. */
export function waitingCounts(backlog) {
  const out = new Map();
  for (const t of backlog ?? []) { const id = t?.suggest?.[0]?.id; if (id) out.set(id, (out.get(id) ?? 0) + 1); }
  return out;
}

/** The plain-word facts on a Library row, in order: misfiled, waiting to be filed here, the BPM
 *  range its heard tracks settle on, and its top style. Nothing is shown that is not known. */
export function rowFacts({ misfiled = 0, waiting = 0, vm = null } = {}) {
  const out = [];
  if (misfiled > 0) out.push({ k: 'warn', text: `${misfiled} misfiled` });
  if (waiting > 0) out.push({ k: 'ok', text: `${waiting} to file` });
  const b = vm?.bpm;
  const r = Array.isArray(b) ? b : Number.isFinite(b) ? [b, b] : null;
  if (r && r.every(x => Number.isFinite(x) && x > 0)) {
    const [lo, hi] = [Math.round(Math.min(...r)), Math.round(Math.max(...r))];
    out.push({ k: 'bpm', text: `${lo === hi ? lo : `${lo}–${hi}`} BPM` });
  }
  const top = (Array.isArray(vm?.styles) ? vm.styles : []).find(s => Array.isArray(s) && s[0] && s[1] > 0);
  if (top) out.push({ k: 'style', text: String(top[0]) });
  return out;
}

/** Library's order: what needs a look first (health under 85, lowest first, then most to fix), then
 *  every other playlist by size. A playlist too small to judge sorts with the healthy ones. */
export function attentionOrder(rows, infoOf) {
  const key = p => { const i = infoOf(p); const s = i?.health?.score;
    return { need: s != null && s < 85, s: s ?? 100, fix: (i?.misfiled ?? 0) + (i?.waiting ?? 0) }; };
  const k = new Map(rows.map(p => [p, key(p)]));
  return [...rows].sort((a, b) => { const x = k.get(a), y = k.get(b);
    if (x.need !== y.need) return x.need ? -1 : 1;
    if (x.need && x.s !== y.s) return x.s - y.s;
    if (x.need && x.fix !== y.fix) return y.fix - x.fix;
    return (b.tracks ?? 0) - (a.tracks ?? 0) || String(a.name ?? '').localeCompare(String(b.name ?? '')); });
}

/** The score a row shows only below this (DESIGN-PLAN L2): a healthy playlist's row says nothing about health. */
export const ROW_SCORE_BELOW = 90;

/** What Tidy has to act on in one playlist, from the reports Library already holds: tracks that look
 *  misfiled there and repeats inside it. `sec` is the Tidy section to open on (the one with rows). */
export function tidyFor(R, id) {
  const misfiled = (R?.misfiled ?? []).filter(m => m.currentPlaylistId === id).length;
  const repeats = (R?.within ?? []).filter(x => x.playlistId === id).length;
  const n = misfiled + repeats;
  return n ? { n, sec: misfiled ? 'misfile' : 'dupes' } : null;
}

/** File's queue with the tracks whose first pick is this playlist moved to the front, in their own order
 *  (the "N to file" button). Nothing else changes order. */
export function fileFirst(backlog, id) {
  const mine = [], rest = [];
  for (const t of backlog ?? []) (t?.suggest?.[0]?.id === id ? mine : rest).push(t);
  return { order: [...mine, ...rest], n: mine.length };
}

/** The words for a health score, and its colour class. */
const healthClass = s => s >= 85 ? 'ok' : s >= 65 ? 'fine' : 'low';

/** "How well it knows you": the last Score run on this account, in one line. Never a number nobody measured. */
export function knowsYouLine(sum, now = Date.now()) {
  if (!sum || !Number.isFinite(sum.top1)) return 'Not measured yet. It checks its picks against what you already filed by itself, about a minute after Betterfy opens.';
  const pc = x => `${Math.round(x * 100)}%`;
  const days = Number.isFinite(sum.at) ? Math.floor((now - sum.at) / 864e5) : null;
  const when = days == null ? '' : days <= 0 ? ', checked today' : days === 1 ? ', checked yesterday' : `, checked ${days} days ago`;
  return `Right first time on ${pc(sum.top1)} of your filed tracks${Number.isFinite(sum.top3) ? `, and in its top three on ${pc(sum.top3)}` : ''}`
    + `${Number.isFinite(sum.scored) ? ` (${sum.scored.toLocaleString()} tracks${when})` : when ? ` (${when.slice(2)})` : ''}.`;
}

/** Library's Score card (owner, 2026-11-18: "i cant find score"): the last Score + Tune run, or that one is on its way,
 *  and whether listening has heard enough for sound to count. Words only; the numbers are the Engine's own. */
export function scoreCardHTML(c, now = Date.now()) {
  const info = c.scoreCard?.();
  if (!info) return '';
  const { esc } = c, pc = x => `${Math.round(x * 100)}%`, sum = info.score;
  const has = Number.isFinite(sum?.top1);
  // Before the first run there is nothing to show, and the run starts by itself:
  // Settings › Your score says so. Library leads with the playlists instead.
  if (!has && !info.running) return '';
  const days = has && Number.isFinite(sum.at) ? Math.floor((now - sum.at) / 864e5) : null;
  const when = days == null ? '' : days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
  const head = info.running ? 'Scoring…'
    : has ? `Your score: top-1 ${pc(sum.top1)}${Number.isFinite(sum.top3) ? ` · top-3 ${pc(sum.top3)}` : ''}`
    : 'Not scored yet';
  const sub = info.running ? 'Checking its picks against what you filed. You can keep using Betterfy.'
    : has ? `Last run ${when}${info.build ? `, build ${esc(info.build)}` : ''}.`
    : 'It runs by itself about a minute after Betterfy opens.';
  const heard = Number(info.heard) || 0, total = Number(info.total) || 0;
  const sound = `Listening: heard ${heard.toLocaleString()}${total ? ` of ${total.toLocaleString()}` : ''}`
    + (heard < 30 ? ' · sound lines appear after ~30 heard' : ' · sound is part of the score');
  return `<section class="scorecard" aria-labelledby="scorecard-h">
      <div class="scorecard-main"><h2 id="scorecard-h">${head}</h2>
        <p class="plmeta">${sub}</p><p class="plmeta">${sound}</p></div>
      <div class="scorecard-b"><button class="b sm p" data-go="engine">See results</button>
        ${has || info.running ? '<button class="b sm" data-act="scorecopy">Copy results</button>' : ''}</div>
    </section>`;
}

/* ---------- Names that say what is in a playlist (core/playlists/describe.mjs) ----------
 * The suggestions are worked out in the lazy engine bundle (it carries the genre
 * ontology); until it is here nothing is suggested and the sheet still renames by
 * hand. What each playlist holds is read once per library, tag table and set of
 * names, and kept; the style is learned from this account's own playlist names. */
const NAMES = { stamp: null, facts: new Map(), memo: new Map(), style: null, loading: false, prefill: null };
const NAME_SKIP = 'bf_name_skip';

function nameKit(c) {
  const D = c.BetterfyDescribe;
  if (!D) {
    if (!NAMES.loading && typeof c.engineLoad === 'function') {
      NAMES.loading = true;
      Promise.resolve(c.engineLoad()).then(() => c.store?.touch?.('ui.lists'), () => {});
    }
    return null;
  }
  const pls = (c.LIB?.playlists ?? []).filter(p => p?.id && !c.isMirrorPlaylist?.(p));
  const tagN = c.TAGS ? Object.keys(c.TAGS).length : 0;
  const stamp = `${c.LIB?.captured_at}|${tagN}|${pls.map(p => p.id + '\u0001' + p.name).join('\u0002')}`;
  if (NAMES.stamp !== stamp) {
    Object.assign(NAMES, { stamp, facts: new Map(), memo: new Map(), style: D.nameStyle(pls.map(p => p.name)) });
  }
  const factsOf = p => {
    if (!NAMES.facts.has(p.id)) NAMES.facts.set(p.id, D.describeTracks(p, id => c.TAGS?.[id]?.tags, { memo: NAMES.memo }));
    return NAMES.facts.get(p.id);
  };
  return { D, style: NAMES.style, factsOf, pls };
}

function nameSkips(c) { try { return JSON.parse(c.LS?.getItem?.(NAME_SKIP) || '{}') ?? {}; } catch { return {}; } }

/** Library's "Names that could say more": vague names and names that say another genre, three at most. */
export function namesListHTML(c) {
  const kit = nameKit(c);
  if (!kit) return '';
  const { esc } = c;
  const skip = nameSkips(c);
  const rows = kit.D.namesToImprove(kit.pls, kit.factsOf, { soundOf: p => c.LISTS_SOUND?.profile?.(p.id) ?? null,
    style: kit.style, skip: p => skip[p.id] === p.name });
  if (!rows.length) return '';
  return `<section class="plsugg plnames" aria-labelledby="plname-h">
      <div class="plsugg-head"><h2 id="plname-h">Names that could say more</h2></div>
      <p class="hint">From the music in each, in your naming style. Tap to edit first.</p>
      <div class="plrows">${rows.slice(0, 3).map(r => `<div class="plline"><button class="plrow" type="button" data-act="lnameedit" data-pl="${esc(r.id)}" data-name="${esc(r.best.name)}" data-why="${esc(r.best.why)}" aria-haspopup="dialog" aria-label="${esc(`Edit the name for ${r.name}, starting from ${r.best.name}`)}">
        <span class="plmain"><span class="ttl">${esc(r.name)}</span>
          <span class="plmeta"><span class="plname-to">→ ${esc(r.best.name)}</span>${r.vague ? '' : ` · ${esc(r.why)}`}</span></span></button>
        <span class="placts"><button class="b sm p" type="button" data-act="lrename" data-pl="${esc(r.id)}" data-name="${esc(r.best.name)}"
          aria-label="${esc(`Rename ${r.name} to ${r.best.name}`)}">Rename</button>
        <button class="b sm" type="button" data-act="lnameskip" data-pl="${esc(r.id)}">Not now</button></span></div>`).join('')}</div>
    </section>`;
}

/** The sheet's Name section: suggestions as chips, and a field to rename it by hand. */
export function nameSheetHTML(c, id, pl) {
  const { esc } = c;
  if (c.isMirrorPlaylist?.(pl)) return '';
  const kit = nameKit(c);
  // A suggestion picked in Library opens here in the field, to change before saving.
  const pre = NAMES.prefill?.id === id ? NAMES.prefill : null;
  const s = kit ? kit.D.suggestNames(pl.name, kit.factsOf(pl), c.LISTS_SOUND?.profile?.(id) ?? null, kit.style) : null;
  const said = !s ? '' : s.misleading ? `${s.misleading}.`
    : s.vague && s.names.length ? 'Its name doesn’t say what’s in it yet.'
    : s.fits ? 'Its name already says what’s in it; these add a little more.'
    : s.names.length ? 'Your name stays first; these add what’s in it.' : '';
  const chips = s?.names?.length ? `<div class="rowbtns plnamechips">${s.names.map(n =>
    `<button class="chip" type="button" data-act="lnamepick" data-pl="${esc(id)}" data-name="${esc(n.name)}" data-why="${esc(n.why)}" title="${esc(n.why)}">${esc(n.name)}</button>`).join('')}</div>` : '';
  return `<section class="pls-sec plnamesec"><h3>Name</h3>
      ${said ? `<p class="hint">${esc(said)}</p>` : ''}${chips}
      <p class="hint plname-why" id="plname-why" aria-live="polite">${pre?.why ? esc(`Why: ${pre.why}.`) : ''}</p>
      <label class="pls-f plname-f"><input id="plname-in" value="${esc(pre?.name ?? pl.name)}" maxlength="100" aria-label="New name for ${esc(pl.name)}"></label>
      <div class="rowbtns"><button class="b sm p" type="button" data-act="lrename" data-pl="${esc(id)}" data-from="input">Rename</button></div>
      <p class="hint">${s?.names?.length ? 'Suggested from its artists’ tags, release years and, once heard, how it sounds. ' : ''}Renames it in Spotify too; undo from History.</p></section>`;
}

/** Rename, then say so with an Undo. */
async function renameNow(c, id, name, el) {
  const to = String(name ?? '').trim();
  const from = c.LIB?.playlists?.find(x => x.id === id)?.name ?? c.CFG?.[id]?.name ?? '';
  if (!to) return c.toast('A playlist needs a name.');
  if (to === from) return c.toast('That is its name already.');
  if (el) el.disabled = true;
  try {
    const at = await c.renamePlaylist(id, to);
    NAMES.prefill = null;
    c.render();
    c.toast(`Renamed “${from}” to “${to}”.`, at ? async () => { await c.undoAction(at); c.render(); } : null);
  } catch (err) {
    if (el) el.disabled = false;
    c.toast('Rename failed: ' + (err?.message ?? err));
  }
}

/** Everything the rows and the sheet need to know about one playlist, in one place. */
function plInfo(c, p, splitIds, undecidedIds, waiting = null) {
  const { R, LISTS_SOUND } = c;
  const vm = LISTS_SOUND.profile(p.id);
  const pl = c.LIB?.playlists?.find(x => x.id === p.id);
  const misfiled = (R.misfiled ?? []).filter(m => m.currentPlaylistId === p.id).length;
  const health = playlistHealth({ tracks: p.tracks,
    twins: twinsOf(c.twinPairs?.()).get(p.id) ?? [], repeats: repeatCount(pl?.tracks), staleDays: staleDays(pl?.tracks),
    misfiled, drifting: (R.drift ?? []).some(d => d.playlistId === p.id),
    split: splitIds.has(p.id), undecided: undecidedIds.has(p.id) });
  return { vm, health, misfiled, waiting: waiting?.get(p.id) ?? 0, tidy: tidyFor(R, p.id), face: pl?.tracks?.find(t => t?.art) ?? null };
}

/** One Library row. The row opens the playlist's sheet; what can be done straight away ("Tidy N", "N to file")
 *  sits beside it as its own buttons, and the score shows only when it is under ROW_SCORE_BELOW (L2, M4). */
const plRowHTML = (c, p, info, undecided) => {
  const { esc } = c;
  const spark = sparkHTML(info.vm), h = info.health;
  // Misfiled and waiting are said by the buttons; the meta line keeps the plain facts.
  const facts = rowFacts(info).filter(f => f.k !== 'warn' && f.k !== 'ok')
    .map(f => `<span class="plf plf-${f.k}">${esc(f.text)}</span>`).join(' ');
  const face = c.thumbHTML ? c.thumbHTML({ id: p.id, title: p.name, art: info.face?.art }) : '';
  const score = h && h.score < ROW_SCORE_BELOW
    ? `<span class="plscore plh-${healthClass(h.score)}" title="Health: ${esc(h.word)}${h.notes.length ? ' · ' + esc(h.notes.join('; ')) : ''}"><b class="mono">${h.score}</b><span>${esc(h.word)}</span></span>` : '';
  const row = `<button class="plrow" type="button" data-act="plopen" data-pl="${esc(p.id)}" aria-haspopup="dialog">${face}
    <span class="plmain"><span class="ttl">${esc(p.name)}</span>
      <span class="plmeta"><span class="mono">${p.tracks}</span> tracks${
        undecided ? ' · <span class="tag warn">what kind?</span>' : ''}${facts ? ` · ${facts}` : ''}</span></span>${spark}${score}</button>`;
  const t = info.tidy, w = info.waiting;
  if (!t && !(w > 0)) return row;
  const acts = [
    t ? `<button class="b sm warn" type="button" data-act="ltidy" data-pl="${esc(p.id)}" data-sec="${t.sec}" aria-label="${esc(`Tidy ${t.n} in ${p.name}`)}">Tidy ${t.n.toLocaleString()}</button>` : '',
    w > 0 ? `<button class="b sm" type="button" data-act="lfile" data-pl="${esc(p.id)}" aria-label="${esc(`File the ${w} songs suggested for ${p.name}`)}">${w.toLocaleString()} to file</button>` : '',
  ].join('');
  return `<div class="plline">${row}<span class="placts">${acts}</span></div>`;
};

/** The playlist detail sheet's body (opened by plopen; shell.js draws it into #plSheet). */
export function sheetHTML(c, id) {
  const { CFG, LIB, esc, profileRow, MIN_FOR_TARGET, LPROF } = c;
  if (WIZ && WIZ.sheet === id) return wizardHTML(c);
  const p = CFG[id], pl = LIB.playlists.find(x => x.id === id);
  if (!p || !pl) return '';
  const split = c.listsSplits().find(x => x.p.id === id)?.split;
  const undecided = p.why === c.NO_SIGNAL;
  const info = plInfo(c, { id, ...p }, new Set(split ? [id] : []), new Set(undecided ? [id] : []));
  const { health } = info;
  const prof = profileRow(info.vm);
  const few = p.tracks < MIN_FOR_TARGET;
  const canMix = c.mixHeardIn(pl.tracks) >= (c.BetterfyOrder?.MIN_MIX ?? 8);
  const made = LPROF?.made?.has(id);
  const splitKey = offerKey('split', [id]);
  const tagSplit = split ? null : (c.GAPS?.status === 'ready' ? (c.GAPS.splits ?? []).find(x => x.playlistId === id) : null);
  const ms = msMeasure(c);
  if (split || tagSplit) noteShown(c, splitKey);
  const notNow = key => ms.dismissed[key] || ms.made[key] ? '' : `<button class="b sm" data-act="wizdismiss" data-key="${esc(key)}">Not now</button>`;
  return `<div class="pls-head"><h2>${esc(pl.name)}</h2><button class="iconbtn" type="button" data-plclose aria-label="Close">✕</button></div>
    <div class="pls-body">
    <p class="plmeta"><span class="mono">${p.tracks}</span> tracks</p>
    ${health ? `<section class="pls-sec"><h3>Health</h3>
      <p class="plhealth plh-${health.score >= 85 ? 'ok' : health.score >= 65 ? 'fine' : 'low'}"><b class="mono">${health.score}</b> ${esc(health.word)}</p>
      ${health.notes.length ? `<ul class="plnotes">${health.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : '<p class="hint">Nothing out of place.</p>'}</section>` : ''}
    <section class="pls-sec"><h3>What kind of playlist</h3>
      <p class="hint">${esc(p.why ?? '')}</p>
      <label class="pls-f">It groups by <select data-act="axis" data-ax="${esc(id)}" aria-label="What ${esc(pl.name)} groups by">${AXES.map(a =>
        `<option value="${a}" ${p.axis === a ? 'selected' : ''}>${esc(AXIS_WORDS[a] ?? a)}</option>`).join('')}</select></label>
      <label class="pls-f"><input type="checkbox" data-act="target" data-tg="${esc(id)}" ${p.target ? 'checked' : ''} ${few ? 'disabled title="too few tracks to learn from"' : ''}>
        Suggest new tracks for it</label></section>
    ${prof ? `<section class="pls-sec"><h3>Sound</h3>${prof}</section>` : ''}
    ${nameSheetHTML(c, id, pl)}
    ${twoGenresHTML(c, id, split, tagSplit, !!(split ? made || ms.made[splitKey] : ms.made[splitKey]), notNow(splitKey))}
    ${weakSheetHTML(c, id)}
    ${fillHTML(c, id, pl)}
    ${pl.tracks.length >= 8 ? `<section class="pls-sec"><h3>Shuffle</h3>
      <p class="hint">Spaces out the same artist, then writes it as a playlist to play with Spotify’s shuffle off.</p>
      <div class="rowbtns"><button class="b p" data-act="plshuffle" data-pl="${esc(id)}">Shuffle</button>${
        canMix ? `<button class="b" data-act="pldj" data-pl="${esc(id)}">DJ order</button>` : ''}</div></section>` : ''}
    </div>`;
}

/** The sheet's one "Two genres?" section (M6): the split by sound when there is one, else the split by
 *  artists' tags. Same title, same wizard; '' when neither is on offer. */
export function twoGenresHTML(c, id, split, tagSplit, made, notNow = '') {
  const { esc } = c;
  if (!split && !tagSplit) return '';
  const src = split ? 'sound' : 'tags';
  const said = split
    ? `<b>${split.keep.n}</b> sound like ${esc(split.keep.name)}, <b>${split.move.n}</b> like ${esc(split.move.name)}.`
    : `By its artists’ tags: ${tagSplit.parts.map(x => `<b>${x.size}</b> ${x.rest ? 'the rest of ' : ''}${esc(x.label)}`).join(', ')}.`;
  return `<section class="pls-sec"><h3>Two genres?</h3>
      <p class="hint">${said} Splitting previews each part as a new playlist; nothing leaves this one.</p>
      ${made ? '<span class="tag ok">Made</span>' : `<div class="rowbtns"><button class="b sm p" data-act="wizsplit" data-pl="${esc(id)}" data-src="${src}">Split into playlists…</button>${notNow}</div>`}</section>`;
}

/* ---------- Playlists it understands least (core/intrinsic/weak.mjs) ----------
 * The last Score run's weakest genre playlists, each with its likeliest reason
 * and the honest fix, kept in `bf_weak` by web/app/engine.js. Advice only: a
 * merge opens the wizard (nothing is written until its own tap), and "add a
 * few tracks" is for the listener to do. Scored again by itself (autoscore). */
const weakName = (c, id) => c.LIB?.playlists?.find(x => x.id === id)?.name ?? c.CFG?.[id]?.name ?? null;
/** Saved weak rows whose playlists still exist, in the order Score gave them. */
export function weakRows(c) {
  const w = c.weakSaved?.();
  if (!w?.rows?.length) return [];
  return w.rows.filter(d => weakName(c, d.id)).map(d => ({ ...d, partner: d.partner && weakName(c, d.partner) ? d.partner : null }));
}
const weakWhen = (at, now = Date.now()) => {
  const days = Number.isFinite(at) ? Math.floor((now - at) / 864e5) : null;
  return days == null ? '' : days <= 0 ? ' (checked today)' : days === 1 ? ' (checked yesterday)' : ` (checked ${days} days ago)`;
};
export function weakSheetHTML(c, id) {
  const { esc } = c;
  const d = weakRows(c).find(x => x.id === id);
  if (!d) return '';
  const w = weakWords(d, x => weakName(c, x) ?? x);
  const pc = x => `${Math.round((x ?? 0) * 100)}%`;
  const merge = d.fix === 'merge' && d.partner
    ? `<div class="rowbtns"><button class="b sm p" data-act="wizmerge" data-a="${esc(id)}" data-b="${esc(d.partner)}">Merge with ${esc(weakName(c, d.partner))}…</button></div>` : '';
  return `<section class="pls-sec" id="plweak"><h3>Help it learn this one</h3>
    <p class="hint">Offered in its top three for ${pc(d.inTop3)} of the ${d.n} tracks it was checked on${esc(weakWhen(c.weakSaved?.()?.at))}.${d.calls != null && d.top1 != null
      ? esc(` ${d.calls ? `When Betterfy names it first, it is right ${pc(d.precision)} of ${d.calls} times` : 'Betterfy never named it first'}; it finds ${pc(d.top1)} of its own tracks.`) : ''} ${esc(w.why)}</p>
    <p class="hint"><b>${esc(w.fix)}</b></p>${merge}</section>`;
}
export function weakListHTML(c) {
  const { esc } = c;
  const rows = weakRows(c).filter(d => d.fix !== 'none' && d.fix !== 'wait').slice(0, 3);
  if (!rows.length) return '';
  const nameOf = x => weakName(c, x) ?? x;
  return `<section class="plsugg" aria-labelledby="plweak-h">
      <div class="plsugg-head"><h2 id="plweak-h">Playlists it gets wrong most</h2></div>
      <p class="hint">From your last Score${esc(weakWhen(c.weakSaved?.()?.at))}. Each one with what would help; nothing changes without a tap.</p>
      <div class="plrows">${rows.map(d => `<button class="plrow" type="button" data-act="plopen" data-pl="${esc(d.id)}" aria-haspopup="dialog">
        <span class="plmain"><span class="ttl">${esc(nameOf(d.id))}</span>
          <span class="plmeta">${esc(weakWords(d, nameOf).fix)}</span></span></button>`).join('')}</div>
    </section>`;
}

/* ---------- Fill this playlist (BUILD-6 F2) ----------
 * Liked songs you haven't filed anywhere, ranked by fit to this playlist with the
 * engine's own signals (core/recommend/fill.mjs: artist graph, tags, sound, record
 * shape). Shown only once the account's own measure clears the bar: hide a fifth of
 * each playlist, see whether its hidden tracks come back in the top 10. The Score
 * run (Settings › Engine) and the sheet's "Check" button both write that measure to
 * `bf_fill`; `bf_fill_force` = '1' is the owner's flag to show it anyway. */
export const FILL_BAR = 0.4;          // mirrors core/recommend/fill.mjs FILL.bar (test/fill-ui.test.mjs holds them equal)
export const FILL_SHOW = 10;
const FILL_MIN = 10;
const FILL = new Map();               // playlist id → { status, rows, err, for }
let FILL_MODEL = null;                // { key, model }, one per library state
let FILL_CHECK = null;                // null | 'working' | error text

function readJSON(LS, k) { try { return JSON.parse(LS.getItem(k) || 'null'); } catch { return null; } }

/** Whether the section offers suggestions: from the stored measure, or the flag. */
export function fillGateOf(measure, force = false) {
  const r = measure?.recall;
  if (force) return { on: true, measured: Number.isFinite(r), recall: Number.isFinite(r) ? r : null, forced: true };
  if (!Number.isFinite(r)) return { on: false, measured: false, recall: null };
  return { on: r >= FILL_BAR, measured: true, recall: r };
}

/** The liked tracks waiting to be filed, as Spotify track objects (File's queue, in its order). */
function fillCandidates(c) {
  const ids = (c.R?.backlog ?? []).map(b => b.id);
  if (!ids.length) return [];
  const byId = new Map((c.LIB?.liked ?? []).filter(t => t?.id).map(t => [t.id, t]));
  return ids.map(id => byId.get(id)).filter(Boolean);
}

const pct = x => (x == null ? '—' : Math.round(x * 100) + '%');

export function fillHTML(c, id, pl) {
  const { esc, LS } = c;
  if ((pl.tracks?.length ?? 0) < FILL_MIN || c.isMirrorPlaylist?.(pl)) return '';
  const cands = fillCandidates(c);
  if (!cands.length) return '';
  const measure = readJSON(LS, 'bf_fill');
  const gate = fillGateOf(measure, LS.getItem('bf_fill_force') === '1');
  const head = '<section class="pls-sec plfill" aria-labelledby="plfill-h"><h3 id="plfill-h">Fill this playlist</h3>';
  if (!gate.on && !gate.measured) {
    // A3: it checks itself in the background (app/autoscore.js); the button is only for not waiting.
    const busy = FILL_CHECK === 'working' || !!c.fillAutoRunning?.();
    return `${head}<p class="hint">Liked songs you haven’t filed that fit here. It checks itself on your own playlists first,
      by itself in the background: it hides a fifth of each one and sees whether it finds those tracks again.</p>
      ${typeof FILL_CHECK === 'string' && FILL_CHECK !== 'working' ? `<p class="hint">That didn’t work: ${esc(FILL_CHECK)}</p>` : ''}
      <button class="b sm" data-act="fillcheck" ${busy ? 'disabled' : ''}>${busy ? 'Checking…' : 'Check now'}</button></section>`;
  }
  if (!gate.on) {
    return `${head}<p class="hint">Not enough to go on for this playlist yet.</p></section>`;
  }
  const st = FILL.get(id);
  const key = fillKey(c);
  if (!st || st.for !== key || st.status === 'idle') { fillKick(c, id, key); return `${head}<p class="hint">Finding tracks that fit…</p></section>`; }
  if (st.status === 'working') return `${head}<p class="hint">Finding tracks that fit…</p></section>`;
  if (st.status === 'error') return `${head}<p class="hint">Couldn’t rank tracks: ${esc(st.err)}</p>
    <button class="b sm" data-act="fillretry" data-pl="${esc(id)}">Try again</button></section>`;
  const rows = st.rows;
  const note = gate.forced && gate.recall != null && gate.recall < FILL_BAR ? ` Shown by the flag; it measured ${pct(gate.recall)} on your library.`
    : gate.recall != null ? ` On your library it finds ${pct(gate.recall)} of hidden tracks in its top ${FILL_SHOW}.` : '';
  if (!rows.length) return `${head}<p class="hint">Nothing waiting to be filed fits here.${esc(note)}</p></section>`;
  return `${head}<p class="hint">Liked songs you haven’t filed, best fit first.${esc(note)}</p>
    <ul class="fillrows">${rows.map(r => `<li class="fillrow"><span class="plmain"><span class="ttl">${esc(r.title)}</span>
      <span class="plmeta">${esc(r.artist)} · <span class="tag">${esc(r.why)}</span></span></span>
      <button class="b sm" data-act="filladd" data-pl="${esc(id)}" data-tid="${esc(r.id)}" aria-label="Add ${esc(r.title)} to ${esc(pl.name)}">Add</button></li>`).join('')}</ul>
    ${rows.length > 1 ? `<div class="rowbtns"><button class="b sm p" data-act="fillall" data-pl="${esc(id)}">Add all ${rows.length} shown</button></div>` : ''}
    </section>`;
}

/** What a ranking was made from: a new sync, a tag fetch or a filing makes it stale. */
function fillKey(c) {
  const lib = c.LIB;
  let n = 0;
  for (const p of lib?.playlists ?? []) n += p.tracks?.length ?? 0;
  return `${lib?.captured_at ?? ''}|${lib?.playlists?.length ?? 0}|${n}|${(c.R?.backlog ?? []).length}|${Object.keys(c.TAGS ?? {}).length}`;
}

function fillKick(c, id, key) {
  FILL.set(id, { status: 'working', rows: [], for: key });
  // Not inside the paint that asked: the ranking runs next, then the sheet repaints.
  setTimeout(() => fillRun(c, id, key).catch(err => { FILL.set(id, { status: 'error', err: err?.message ?? String(err), rows: [], for: key }); c.render(); }), 0);
}

async function fillRun(c, id, key) {
  await c.engineLoad();
  const F = c.BetterfyFill;
  if (!F) throw new Error('the engine did not load');
  const audio = c.engineAudio ? await c.engineAudio() : null;
  const libKey = key.split('|').slice(0, 3).join('|') + '|' + Object.keys(c.TAGS ?? {}).length + '|' + (audio?.length ?? 0);
  if (FILL_MODEL?.key !== libKey) FILL_MODEL = { key: libKey, model: F.fillModel(c.LIB, { tags: c.TAGS, audio, isMirror: c.isMirrorPlaylist }) };
  const cands = fillCandidates(c);
  const byId = new Map(cands.map(t => [t.id, t]));
  const r = F.fillRank(FILL_MODEL.model, id, cands, { limit: FILL_SHOW });
  const rows = r.results.map(x => { const t = byId.get(x.id);
    return { id: x.id, title: t?.name ?? x.id, artist: (t?.artists ?? []).map(a => a.name).filter(Boolean).join(', '), why: x.why, score: x.score }; });
  FILL.set(id, { status: 'ready', rows, for: key, used: r.used });
  c.render();
}

/** Add tracks to the playlist: one write, one History entry (its own group), one undo. */
async function fillAdd(c, id, ids, el) {
  const { CFG, R, S } = c;
  if (!ids.length) return;
  if (el) el.disabled = true;
  const name = CFG[id]?.name ?? c.LIB.playlists.find(p => p.id === id)?.name ?? id;
  try {
    await c.addTracks(id, ids);
    const at = await c.logAction({ op: 'add', playlistId: id, playlistName: name, trackIds: ids,
                                   reason: 'fill this playlist', group: c.newGroup() });
    // Filed now: off File's queue (keeping the card on screen on screen) and off this list.
    const gone = new Set(ids), keep = R.backlog?.[S.inboxAt ?? 0]?.id, removed = [];
    for (let k = (R.backlog?.length ?? 0) - 1; k >= 0; k--) if (gone.has(R.backlog[k].id)) removed.unshift(R.backlog.splice(k, 1)[0]);
    if (R.backlog && S) S.inboxAt = Math.max(0, R.backlog.findIndex(b => b.id === keep));
    const st = FILL.get(id);
    const one = st?.rows?.find(r => r.id === ids[0])?.title ?? removed[0]?.title;
    if (st?.rows) { st.rows = st.rows.filter(r => !gone.has(r.id)); st.for = fillKey(c); }
    if (ids.length > 1) FILL.delete(id);   // "Add all": rank what is left
    const title = ids.length === 1 ? (one ? `“${one}”` : '1 track') : `${ids.length} tracks`;
    c.toast(`Added ${title} to ${name}.`, async () => {
      await c.undoAction(at);
      // Back in the queue, and the ranking redone with them.
      if (R.backlog) for (const b of removed) if (!R.backlog.some(x => x.id === b.id)) R.backlog.push(b);
      FILL.delete(id);
      c.render();
    });
    c.render();
  } catch (err) {
    if (el) el.disabled = false;
    c.toast('Failed: ' + err.message);
  }
}

/** The measure now, without waiting for the background tick (A3). */
async function fillCheck(c) {
  FILL_CHECK = 'working';
  c.render();
  try {
    if (c.fillMeasure) { await c.fillMeasure(); FILL_CHECK = null; c.render(); return; }
    await c.engineLoad();
    await new Promise(r => setTimeout(r, 30));   // let "Checking…" paint before the main thread is busy
    const audio = c.engineAudio ? await c.engineAudio() : null;
    const m = c.BetterfyFill.fillRecall(c.LIB, { tags: c.TAGS, audio, isMirror: c.isMirrorPlaylist });
    if (m.recall == null) throw new Error('no playlist has 10 or more tracks to check it on');
    c.LS.setItem('bf_fill', JSON.stringify({ ...m, at: Date.now() }));
    FILL_CHECK = null;
  } catch (err) { FILL_CHECK = err?.message ?? String(err); }
  c.render();
}

/* ---------- Merge and split (BUILD-6 F4) ----------
 * One wizard behind one preview for the two offers Library already makes: twins
 * (playlists the engine can't tell apart, twinsOf) and "two genres" (a split by
 * sound from plprofile, or by tags from the Gaps screen). The plan is
 * core/playlists/mergesplit.mjs; this draws it into the playlist sheet, lets you
 * rename parts and move tracks, and writes it. It only ever makes new private
 * playlists: the originals are never edited. Every playlist it makes is one `add`
 * entry with `created: true`, all in one History group, so one Undo (here, the
 * toast, or History) takes every track out and deletes every playlist it made.
 * Offers shown, dismissed and made are counted in `bf_mergesplit`, on this device
 * only, for the dismiss-rate bar (≤ 25% over ≥ 10 offers). */
const MS_KEY = 'bf_mergesplit';
const WIZ_ROWS = 30;
let WIZ = null;   // { sheet, kind, key, plan, title, status: 'preview'|'working'|'done'|'undone'|'error', err, at, made, more }

function msMeasure(c) { try { return readMeasure(c.LS?.getItem?.(MS_KEY)); } catch { return readMeasure(null); } }
function noteOffer(c, what, key) {
  const next = recordOffer(msMeasure(c), what, key);
  if (next) try { c.LS.setItem(MS_KEY, JSON.stringify(next)); } catch { /* private mode: the measure is a bonus */ }
}
const noteShown = (c, key) => noteOffer(c, 'shown', key);

/** Open the wizard on a merge ({ kind:'merge', a, b }) or a split ({ kind:'split', id, src:'sound'|'tags' }). */
export function wizardOpen(c, spec) {
  const lib = c.LIB?.playlists ?? [];
  const byId = id => lib.find(x => x.id === id);
  let plan = null, sheet = null, key = null, title = '';
  if (spec?.kind === 'merge') {
    const a = byId(spec.a), b = byId(spec.b);
    if (!a || !b) return c.toast('Those playlists are not in your library any more.');
    plan = mergePlan(a, b); sheet = a.id; key = offerKey('merge', [a.id, b.id]); title = 'Merge two playlists';
  } else if (spec?.kind === 'split') {
    const pl = byId(spec.id);
    if (!pl) return c.toast('That playlist is not in your library any more.');
    const parts = spec.src === 'tags'
      ? partsFromTags((c.GAPS?.splits ?? []).find(x => x.playlistId === pl.id))
      : partsFromSound(pl.name, c.listsSplits().find(x => x.p.id === pl.id)?.split);
    if (parts.length < 2) return c.toast('That split is not on offer any more.');
    plan = splitPlan(pl, parts, { restTo: 0 }); sheet = pl.id; key = offerKey('split', [pl.id]); title = `Split “${pl.name}”`;
  } else return;
  noteShown(c, key);
  WIZ = { sheet, kind: spec.kind, key, plan, title, status: 'preview', err: null, at: null, made: [], more: new Set() };
  if (c.S?.plSheet === sheet) c.render(); else c.openPlSheet(sheet);
}

/** What the name boxes say now: a repaint must not lose a name being typed. */
function wizSyncNames(c) {
  if (!WIZ) return;
  WIZ.plan.parts.forEach((p, k) => { const v = c.$?.('#wiznm' + k)?.value; if (typeof v === 'string') WIZ.plan = renamePart(WIZ.plan, k, v); });
}

function wizardHTML(c) {
  const { esc } = c, w = WIZ, plan = w.plan;
  const busy = w.status === 'working';
  const head = `<div class="pls-head"><h2>${esc(w.title)}</h2><button class="iconbtn" type="button" data-plclose aria-label="Close">✕</button></div>`;
  if (w.status === 'done' || w.status === 'undone') {
    return `${head}<div class="pls-body wiz" data-uh="lists"><section class="pls-sec" aria-live="polite">
      ${w.status === 'done'
        ? `<p>Made ${w.made.map(m => `<b>${esc(m.name)}</b> (<span class="mono">${m.n}</span>)`).join(' and ')}. Nothing in ${
            plan.sources.map(s => `“${esc(s.name)}”`).join(' or ')} was changed.</p>
           <p class="hint">One Undo deletes ${w.made.length === 1 ? 'it' : 'them'} again; it is in History too.</p>
           <div class="rowbtns"><button class="b" data-act="wizundo">Undo</button><button class="b p" data-act="wizback">Done</button></div>`
        : `<p>Undone: ${w.made.length === 1 ? 'the new playlist is' : 'the new playlists are'} gone and nothing else changed.</p>
           <div class="rowbtns"><button class="b p" data-act="wizback">Done</button></div>`}</section></div>`;
  }
  const { writes, problems } = writesOf(plan);
  const intro = plan.kind === 'merge'
    ? `<p class="hint">One new private playlist with everything in both, each recording once. <b>${esc(plan.sources[0].name)}</b> and
        <b>${esc(plan.sources[1].name)}</b> stay exactly as they are.</p>
       <p class="hint"><span class="mono">${plan.counts.a}</span> from the first, <span class="mono">${plan.counts.b}</span> only in the second,
        <span class="mono">${plan.counts.dupes}</span> duplicate${plan.counts.dupes === 1 ? '' : 's'} dropped.</p>`
    : `<p class="hint">Each part becomes a new private playlist. Rename them, move tracks between them, or leave one out.
        <b>${esc(plan.sources[0].name)}</b> stays exactly as it is.</p>`;
  const parts = plan.parts.map((p, k) => {
    const others = plan.parts.map((x, i) => [x, i]).filter(([, i]) => i !== k);
    const all = w.more.has(k), rows = all ? p.rows : p.rows.slice(0, WIZ_ROWS);
    const to = others[0];
    return `<section class="pls-sec wizpart" aria-labelledby="wizh${k}">
      <h3 id="wizh${k}">${plan.kind === 'merge' ? 'New playlist' : `Part ${k + 1}`} · <span class="mono">${p.rows.length}</span> track${p.rows.length === 1 ? '' : 's'}</h3>
      <label class="pls-f wizname">Name <input id="wiznm${k}" value="${esc(p.name)}" maxlength="100" ${busy ? 'disabled' : ''}></label>
      ${plan.kind === 'split' ? `<label class="pls-f"><input type="checkbox" data-act="wizinc" data-k="${k}" ${p.include ? 'checked' : ''} ${busy ? 'disabled' : ''}> make this one</label>` : ''}
      <ol class="wizrows">${rows.map(r => `<li class="wizrow${r.from === 'rest' ? ' rest' : ''}"><span class="plmain"><span class="ttl">${esc(r.title)}</span>
        <span class="plmeta">${esc(r.artist)}${r.from === 'b' ? ' · <span class="tag">only in the second</span>' : r.from === 'rest' ? ' · <span class="tag">not placed</span>' : ''}</span></span>${
        to ? `<button class="b sm" data-act="wizmove" data-tid="${esc(r.id)}" data-to="${to[1]}" ${busy ? 'disabled' : ''}
          aria-label="Move ${esc(r.title)} to ${esc(to[0].name || 'part ' + (to[1] + 1))}">Move</button>` : ''}</li>`).join('')}</ol>
      ${!all && p.rows.length > WIZ_ROWS ? `<button class="b sm" data-act="wizmore" data-k="${k}">Show all ${p.rows.length}</button>` : ''}
    </section>`;
  }).join('');
  const n = writes.length;
  return `${head}<div class="pls-body wiz" data-uh="lists">${intro}${parts}
    ${w.status === 'error' ? `<p class="hint warn" role="alert">That didn’t work: ${esc(w.err)}</p>` : ''}
    ${problems.length ? `<p class="hint">${problems.map(esc).join(' ')}</p>` : ''}
    <div class="rowbtns wizgo"><button class="b p" data-act="wizgo" ${busy || problems.length ? 'disabled' : ''}>${busy ? 'Making…'
      : `Make ${n} playlist${n === 1 ? '' : 's'}`}</button><button class="b" data-act="wizback" ${busy ? 'disabled' : ''}>Cancel</button></div></div>`;
}

/** Write the plan: one new private playlist per part, one History group, rolled back whole if a write fails. */
async function wizGo(c) {
  if (!WIZ || WIZ.status === 'working') return;
  wizSyncNames(c);
  const w = WIZ, { writes, problems } = writesOf(w.plan);
  if (problems.length) return c.toast(problems[0]);
  w.status = 'working'; w.err = null; c.render();
  const group = c.newGroup(), made = [];
  const from = w.plan.sources.map(s => s.name).join(' and ');
  const reason = w.kind === 'merge' ? `merged from ${from}` : `split from ${from}`;
  let first = null;
  try {
    for (const x of writes) {
      const pl = await c.sp('/me/playlists', { method: 'POST',
        body: JSON.stringify({ name: x.name, public: false, description: `Made by Betterfy, ${reason}.` }) });
      let err = null;
      try { await c.addTracks(pl.id, x.ids); } catch (e) { err = e; }
      const ids = err ? ((await c.landedIn?.(pl.id, x.ids)) ?? []) : x.ids;
      // Logged even when the add broke half way: the playlist exists, so Undo has to know about it.
      const at = await c.logAction({ op: 'add', group, playlistId: pl.id, playlistName: x.name, trackIds: ids, created: true, reason });
      first ??= at;
      made.push({ id: pl.id, name: x.name, n: ids.length });
      if (err) throw err;
    }
  } catch (err) {
    let back = '';
    if (first) { try { await c.undoAction(first); back = ' Nothing was left behind.'; } catch { back = ' What was made is in History, to undo from there.'; } }
    w.status = 'error'; w.err = (err?.message ?? String(err)) + back;
    c.render();
    return;
  }
  Object.assign(w, { status: 'done', at: first, made });
  noteOffer(c, 'made', w.key);
  c.toast(`Made ${made.length === 1 ? `“${made[0].name}”` : `${made.length} playlists`}. Nothing in ${from} was changed.`, () => wizUndo(c, w));
  c.render();
}

async function wizUndo(c, w = WIZ) {
  if (!w?.at || w.status === 'undone') return;
  await c.undoAction(w.at);
  w.status = 'undone';
  c.render();
}

export function view(c) {
  const { CFG, R, GAPS, esc, NO_SIGNAL, listsSplits } = c;
  c.gapsKick?.();
  const all = Object.entries(CFG).map(([id, v]) => ({ id, ...v }));
  const splitIds = new Set(listsSplits().map(x => x.p.id));
  const undecidedIds = new Set(all.filter(p => p.why === NO_SIGNAL).map(p => p.id));
  const waiting = waitingCounts(R?.backlog);
  const infos = new Map(all.map(p => [p.id, plInfo(c, p, splitIds, undecidedIds, waiting)]));
  const rows = attentionOrder(all, p => infos.get(p.id));
  const needN = rows.filter(p => (infos.get(p.id)?.health?.score ?? 100) < 85).length;
  const sugg = suggestionsOf(GAPS, R);
  const mixes = c.playlistMixes().mix;
  const ticks = genreTickSuggestions(rows.map(p => ({ ...p, mirror: c.isMirrorPlaylist?.({ id: p.id, name: p.name }) })), mixes, id => c.LISTS_SOUND.profile(id));
  const ticksHTML = ticks.length ? `<section class="plsugg" aria-labelledby="pltick-h">
      <div class="plsugg-head"><h2 id="pltick-h">These look like genre playlists</h2>
        <button class="b sm p" data-act="ltickall" aria-label="Mark all ${ticks.length} as genre">Mark all ${ticks.length}</button></div>
      <div class="plrows">${ticks.slice(0, 5).map(t => `<div class="plrow"><span class="plmain"><span class="ttl">${esc(t.name)}</span>
        <span class="plmeta">${esc(t.why)}</span></span><button class="b sm" data-act="ltick" data-pl="${esc(t.id)}">Genre</button></div>`).join('')}</div>
    </section>` : '';
  // Cold start (no genre playlist at all) is offered on File, which keeps "Start these playlists" (C2); still kicked
  // here so its groups are ready. "Possible new genres" moved to New playlists › By sound (M5).
  const noGenre = rows.length > 0 && !rows.some(p => p.axis === 'genre');
  c.coldKick?.(noGenre);
  // Twins (SMARTER-GENRES phase 3: they used to live only on the Engine screen), as merge offers.
  const ms = msMeasure(c);
  const have = new Set((c.LIB?.playlists ?? []).map(x => x.id));
  const twins = twinOffers(c.twinPairs?.()).filter(o => have.has(o.a.id) && have.has(o.b.id) && !ms.dismissed[o.key] && !ms.made[o.key]);
  for (const o of twins.slice(0, 3)) noteShown(c, o.key);
  const twinsHTML = twins.length ? `<section class="plsugg" aria-labelledby="pltwin-h">
      <div class="plsugg-head"><h2 id="pltwin-h">Playlists that sound the same</h2></div>
      <p class="hint">Hard to tell apart by sound. Merging makes a new playlist and keeps both.</p>
      <div class="plrows">${twins.slice(0, 3).map(o => `<div class="plrow"><span class="plmain"><span class="ttl">${esc(o.a.name)}</span>
        <span class="plmeta">and ${esc(o.b.name)}</span></span>
        <button class="b sm p" data-act="wizmerge" data-a="${esc(o.a.id)}" data-b="${esc(o.b.id)}">Merge…</button>
        <button class="b sm" data-act="wizdismiss" data-key="${esc(o.key)}">Not now</button></div>`).join('')}</div>
    </section>` : '';
  const suggHTML = sugg.length ? `<section class="plsugg" aria-labelledby="plsugg-h">
      <div class="plsugg-head"><h2 id="plsugg-h">Suggested playlists</h2>
        <button class="b sm" data-go="new">See all ${sugg.length}</button></div>
      <div class="plrows">${sugg.slice(0, 3).map(s => `<button class="plrow plsg" type="button" data-go="new">
        <span class="plmain"><span class="ttl">${esc(s.title)}</span>
          <span class="plmeta"><span class="mono">${s.n}</span> tracks · ${esc(s.why)}</span></span></button>`).join('')}</div>
    </section>` : '';
  // One line of the Engine's score (owner, 2026-11-18): the Engine itself lives in Settings.
  // The footer is one line (L2): the score sentence, then where to go from here.
  // The score sentence lives in the Score card at the top now; the footer keeps the way to the full results.
  const knows = rows.some(p => p.target);
  const footHTML = `<p class="axcov plfoot"><span class="plfoot-b">${knows ? '<button class="b sm" data-go="engine">How it picks</button>' : ''}
      <button class="b sm" data-act="lshufall">Shuffle everything</button></span></p>`;
  return `<h1>Library</h1>
    <p class="lede">${needN ? `${needN} playlist${needN === 1 ? '' : 's'} could use a look, listed first. ` : ''}Tap a playlist for its health, sound and shuffle.</p>
    ${scoreCardHTML(c)}${ticksHTML}${twinsHTML}${weakListHTML(c)}${namesListHTML(c)}${suggHTML}
    <div class="plrows">${rows.map(p => plRowHTML(c, p, infos.get(p.id), undecidedIds.has(p.id))).join('')}</div>
    ${c.soundSearchHTML?.() ?? ''}${footHTML}`;
}


export const actions = {
  /** The Score card's Copy results: the same text as the Engine screen's. */
  scorecopy(c) { return c.scoreCopy?.(); },
  /** Tap a playlist: its detail sheet. */
  plopen(c, el) { if (WIZ?.status !== 'working') WIZ = null; NAMES.prefill = null; c.openPlSheet(el.dataset.pl); },

  /** The sheet's Shuffle: the Shuffle screen on this playlist, as a spaced shuffle. */
  plshuffle(c, el) { return plShuffle(c, el.dataset.pl, ''); },
  /** The sheet's DJ order: the same, in the first DJ-order mode. */
  pldj(c, el) { return plShuffle(c, el.dataset.pl, Object.keys(c.MIX_MODES)[0]); },

  /** Merge and split (F4): open the wizard on twins, or on a playlist's split. */
  wizmerge(c, el) { return wizardOpen(c, { kind: 'merge', a: el.dataset.a, b: el.dataset.b }); },
  wizsplit(c, el) { return wizardOpen(c, { kind: 'split', id: el.dataset.pl, src: el.dataset.src }); },
  /** "Not now" on an offer: counted for the dismiss rate, and not offered in Library again. */
  wizdismiss(c, el) { noteOffer(c, 'dismissed', el.dataset.key); c.render(); },
  wizmove(c, el) { if (!WIZ || WIZ.status === 'working') return; wizSyncNames(c); WIZ.plan = moveTrack(WIZ.plan, el.dataset.tid, +el.dataset.to); c.render(); },
  wizinc(c, el) { if (!WIZ || WIZ.status === 'working') return; wizSyncNames(c); WIZ.plan = includePart(WIZ.plan, +el.dataset.k, el.checked); c.render(); },
  wizmore(c, el) { if (!WIZ) return; wizSyncNames(c); WIZ.more.add(+el.dataset.k); c.render(); },
  wizgo(c) { return wizGo(c); },
  async wizundo(c, el) {
    el.disabled = true;
    try { await wizUndo(c); c.toast('Restored.'); } catch (err) { el.disabled = false; c.toast('Undo failed: ' + err.message); }
  },
  /** Leave the wizard: back to the playlist's own sheet. */
  wizback(c) { if (WIZ?.status === 'working') return; WIZ = null; c.render(); },

  /** One "looks like a genre playlist": confirmed. */
  ltick(c, el) { return setAxis(c, el.dataset.pl, { value: 'genre' }, null); },
  /** Every suggested one at once. */
  ltickall(c) {
    const rows = Object.entries(c.CFG).map(([id, v]) => ({ id, ...v, mirror: c.isMirrorPlaylist?.({ id, name: v.name }) }));
    const ids = genreTickSuggestions(rows, c.playlistMixes().mix, id => c.LISTS_SOUND.profile(id)).map(t => t.id);
    for (const id of ids) setAxis(c, id, { value: 'genre' }, null, true);
    return finishAxes(c, `${ids.length} marked as genre`);
  },
  /** "Tidy N" on a row: Tidy at this playlist only, on the section that has its rows (M4). */
  ltidy(c, el) {
    const { S, R } = c, id = el.dataset.pl, sec = el.dataset.sec;
    S.tidyPl = id; S.tidySec = sec;
    if (sec === 'misfile') {
      const mine = (R?.misfiled ?? []).filter(x => x.currentPlaylistId === id);
      S.mfBand = ['high', 'medium', 'low'].find(b => mine.some(x => x.confidence === b)) ?? S.mfBand;
    }
    S.tidyFocus = 'rows';
    c.go('tidy');
  },
  /** "N to file" on a row: File, with the songs it suggests for this playlist first in the queue. */
  lfile(c, el) {
    const { S, R } = c, id = el.dataset.pl;
    const { order, n } = fileFirst(R?.backlog, id);
    const name = c.CFG?.[id]?.name ?? id;
    if (!n) return c.toast(`Nothing is waiting for ${name} any more.`);
    R.backlog.splice(0, R.backlog.length, ...order);   // in place: File and its actions hold this array
    S.inboxAt = 0; S.inboxFor = id;
    c.go('inbox');
    c.toast(`${n === 1 ? 'The song' : `The ${n} songs`} suggested for ${name} ${n === 1 ? 'is' : 'are'} first in File.`);
  },
  /** "Shuffle everything": the Shuffle screen on All Songs, whatever a sheet last picked (F2). */
  lshufall(c) {
    c.S.shufPl = null; c.S.shufCache = null;
    c.go('shuffle');
  },

  /** Fill this playlist: add one suggestion. */
  filladd(c, el) { return fillAdd(c, el.dataset.pl, [el.dataset.tid], el); },
  /** Every suggestion shown, as one History entry and one undo. */
  fillall(c, el) { return fillAdd(c, el.dataset.pl, (FILL.get(el.dataset.pl)?.rows ?? []).map(r => r.id), el); },
  /** Run the measure that decides whether Fill shows. */
  fillcheck(c) { return fillCheck(c); },
  fillretry(c, el) { FILL.delete(el.dataset.pl); c.render(); },

  /** Rename: a "Names that could say more" row's suggestion, or the sheet's field. */
  lrename(c, el) {
    const name = el.dataset.from === 'input' ? c.$?.('#plname-in')?.value : el.dataset.name;
    return renameNow(c, el.dataset.pl, name, el);
  },
  /** A "Names that could say more" row: its playlist's sheet, with the suggestion in the name field, selected,
   *  to change before saving. Nothing is renamed until Rename. */
  lnameedit(c, el) {
    const id = el.dataset.pl;
    NAMES.prefill = { id, name: el.dataset.name ?? '', why: el.dataset.why ?? '' };
    if (WIZ?.status !== 'working') WIZ = null;
    c.openPlSheet(id);
    setTimeout(() => {
      const box = c.$?.('#plname-in');
      box?.closest?.('.plnamesec')?.scrollIntoView?.({ block: 'nearest' });
      box?.focus?.(); box?.select?.();
    }, 60);
  },
  /** A suggested name tapped in the sheet: into the field, with why, to edit or keep. */
  lnamepick(c, el) {
    const box = c.$?.('#plname-in');
    if (box) { box.value = el.dataset.name; box.focus?.(); }
    if (el.dataset.pl) NAMES.prefill = { id: el.dataset.pl, name: el.dataset.name ?? '', why: el.dataset.why ?? '' };
    const why = c.$?.('#plname-why');
    if (why) why.textContent = el.dataset.why ? `Why: ${el.dataset.why}.` : '';
  },
  /** "Not now" on a name row: not offered again until the playlist's name changes. */
  lnameskip(c, el) {
    const skip = nameSkips(c), id = el.dataset.pl;
    skip[id] = c.LIB?.playlists?.find(x => x.id === id)?.name ?? '';
    try { c.LS.setItem(NAME_SKIP, JSON.stringify(skip)); } catch { /* private mode: this session only */ }
    c.render();
  },

  /** Axis edit: per-viewer, persisted on this device. */
  axis(c, el) { return setAxis(c, el.dataset.ax, el, null); },
  /** Receives-suggestions tick. */
  target(c, el) { return setAxis(c, el.dataset.tg, null, el); },
};

function setAxis(c, id, ax, tg, quiet = false) {
  const { CFG, LS } = c;
  if (ax) {
    CFG[id].axis = ax.value;
    // Matches what a reload would do via classify()'s saved-override merge —
    // done here too so a playlist just fixed drops out of "Needs your input"
    // immediately rather than waiting for the next full sync.
    CFG[id].why = 'set by you';
    // Saying a playlist is a genre playlist is saying "file into it", so it
    // starts taking suggestions; any axis that takes none stops.
    if (ax.value === 'genre') CFG[id].target = CFG[id].tracks >= c.MIN_FOR_TARGET && !c.isMirrorPlaylist({ id, name: CFG[id].name });
    else if (ax.value !== 'mood') CFG[id].target = false;
  } else {
    CFG[id].target = tg.checked;
  }
  const saved = JSON.parse(LS.getItem('bf_axes') || '{}');
  saved[id] = { axis: CFG[id].axis, target: CFG[id].target, at: Date.now() };
  LS.setItem('bf_axes', JSON.stringify(saved));
  if (!quiet) finishAxes(c, 'Updated');
}

function finishAxes(c, said) {
  c.rebuildReports();
  c.toast(`${said} — suggestions recomputed.`);
  c.render();
  // Shared with linked devices straight away, not only at the next load.
  c.syncAxes().then(changed => { if (changed) c.store.set('reports', c.rebuildReports()); });
}

function plShuffle(c, id, mode) {
  c.S.shufPl = id; c.S.shufCache = null; c.S.shufMode = mode;
  try { c.LS.setItem('bf_shuf_mode', mode); } catch { /* private mode */ }
  c.closePlSheet();
  c.go('shuffle');
}
