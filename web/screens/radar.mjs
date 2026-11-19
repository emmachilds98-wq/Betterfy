/* Release Radar: the first section of the Discover tab (docs/RELEASE-RADAR-PLAN.md §6,
 * BUILD-6-PLAN §2.3). Not a screen of its own: discover.mjs imports this module and
 * draws radarView() above "Find new music", and spreads radarActions into its own.
 * Like a screen module it reaches nothing but ctx; ctx.radar comes from
 * web/app/radar.js (the sync job, IndexedDB, filing), and is absent in tests and
 * on a page without it, in which case nothing is drawn.
 *
 * The feed's rules (§4) are all decided upstream, in core/release/: this module
 * only filters, groups and windows the stored rows. What it promises:
 *   - a partial radar is never presented as complete: while a sync runs, or
 *     after one stopped, the status line says how far it got;
 *   - dates are shown as precisely as Spotify gave them, under month headers;
 *   - reissues and the features lane are never in the main chronology;
 *   - owned is a quiet marker, never a filter by default;
 *   - the feed is windowed: PAGE rows at a time, more as you scroll. */
import { parseDate, shortLabel, groupKey, groupLabel, cutoffTs, inWindow } from '../../core/release/dates.mjs';
import { estimate, planTasks } from '../../core/release/plan.mjs';
import { VARIOUS_ARTISTS_ID } from '../../core/release/normalise.mjs';
import { norm } from '../../norm.mjs';

export const PAGE = 60;
export const FILTERS = Object.freeze([
  ['all', 'All'], ['month', 'This month'], ['unheard', 'Unheard'], ['singles', 'Singles'],
  ['albums', 'Albums'], ['features', 'Features'], ['reissues', 'Reissues'],
]);
const FILTER_EMPTY = { all: 'Nothing new in the last two years', month: 'Nothing new this month',
  unheard: 'Nothing unheard', singles: 'No singles', albums: 'No albums', features: 'No features',
  reissues: 'No reissues spotted' };

/** Every distinct credited artist in the library, Various Artists excluded: the radar's set before listening reorders it. */
export function libraryArtists(LIB) {
  const by = new Map();
  const add = a => { if (a?.id && a.id !== VARIOUS_ARTISTS_ID && !by.has(a.id)) by.set(a.id, { id: a.id, name: a.name ?? '' }); };
  for (const p of LIB?.playlists ?? []) for (const t of p?.tracks ?? []) for (const a of t?.artists ?? []) add(a);
  for (const t of LIB?.liked ?? []) for (const a of t?.artists ?? []) add(a);
  return [...by.values()];
}

const ARTISTS = new WeakMap();
/** libraryArtists(), once per library object. */
const artistsOf = LIB => {
  if (!LIB || typeof LIB !== 'object') return [];
  if (!ARTISTS.has(LIB)) ARTISTS.set(LIB, libraryArtists(LIB));
  return ARTISTS.get(LIB);
};

/** The artists the search offers: the library's, plus any the stored rows credit. */
export function searchArtists(LIB, rows) {
  const seen = new Map(artistsOf(LIB).map(a => [a.id, a]));
  for (const r of rows ?? []) for (const a of r.artists ?? []) if (a.id && a.id !== VARIOUS_ARTISTS_ID && !seen.has(a.id)) seen.set(a.id, a);
  return [...seen.values()];
}

/** The cold sync's honest estimate for these artists (core/release/plan.mjs, measured on the simulation). */
export function coldEstimate(artists, now = Date.now()) {
  const e = estimate(planTasks(artists, new Map(), now), { artists: artists.length });
  return { artists: artists.length, ...e };
}

const kindOf = r => r.albumType === 'album' ? 'album' : r.albumType === 'compilation' ? 'compilation'
  : (r.totalTracks ?? 0) >= 4 ? 'ep' : 'single';

/**
 * The rows a filter shows, newest first. `all` is the main lane without
 * reissues; `features` and `reissues` are the only ways those appear.
 * Dismissed (and filed) rows never show. `artistId` narrows to one artist.
 */
