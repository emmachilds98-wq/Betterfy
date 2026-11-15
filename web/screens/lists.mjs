// @bundle screens lists 50
/* The Playlists screen (docs/BUILD-5-PLAN.md A4): an ES module. Reaches nothing but `ctx`;
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

function listsSplitHTML(c, splits) {
  const { LIB, LPROF, esc, BetterfyPlProfile } = c;
  if (!splits.length) return '';
  const byId = new Map(LIB.playlists.flatMap(p => p.tracks ?? []).map(t => [t.id, t]));
  const card = ({ p, split }) => {
    const { keep, move } = split, name = BetterfyPlProfile.splitName(p.name, split);
    const made = LPROF.made.has(p.id);
    const eg = move.ids.slice(0, 3).map(id => byId.get(id)).filter(Boolean)
      .map(t => `<li>${esc(t.name ?? '')}<span class="sub"> · ${esc((t.artists ?? []).map(a => a?.name).filter(Boolean).join(', '))}</span></li>`).join('');
    return `<div class="row lsplit${made ? ' done' : ''}"><div class="main">
      <div class="ttl">${esc(p.name)}</div>
      <div class="lsplit-bar" aria-hidden="true"><i style="flex:${keep.n}"></i><i class="mv" style="flex:${move.n}"></i></div>
      <div class="sub"><b>${keep.n}</b> sound like ${esc(keep.name)} · <b>${move.n}</b> sound like ${esc(move.name)}</div>
      ${eg ? `<ul class="lsplit-eg">${eg}</ul>` : ''}
    </div><div class="acts">${made ? '<span class="tag ok">Made</span>'
      : `<button class="b sm" data-act="lsplit" data-lsplit="${esc(p.id)}">Make “${esc(name)}”</button>`}</div></div>`;
  };
  return `<h2>Two genres by sound</h2>
    <p class="lede">${splits.length === 1 ? 'This playlist’s' : 'These playlists’'} heard tracks fall into two groups that
      sound apart and name different genres. Making the new playlist copies the second group into it; nothing is taken
      out of the original until you do that yourself.</p>
    <div class="rows">${splits.map(card).join('')}</div>`;
}

/** One row of the axes table, plus a hidden sound-profile row under it when
 *  there is a profile to show. No profile, no toggle and no hidden row. */
function axisRowHTML(c, p, mix) {
  const { esc, profileRow, LISTS_SOUND, MIN_FOR_TARGET } = c;
  const m = mixLabel(mix);
  const prof = profileRow(LISTS_SOUND.profile(p.id));
  const few = p.tracks < MIN_FOR_TARGET;
  return `<tr class="axrow" data-axrow="${esc(p.id)}">
      <th scope="row" class="axname">${prof ? `<button class="axexp" data-act="axexp" data-axexp="${esc(p.id)}" aria-expanded="false"
          aria-controls="axprof-${esc(p.id)}" aria-label="Sound profile of ${esc(p.name)}"></button>` : ''}<span class="ttl">${esc(p.name)}</span>
        <span class="axwhy ${p.why === 'set by you' ? 'mine' : ''}">${esc(p.why ?? '')}</span></th>
      <td class="axn mono">${p.tracks}</td>
      <td class="axmix">${m ? `<span title="which kind of tag its tracks carry">${esc(m)}</span>` : ''}</td>
      <td class="axsel"><select data-act="axis" data-ax="${esc(p.id)}" aria-label="Axis of ${esc(p.name)}">${AXES.map(a => `<option value="${a}" ${p.axis===a?'selected':''}>${a}</option>`).join('')}</select></td>
      <td class="axtg"><label><input type="checkbox" data-act="target" data-tg="${esc(p.id)}" ${p.target?'checked':''} ${few ? 'disabled title="too few tracks to model"' : ''}>
        <span class="axtglbl">receives suggestions</span></label></td>
    </tr>${prof ? `
    <tr class="axprof" id="axprof-${esc(p.id)}" hidden><td colspan="5">${prof}</td></tr>` : ''}`;
}

/** The axes table. Columns are labelled once at the top rather than on
 *  every row; on a phone each row folds into a two-line card (62-lists.css). */
