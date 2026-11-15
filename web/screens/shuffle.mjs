// @bundle screens shuffle 50
/* The Shuffle screen (docs/BUILD-5-PLAN.md A4): view and actions only. The spacing, DJ-order and
 * All Songs mirror code stays classic in web/app/shuffle-engine.js; ctx comes from SCREEN_CTX.shuffle. */
const mixPct = x => `${Math.round(x * 100)}%`;
export function mixBpmOf(index, id) {
  const d = index.get(id)?.rec?.dsp;
  return d?.bpm > 0 ? Math.round(d.bpm) : null;
}
/** The energy along the mix as a row of bars; only once energy labels have been checked. */
function mixEnergyHTML(energy, { labelsShownNow, esc }) {
  const shown = labelsShownNow();
  if (!shown?.energy || !(energy?.length >= 2)) return '';
  return `<div class="mx-arc" role="img" aria-label="Energy along the mix, calm to intense">${energy.map(e =>
    `<span style="height:${Math.max(8, Math.round(e * 100))}%"></span>`).join('')}</div>`;
}
function mixHTML(mix, tracks, p, { S, esc, emptyState, skeleton, artistOf, MIX_PAGE, MIX_MODES, labelsShownNow, BetterfyAudio }) {
  if (mix.pending) return MIX_PAGE.err
    ? emptyState('The mix couldn’t load', esc(MIX_PAGE.err), { compact: true })
    : emptyState('Working out the mix…', 'Matching tempos and sounds across what listening has heard.', { compact: true }) + (skeleton ? skeleton('rows', 4) : '');
  const st = mix.stats, nv = mix.naive, bpmOn = BetterfyAudio?.bpmShown ? BetterfyAudio.bpmShown() : true;
  const row = (t, i) => {
    const heard = i < mix.mixed, step = i > 0 && i < mix.mixed ? mix.steps[i - 1] : null;
    const bpm = heard && bpmOn ? mixBpmOf(mix.index, t.id) : null;
    const jump = step && !step.rel;
    return `<div class="${jump ? 'mx-jump' : ''}${heard ? '' : ' mx-unheard'}" data-flip data-key="${esc(`o:${t.id}`)}">
      <span class="i">${String(i+1).padStart(3,'0')}</span>
      <span class="t">${esc(t.name)}</span>
      <span class="a">${esc(artistOf(t))}</span>${bpm ? `<span class="mx-bpm"${step?.rel && step.rel !== 'same' ? ` title="${step.rel === 'half' ? 'double' : 'half'} time"` : ''}>${bpm}</span>` : ''}${jump ? '<span class="mx-tag">tempo change</span>' : ''}</div>`;
  };
  return `<div class="vs">
      <div class="bad"><div class="l">Shuffled</div><div class="n">${nv.share === null ? '—' : mixPct(nv.share)}</div>
        <div class="d">of track changes can be beatmatched</div></div>
      <div class="good"><div class="l">${esc(MIX_MODES[S.shufMode])}</div><div class="n">${st.share === null ? '—' : mixPct(st.share)}</div>
        <div class="d">can be beatmatched${st.shift !== null ? `, ${(st.shift * 100).toFixed(1)}% pitch change on average` : ''}</div></div>
    </div>
    ${mixEnergyHTML(st.energy, { labelsShownNow, esc })}
    <p class="lede mx-sum">${mix.mixed} heard tracks in the mix${bpmOn && st.bpm ? ` · ${Math.round(st.bpm[0])}–${Math.round(st.bpm[1])} BPM` : ''}${mix.rest ? ` · ${mix.rest} not heard yet follow in the spaced shuffle` : ''}${tracks.length!==p.tracks.length?` · ${p.tracks.length-tracks.length} near-duplicates dropped`:''}</p>
    <h2>Order</h2>
    <div class="order mx-order">${mix.order.slice(0,40).map(row).join('')}</div>`;
}

