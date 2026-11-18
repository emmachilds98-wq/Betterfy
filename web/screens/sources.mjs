// @bundle screens sources 40
/** One source card: name, a status pill, one line of what it is for, then its
 *  controls. `state` is ok (working), idle (optional, not set up) or warn. */
function sourceCard(id, name, state, status, line, body) {
  return `<section class="srccard" id="src-${id}" aria-labelledby="src-${id}-h">
    <div class="srchead"><h2 id="src-${id}-h">${name}</h2><span class="tag ${state}">${status}</span></div>
    <p class="srcline">${line}</p>
    ${body}
  </section>`;
}

/**
 * How much each source knows about this account's own artists (BUILD-6 H1,
 * SMARTER-GENRES §6): "Deezer knows N%, Wikidata M%, shared table K%". Worked
 * out on this device from what the page already holds, so a source that is
 * thin for one account's taste shows up as thin for that account, and nothing
 * is sent anywhere to get it.
 *
 *   ids      the account's artist ids (playlists and liked songs)
 *   shipped  the shared table as downloaded: id -> tags (either shape)
 *   extra    tags_extra: id -> { source, tags }  (only `source` and `tags.length` are read)
 *   bridge   bridge-raw's entries: id -> { deezerId, deezerAt, mbid, mbidAt }
 *
 * A source counts as knowing an artist when it answered with something:
 * Deezer found the artist (its related-artists list hangs off that); Wikidata
 * gave genres or a MusicBrainz id. `asked` is how many it has been asked
 * about, since a source never asked has not said it does not know.
 */
export function artistCoverage({ ids = [], shipped = {}, extra = {}, bridge = {} } = {}) {
  const all = [...new Set(ids)];
  const n = all.length;
  const tagsOf = e => (Array.isArray(e) ? e : e?.tags) ?? [];
  let shared = 0, deezer = 0, deezerAsked = 0, wikidata = 0, wikidataAsked = 0;
  for (const id of all) {
    if (tagsOf(shipped?.[id]).length) shared++;
    const b = bridge?.[id], x = extra?.[id];
    if (Number.isFinite(b?.deezerAt)) { deezerAsked++; if (b.deezerId) deezer++; }
    const wdGenres = x?.source === 'wikidata';
    if (Number.isFinite(b?.mbidAt) || wdGenres) {
      wikidataAsked++;
      if (b?.mbid || (wdGenres && tagsOf(x).length)) wikidata++;
    }
  }
  const pct = k => (n ? Math.round(100 * k / n) : 0);
  return { total: n, shared, deezer, wikidata, deezerAsked, wikidataAsked,
           sharedPct: pct(shared), deezerPct: pct(deezer), wikidataPct: pct(wikidata) };
}

/** The coverage card's body: one sentence, then what has not been asked yet.
 *  Nothing to count (not read yet, or no artists): '' and no card at all, so
 *  the screen is byte-identical to what it was before the card existed. */
export function coverageHTML(cov) {
  if (!cov?.total) return '';
  const part = (name, pct, asked) => asked ? `${name} knows <b class="mono">${pct}%</b>` : `${name} <b>not asked yet</b>`;
  const unasked = [['Deezer', cov.deezerAsked], ['Wikidata', cov.wikidataAsked]]
    .filter(([, k]) => k && k < cov.total).map(([name, k]) => `${name} about ${k.toLocaleString()}`);
  return `<p class="srcline srcknow">${part('Deezer', cov.deezerPct, cov.deezerAsked)}, ${part('Wikidata', cov.wikidataPct, cov.wikidataAsked)},
      the shared tag list <b class="mono">${cov.sharedPct}%</b> of your <span class="mono">${cov.total.toLocaleString()}</span> artists.</p>
    ${unasked.length ? `<p class="srcline sub">Asked so far: ${unasked.join(', ')}. The rest are looked up as File, Score and Discover need them.</p>` : ''}`;
}

