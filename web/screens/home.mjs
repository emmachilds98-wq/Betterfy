// @bundle screens home 10
/** Icons for the four things Home offers to do, matched to the tab bar. */
const ACT_IC = {
  inbox: '<path d="M3 13.5h4.5l1.7 2.6h5.6l1.7-2.6H21"/><path d="M5.2 4.5h13.6l2.2 9v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4z"/>',
  tidy: '<rect x="8.5" y="8.5" width="12" height="12" rx="2.5"/><path d="M15.5 4.5H6a2.5 2.5 0 0 0-2.5 2.5v9.5"/>',
  discover: '<circle cx="12" cy="12" r="8.8"/><path d="m15.4 8.6-2 4.8-4.8 2 2-4.8z"/>',
  shuffle: '<path d="M17 4.5 20.5 7 17 9.5"/><path d="M17 14.5 20.5 17 17 19.5"/><path d="M3.5 7h3.2c1.2 0 2.3.6 3 1.6l4.6 6.8c.7 1 1.8 1.6 3 1.6h3.2"/><path d="M3.5 17h3.2c1.2 0 2.3-.6 3-1.6l.9-1.3"/><path d="M14.4 9.9l.9-1.3c.7-1 1.8-1.6 3-1.6h2.2"/>',
};
ACT_IC.heard = '<path d="M5 14.5v4"/><path d="M9.5 9.5v9"/><path d="M14 5v13.5"/><path d="M18.5 10.5v8"/>';
const actIcon = v => `<span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ACT_IC[v]}</svg></span>`;

/** "Evening" rather than a clock: the greeting is a tone, not a timestamp. */
export function partOfDay(d = new Date()) {
  const h = d.getHours();
  return h < 5 ? 'Late night' : h < 12 ? 'Morning' : h < 18 ? 'Afternoon' : 'Evening';
}

