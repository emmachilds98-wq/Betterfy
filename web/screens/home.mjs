// @bundle screens home 10
import { feedRows } from './radar.mjs';
import { parseDate } from '../../core/release/dates.mjs';
/* File, the home tab (docs/archive/BUILD-5-PLAN.md §4.1, UI-D; docs/DESIGN-PLAN.md L8
 * step 2). The top is a calm "today" header: a greeting, then one line of
 * status ("72 to file · 3 new releases · 1 to tidy · tidying up: keys 5/40"),
 * each part a tap to where it lives. The old status line, the getting-started
 * strip, the analysis strip, the liked line's count and the "listen to my
 * music" nudge all fold into that line (DESIGN-PLAN §7.7 M1, A5) and go when
 * they have nothing to say. Under it, the File deck itself (the `inbox`
 * module, handed in as ctx.deck), and Up next as a horizontal strip. With
 * nothing left to file it is the done state and the library bar. Nothing here
 * reads new data: R, LIB, the radar's stored rows, LISTEN and the File queue. */

/** Released in the last two weeks, not in the library, not dismissed: what "new releases" counts. */
export const NEW_RELEASE_DAYS = 14;

/** How many new releases the radar holds (0 until its stored rows are read; reading them is no request). */
export function newReleases({ radar, now }) {
  const R = radar?.R;
  if (!R) return 0;
  if (!R.loaded) { radar.load?.(); return 0; }
  const at = now ?? Date.now(), since = at - NEW_RELEASE_DAYS * 864e5;
  return feedRows(R.rows, { filter: 'unheard', dismissed: R.dismissed ?? new Set(), now: at })
    .filter(r => parseDate(r.releaseDate, r.precision).ts >= since).length;
}

/** "Good morning, Sam": the first word of the Spotify display name, when there is one. */
export function greeting({ LIB, now }) {
  const h = new Date(now ?? Date.now()).getHours();
  const part = h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  const name = String(LIB?.user?.name ?? '').trim().split(/\s+/)[0];
  return name ? `${part}, ${name}` : part;
}

/**
 * Every part of the header's line that has something to say, in order. Each is
 * `{ key, n?, text, go?, act? }`: `go` is the screen it opens, `act` the action.
 * The counts are the same ones the tab badges show (render.js), so a part and
 * the badge of the tab it opens never disagree (§7.7 F4).
 */
export function statusParts(ctx) {
  const { R, LIB, listenStatus } = ctx;
  const parts = [];
  const backlog = R.backlog.length;
  const liked = R.likedIn?.liked ?? LIB?.liked?.length ?? 0;
  // A large first read draws File from its first liked page while the rest comes in
  // (boot.js, BUILD-7 P1): the counts are "so far" until it ends, and the read says how far it is.
  const reading = ctx.reading?.() ?? '';
  if (reading) {
    parts.push({ key: 'file', n: backlog, text: 'to file so far' });
    parts.push({ key: 'reading', text: reading });
  } else {
    parts.push({ key: 'file', n: backlog, text: liked > backlog ? `to file of ${liked.toLocaleString()} liked` : 'to file' });
    const total = R.likedIn?.total;
    if (total != null && total > liked) parts.push({ key: 'short', text: `Spotify has ${total.toLocaleString()} liked: sync again to read the rest`, act: 'opensync' });
  }
  const fresh = newReleases(ctx);
  if (fresh) parts.push({ key: 'radar', n: fresh, text: fresh === 1 ? 'new release' : 'new releases', go: 'discover', side: 'radar' });
  const toTidy = typeof ctx.tidyCount === 'function' ? ctx.tidyCount() : R.within.length + R.misfiled.length;
  parts.push({ key: 'tidy', n: toTidy, text: 'to tidy', go: 'tidy' });
  // While the first analysis runs it says what it is doing (and listening's
  // count is inside it); otherwise listening speaks for itself, and nothing at
  // all is said about it until it has run.
  // The first analysis waits for the whole read, so it has nothing to say until then.
  const analysing = reading ? '' : ctx.analyseLine?.() ?? '';
  const listen = typeof listenStatus === 'function' ? listenStatus() : '';
  if (analysing) parts.push({ key: 'analyse', text: analysing });
  else if (listen) parts.push({ key: 'listen', text: listen, act: 'openlisten' });
  else if (ctx.listenOff?.()) parts.push({ key: 'off', text: 'listening is off', act: 'openlisten' });
  const onb = ctx.onbState?.();
  if (onb) parts.push({ key: 'onb', text: `first ${onb.goal} filed: ${onb.n}/${onb.goal}` });
  const ideas = ctx.ideasCount?.() ?? 0;
  if (ideas) parts.push({ key: 'ideas', n: ideas, text: ideas === 1 ? 'new playlist idea' : 'new playlist ideas', go: 'new' });
  return parts;
}