/** The Listening section's body: the one panel (on/off, Wi-Fi rule, scope, Deep listen), then the label check. */
export function listeningHTML({ audioPanelHTML = () => '', labelCheckHTML = () => '' }) {
  return `<div class="srclisten" id="src-listening">${audioPanelHTML()}</div>${labelCheckHTML()}`;
}

/** The sources section's body (Settings > What's helping your picks): every source with its live
 *  check, then what each knows about this account and the two that take a key. */
export function sourcesHTML({ LS, esc, lfmKey, sourceCoverage = () => null, helpersPanelHTML = () => '' }) {
  const lfmOwn = LS.getItem('bf_lfm') || '', lfm = lfmOwn || lfmKey() || '', discogs = LS.getItem('bf_discogs') || '';
  const cov = (body => body ? sourceCard('coverage', 'Your artists', 'ok', 'This account',
      'How much each source knows about the artists in your own library, worked out on this device.', body) : '')(
      coverageHTML((d => d && artistCoverage(d))(sourceCoverage())));
  return `${helpersPanelHTML({ bare: true })}
    <div class="srcgrid">
    ${cov}${sourceCard('lastfm', 'Last.fm', lfm ? 'ok' : 'idle', lfmOwn ? 'On · your key' : lfm ? 'On · built-in key' : 'Off',
      'Crowd genre tags for the artists the shipped set doesn\'t cover. '
        + (!lfmOwn && lfm ? 'On for everyone with Betterfy\'s built-in key, and asked by itself every time Betterfy opens, most-played artists first. Your own key is optional.' : lfm ? 'Asked by itself every time Betterfy opens, most-played artists first.' : 'Needs a free API key.'),
      `<div class="rowbtns"><button class="b" type="button" data-lfmconnect>${lfmOwn ? 'Change key' : lfm ? 'Use my own key' : 'Connect Last.fm'}</button>
        <button class="b sm" id="enrich" data-act="enrich" ${lfm ? '' : 'disabled'}>Ask again now</button></div>`)}

    ${sourceCard('discogs', 'Discogs', discogs ? 'ok' : 'idle', discogs ? 'Token saved' : 'Optional',
      'Styles from an artist\'s own releases, finer than one flat tag. Only fills gaps Last.fm leaves, as part of the same start-up check.',
      `<div class="rowbtns">
        <input id="discogsKey" placeholder="Discogs personal access token" size="34" value="${esc(discogs)}" aria-label="Discogs personal access token">
        <button class="b" id="saveDiscogs" data-act="saveDiscogs">Save token</button>
        <a class="b sm" href="https://www.discogs.com/settings/developers" target="_blank" rel="noopener">Get a token</a>
      </div>`)}
    </div>`;
}

/** The whole of what used to be the Sources screen. The Settings sheet draws the same parts as three
 *  sections (Listening, What's helping your picks, Your data); this stays for the tests and as one page. */
export function view({ infoBtn = () => '', LS, esc, lfmKey, tagCoverage, playlistMixes, audioPanelHTML, labelCheckHTML,
                       sourceCoverage = () => null, helpersPanelHTML = () => '', ...rest }) {
  const cov = tagCoverage();
  const { base } = playlistMixes();
  const genreShare = base.tracks ? Math.round(base.genre * 100) : null;
  return `<h1>Sources</h1>
    <p class="lede">Where your genre data comes from.${infoBtn('sources', 'Genre sources', `<p>Spotify provides no genre data, so tags come from Last.fm and Wikidata, and, once Listening is on, from how your tracks sound. This page ships a prebuilt set covering many
        artists; the sources below fill in the rest, into this device only. A Last.fm tag always wins; Wikidata and
        Discogs only ever fill an artist with no tags at all. To fix an artist that has tags but has them wrong, tap
        <b>Wrong tags?</b> under it on a Tidy or File row.</p>
      ${genreShare === null ? '' : `<p>Of all the tag weight across your library, <b>${genreShare}%</b> describes a
        sound — the rest is moods, decades, occasions and things like nationality, which are not counted as
        evidence of genre.</p>`}`)}</p>
    <p class="srccov"><b class="mono">${cov.have.toLocaleString()}</b> of <span class="mono">${cov.total.toLocaleString()}</span>
      artists have genre tags (${cov.pct}%).${cov.pct < 85 ? ' Suggestions will be thin until this improves.' : ''}</p>
    ${sourcesHTML({ LS, esc, lfmKey, sourceCoverage, helpersPanelHTML })}
    ${listeningHTML({ audioPanelHTML, labelCheckHTML })}${rest.DATA_KEYS ? '\n    ' + yourDataHTML({ esc, ...rest }) : ''}`;
}