export function view(ctx) {
  const { S, LIB, LS, esc, emptyState, isMirrorPlaylist, dedupe, spacedShuffle, shuffleStats, rnd, artistOf,
          mixHeardIn, shuffleMix, MIX_MODES } = ctx;
  const pls = LIB.playlists.filter(p => p.tracks.length >= 8).sort((a,b) => b.tracks.length - a.tracks.length);
  // Once it exists, everything you own beats any single bucket as a shuffle
  // source — that default only loses to a playlist you have since chosen.
  const allSongs = LIB.playlists.find(isMirrorPlaylist);
  // Persisted immediately, not just used locally — otherwise "Create shuffled
  // playlist" (which reads S.shufPl on its own) can act on a different
  // playlist than whichever one the dropdown is actually showing as selected.
  const sel = S.shufPl = S.shufPl ?? allSongs?.id ?? pls[0]?.id;
  const p = LIB.playlists.find(x => x.id === sel);
  const tracks = p ? dedupe(p.tracks) : [];
  // Cached against the source it was built from. Shuffling used to run again on
  // every single redraw of this screen — including the redraw after an
  // unrelated toast — and it is by some distance the most expensive thing the
  // app computes. "Shuffle again" below is how you deliberately re-roll it.
  if (S.shufFlow === undefined) { try { S.shufFlow = LS.getItem('bf_shuf_flow') === '1'; S.shufRedisc = LS.getItem('bf_shuf_redisc') === '1'; } catch { S.shufFlow = S.shufRedisc = false; } }
  // Flow needs a sound reading or a genre tag on half the list; without that the option is not offered.
  const canFlow = !!ctx.flowReady?.(tracks), flow = canFlow && S.shufFlow;
  const redisc = !!S.shufRedisc && S.shufActive?.size > 0;
  if (S.shufRedisc && !S.shufActive && ctx.rediscoverKick) ctx.rediscoverKick();
  if (S.shufCache?.id !== sel || S.shufCache?.n !== tracks.length || S.shufCache.flow !== flow || S.shufCache.redisc !== redisc) {
    S.shufCache = { id: sel, n: tracks.length, flow, redisc,
      order: tracks.length ? (ctx.shuffleOrder
        ? ctx.shuffleOrder(tracks, { rediscover: redisc ? S.shufActive : null, near: flow ? ctx.flowNear() : null })
        : spacedShuffle(tracks)) : [],
      naive: tracks.length ? shuffleStats(rnd([...tracks])) : null };
  }
  const order = S.shufCache.order, naive = S.shufCache.naive;
  const good = order.length ? shuffleStats(order) : null;
  // DJ order: offered only once enough of this list has been heard; otherwise nothing changes.
  const canMix = order.length && mixHeardIn(tracks) >= (ctx.BetterfyOrder?.MIN_MIX ?? 8);
  if (S.shufMode === undefined) { try { S.shufMode = LS.getItem('bf_shuf_mode') || ''; } catch { S.shufMode = ''; } }
  const mix = canMix && MIX_MODES[S.shufMode] ? shuffleMix(sel, tracks, S.shufMode) : null;
  const mixPick = canMix ? ` <select id="shufMode" data-act="shufMode" aria-label="Order">${[['', 'Spaced shuffle'], ...Object.entries(MIX_MODES)].map(([v, l]) =>
    `<option value="${v}" ${v === (mix ? S.shufMode : '') ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>` : '';
  S.shufOrder = mix && !mix.pending ? mix.order : mix ? [] : order;
  S.shufOrderMode = mix && !mix.pending ? S.shufMode : null;
  return `<h1>Shuffle</h1>
    <p class="lede">Spotify's shuffle clusters artists; this spaces them out.${ctx.infoBtn?.('shuffle', 'Shuffle', `<p>This maximises the distance between tracks by the same artist and the same album, then writes the result as a playlist you play with Spotify's own shuffle <b>off</b>.</p>`) ?? ''}</p>
    <p class="lede" style="margin-top:-8px">${allSongs
      ? `Shuffling from <b>${esc(allSongs.name)}</b> by default — everything in your library, kept in one place.`
      : `No single playlist has everything you own yet.`}
      <button class="b sm" data-act="syncAllSongs" id="syncAllSongs" style="margin-left:6px">${allSongs ? 'Refresh it' : 'Build it'}</button></p>
    <div class="rowbtns" style="margin-bottom:22px">
      <select id="shufPl" data-act="shufPl">${pls.map(x => `<option value="${esc(x.id)}" ${x.id===sel?'selected':''}>${esc(x.name)} (${x.tracks.length})</option>`).join('')}</select>
      <button class="b p" id="shufApply" ${S.shufOrder.length?'':'disabled'} data-act="shufApply">Create shuffled playlist</button>
      <button class="b" data-act="shufPlay" id="shufPlay" ${S.shufOrder.length?'':'disabled'}>Create and play</button>
      <button class="b sm" data-act="shufAgain" id="shufAgain" ${order.length?'':'disabled'}>Shuffle again</button>${mixPick}
    </div>
    ${order.length ? `<div class="rowbtns" style="margin:-12px 0 18px">${canFlow ? `
      <label class="pls-f"><input type="checkbox" data-act="shufFlow" ${flow ? 'checked' : ''}> keep neighbours alike</label>` : ''}
      <label class="pls-f"><input type="checkbox" data-act="shufRedisc" ${S.shufRedisc ? 'checked' : ''}> rediscover: what you have not been playing first</label></div>` : ''}
    ${mix ? mixHTML(mix, tracks, p, ctx) : good ? `<div class="vs">
      <div class="bad"><div class="l">Spotify's shuffle</div><div class="n">${naive.minGap}</div>
        <div class="d">${naive.minGap === 1 ? 'slot' : 'slots'} between the same artist, ${naive.within3} ${naive.within3 === 1 ? 'pair' : 'pairs'} within three</div></div>
      <div class="good"><div class="l">Betterfy</div><div class="n">${good.minGap}</div>
        <div class="d">${good.minGap === 1 ? 'slot' : 'slots'} minimum, ${good.within3 ? `${good.within3} ${good.within3 === 1 ? 'pair' : 'pairs'} within three` : 'nothing within three'}, average gap ${good.avgGap}</div></div>
    </div>
    <p class="lede" style="margin:-10px 0 20px; font-size:14px">${order.length} tracks · ${new Set(tracks.map(artistOf)).size} artists${tracks.length!==p.tracks.length?` · ${p.tracks.length-tracks.length} near-duplicates dropped`:''}</p>
    <details class="how orderprev"><summary>Preview the order</summary>
    <div class="order">${order.slice(0,40).map((t,i) => `<div data-flip data-key="${esc(`o:${t.id}`)}">
      <span class="i">${String(i+1).padStart(3,'0')}</span>
      <span class="t">${esc(t.name)}</span>
      <span class="a">${esc(artistOf(t))}</span></div>`).join('')}</div></details>` : emptyState('Pick a playlist', 'Anything with eight tracks or more can be re-spaced.')}`;
}


export const actions = {
  async syncAllSongs({ syncAllSongsPlaylist, toast, render }, btn) {
    btn.disabled = true; btn.textContent = 'Working…';
    try { await syncAllSongsPlaylist(); }
    catch (err) { toast('Failed: ' + err.message); render(); }
  },
  shufPl({ S, render }, el) { S.shufPl = el.value; S.shufCache = null; render(); },
  shufMode({ S, LS, render }, el) { S.shufMode = el.value; try { LS.setItem('bf_shuf_mode', S.shufMode); } catch {} render(); },
  shufAgain({ S, render }) { S.shufCache = null; render(); },
  shufFlow({ S, LS, render }, el) { S.shufFlow = el.checked; try { LS.setItem('bf_shuf_flow', el.checked ? '1' : '0'); } catch {} S.shufCache = null; render(); },
  shufRedisc({ S, LS, render, rediscoverKick }, el) {
    S.shufRedisc = el.checked; try { LS.setItem('bf_shuf_redisc', el.checked ? '1' : '0'); } catch {}
    S.shufCache = null; if (el.checked) rediscoverKick?.(); render();
  },
  shufApply(ctx, btn) { return build(ctx, btn, false); },
  shufPlay(ctx, btn) { return build(ctx, btn, true); },
};

async function build({ S, LIB, LS, MIX_MODES, paged, sp, plCall, chunk, logAction, toast, render }, btn, playIt) {
  // vShuffle() always sets S.shufPl to whatever it last showed as selected
  // by the time this button is reachable, so this and the screen agree.
  const src = LIB.playlists.find(p => p.id === S.shufPl);
  const order = S.shufOrder ?? [];
  if (!order.length) return;
  btn.disabled = true; btn.textContent = 'Working…';
  const dj = S.shufOrderMode ? MIX_MODES[S.shufOrderMode] : null;
  try {
    const name = dj ? `🎧 ${src.name}` : `🔀 ${src.name}`;
    // Remembered by id, like the All Songs mirror and for the same reason:
    // found by name alone, renaming the shuffled playlist (or its source)
    // made the next shuffle build a second one beside it instead of
    // replacing what was already there.
    const key = (dj ? 'bf_mix_' : 'bf_shuf_') + src.id;
    const pinned = LS.getItem(key);
    const mine = await paged('/me/playlists?limit=50');
    const ours = p => p?.owner?.id === LIB.user.id;
    let pl = mine.find(p => p.id === pinned && ours(p)) ?? mine.find(p => p.name === name && ours(p));
    if (!pl) pl = await sp('/me/playlists', { method:'POST',
      body:JSON.stringify({ name, public:false, description: dj
        ? `${dj} of "${src.name}": each next track beatmatches the last. Play with Spotify shuffle OFF.`
        : `Spaced shuffle of "${src.name}". Play with Spotify shuffle OFF.` }) });
    LS.setItem(key, pl.id);
    // PUT replaces wholesale, so re-shuffling the same playlist doesn't pile up
    await plCall(pl.id, 'PUT', { uris: order.slice(0,100).map(t => 'spotify:track:'+t.id) });
    for (const part of chunk(order.slice(100), 100)) await plCall(pl.id, 'POST', { uris: part.map(t => 'spotify:track:'+t.id) });
    await logAction({ op:'shuffle', playlistId:pl.id, playlistName:pl.name ?? name, trackIds:order.map(t=>t.id), reason:`${dj ? dj.toLowerCase() + ' ' : ''}from ${src.name}` });
    if (playIt) {
      const d = await sp('/me/player/devices');
      const dev = (d.devices??[]).find(x=>x.is_active) ?? (d.devices??[])[0];
      if (!dev) toast(`"${pl.name ?? name}" is ready — no open Spotify device to play it on.`);
      else {
        await sp(`/me/player/shuffle?state=false&device_id=${dev.id}`, { method:'PUT' });
        await sp(`/me/player/play?device_id=${dev.id}`, { method:'PUT', body:JSON.stringify({ context_uri:`spotify:playlist:${pl.id}` }) });
        toast(`Playing "${pl.name ?? name}" on ${dev.name}, Spotify shuffle off.`);
      }
    } else toast(`"${pl.name ?? name}" — ${order.length} tracks, ready. Play it with Spotify shuffle OFF.`);
  } catch (err) { toast('Failed: ' + err.message); }
  render();
}