function axisTableHTML(c, list, mixes) {
  return `<div class="axtable"><table class="axtbl">
    <thead><tr><th scope="col">Playlist</th><th scope="col" class="axn">Tracks</th><th scope="col">Tagged as</th>
      <th scope="col">Axis</th><th scope="col">Receives suggestions</th></tr></thead>
    <tbody>${list.map(p => axisRowHTML(c, p, mixes.get(p.id))).join('')}</tbody></table></div>`;
}

export function view(c) {
  const { CFG, R, esc, tagCoverage, playlistMixes, listsSplits, NO_SIGNAL } = c;
  const rows = Object.entries(CFG).map(([id,v]) => ({ id, ...v })).sort((a,b) => b.tracks - a.tracks);
  const cov = tagCoverage();
  const { mix: mixes } = playlistMixes();
  // Everything classify() could not read from the name or the dates. Nothing
  // is filed into these until the listener says which ones are genre
  // playlists — the silent "treat it as genre" default used to be exactly what
  // turned "Sunday" or "Favourites" into a wrong suggestion.
  const undecided = rows.filter(p => p.why === NO_SIGNAL);
  const splits = listsSplits();
  return `<h1>Playlists</h1>
    <p class="lede">How each playlist is treated, and which ones Betterfy files tracks into.</p>
    <details class="how"><summary>How this works</summary>
      <p>Tracks are only filed into playlists marked <b>receives suggestions</b> — by default, the ones whose name says what
        genre they are (“Donk”, “D&amp;B Rollers”, “Tech House”). Tick any other playlist to file into it too. A track
        is only ever compared against playlists on its own axis, so a metal track in a mood playlist is not flagged as
        misfiled. Each guess says what it was made from — the name, the dates the tracks were filed, or what kind of
        tags they carry — and correcting one is remembered on this device.</p>
      <p><b>Tagged as</b> is what a playlist's tracks are tagged with. Only the <b>genre</b> share tells a genre
        playlist apart from another one; the mood, decade and occasion tags are what a <b>mood</b> or <b>context</b>
        playlist is really held together by, and each axis weighs them accordingly.</p>
    </details>
    <p class="axcov"><span class="mono">${cov.pct}%</span> of artists have genre tags${cov.pct < 85 ? ', so suggestions will be thin until that improves' : ''}.
      <button class="b sm" data-go="sources">Genre sources</button></p>

    ${undecided.length ? `<h2>Needs your input</h2>
    <p class="lede">${undecided.length} playlist${undecided.length===1?' has':'s have'} no genre in ${undecided.length===1?'its':'their'} name,
      nothing in the dates, and no strong lean in the tags either — so nothing is filed into ${undecided.length===1?'it':'them'} until you say so.
      If one of these <i>is</i> a genre playlist, tick <b>receives suggestions</b> (or set it to genre); otherwise set what it really is.</p>
    ${axisTableHTML(c, undecided, mixes)}` : ''}

    ${(R.drift ?? []).length ? `<h2>Recently drifting</h2>
    <p class="lede">${R.drift.length} playlist${R.drift.length===1?'':'s'} whose newest additions read differently from everything added before them — not necessarily wrong, just worth a look. This is a trend across many tracks, not a single misfile.</p>
    <div class="rows">${R.drift.map(d => `<div class="row">
      <div class="main"><div class="ttl">${esc(d.playlistName)}</div>
        <div class="sub">newest ${d.recentCount}: <b>${d.recentTags.map(esc).join(', ') || '—'}</b>
          &nbsp;·&nbsp; the other ${d.olderCount}: <b>${d.olderTags.map(esc).join(', ') || '—'}</b>
          &nbsp;·&nbsp; ${Math.round(d.similarity*100)}% alike</div></div>
    </div>`).join('')}</div>` : ''}
${listsSplitHTML(c, splits)}
    <h2>Axes</h2>
    ${axisTableHTML(c, rows, mixes)}`;
}


export const actions = {
  /** A playlist's sound profile row, shown under it on demand. */
  axexp(c, el) {
    const open = el.getAttribute('aria-expanded') !== 'true';
    el.setAttribute('aria-expanded', String(open));
    const pr = c.document.getElementById(el.getAttribute('aria-controls'));
    if (pr) pr.hidden = !open;
  },

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
