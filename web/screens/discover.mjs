// @bundle screens discover 60
/* The Discover screen (docs/BUILD-5-PLAN.md A4): view and actions only. Seeds, runs and the by-sound
 * ranking stay classic in web/app/discover-engine.js; ctx comes from SCREEN_CTX.discover. */
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
        ${best ? `<button class="b sm go" type="button" data-act="dadd" data-tid="${esc(t.id)}" data-pl="${esc(best.id)}" aria-label="Add ${esc(t.track)} to ${esc(best.name)}">+ ${esc(best.name)}</button>` : ''}
      </span></div>`;
  }).join('');
  return `<section class="drows" aria-labelledby="drows-h">
    <div class="plsugg-head"><h2 id="drows-h">All ${d.length} picks</h2><span class="hint">▶ plays a 30-second preview here</span></div>
    <div class="plrows">${rows}</div></section>`;
}

export function view(ctx) {
  const { S, LIB, CFG, esc, lfmKey, emptyState, discListenOn, soundSearchHTML, discSoundLine, discFitHTML,
          artHTML, trackChip, trackStrip, tagChips, pickEvidence, pickBand, mmss, ICON_PLAY } = ctx;
  const ib = ctx.infoBtn ?? (() => '');
  const d = S.discover ?? [];
  const pls = LIB.playlists.filter(p => p.tracks.length >= 10).sort((a,b) => b.tracks.length - a.tracks.length);
  const hasKey = !!lfmKey();
  const head = `<h1>Discover</h1>
    <p class="lede">New music, with everything you already own taken out.${ib('discover', 'Discover', `<p>Every artist and track you already own is subtracted before ranking, including each artist named inside a collaboration, so nothing here recycles your library.</p>
      <p><b>Everything I listen to</b> weights your top artists and recent plays above what is merely filed; pick a playlist instead for that playlist's radio.</p>`)}</p>
    ${hasKey ? '' : `<div class="note discnokey">
      <b>No key needed.</b> Picks come from Deezer's and ListenBrainz's “fans also like” for the artists you play${discListenOn() ? ', then ranked by how they sound' : ''}.
      A free Last.fm key adds its own similar artists and genre tags.
      <div class="rowbtns" style="margin-top:8px"><button class="b" type="button" data-lfmconnect>Connect Last.fm</button></div>
    </div>`}
    <div class="rowbtns" style="margin-bottom:16px">
      <select data-act="discPl" id="discPl" aria-label="Find new music from">
        <option value="">Everything I listen to</option>
        <optgroup label="Playlist radio">
          ${pls.map(p => `<option value="${esc(p.id)}" ${S.discSeed===p.id?'selected':''}>${esc(p.name)}</option>`).join('')}
        </optgroup>
      </select>
      <button class="b p" data-act="discRun" id="discRun" >Find new music</button>
    </div>`;

  // WP-C3: "find tracks that sound like ___". '' without CLAP records.
  const sounds = soundSearchHTML();
  // Every empty state gets a button (USER-REVIEW): here it is the Find button itself.
  if (!d.length) return head + sounds + emptyState('Nothing found yet', 'One run takes a minute or two, and leaves out everything you already own.',
    { acts: '<button class="b p" type="button" data-act="discRun">Find new music from what I play</button>' });

  const i = Math.min(S.discAt ?? 0, d.length - 1), t = d[i];
  const opts = Object.entries(CFG).filter(([,v])=>v.target).map(([id,v])=>({id,...v})).sort((a,b)=>a.name.localeCompare(b.name));
  const art = artHTML({ art:t.art, id:t.id, title:t.track },
                      `data-dplay="${esc(t.id)}" data-ddur="${t.dur ?? 0}"`);

  const best = (t.suggest ?? [])[0];
  return head + sounds + discSoundLine() + `<div class="counter" style="margin:0 0 14px">
      <span style="font-family:var(--mono); font-size:11.5px; letter-spacing:.12em; text-transform:uppercase; color:var(--accent)">via ${esc((t.via??[]).join(', '))} · ${i+1} of ${d.length}</span>
      <span>from ${esc(S.discoverFrom)}</span>
    </div>
    <div class="deck">
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
        ${best ? `<button class="fitcall" data-act="dfile" data-dfile="${esc(best.id)}">
            <span class="mid"><span class="nm">Would sit well in ${esc(best.name)}</span>
              <span class="ax"><b>${esc(best.axis??'')}</b> playlist · ${best.via === 'sound' ? 'by how it sounds next to what you filed there' : 'ranked by the same model the file queue uses'}</span>${pickEvidence(best)}</span>
            ${pickBand(best)}<span class="sc">${fitWord(best.score)}</span>
          </button>` : ''}
        ${(t.suggest??[]).length > 1 ? `<div class="picks">${t.suggest.slice(1,3).map((sg,n)=>
          `<button class="pick" data-act="dfile" data-dfile="${esc(sg.id)}"><span class="k">${n+2}</span>
           <span class="mid"><span class="nm">${esc(sg.name)}</span><span class="ax">${esc(sg.axis??'')} playlist</span>${pickEvidence(sg)}</span>
           <span class="rt">${pickBand(sg)}<span class="sc">${fitWord(sg.score)}</span>
             <span class="bar"><i style="width:${(sg.score*100).toFixed(0)}%"></i></span></span></button>`).join('')}</div>` : ''}
        ${(t.suggest??[]).length ? '' : `<p class="why" style="margin-top:20px">No confident suggestion — ${hasKey ? 'Last.fm has no tags for this artist' : 'nothing says what this artist is yet'}, or it fits nothing you have. Pick a playlist below.</p>`}

        <div class="rowbtns" style="margin-top:20px">
          ${best ? `<button class="b big go grow" data-act="dfile" data-dfile="${esc(best.id)}">Add to ${esc(best.name)}</button>` : ''}
          <button class="b big" data-act="dnav" data-dnav="1" ${i>=d.length-1?'disabled':''}>Next →</button>
        </div>
        <div class="rowbtns" style="margin-top:10px">
          <button class="b sm" data-act="dnav" data-dnav="-1" ${i===0?'disabled':''}>← Back</button>
          <button class="b sm" data-act="dpass" data-dpass="${esc(t.id)}" title="Not for me: this artist won't be offered again">Not for me</button>
          <button class="b sm" data-act="like" data-like="${esc(t.id)}">Like</button>
          <a class="b sm" href="https://open.spotify.com/track/${esc(t.id)}" target="_blank" rel="noopener">Open</a>
          <select data-act="discAnyPl" id="discAnyPl"><option value="">Add to another playlist…</option>${opts.map(o=>`<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('')}</select>
          ${t.isrc ? `<button class="b sm" type="button" data-act="dprev" data-tid="${esc(t.id)}">${ctx.previewState?.(t.id) === 'playing' ? 'Pause preview' : 'Preview'}</button>` : ''}
        </div>
      </div>
    </div>
    ${pickRowsHTML(ctx, d, i)}`;
}


export const actions = {
  discRun: ({ S, runDiscovery }) => runDiscovery(S.discSeed || null),
  discPl({ S }, el) { S.discSeed = el.value; },
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
async function discAdd({ S, CFG, addTracks, logAction, getLog, toast, undoAction, render, discRemember }, playlistId, pick = null) {
  const d = S.discover ?? [], cur = Math.min(S.discAt ?? 0, d.length - 1), at = pick ?? cur, t = d[at];
  if (!t) return;
  const name = CFG[playlistId]?.name ?? playlistId;
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

