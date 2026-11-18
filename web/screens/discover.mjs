// @bundle screens discover 60
/* The Discover screen (docs/archive/BUILD-5-PLAN.md A4): view and actions only. Seeds, runs and the by-sound
 * ranking stay classic in web/app/discover-engine.js; ctx comes from SCREEN_CTX.discover. */
import { radarView, radarActions, radarMount, newReleaseCount } from './radar.mjs';

/** A fit score in the same words as everywhere else, not a percentage. */
export const fitWord = v => v >= 0.7 ? 'Sure' : v >= 0.45 ? 'Likely' : 'Unsure';

/** "Because you listen to A and B": the pick's own neighbours in this account's listening. */
export function whyLine(t, esc) {
  const v = [...new Set((t.via ?? []).filter(Boolean))];
  if (!v.length) return '';
  const names = v.length > 1 ? `${v.slice(0, -1).map(esc).join(', ')} and ${esc(v[v.length - 1])}` : esc(v[0]);
  return `<p class="why discwhy">Because you listen to <b>${names}</b>.</p>`;
}

/** The preview button's face and words for one state (app/preview.js). */
export function previewBtn(state) {
  return { playing: { icon: '❚❚', label: 'Pause preview' }, loading: { icon: '…', label: 'Loading preview' },
    none: { icon: '–', label: 'No preview for this track' }, error: { icon: '!', label: 'Preview failed, tap to try again' } }[state]
    ?? { icon: '▶', label: 'Play a 30-second preview' };
}

/** Every pick as a row: play its preview, Like it, add it where it fits best, or open it on the card above.
 *  The row on the card is marked. Nothing here writes until a button is tapped. */
export function pickRowsHTML(ctx, d, at) {
  const { esc, thumbHTML, previewState } = ctx;
  if (!d?.length) return '';
  const rows = d.map((t, i) => {
    const best = (t.suggest ?? [])[0];
    const st = !t.isrc ? 'none' : previewState ? previewState(t.id) : 'idle', pb = previewBtn(st);
    const face = thumbHTML ? thumbHTML({ id: t.id, title: t.track, art: t.art }) : '';
    return `<div class="drow${i === at ? ' on' : ''}${st === 'playing' ? ' playing' : ''}" data-drow="${esc(t.id)}">
      <button class="dprev" type="button" data-act="dprev" data-tid="${esc(t.id)}" aria-label="${esc(pb.label)}: ${esc(t.track)}" title="${esc(pb.label)}"${st === 'none' ? ' disabled' : ''}>${face}<span class="dpi" aria-hidden="true">${pb.icon}</span></button>
      <button class="dmain" type="button" data-act="dshow" data-at="${i}"${i === at ? ' aria-current="true"' : ''}>
        <span class="ttl">${esc(t.track)}</span><span class="dsub">${esc(t.artist ?? '')}${best ? ` · <span class="dfit">${esc(fitWord(best.score))} in ${esc(best.name)}</span>` : ''}</span></button>
      <span class="dacts">
        ${ctx.S?.discLiked?.has(t.id) ? '<button class="b sm" type="button" disabled>Liked</button>'
          : `<button class="b sm" type="button" data-act="like" data-like="${esc(t.id)}" aria-label="Like ${esc(t.track)}">Like</button>`}
        ${best ? `<button class="b sm dadd" type="button" data-act="dadd" data-tid="${esc(t.id)}" data-pl="${esc(best.id)}" aria-label="Add ${esc(t.track)} to ${esc(best.name)}">+ ${esc(best.name)}</button>` : ''}
      </span></div>`;
  }).join('');
  return `<section class="drows" aria-labelledby="drows-h">
    <div class="plsugg-head"><h2 id="drows-h">All ${d.length} picks</h2><span class="hint">▶ plays a 30-second preview here</span></div>
    <div class="plrows">${rows}</div></section>`;
}

/** Why the card's first pick is offered, in words. */
export function fitHow(best) {
  return best?.via === 'seed' ? 'sounds right at home next to its tracks, the playlist this radio is from'
    : best?.via === 'sound' ? 'by how it sounds next to what you filed there'
    : 'ranked by the same model the file queue uses';
}

/** "Add to another playlist": every playlist you own, the pick's suggestions first, then the rest A to Z.
 *  Not only the filing targets: you can add a pick to any playlist that is yours. */
