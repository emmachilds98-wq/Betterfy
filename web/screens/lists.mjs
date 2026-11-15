// @bundle screens lists 50
/* The Library tab (docs/BUILD-5-PLAN.md A4, UI-E): compact playlist rows, a Suggested playlists section, and a detail sheet per playlist. Was the Playlists screen: an ES module. Reaches nothing but `ctx`;
 * SCREEN_CTX.lists in app/screens.js builds it. playlistMixes, tagCoverage, the sound profiles
 * and the split job stay classic in app/screenjobs.js. */

const AXES = ['genre','mood','era','event','djset','context','inbox'];
/** "64% genre · 19% mood" — what a playlist's tags are actually made of,
 *  which is the evidence behind a content-guessed axis and a sanity check on
 *  every other one. Facets under a tenth are left out as noise. */
function mixLabel(mix) {
  if (!mix || !mix.tracks) return '';
  const parts = ['genre','mood','era','occasion','descriptor']
    .map(f => [f, mix[f]]).filter(([, x]) => x >= 0.1)
    .sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([f, x]) => `${Math.round(x * 100)}% ${f}`);
  return parts.join(' · ');
}

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

/** 0-100 and the reasons, from what Betterfy already knows about one playlist: misfiled tracks,
 *  drift, a second genre, an axis nobody has settled. Null under eight tracks (too few to judge). */