export function feedRows(rows, { filter = 'all', artistId = null, dismissed = new Set(), now = Date.now(), years = 2 } = {}) {
  const cut = cutoffTs(now, years);
  const month = groupKey(parseDate(new Date(now).toISOString().slice(0, 10), 'day'));
  return (rows ?? []).filter(r => {
    if (!r || dismissed.has(r.key)) return false;
    const d = parseDate(r.releaseDate, r.precision);
    if (!inWindow(d, cut)) return false;
    if (artistId && !(r.via ?? []).includes(artistId) && !(r.artists ?? []).some(a => a.id === artistId)) return false;
    if (filter === 'features') return r.lane === 'features';
    if (r.lane !== 'main') return false;
    if (filter === 'reissues') return !!r.reissue;
    if (r.reissue) return false;
    if (filter === 'month') return groupKey(d) === month;
    if (filter === 'unheard') return r.owned === 'none';
    if (filter === 'singles') return kindOf(r) === 'single' || kindOf(r) === 'ep';
    if (filter === 'albums') return kindOf(r) === 'album' || kindOf(r) === 'compilation';
    return true;
  }).sort((a, b) => (b.ts - a.ts) || String(a.key).localeCompare(String(b.key)));
}

/** Consecutive rows under their month header: [{ key, label, rows }]. */
export function groupByMonth(rows) {
  const out = [];
  for (const r of rows) {
    const k = groupKey(parseDate(r.releaseDate, r.precision));
    if (out.at(-1)?.key !== k) out.push({ key: k, label: groupLabel(k), rows: [] });
    out.at(-1).rows.push(r);
  }
  return out;
}

/** Type-ahead over the artist set by normalised name: at most `n`, prefix matches first. */
export function artistMatches(artists, q, n = 8) {
  const k = norm(q ?? '');
  if (!k) return [];
  const hits = (artists ?? []).filter(a => norm(a.name).includes(k));
  return hits.sort((a, b) => (norm(b.name).startsWith(k) - norm(a.name).startsWith(k)) || a.name.localeCompare(b.name)).slice(0, n);
}

/** "2 hours ago", "3 days ago", "just now". */
export function ago(ts, now = Date.now()) {
  const s = Math.max(0, (now - ts) / 1000);
  if (s < 90) return 'just now';
  const [n, u] = s < 5400 ? [Math.round(s / 60), 'minute'] : s < 129600 ? [Math.round(s / 3600), 'hour'] : [Math.round(s / 86400), 'day'];
  return `${n} ${u}${n === 1 ? '' : 's'} ago`;
}

const STOP_WORDS = {
  'rate-limit': 'Spotify asked for a pause',
  'signed-out': 'the Spotify sign-in stopped working',
  offline: 'the connection dropped',
  budget: 'it reached today’s request budget',
  aborted: 'you stopped it',
};

/**
 * The one honest status line, and whether the radar may be called complete.
 * `R` is web/app/radar.js's RADAR state.
 */
export function statusLine(R, now = Date.now()) {
  const n = (x) => Number(x ?? 0).toLocaleString('en-GB');
  const ix = R.index;
  if (R.running) {
    const p = R.progress;
    if (!p) return { text: 'Starting…', complete: false };
    return { text: p.phase === 'features'
      ? `Reading features: ${n(p.done)} of ${n(p.total)} checks`
      : `Reading ${n(p.artistsDone)} of ${n(p.artistsTotal)} artists`, complete: false, frac: p.total ? p.done / p.total : 0 };
  }
  if (!ix) return { text: 'Not started', complete: false };
  if (R.stopped || ix.stopped) {
    const st = R.stopped ?? ix.stopped;
    if (st.why === 'budget') return { text: `${n(ix.done)} of ${n(ix.total)} checked · the rest carry on tomorrow (daily request budget)`, complete: false };
    const msg = R.err ? ` (${R.err})` : '';
    return { text: `Stopped after ${n(ix.done)} of ${n(ix.total)} checks: ${STOP_WORDS[st.why] ?? 'it stopped'}${msg}. Start again picks up where it stopped.`,
             complete: false, warn: true };
  }
  if (!ix.coldDone) return { text: `Partly read: ${n(ix.done)} of ${n(ix.total)} checks. Start again to finish.`, complete: false, warn: true };
  return { text: `${n(ix.artists)} artists · last checked ${ago(ix.at, now)}`, complete: true };
}

const pill = (t, cls = '') => `<span class="rr-pill${cls ? ' ' + cls : ''}">${t}</span>`;