const WHERE = { local: 'This browser', idb: 'This browser (database)', 'idb-db': 'This browser (database)', firestore: 'Firestore' };

/** The restore preview, progress or outcome, by stage. */
function restoreHTML(BK, esc) {
  if (BK.stage === 'preview') {
    const picked = BK.plan.filter(r => r.pick);
    const exist = BK.plan.filter(r => r.exists).length;
    return `<div class="bkprev" aria-live="polite">
      <p class="srcline"><b>${esc(BK.file)}</b>: ${BK.plan.length} playlist${BK.plan.length === 1 ? '' : 's'}${exist ? `, ${exist} of which you still have (left unticked; ticking one makes a new copy named “… (restored)”, the one you have is not touched)` : ''}.</p>
      <ul class="bklist">${BK.plan.map(r => `<li><label><input type="checkbox" data-act="bkPick" data-i="${r.i}" ${r.pick ? 'checked' : ''}>
        <span class="bkname">${esc(r.name)}</span> <span class="sub mono">${r.n.toLocaleString()} track${r.n === 1 ? '' : 's'}</span>${r.exists ? ' <span class="tag warn">already exists</span>' : ''}</label></li>`).join('')}</ul>
      <div class="rowbtns"><button class="b p" type="button" data-act="bkGo" ${picked.length ? '' : 'disabled'}>Restore ${picked.length} as private playlist${picked.length === 1 ? '' : 's'}</button>
        <button class="b" type="button" data-act="bkCancel">Cancel</button></div>
    </div>`;
  }
  if (BK.stage === 'working') return `<p class="srcline bkprog" aria-live="polite">${esc(BK.progress)}</p>`;
  const made = BK.result?.made ?? [];
  const summary = made.length ? `<ul class="bklist">${made.map(m => `<li><span class="bkname">${esc(m.name)}</span>
      <span class="sub mono">${m.added.toLocaleString()} of ${m.n.toLocaleString()}${m.byIsrc ? ` · ${m.byIsrc} found by ISRC` : ''}${m.missing ? ` · ${m.missing} not found` : ''}</span></li>`).join('')}</ul>
      <div class="rowbtns"><button class="b" type="button" data-act="bkUndo">Undo this restore</button></div>` : '';
  if (BK.stage === 'done') return `<div class="bkprev" aria-live="polite"><p class="srcline">Restored ${made.length} playlist${made.length === 1 ? '' : 's'}, private. They show in Library after the next library read.</p>${summary}</div>`;
  if (BK.stage === 'error') return `<div class="bkprev" aria-live="polite"><p class="srcline bkerr">${esc(BK.error)}</p>${summary}</div>`;
  return '';
}