export function anyPlaylistMenu(ctx, t) {
  const { LIB, CFG = {}, esc } = ctx;
  const mirror = ctx.isMirrorPlaylist ?? (() => false);
  const mine = (LIB?.playlists ?? []).filter(p => p?.id && !mirror(p));
  const byId = new Map(mine.map(p => [p.id, p]));
  const nameOf = id => byId.get(id)?.name ?? CFG[id]?.name ?? id;
  const sugg = [...new Set((t?.suggest ?? []).map(s => s?.id).filter(id => id && (byId.has(id) || CFG[id])))];
  const rest = mine.filter(p => !sugg.includes(p.id))
    .sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''), undefined, { sensitivity: 'base' }));
  const opt = (id, name) => `<option value="${esc(id)}">${esc(name)}</option>`;
  const top = sugg.length ? `<optgroup label="Suggested">${sugg.map(id => opt(id, nameOf(id))).join('')}</optgroup>` : '';
  const all = rest.length ? (sugg.length ? `<optgroup label="Your other playlists">${rest.map(p => opt(p.id, p.name)).join('')}</optgroup>`
    : rest.map(p => opt(p.id, p.name)).join('')) : '';
  return top + all;
}

/** Which side of Discover shows (L3): 'find' (new music, the default) or 'radar' (new releases).
 *  Without a radar on the page there is only the one side. */
export const sideOf = ctx => ctx.radar && ctx.S?.discSide === 'radar' ? 'radar' : 'find';

/** The two-way switch at the top: Find new music | New releases, with the count of recent releases. */
export function sideSwitchHTML(ctx, side) {
  if (!ctx.radar) return '';
  const R = ctx.radar.R ?? {}, now = ctx.radar.now?.() ?? Date.now();
  const n = newReleaseCount(R, now);
  const btn = (id, label, extra = '') => `<button type="button" aria-pressed="${side === id}" data-act="discSide" data-side="${id}">${label}${extra}</button>`;
  return `<div class="seg discside" role="group" aria-label="Show">${btn('find', 'Find new music')}${btn('radar', 'New releases',
    n ? ` <span class="n" title="${n} released in the last two weeks">${n.toLocaleString('en-GB')}</span>` : '')}</div>`;
}

