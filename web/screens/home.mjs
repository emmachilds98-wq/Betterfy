// @bundle screens home 10
/* File, the home tab (docs/BUILD-5-PLAN.md §4.1, UI-D). Home and File were two
 * screens; this is one: a single status line, the "Analyse my library" strip,
 * the File deck itself (the `inbox` module, handed in as ctx.deck), and Up next
 * as a horizontal strip. With nothing left to file it is the done state and the
 * library bar. The old Home's hero, four cards and facts panel are gone: the
 * tab bar is the four cards, and Settings holds the rest. */

/** "42 to file · 1 to tidy · listening 37/412", each part only when there is something to say. */
export function statusParts({ R, listenStatus }) {
  const backlog = R.backlog.length, toTidy = R.within.length + R.misfiled.length;
  const listen = typeof listenStatus === 'function' ? listenStatus() : '';
  return { backlog, toTidy, listen };
}

export function statusHTML(ctx) {
  const { esc } = ctx;
  const { backlog, toTidy, listen } = statusParts(ctx);
  const parts = [`<span class="st-file"><b>${backlog.toLocaleString()}</b> to file</span>`,
    `<button class="st-tidy" data-go="tidy"><b>${toTidy.toLocaleString()}</b> to tidy</button>`];
  // Nothing is said about listening until it has run, so a listener who never
  // turns it on reads the same line as before.
  if (listen) parts.push(`<button class="st-listen" data-act="openlisten" data-listenstat>${esc(listen)}</button>`);
  return `<div class="status" id="fileStatus" role="status">${parts.join('<span class="dot" aria-hidden="true">·</span>')}</div>`;
}

/** Where the library sits, as one bar over one population: your liked songs. */
export function libraryBarHTML({ R, LIB, esc, isMirrorPlaylist }) {
  const uniq = new Set();
  for (const p of LIB.playlists) { if (isMirrorPlaylist(p)) continue; for (const t of p.tracks) uniq.add(t.id); }
  const backlog = R.backlog.length;
  const liked = LIB.liked.length;
  const likedIds = new Set(LIB.liked.map(t => t?.id).filter(Boolean));
  const crossLiked = R.across.filter(x => likedIds.has(x.id)).length;
  const filed = Math.max(liked - backlog, 0);
  const seg = [
    ['Filed', Math.max(filed - crossLiked, 0), 'm4'],
    ['Cross-filed', Math.min(crossLiked, filed), 'm3'],
    ['Unfiled', backlog, 'm0'],
  ];
  const tot = seg.reduce((n, x) => n + x[1], 0) || 1;
  return `<div class="panel libbar">
      <div class="ph">
        <h2>Where your library sits</h2>
        <span class="mono">${uniq.size.toLocaleString()} tracks · ${LIB.playlists.length} playlists</span>
      </div>
      <div class="bar">${seg.map(([, n, c]) =>
        `<i style="width:${(100 * n / tot).toFixed(2)}%; background:var(--${c})"></i>`).join('')}</div>
      <div class="key">${seg.map(([l, n, c]) =>
        `<span><i style="background:var(--${c})"></i>${esc(l)} <b>${n.toLocaleString()}</b></span>`).join('')}</div>
    </div>`;
}