/** Settings › Your data: backup and restore, every key kept and why, who hears what, and the wipe (BUILD-6 F7/F8). */
export function yourDataHTML({ esc, BK = { stage: 'idle' }, DATA_KEYS = [], DATA_SERVICES = [], myPlaylists = () => 0, bare = false }) {
  const groups = new Map();
  for (const k of DATA_KEYS) (groups.get(k.group) ?? groups.set(k.group, []).get(k.group)).push(k);
  const n = myPlaylists();
  return `<section class="yourdata${bare ? ' bare' : ' srccard'}" id="src-data"${bare ? '' : ' aria-labelledby="src-data-h"'}>
    ${bare ? '' : '<div class="srchead"><h2 id="src-data-h">Your data</h2><span class="tag ok">On this device</span></div>'}
    <p class="srcline">What Betterfy keeps lives in this browser. Nothing from your library is pooled with other accounts or uploaded anywhere
      except to the services listed below, and only for the reason given.</p>

    <h3 class="bkh">Back up and restore your playlists</h3>
    <p class="srcline">The backup is a file of your ${n ? n.toLocaleString() + ' ' : ''}playlists: names, descriptions, track ids, ISRCs and dates added.
      It is saved to this device and goes nowhere else. Restoring makes new private playlists from it and never changes one you have.</p>
    <div class="rowbtns"><button class="b p" type="button" data-act="bkSave" ${n ? '' : 'disabled'}>Back up my playlists</button>
      <label class="b bkpick">Restore from a backup…<input type="file" id="bkFile" accept=".json,application/json" class="vh"></label></div>
    ${restoreHTML(BK, esc)}

    <details class="bkkeys"><summary>What is kept, and why (${DATA_KEYS.length})</summary>
      ${[...groups].map(([g, ks]) => `<h4>${esc(g)}</h4><dl>${ks.map(k => `<dt>${esc(k.name ?? k.key)} <span class="sub">${WHERE[k.where] ?? esc(k.where)}</span></dt><dd>${esc(k.why)}</dd>`).join('')}</dl>`).join('')}
    </details>
    <details class="bkkeys"><summary>Who hears from Betterfy (${DATA_SERVICES.length})</summary>
      <dl>${DATA_SERVICES.map(s => `<dt>${esc(s.name)}</dt><dd>${esc(s.what)}</dd>`).join('')}</dl>
    </details>

    <h3 class="bkh">Wipe this device</h3>
    ${BK.wipe ? `<div class="bkwipe" role="alert"><p class="srcline">This removes everything Betterfy keeps in this browser: your sign-in, the library copy,
        History, skips, tags, engine and listening data. Only your theme stays. Your Spotify playlists are not touched, and a device you linked
        keeps its own copy.</p>
      <div class="rowbtns"><button class="b danger" type="button" data-act="wipeGo">Wipe everything</button>
        <button class="b" type="button" data-act="wipeNo">Cancel</button></div></div>`
      : `<p class="srcline">Signs you out and clears every key above from this browser, except the theme.</p>
      <div class="rowbtns"><button class="b" type="button" data-act="wipeAsk">Wipe this device…</button></div>`}
  </section>`;
}

export const actions = {
  saveDiscogs(c) {
    const v = c.$('#discogsKey').value.trim();
    if (v) { c.LS.setItem('bf_discogs', v); c.toast('Token saved.'); }
    else { c.LS.removeItem('bf_discogs'); c.toast('Token cleared.'); }
    c.render();
  },
  /** Normally all of this runs by itself at every start (boot.js); the button is only a re-ask now. */
  async enrich(c) { try { await c.fillFromWikidata?.({ quiet: true }); } catch { /* Last.fm still asks */ } return c.enrichMissing(); },
  bkSave: c => c.backupDownload(),
  bkPick(c, el) { const r = c.BK.plan?.[+el.dataset.i]; if (r) r.pick = el.checked; c.render(); },
  bkGo: c => c.restoreGo(),
  bkCancel: c => c.restoreCancel(),
  bkUndo: c => c.restoreUndo(),
  wipeAsk(c) { c.BK.wipe = true; c.render(); },
  wipeNo(c) { c.BK.wipe = false; c.render(); },
  wipeGo: c => c.wipeThisDevice(),
};