function rowHTML(r, { esc, suggest }) {
  const d = parseDate(r.releaseDate, r.precision);
  const k = kindOf(r);
  const pills = [k === 'single' ? pill('Single') : k === 'ep' ? pill('EP') : k === 'compilation' ? pill('Compilation') : '',
    r.lane === 'features' ? pill('Feature') : '',
    r.reissue ? pill(r.reissueBasis === 'isrc' ? 'Reissue' : 'Reissue?', 'rr-re') : ''].join('');
  const owned = r.owned === 'all' ? '<span class="rr-own">owned</span>' : r.owned === 'some' ? '<span class="rr-own">own some</span>' : '';
  const who = (r.artists ?? []).map(a => a.name).join(', ');
  const best = r.lane === 'main' && !r.reissue ? suggest?.(r) : null;
  const art = r.img ? `<img class="rr-art" src="${esc(r.img)}" alt="" loading="lazy" decoding="async" width="56" height="56">`
    : `<span class="rr-art ph" aria-hidden="true"></span>`;
  return `<li class="rr-row" data-key="${esc(r.key)}">
    <a class="rr-open" href="https://open.spotify.com/album/${esc(r.ids?.[0] ?? '')}" target="_blank" rel="noopener">${art}
      <span class="rr-txt"><span class="rr-t">${esc(r.name)}${pills}</span>
        <span class="rr-a">${esc(who)}</span>
        <span class="rr-m"><time datetime="${esc(d.raw)}">${esc(shortLabel(d))}</time>${owned}</span></span></a>
    <span class="rr-acts">
      ${best ? `<button class="b sm rr-file" type="button" data-act="rrFile" data-key="${esc(r.key)}" data-pl="${esc(best.id)}"
          title="${esc(best.why ?? '')}">File → ${esc(best.name)}</button>` : ''}
      <button class="rr-x" type="button" data-act="rrDismiss" data-key="${esc(r.key)}" aria-label="Dismiss ${esc(r.name)}">×</button>
    </span>
  </li>`;
}

/** The account check (F5, BUILD-7 R1): one plain line, and the per-route table behind Details. */
export function probeHTML(R, esc) {
  const P = R?.probe;
  const btn = `<button class="b sm" type="button" data-act="rrProbe"${P?.running ? ' disabled' : ''}>${P?.running ? 'Checking…' : P ? 'Check again' : 'Check it works on this account'}</button>`;
  if (!P || P.running) return `<div class="rr-probe">${btn}</div>`;
  if (P.err) return `<div class="rr-probe"><p class="why">The check couldn’t run: ${esc(P.err)}</p>${btn}</div>`;
  const v = P.verdict ?? { ok: false, missing: [] };
  const line = v.ok ? '<b>Works.</b> Spotify answers everything the radar needs on this account.'
    : '<b>Spotify isn’t sharing new releases with this account right now.</b>';
  // Refused: Check again sits by the line, since it is the way back (BUILD-7 R1 holds the sync).
  return `<div class="rr-probe${v.ok ? ' ok' : ' warn'}" role="status"><p>${line}</p>${v.ok ? '' : `<div class="rowbtns">${btn}</div>`}
    <details class="rr-pdet"><summary>Details</summary>
    ${v.ok ? '' : `<p class="why">Refused: ${v.missing.map(esc).join(', ')}.</p>`}
    <table class="rr-ptab"><tbody>${(P.rows ?? []).map(r => `<tr class="${r.ok ? 'ok' : 'no'}"><td>${esc(r.label)}</td><td class="mono">${esc(r.status)}</td><td>${esc(r.note)}</td></tr>`).join('')}</tbody></table>
    <div class="rowbtns">${v.ok ? btn : ''}<button class="b sm" type="button" data-act="rrProbeCopy">Copy the table</button></div></details></div>`;
}

/** Releases new enough to count on Discover's "New releases" side: the same rule as File's header
 *  (home.mjs newReleases): unheard, main lane, released in the last `days` days, not dismissed. */
export function newReleaseCount(R, now = Date.now(), days = 14) {
  const since = now - days * 864e5;
  return feedRows(R?.rows, { filter: 'unheard', dismissed: R?.dismissed ?? new Set(), now })
    .filter(r => parseDate(r.releaseDate, r.precision).ts >= since).length;
}