function partHTML(p, esc) {
  const body = `${p.n != null ? `<b>${p.n.toLocaleString()}</b> ` : ''}${esc(p.text)}`;
  if (p.key === 'analyse') return `<span class="st-analyse" id="analyseStrip" aria-live="polite"><span class="txt">${body}</span></span>`;
  if (p.key === 'listen') return `<button class="st-listen" data-act="openlisten" data-listenstat>${body}</button>`;
  if (p.go) return `<button class="st-${p.key}" data-go="${p.go}"${p.side ? ` data-side="${p.side}"` : ''}>${body}</button>`;
  if (p.act) return `<button class="st-${p.key}" data-act="${p.act}">${body}</button>`;
  return `<span class="st-${p.key}">${body}</span>`;
}

/** The "today" header: a greeting over the one line of status. */
export function statusHTML(ctx) {
  const { esc } = ctx;
  const line = statusParts(ctx).map(p => partHTML(p, esc)).join('<span class="dot" aria-hidden="true">·</span>');
  return `<header class="today" aria-label="Today"><p class="hello">${esc(greeting(ctx))}</p>
    <div class="status" id="fileStatus" role="status">${line}</div></header>`;
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
  return `<div class="seehead"><h2>Up next</h2></div>
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
        <span class="h${strong ? ' sure' : ''}">${best
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
  const { R, LIB, deck } = ctx;
  const head = statusHTML(ctx);
  // A brand-new account: File's own message says what to do; no bar of zeros under it.
  if (!LIB.liked.length && !LIB.playlists.some(p => p.tracks?.length)) return `${head}${deck()}`;
  // Nothing to file: the deck's own done card, then where the library stands.
  if (!R.backlog.length) return `${head}${deck()}${libraryBarHTML(ctx)}`;
  // L1: on a desktop (>=1100px) Up next is a rail beside the card. The wrapper is display:contents below
  // that, so the phone and narrow layouts are exactly what they were.
  const next = upNextHTML(ctx);
  if (!next) return `${head}${coldHTML(ctx)}${deck()}`;
  return `${head}${coldHTML(ctx)}<div class="wide2 filewide"><div class="w-main">${deck()}</div><div class="w-rail">${next}</div></div>`;
}

export const actions = {
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
  // "Spotify has more liked than were read": the sync lives in the Settings sheet.
  opensync: ({ openSettings }) => openSettings?.(true),
  // A card under "Up next" opens the queue on that track, not at the top.
  // Its index is an absolute position in the queue, not an offset from wherever
  // the queue was left.
  goinbox({ S, R, render, morphArt }, el) {
    S.inboxAt = Math.min(+el.dataset.goinbox || 0, Math.max(R.backlog.length - 1, 0));
    // The cover grows into the File card's art where View Transitions exist.
    return morphArt ? morphArt(el.querySelector?.('.cov'), R.backlog[S.inboxAt]?.id, render) : render();
  },
};