export function view(ctx) {
  const { S, R, LIB, esc, isMirrorPlaylist, listenEverRan, listenHeard, listenTarget, tagCoverage,
          analyseHTML, VHUE, HEARD_HUE, hueOf, filePicks } = ctx;
  const exact = R.within.filter(x => x.verdict === 'same-recording').length;
  const clash = R.within.length - exact;
  const uniq = new Set(); let placements = 0;
  for (const p of LIB.playlists) { if (isMirrorPlaylist(p)) continue;
    for (const t of p.tracks) { uniq.add(t.id); placements++; } }

  const backlog = R.backlog.length;
  const toTidy = R.within.length + R.misfiled.length;
  const found = (S.discover ?? []).length;
  const shufflable = LIB.playlists.filter(p => p.tracks.length >= 8).length;
  const first = String(LIB.user?.name ?? '').trim().split(/\s+/)[0] ?? '';
  const name = (!first.includes('@') && first.length <= 18) ? first : '';

  // The four cards are the four screens, in the order you would work them.
  const acts = [
    ['inbox', backlog, 'likes with no home', 'File them one at a time, each with a suggested playlist.'],
    ['tidy', toTidy, 'things to tidy', 'Repeats, version clashes and tracks filed in the wrong place.'],
    ['discover', found, found ? "records you don't own" : 'nothing found yet',
      found ? 'Built from what you actually played, minus everything you have.' : 'Run a search: weighted by what you played, minus what you own.'],
    ['shuffle', shufflable, 'playlists to re-order', 'Spacing that keeps the same artist from clumping.'],
  ];
  // A fifth card once listening has ever run, and never before: a listener who
  // never turns it on gets the same four cards, byte for byte.
  if (listenEverRan()) acts.push(['heard', listenHeard(), listenHeard() === 1 ? 'track heard' : 'tracks heard',
    'Previews listened to on this device, to place tracks by how they sound.']);

  // Where the library sits, as one bar over one population: your liked songs.
  // It used to mix three that came from different ones — liked-and-filed,
  // cross-filing measured across the whole library, and a Tidy total that had
  // already counted some of the same tracks twice — so the segments could sum
  // to more than the library, and "Filed" clamped to zero on any library with
  // much to tidy.
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
  const cov = tagCoverage();
  const upNext = R.backlog.slice(0, 4);

  return `<div class="hero">
      <div class="in">
        <div class="txt">
          <div class="when">${esc(partOfDay())}${LIB.captured_at ? ' · synced ' + esc(LIB.captured_at.slice(0, 10)) : ''}</div>
          <h1>${esc(partOfDay())}${name ? ', ' + esc(name) : ''}. ${backlog
            ? `${backlog.toLocaleString()} liked ${backlog === 1 ? 'song' : 'songs'} still ${backlog === 1 ? 'needs' : 'need'} a home.`
            : 'Your library is in good shape.'}</h1>
          <p>Nothing is written to Spotify until you tap something — and every change can be undone.</p>
        </div>
        <div class="tile">
          <svg viewBox="0 0 32 32" aria-hidden="true">
            <rect x="7.75" y="4.9" width="7" height="3.4" rx="1.7" style="fill:var(--m0)"/>
            <rect x="7.75" y="9.6" width="12" height="3.4" rx="1.7" style="fill:var(--m1)"/>
            <rect x="7.75" y="14.3" width="16.5" height="3.4" rx="1.7" style="fill:var(--m2)"/>
            <rect x="7.75" y="19" width="12" height="3.4" rx="1.7" style="fill:var(--m3)"/>
            <rect x="7.75" y="23.7" width="7" height="3.4" rx="1.7" style="fill:var(--m4)"/>
          </svg>
        </div>
      </div>
    </div>

    ${analyseHTML()}

    <div class="acts4${acts.length > 4 ? ' five' : ''}">${acts.map(([v, n, label, desc]) => `
      <button class="act" data-go="${v === 'heard' ? listenTarget() : v}"${v === 'heard' ? ' data-heard' : ''} style="--ac:var(--${VHUE[v] ?? HEARD_HUE}); --ac-ink:var(--${VHUE[v] ?? HEARD_HUE}-ink)">
        ${actIcon(v)}
        <span class="n">${n.toLocaleString()}</span>
        <span class="l">${esc(label)}</span>
        <span class="d">${esc(desc)}</span>
      </button>`).join('')}</div>

    <div class="split">
      <div class="panel">
        <div class="ph">
          <h2>Where your library sits</h2>
          <span class="mono">${uniq.size.toLocaleString()} tracks · ${LIB.playlists.length} playlists</span>
        </div>
        <div class="bar">${seg.map(([, n, c]) =>
          `<i style="width:${(100 * n / tot).toFixed(2)}%; background:var(--${c})"></i>`).join('')}</div>
        <div class="key">${seg.map(([l, n, c]) =>
          `<span><i style="background:var(--${c})"></i>${esc(l)} <b>${n.toLocaleString()}</b></span>`).join('')}</div>
      </div>
      <div class="panel">
        <h2 style="margin:0 0 16px">Your library</h2>
        <div class="facts">
          <div><span>Liked songs</span><b class="mono">${liked.toLocaleString()}</b></div>
          <div><span>Placements</span><b class="mono">${placements.toLocaleString()}</b></div>
          <div><span>Exact repeats</span><b class="mono">${exact.toLocaleString()}</b></div>
          <div><span>Version clashes</span><b class="mono">${clash.toLocaleString()}</b></div>
          <div><span>Genre coverage</span><b class="mono">${cov.pct}%</b></div>
          <hr>
          <p>Genre comes from Last.fm — Spotify stopped providing it. Top yours up under Sources.</p>
        </div>
      </div>
    </div>

    ${upNext.length ? `<div class="seehead">
      <h2 style="margin:0">Next up to file</h2>
      <button class="more" data-go="inbox">Open the queue →</button>
    </div>
    <div class="upnext">${upNext.map((t, i) => {
      const best = (filePicks ? filePicks(t) : t.suggest ?? [])[0];
      const strong = best && best.score >= 0.7;
      const h = hueOf(t.id ?? t.title ?? '');
      const cover = t.art
        ? `<img class="cov" src="${esc(t.art)}" alt="" loading="lazy" decoding="async">`
        : `<span class="cov" style="background:linear-gradient(150deg,hsl(${h} 62% 56%),hsl(${(h + 48) % 360} 58% 44%))">${esc((t.title || '?').trim()[0] ?? '?')}</span>`;
      return `<button class="u" data-act="goinbox" data-goinbox="${i}" title="${esc(t.title)} — ${esc(t.artist)}">${cover}<span class="bd">
        <span class="t">${esc(t.title)}</span>
        <span class="a">${esc(t.artist)}</span>
        <span class="h" style="color:var(--${strong ? 'ok' : 'accent'})">${best
          ? `→ ${esc(best.name)} ${(best.score * 100).toFixed(0)}%` : '→ no confident pick'}</span>
      </span></button>`;
    }).join('')}</div>` : ''}`;
}


export const actions = {
  analyseGo: ({ analyseGo }) => analyseGo(),
  // A card under "Next up to file" opens the queue on that track, not at the top.
  // Its index is an absolute position in the queue, not an offset from wherever
  // the queue was left.
  goinbox({ S, R, go }, el) {
    S.inboxAt = Math.min(+el.dataset.goinbox || 0, Math.max(R.backlog.length - 1, 0));
    return go('inbox');
  },
};