/** The whole section. '' when the page gives no radar (tests of the rest of Discover, old builds). */
export function radarView(ctx) {
  const rad = ctx.radar;
  if (!rad) return '';
  const { esc } = ctx;
  const R = rad.R, now = rad.now?.() ?? Date.now();
  const empty = ctx.emptyState ?? ((t, b) => `<p class="why"><b>${t}</b> ${b}</p>`);
  const ib = ctx.infoBtn ?? (() => '');
  const head = `<section class="rr" id="radar" aria-labelledby="rrTitle">
    <h2 id="rrTitle">Release radar${ib('radar', 'Release radar', `<p>New releases by every artist in your playlists, liked songs and listening, newest first, two years back.</p>
      <p>Reissues of records you already own are kept out of the main list (find them under Reissues), and guest spots and remixes sit under Features. Spotify reads one artist at a time, so the first read takes a while; after that only the artists due a check are read again.</p>`)}</h2>`;

  // This account's check found a read the radar needs refused (BUILD-7 R1): the sync is held,
  // and the section says so in one line, with what was refused behind Details.
  const held = !R.running && !!rad.held?.();
  const heldR = held && !(R.probe && (R.probe.running || R.probe.verdict))
    ? { probe: { rows: R.check?.rows ?? [], verdict: { ok: false, missing: R.check?.missing ?? [] } } } : R;
  if (held && !(R.rows ?? []).length) return head + probeHTML(heldR, esc) + '</section>';

  // Never synced: an explainer, one button, an honest estimate.
  if (!R.index && !R.running && !(R.rows ?? []).length) {
    const est = coldEstimate(artistsOf(ctx.LIB), now);
    if (!est.artists) return head + empty('No artists yet', 'Once your library has songs in it, the radar can follow their artists.', { compact: true }) + '</section>';
    // It starts by itself (owner, 2026-11-18): one button to start sooner. The account check is
    // only offered after a read went wrong, or once it has been run, to say what Spotify refused.
    const auto = rad.auto?.() ?? true;
    const when = auto ? 'It starts by itself a minute or two after Betterfy opens. ' : 'Off on this device since you pressed Stop. ';
    return head + `<p class="lede">New releases from the ${est.artists.toLocaleString('en-GB')} artists in your library, newest first.</p>
      <div class="rr-start">
        <p>${when}The first read asks Spotify about each artist in turn: about <b>${est.minutes} minute${est.minutes === 1 ? '' : 's'}</b>. You can keep using the app, and what has been read shows as it arrives.</p>
        <div class="rowbtns"><button class="b${auto ? '' : ' p'}" type="button" data-act="rrStart" id="rrStart">${auto ? 'Start now' : 'Start the radar'}</button></div>
        ${R.err || R.probe ? probeHTML(R, esc) : ''}
      </div></section>`;
  }

  const st = statusLine(R, now);
  const status = `<div class="rr-status${st.warn ? ' warn' : ''}" role="status">
      <span class="rr-line" id="rrLine">${esc(st.text)}</span>
      ${R.running ? `<button class="b sm" type="button" data-act="rrStop">Stop</button>`
        : `<button class="b sm" type="button" data-act="rrStart" id="rrStart">${st.complete ? 'Check again' : 'Start again'}</button>`}
      ${R.running ? `<span class="rr-prog" aria-hidden="true"><i style="width:${((st.frac ?? 0) * 100).toFixed(1)}%"></i></span>` : ''}
    </div>`;

  const filter = R.filter ?? 'all';
  const chips = `<div class="rr-chips" role="group" aria-label="Show">${FILTERS.map(([id, label]) =>
    `<button class="chip${filter === id ? ' on' : ''}" type="button" data-act="rrFilter" data-f="${id}" aria-pressed="${filter === id}">${label}</button>`).join('')}</div>`;

  const artists = searchArtists(ctx.LIB, R.rows);
  const pinned = R.artist ? artists.find(a => a.id === R.artist) ?? { id: R.artist, name: 'that artist' } : null;
  const matches = pinned ? [] : artistMatches(artists, R.q);
  const search = `<div class="rr-search">
      <input id="rrSearch" type="search" autocomplete="off" placeholder="Find an artist" aria-label="Find an artist" value="${esc(R.q ?? '')}">
      ${matches.length ? `<div class="rr-hits">${matches.map(a => `<button class="chip" type="button" data-act="rrArtist" data-id="${esc(a.id)}">${esc(a.name)}</button>`).join('')}</div>` : ''}
      ${pinned ? `<div class="rr-hits"><button class="chip on" type="button" data-act="rrArtistClear" aria-label="Show every artist again">${esc(pinned.name)} ×</button>
        <button class="b sm" type="button" data-act="rrOlder" data-id="${esc(pinned.id)}" ${R.running ? 'disabled' : ''}>Read older releases</button></div>` : ''}
    </div>`;

  const opts = { filter, artistId: R.artist, dismissed: R.dismissed ?? new Set(), now, years: R.artist && R.olderFor?.has(R.artist) ? 60 : 2 };
  const rows = feedRows(R.rows, opts);
  const shown = rows.slice(0, R.shown ?? PAGE);
  const sugg = rad.suggest;
  let feed;
  if (!rows.length) {
    if (R.running && !(R.rows ?? []).length) feed = (ctx.skeleton?.('row', 4) ?? '');
    else if (filter !== 'all' || R.artist) feed = empty(FILTER_EMPTY[filter] + (R.artist ? ` for ${pinned?.name ?? 'this artist'}` : filter === 'month' ? '' : ' in the last two years'),
      '', { compact: true, acts: `<button class="b sm" type="button" data-act="rrFilter" data-f="all" data-clear="1">Show everything</button>` });
    else feed = empty(st.complete ? `Nothing new since ${new Date(R.index.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}` : 'Nothing found yet',
      st.complete ? 'No artist in your library has released anything in the last two years.' : 'Releases appear here as artists are read.', { compact: true });
  } else {
    feed = `<ol class="rr-feed">${groupByMonth(shown).map(g => `<li class="rr-group"><h3 class="rr-month">${esc(g.label)}</h3>
        <ul class="rr-rows">${g.rows.map(r => rowHTML(r, { esc, suggest: sugg })).join('')}</ul></li>`).join('')}</ol>
      ${rows.length > shown.length ? `<button class="b rr-more" type="button" data-act="rrMore" id="rrMore">Show more (${(rows.length - shown.length).toLocaleString('en-GB')} left)</button>` : ''}`;
  }
  // The features lane is the Features chip only (C5): the fold under All showed the same rows.
  const partial = !st.complete && rows.length ? `<p class="rr-partial">Not the whole radar yet: ${R.running ? 'still reading' : 'some artists are still to be read'}.</p>` : '';
  const count = `<p class="rr-count vh" aria-live="polite">${rows.length.toLocaleString('en-GB')} release${rows.length === 1 ? '' : 's'}</p>`;
  return head + status + (held || R.probe || (R.err && !R.running) ? probeHTML(heldR, esc) : '') + chips + search + count + partial + feed + '</section>';
}