/** The next few after the one on the deck, as a strip you can scroll sideways. */
export function upNextHTML({ S, R, esc, hueOf, filePicks, pickBacked }) {
  const at = Math.min(S.inboxAt ?? 0, R.backlog.length - 1);
  const upNext = R.backlog.map((t, i) => [t, i]).slice(at + 1, at + 9);
  if (!upNext.length) return '';
  return `<div class="seehead"><h2 style="margin:0">Up next</h2></div>
    <div class="upnext strip">${upNext.map(([t, i]) => {
      const best = (filePicks ? filePicks(t) : t.suggest ?? [])[0];
      // Green and "Sure" only for a pick sound or filing history backs (USER-REVIEW item 2).
      const strong = best && best.score >= 0.7 && (pickBacked ? pickBacked(best) : true);
      const h = hueOf(t.id ?? t.title ?? '');
      const cover = t.art
        ? `<img class="cov" src="${esc(t.art)}" alt="" loading="lazy" decoding="async">`
        : `<span class="cov" style="background:linear-gradient(150deg,hsl(${h} 62% 56%),hsl(${(h + 48) % 360} 58% 44%))">${esc((t.title || '?').trim()[0] ?? '?')}</span>`;
      return `<button class="u" data-act="goinbox" data-goinbox="${i}" title="${esc(t.title)} — ${esc(t.artist)}">${cover}<span class="bd">
        <span class="t">${esc(t.title)}</span>
        <span class="a">${esc(t.artist)}</span>
        <span class="h" style="color:var(--${strong ? 'ok' : 'accent'})">${best
          ? `→ ${esc(best.name)} · ${strong ? 'Sure' : best.score >= 0.45 ? 'Likely' : 'Unsure'}` : '→ no confident pick'}</span>
      </span></button>`;
    }).join('')}</div>`;
}

/** No genre playlist yet: the groups already sitting together in the library, startable right on File. */
export function coldHTML({ esc, onbColdOffers }) {
  const offers = onbColdOffers?.() ?? [];
  if (!offers.length) return '';
  return `<section class="panel cold" aria-labelledby="fcold-h">
    <h2 id="fcold-h">Start these playlists</h2>
    <p class="hint">You have no genre playlists yet, so File has little to go on. These groups already sit together in your library.</p>
    ${offers.map((o, i) => `<div class="plrow"><span class="plmain">
      <input id="fcoldnm${i}" aria-label="Name for this playlist" value="${esc(o.title)}">
      <span class="plmeta"><span class="mono">${o.n}</span> tracks · ${esc(o.why)}</span></span>
      <button class="b sm p" data-act="coldStart" data-cold="${i}">Start</button></div>`).join('')}</section>`;
}

export function view(ctx) {
  const { R, LIB, analyseHTML, deck } = ctx;
  const head = statusHTML(ctx) + (ctx.onbHTML?.() ?? '') + analyseHTML();
  // A brand-new account: File's own message says what to do; no bar of zeros under it.
  if (!LIB.liked.length && !LIB.playlists.some(p => p.tracks?.length)) return `${head}${deck()}`;
  // Nothing to file: the deck's own done card, then where the library stands.
  if (!R.backlog.length) return `${head}${deck()}${libraryBarHTML(ctx)}`;
  return `${head}${coldHTML(ctx)}${deck()}${upNextHTML(ctx)}`;
}

export const actions = {
  analyseGo: ({ analyseGo }) => analyseGo(),
  /** Make the playlist for one offered group, then the deck has somewhere to file into. */
  async coldStart({ COLD, gapsCreate, onbColdOffers, $, toast, render }, el) {
    const i = +el.dataset.cold, o = onbColdOffers()[i], name = $('#fcoldnm' + i)?.value.trim();
    if (!o) return;
    if (!name) return toast('Give it a name first.');
    el.disabled = true;
    try {
      await gapsCreate(name, o.ids);
      COLD.found.proposals = COLD.found.proposals.filter(p => p.ids !== o.ids);
      COLD.found.clusters = COLD.found.clusters.filter(p => (p.ids ?? p.tracks?.map(t => t.id)) !== o.ids);
      render();
    } catch (err) { el.disabled = false; toast('Failed: ' + err.message); }
  },
  openlisten: ({ openUnderHood }) => openUnderHood('sources'),
  // A card under "Up next" opens the queue on that track, not at the top.
  // Its index is an absolute position in the queue, not an offset from wherever
  // the queue was left.
  goinbox({ S, R, render, morphArt }, el) {
    S.inboxAt = Math.min(+el.dataset.goinbox || 0, Math.max(R.backlog.length - 1, 0));
    // The cover grows into the File card's art where View Transitions exist.
    return morphArt ? morphArt(el.querySelector?.('.cov'), R.backlog[S.inboxAt]?.id, render) : render();
  },
};