export function playlistHealth({ tracks = 0, misfiled = 0, drifting = false, split = false, undecided = false } = {}) {
  if (tracks < 8) return null;
  const notes = [];
  let score = 100;
  if (misfiled) { score -= Math.min(45, Math.round(misfiled / tracks * 150)); notes.push(`${misfiled} track${misfiled === 1 ? '' : 's'} look${misfiled === 1 ? 's' : ''} misfiled`); }
  if (drifting) { score -= 15; notes.push('newest additions read differently from the rest'); }
  if (split) { score -= 20; notes.push('sounds like two genres'); }
  if (undecided) { score -= 10; notes.push('no axis decided yet'); }
  score = Math.max(0, score);
  return { score, word: score >= 85 ? 'Healthy' : score >= 65 ? 'Fine' : 'Needs a look', notes };
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

/** Everything the rows and the sheet need to know about one playlist, in one place. */
function plInfo(c, p, splitIds, undecidedIds) {
  const { R, LISTS_SOUND } = c;
  const vm = LISTS_SOUND.profile(p.id);
  const health = playlistHealth({ tracks: p.tracks,
    misfiled: (R.misfiled ?? []).filter(m => m.playlistId === p.id).length,
    drifting: (R.drift ?? []).some(d => d.playlistId === p.id),
    split: splitIds.has(p.id), undecided: undecidedIds.has(p.id) });
  return { vm, health };
}

const plRowHTML = (c, p, info, undecided) => {
  const { esc } = c;
  const spark = sparkHTML(info.vm), h = info.health;
  return `<button class="plrow" type="button" data-act="plopen" data-pl="${esc(p.id)}" aria-haspopup="dialog">
    <span class="plmain"><span class="ttl">${esc(p.name)}</span>
      <span class="plmeta"><span class="mono">${p.tracks}</span> tracks · <span class="tag">${esc(p.axis)}</span>${
        undecided ? ' <span class="tag warn">pick an axis</span>' : p.target ? ' <span class="tag ok">files here</span>' : ''}${
        h && h.score < 65 ? ' <span class="tag warn">needs a look</span>' : ''}</span></span>${spark}</button>`;
};

/** The playlist detail sheet's body (opened by plopen; shell.js draws it into #plSheet). */
export function sheetHTML(c, id) {
  const { CFG, LIB, esc, profileRow, MIN_FOR_TARGET, BetterfyPlProfile, LPROF } = c;
  const p = CFG[id], pl = LIB.playlists.find(x => x.id === id);
  if (!p || !pl) return '';
  const split = c.listsSplits().find(x => x.p.id === id)?.split;
  const undecided = p.why === c.NO_SIGNAL;
  const info = plInfo(c, { id, ...p }, new Set(split ? [id] : []), new Set(undecided ? [id] : []));
  const { health } = info;
  const mix = mixLabel(c.playlistMixes().mix.get(id));
  const prof = profileRow(info.vm);
  const few = p.tracks < MIN_FOR_TARGET;
  const canMix = c.mixHeardIn(pl.tracks) >= (c.BetterfyOrder?.MIN_MIX ?? 8);
  const made = LPROF?.made?.has(id);
  const splitName = split ? BetterfyPlProfile.splitName(pl.name, split) : '';
  return `<div class="pls-head"><h2>${esc(pl.name)}</h2><button class="iconbtn" type="button" data-plclose aria-label="Close">✕</button></div>
    <div class="pls-body">
    <p class="plmeta"><span class="mono">${p.tracks}</span> tracks${mix ? ` · ${esc(mix)}` : ''}</p>
    ${health ? `<section class="pls-sec"><h3>Health</h3>
      <p class="plhealth plh-${health.score >= 85 ? 'ok' : health.score >= 65 ? 'fine' : 'low'}"><b class="mono">${health.score}</b> ${esc(health.word)}</p>
      ${health.notes.length ? `<ul class="plnotes">${health.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : '<p class="hint">Nothing out of place.</p>'}</section>` : ''}
    <section class="pls-sec"><h3>How it is treated</h3>
      <p class="hint">${esc(p.why ?? '')}</p>
      <label class="pls-f">Axis <select data-act="axis" data-ax="${esc(id)}" aria-label="Axis of ${esc(pl.name)}">${AXES.map(a =>
        `<option value="${a}" ${p.axis === a ? 'selected' : ''}>${a}</option>`).join('')}</select></label>
      <label class="pls-f"><input type="checkbox" data-act="target" data-tg="${esc(id)}" ${p.target ? 'checked' : ''} ${few ? 'disabled title="too few tracks to model"' : ''}>
        receives suggestions</label></section>
    ${prof ? `<section class="pls-sec"><h3>Sound</h3>${prof}</section>` : ''}
    ${split ? `<section class="pls-sec"><h3>Two genres?</h3>
      <p class="hint"><b>${split.keep.n}</b> sound like ${esc(split.keep.name)}, <b>${split.move.n}</b> like ${esc(split.move.name)}.
        Making the new playlist copies the second group; nothing leaves this one.</p>
      ${made ? '<span class="tag ok">Made</span>' : `<button class="b sm" data-act="lsplit" data-lsplit="${esc(id)}">Make “${esc(splitName)}”</button>`}</section>` : ''}
    ${pl.tracks.length >= 8 ? `<section class="pls-sec"><h3>Shuffle</h3>
      <p class="hint">Spaces out the same artist, then writes it as a playlist to play with Spotify’s shuffle off.</p>
      <div class="rowbtns"><button class="b p" data-act="plshuffle" data-pl="${esc(id)}">Shuffle</button>${
        canMix ? `<button class="b" data-act="pldj" data-pl="${esc(id)}">DJ order</button>` : ''}</div></section>` : ''}
    </div>`;
}

export function view(c) {
  const { CFG, R, GAPS, esc, tagCoverage, NO_SIGNAL, listsSplits } = c;
  c.gapsKick?.();
  const rows = Object.entries(CFG).map(([id, v]) => ({ id, ...v })).sort((a, b) => b.tracks - a.tracks);
  const cov = tagCoverage();
  const splitIds = new Set(listsSplits().map(x => x.p.id));
  const undecidedIds = new Set(rows.filter(p => p.why === NO_SIGNAL).map(p => p.id));
  const sugg = suggestionsOf(GAPS, R);
  const suggHTML = sugg.length ? `<section class="plsugg" aria-labelledby="plsugg-h">
      <div class="plsugg-head"><h2 id="plsugg-h">Suggested playlists</h2>
        <button class="b sm" data-go="new">See all ${sugg.length}</button></div>
      <div class="plrows">${sugg.slice(0, 3).map(s => `<button class="plrow plsg" type="button" data-go="new">
        <span class="plmain"><span class="ttl">${esc(s.title)}</span>
          <span class="plmeta"><span class="mono">${s.n}</span> tracks · ${esc(s.why)}</span></span></button>`).join('')}</div>
    </section>` : '';
  return `<h1>Library</h1>
    <p class="lede">Your playlists and how Betterfy treats each. Tap one for its axis, health and shuffle.</p>
    ${suggHTML}
    <div class="plrows">${rows.map(p => plRowHTML(c, p, plInfo(c, p, splitIds, undecidedIds), undecidedIds.has(p.id))).join('')}</div>
    <p class="axcov"><span class="mono">${cov.pct}%</span> of artists have genre tags${cov.pct < 85 ? ', so suggestions will be thin until that improves' : ''}.
      <button class="b sm" data-go="sources">Genre sources</button>
      <button class="b sm" data-go="shuffle">Shuffle everything</button></p>`;
}


export const actions = {
  /** Tap a playlist: its detail sheet. */
  plopen(c, el) { c.openPlSheet(el.dataset.pl); },

  /** The sheet's Shuffle: the Shuffle screen on this playlist, as a spaced shuffle. */
  plshuffle(c, el) { return plShuffle(c, el.dataset.pl, ''); },
  /** The sheet's DJ order: the same, in the first DJ-order mode. */
  pldj(c, el) { return plShuffle(c, el.dataset.pl, Object.keys(c.MIX_MODES)[0]); },

  /** "Two genres by sound": make the playlist for the half that sounds apart. */
  async lsplit(c, el) {
    el.disabled = true;
    try { await c.listsSplitMake(el.dataset.lsplit); } catch (err) { el.disabled = false; c.toast('Failed: ' + err.message); }
  },

  /** Axis edit: per-viewer, persisted on this device. */
  axis(c, el) { return setAxis(c, el.dataset.ax, el, null); },
  /** Receives-suggestions tick. */
  target(c, el) { return setAxis(c, el.dataset.tg, null, el); },
};

function setAxis(c, id, ax, tg) {
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
  c.rebuildReports();
  c.toast('Updated — suggestions recomputed.');
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