export function view(ctx) {
  const { S, LIB, esc, lfmKey, emptyState, discSoundLine, discFitHTML,
          artHTML, trackChip, trackStrip, tagChips, pickEvidence, pickBand, mmss, ICON_PLAY } = ctx;
  const ib = ctx.infoBtn ?? (() => '');
  const d = S.discover ?? [];
  const side = sideOf(ctx);
  // Discover leads with what you came for (L3): the radar is the other side of the switch, and keeps
  // reading in the background (web/app/radar.js) whichever side is showing.
  if (side === 'radar') return `<h1>Discover</h1>${sideSwitchHTML(ctx, side)}${radarView(ctx)}`;
  const pls = LIB.playlists.filter(p => p.tracks.length >= 10).sort((a,b) => b.tracks.length - a.tracks.length);
  const hasKey = !!lfmKey();
  const busy = !!ctx.discBusy?.();
  // One filled button per side: the Find button while there are no picks, the card's Add once there are.
  const runBtn = `<button class="b${d.length ? '' : ' p'}" data-act="discRun" id="discRun"${busy ? ' disabled' : ''}>${busy ? 'Finding…' : d.length ? 'Find more' : 'Find new music'}</button>`;
  const head = `<h1>Discover</h1>${sideSwitchHTML(ctx, side)}
    <p class="lede">New music, with everything you already own taken out.${ib('discover', 'Discover', `<p>Every artist and track you already own is subtracted before ranking, including each artist named inside a collaboration, so nothing here recycles your library.</p>
      <p>It looks by itself once a day, from your top artists and recent plays. <b>Everything I listen to</b> weights those above what is merely filed; pick a playlist instead for that playlist's radio.</p>`)}</p>
    <div class="rowbtns discbar">
      <select data-act="discPl" id="discPl" aria-label="Find new music from">
        <option value="">Everything I listen to</option>
        <optgroup label="Playlist radio">
          ${pls.map(p => `<option value="${esc(p.id)}" ${S.discSeed===p.id?'selected':''}>${esc(p.name)}</option>`).join('')}
        </optgroup>
      </select>
      ${runBtn}
    </div>`;

  // No picks yet: a compact line, no second button (C5). The Find button above is the way on.
  if (!d.length) return head + `<div class="disc-empty">${busy
    ? emptyState('Looking for new music', 'Asking who sits near the artists you play. Picks show here in a minute or two.', { compact: true })
    : emptyState('Nothing found yet', 'One run takes a minute or two, and leaves out everything you already own.', { compact: true })}</div>`;

  const i = Math.min(S.discAt ?? 0, d.length - 1), t = d[i];
  const menu = anyPlaylistMenu(ctx, t);
  // No play-on-art (C5): the card's own player and the row's ▶ play it.
  const art = artHTML({ art:t.art, id:t.id, title:t.track }, 'data-noplay="1"').replace(' title="Play"', '');

  const best = (t.suggest ?? [])[0];
  return head + discSoundLine() + `<div class="counter disccount">
      <span class="discvia">${i+1} of ${d.length}</span>
      <span>from ${esc(S.discoverFrom)}</span>
    </div>
    <div class="wide2 discwide"><div class="w-main"><div class="deck">
      <div class="card disc">
        <div class="prog"><i style="width:${((i+1)/d.length*100).toFixed(2)}%"></i></div>
        <div class="now">
          <div class="artwrap">${art}</div>
          <div class="txt">
            <p class="t">${esc(t.track)}</p><p class="a">${esc(t.artist)}</p>
            <div class="m"><span>${esc(t.album??'')}</span><span>${esc((t.released??'').slice(0,4))}</span><span>${mmss(t.dur)}</span></div>${trackChip(t)}${discFitHTML(t)}
          </div>
        </div>${trackStrip(t)}

        <div class="player">
          <button class="tbtn" id="pToggle" aria-label="Play">${ICON_PLAY}</button>
          <input class="seek" id="seek" type="range" min="0" max="${t.dur ?? 0}" step="1000" value="0"
                 aria-label="Playing position" disabled>
          <span class="tm"><span id="pTime">0:00</span> / <span id="pDur">${mmss(t.dur)}</span></span>
        </div>
        <p class="pdev" id="pDev"></p>

        ${whyLine(t, esc)}
        ${(t.tags??[]).length ? tagChips(t.tags, t.thinData) : ''}
        ${best ? `<button class="fitcall discadd" data-act="dfile" data-dfile="${esc(best.id)}">
            <span class="mid"><span class="nm">Add to ${esc(best.name)}</span>
              <span class="ax">${best.axis ? `<b>${esc(best.axis)}</b> playlist · ` : ''}${fitHow(best)}</span>${pickEvidence(best)}</span>
            ${pickBand(best)}<span class="sc">${fitWord(best.score)}</span>
          </button>` : ''}
        ${(t.suggest??[]).length > 1 ? `<div class="picks">${t.suggest.slice(1,3).map((sg,n)=>
          `<button class="pick" data-act="dfile" data-dfile="${esc(sg.id)}"><span class="k">${n+2}</span>
           <span class="mid"><span class="nm">${esc(sg.name)}</span><span class="ax">${sg.axis ? 'its tags fit here' : sg.via === 'seed' ? 'the playlist this radio is from' : 'playlist'}</span>${pickEvidence(sg)}</span>
           <span class="rt">${pickBand(sg)}<span class="sc">${fitWord(sg.score)}</span>
             <span class="bar"><i style="width:${(sg.score*100).toFixed(0)}%"></i></span></span></button>`).join('')}</div>` : ''}
        ${(t.suggest??[]).length ? '' : `<p class="why discnofit">No confident suggestion — ${hasKey ? 'Last.fm has no tags for this artist' : 'nothing says what this artist is yet'}, or it fits nothing you have. Pick a playlist below.</p>`}

        <div class="rowbtns discnav">
          <button class="b big grow" data-act="dnav" data-dnav="1" ${i>=d.length-1?'disabled':''}>Next →</button>
        </div>
        <div class="rowbtns discmore">
          <button class="b sm" data-act="dnav" data-dnav="-1" ${i===0?'disabled':''}>← Back</button>
          <button class="b sm" data-act="dpass" data-dpass="${esc(t.id)}" title="Not for me: this artist won't be offered again">Not for me</button>
          <button class="b sm" data-act="like" data-like="${esc(t.id)}">Like</button>
          <a class="b sm" href="https://open.spotify.com/track/${esc(t.id)}" target="_blank" rel="noopener">Open</a>
          <select data-act="discAnyPl" id="discAnyPl" aria-label="Add to another playlist"><option value="">Add to another playlist…</option>${menu}</select>
        </div>
      </div>
    </div></div>
    <div class="w-rail">${pickRowsHTML(ctx, d, i)}</div></div>`;
}


/** After paint: the radar's search field and windowed feed. */
export function mount(ctx) {
  ctx.discRestore?.();
  // The radar's stored rows load on either side: the switch counts new releases from them.
  if (sideOf(ctx) === 'radar') radarMount(ctx); else ctx.radar?.load?.();
}

export const actions = {
  ...radarActions,
  discRun: ({ S, runDiscovery }) => runDiscovery(S.discSeed || null),
  discPl({ S }, el) { S.discSeed = el.value; },
  /** The switch: Find new music | New releases. Kept with the remembered filters when those are on. */
  discSide(ctx, el) {
    const side = el.dataset.side === 'radar' ? 'radar' : 'find';
    ctx.S.discSide = side;
    if (ctx.T?.rememberFilters) { ctx.T.discSide = side; ctx.saveTheme?.(); }
    ctx.render();
  },
  discAnyPl(ctx, el) { if (el.value) return discAdd(ctx, el.value); },
  dfile(ctx, el) { return discAdd(ctx, el.dataset.dfile); },
  /** A row's "+ playlist": that pick, into the playlist it fits best. */
  dadd(ctx, el) {
    const at = (ctx.S.discover ?? []).findIndex(x => x.id === el.dataset.tid);
    if (at >= 0) return discAdd(ctx, el.dataset.pl, at);
  },
  /** A row's ▶: its 30-second preview, in the page. */
  dprev(ctx, el) {
    const t = (ctx.S.discover ?? []).find(x => x.id === el.dataset.tid);
    if (t && ctx.previewToggle) return ctx.previewToggle(t);
  },
  /** Tap a row's title: that pick on the card. */
  dshow({ S, render }, el) {
    const d = S.discover ?? [];
    S.discAt = Math.max(0, Math.min(+el.dataset.at || 0, d.length - 1));
    render();
    globalThis.document?.querySelector?.('.deck')?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  },
  dnav({ S, render }, el) {
    const d = S.discover ?? [];
    S.discAt = Math.max(0, Math.min((S.discAt ?? 0) + (+el.dataset.dnav), d.length - 1));
    render();
  },
  /** Pass on this artist for good (kept on this device) and move to the next card. */
  dpass({ S, render, toast, discRemember }) {
    const d = S.discover ?? [], at = Math.min(S.discAt ?? 0, d.length - 1), t = d[at];
    if (!t) return;
    discRemember('pass', t.artist ?? t.artists?.[0]?.name);
    S.discover = d.filter(x => (x.artist ?? '') !== (t.artist ?? ''));
    S.discAt = Math.max(0, Math.min(at, S.discover.length - 1));
    toast(`Won’t offer ${t.artist ?? 'them'} again.`);
    render();
  },
  async like({ S, libraryCall, logAction, toast, discRemember }, el) {
    try { await libraryCall('PUT', [el.dataset.like]);
      const t = (S.discover ?? []).find(x => x.id === el.dataset.like);
      if (t && discRemember) discRemember('like', t.artist ?? t.artists?.[0]?.name);
      await logAction({ op:'add-liked', trackIds:[el.dataset.like], reason:'from discovery' });
      (S.discLiked ??= new Set()).add(el.dataset.like);
      el.textContent = 'Liked'; el.disabled = true; toast('Added to your Liked Songs.'); }
    catch (err) { toast('Failed: '+err.message); }
  },
};

/** Add a pick (the one on the card, unless `pick` says which) to a playlist, and take it off the pile. */
async function discAdd({ S, CFG, LIB, addTracks, logAction, getLog, toast, undoAction, render, discRemember }, playlistId, pick = null) {
  const d = S.discover ?? [], cur = Math.min(S.discAt ?? 0, d.length - 1), at = pick ?? cur, t = d[at];
  if (!t) return;
  const name = CFG[playlistId]?.name ?? LIB?.playlists?.find(p => p.id === playlistId)?.name ?? playlistId;
  try {
    await addTracks(playlistId, [t.id]);
    await logAction({ op:'add', playlistId, playlistName:name, trackIds:[t.id], reason:'added from discovery' });
    const when = (await getLog())[0]?.at;
    toast(`Added “${t.track}” to ${name}.`, () => undoAction(when));
    if (discRemember) discRemember('like', t.artist ?? t.artists?.[0]?.name);
    d.splice(at, 1);
    S.discAt = Math.max(0, Math.min(at < cur ? cur - 1 : pick == null ? at : cur, d.length - 1));
    render();
  } catch (e) { toast('Failed: ' + e.message); }
}