export const radarActions = {
  rrStart: ({ radar }) => radar?.start(),
  rrStop: ({ radar }) => radar?.stop(),
  rrProbe: ({ radar }) => radar?.probe?.(),
  rrProbeCopy: ({ radar }) => radar?.probeCopy?.(),
  rrFilter({ radar, render }, el) {
    if (!radar) return;
    radar.R.filter = el.dataset.f || 'all';
    if (el.dataset.clear) { radar.R.artist = null; radar.R.q = ''; }
    radar.R.shown = PAGE;
    render();
  },
  rrArtist({ radar, render }, el) { if (!radar) return; radar.R.artist = el.dataset.id; radar.R.q = ''; radar.R.shown = PAGE; render(); },
  rrArtistClear({ radar, render }) { if (!radar) return; radar.R.artist = null; radar.R.shown = PAGE; render(); },
  rrMore({ radar, render }) { if (!radar) return; radar.R.shown = (radar.R.shown ?? PAGE) + PAGE; render(); },
  rrOlder: ({ radar }, el) => radar?.start({ deep: { ids: [el.dataset.id], years: 60 } }),
  rrDismiss: ({ radar }, el) => radar?.dismiss(el.dataset.key),
  rrFile: ({ radar }, el) => radar?.file(el.dataset.key, el.dataset.pl),
};

/** After paint: type-ahead on the search field, and more rows as the end comes into view. */
export function radarMount(ctx) {
  const rad = ctx.radar;
  if (!rad) return;
  rad.load?.();
  const doc = ctx.document ?? globalThis.document;
  const input = doc?.getElementById?.('rrSearch');
  if (input && !input.dataset.bound) {
    input.dataset.bound = '1';
    input.addEventListener('input', () => { rad.R.q = input.value; if (rad.R.artist) rad.R.artist = null; ctx.render(); });
  }
  const more = doc?.getElementById?.('rrMore');
  if (more && globalThis.IntersectionObserver && !more.dataset.bound) {
    more.dataset.bound = '1';
    const io = new IntersectionObserver(es => {
      if (es.some(e => e.isIntersecting)) { io.disconnect(); rad.R.shown = (rad.R.shown ?? PAGE) + PAGE; ctx.render(); }
    }, { rootMargin: '400px' });
    io.observe(more);
  }
}
