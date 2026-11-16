// @bundle screens helpers 41
/* "What's helping your picks" (2026-11-16, emma: every part that makes the
 * engine better should be on, and show as on). One list of every source and
 * engine part, each with whether it is on and what it has done for this
 * account, plus a live check that each one answers right now. The rows are
 * worked out from what the page already holds (web/app/helpers.js gathers it),
 * so drawing the list costs no request; only "Check they all answer" asks
 * anything, one small request per source. Shown at the top of the Settings
 * sheet and of Sources. */

const n = x => (Number.isFinite(x) ? x.toLocaleString('en-GB') : '0');

/**
 * The rows, in the order they matter to filing. `s` is the page's state (any
 * part may be missing): { lib: { playlists, liked }, listening: { artists },
 * cov: { pct, have, total }, lfm: { key, own, asked }, bridge: { on, deezerAsked,
 * deezerPct, wikidataAsked, wikidataPct }, audio: { on, state, heard, reason },
 * deep: { maest, clap }, discogs, engine: { status } }.
 * Each row: { id, name, on, kind: 'ok'|'idle'|'warn'|'off', status, did, optional? }.
 */
export function helperRows(s = {}) {
  const rows = [];
  const lib = s.lib ?? {};
  rows.push({ id: 'spotify', name: 'Your Spotify library', on: true, kind: lib.playlists ? 'ok' : 'idle',
    status: lib.playlists ? 'Read' : 'Not read yet',
    did: lib.playlists ? `${n(lib.playlists)} playlists and ${n(lib.liked)} liked songs, the base everything else builds on.` : 'Read once you sign in.' });
  const la = s.listening?.artists ?? 0;
  rows.push({ id: 'listening-history', name: 'What you play', on: true, kind: la ? 'ok' : 'idle', status: la ? 'On' : 'On · waiting',
    did: la ? `Your top and recent artists (${n(la)}) go first everywhere: tags, sound, Discover.` : 'Your top and recent artists, read with the library.' });
  const cov = s.cov ?? {};
  rows.push({ id: 'shared', name: 'Shared genre table', on: true, kind: 'ok', status: 'On',
    did: cov.total ? `${n(cov.have)} of your ${n(cov.total)} artists have genre tags (${cov.pct}%).` : 'Genre tags shipped with Betterfy.' });
  const lfm = s.lfm ?? {};
  rows.push({ id: 'lastfm', name: 'Last.fm', on: !!lfm.key, kind: lfm.key ? 'ok' : 'off',
    status: !lfm.key ? 'Off' : lfm.own ? 'On · your key' : 'On · built-in key',
    did: lfm.key ? `Crowd genre tags for artists the table misses${lfm.asked ? `; ${n(lfm.asked)} artists asked so far` : ''}. Asked again by itself as your library grows.` : 'Add a key to get crowd genre tags.' });
  const b = s.bridge ?? {};
  rows.push({ id: 'wikidata', name: 'Wikidata', on: true, kind: 'ok', status: 'On · no key',
    did: b.wikidataAsked ? `Genres and MusicBrainz ids: knows ${b.wikidataPct}% of your artists (${n(b.wikidataAsked)} asked).` : 'Genres for untagged artists, asked by itself after the library loads.' });
  rows.push({ id: 'deezer', name: 'Deezer', on: b.on !== false, kind: b.on === false ? 'off' : 'ok', status: b.on === false ? 'Off' : 'On · no key',
    did: `Similar artists${b.deezerAsked ? ` (knows ${b.deezerPct}% of your artists)` : ''}, Discover picks without a key, and the 30-second previews Listening and Discover play.` });
  rows.push({ id: 'listenbrainz', name: 'ListenBrainz', on: b.on !== false, kind: b.on === false ? 'off' : 'ok', status: b.on === false ? 'Off' : 'On · no key',
    did: 'Similar artists from real listening sessions, for artists you have not filed yet and for Discover.' });
  const a = s.audio ?? {};
  const aKind = !a.on ? 'off' : a.problem ? 'warn' : 'ok';
  rows.push({ id: 'sound', name: 'Listening (sound)', on: !!a.on, kind: aKind,
    status: !a.on ? 'Off' : a.problem ? 'On · paused' : a.state === 'running' ? 'On · listening' : 'On',
    did: !a.on ? 'Places tracks by how they sound. Switch it on in Listening.' : a.problem ? `Paused: ${a.problem}` :
      `Places tracks by how they sound against your playlists${a.all ? ', hearing your whole library' : ''}${a.heard ? `; ${n(a.heard)} tracks heard` : ''}.` });
  const d = s.deep ?? {};
  const deepOn = d.maest || d.clap;
  rows.push({ id: 'deep', name: 'Deep listen', on: !!deepOn, kind: !deepOn ? 'off' : d.blocked ? 'idle' : 'ok',
    status: !deepOn ? 'Off' : d.blocked ? `On · ${d.blocked}` : 'On',
    did: `A second, finer ear for genre${d.clap ? ' and “sounds like” search' : ''}. Big one-off download, on Wi-Fi.` });
  rows.push({ id: 'engine', name: 'Learning from your playlists', on: true, kind: s.engine?.status === 'error' ? 'warn' : 'ok',
    status: s.engine?.status === 'ready' ? 'On · learnt' : s.engine?.status === 'error' ? 'Problem' : 'On',
    did: 'Who you file together and where, plus every File and Skip tap, so picks follow your own filing.' });
  // Score + Tune by itself (NEXT-WORKPLAN package 1): the gates and fitted weights decide themselves.
  const au = s.auto ?? {};
  rows.push({ id: 'autoscore', name: 'Checks itself weekly', on: true, kind: au.at && !au.ok ? 'idle' : 'ok',
    status: au.running ? 'On · scoring now' : !au.at ? 'On · first run soon' : !au.ok ? 'On · retrying' : `On · ran ${au.ago ?? 'recently'}`,
    did: `Scores itself on your own filing after listening finishes and every week, and switches on the parts that measure better for you${
      au.at && au.ago ? `; last run ${au.ago}` : ''}. No button to press.` });
  rows.push({ id: 'discogs', name: 'Discogs', on: !!s.discogs, kind: s.discogs ? 'ok' : 'idle', status: s.discogs ? 'On · your token' : 'Optional', optional: true,
    did: 'Release styles for artists nothing else knows. Needs a personal token, so it stays an extra.' });
  return rows;
}

/** "9 of 10 on", counting the optional extras only when they are on. */
export function helperSummary(rows, checks = {}) {
  const core = rows.filter(r => !r.optional || r.on);
  const on = core.filter(r => r.on).length;
  const failed = Object.values(checks ?? {}).filter(c => c && c.ok === false).length;
  const checked = Object.values(checks ?? {}).filter(c => c && c.ok != null).length;
  return `${on} of ${core.length} on${checked ? failed ? ` · ${failed} not answering` : ' · all answering' : ''}`;
}

/** What a live check says, in a few words. */
export function checkWords(c) {
  if (!c) return '';
  if (c.running) return 'checking…';
  if (c.ok) return `answering${Number.isFinite(c.ms) ? ` · ${c.ms} ms` : ''}`;
  if (c.skip) return c.skip;
  return `not answering${c.err ? `: ${c.err}` : ''}`;
}

/** The panel. `checks` are the live results by row id; `running` while a check is out. */
export function helpersHTML(rows, { checks = {}, running = false, at = null, esc = s => String(s ?? '') } = {}) {
  return `<section class="helpers" id="helpers" aria-labelledby="helpers-h">
    <div class="helpers-head"><h3 id="helpers-h">What's helping your picks</h3><span class="tag ok">${esc(helperSummary(rows, checks))}</span></div>
    <ul class="hlist">${rows.map(r => { const c = checks?.[r.id];
      return `<li class="hrow2 h-${r.kind}${c?.ok === false ? ' h-fail' : ''}" data-helper="${esc(r.id)}">
        <span class="hdot" aria-hidden="true"></span>
        <span class="hmain"><span class="hname">${esc(r.name)}</span><span class="hdid">${esc(r.did)}</span>${
          c ? `<span class="hcheck${c.ok === false ? ' bad' : c.ok ? ' good' : ''}">${esc(checkWords(c))}</span>` : ''}</span>
        <span class="tag ${r.kind === 'off' ? 'idle' : r.kind}">${esc(r.status)}</span></li>`; }).join('')}</ul>
    <div class="rowbtns"><button class="b sm" type="button" data-hcheck${running ? ' disabled' : ''}>${running ? 'Checking…' : at ? 'Check again' : 'Check they all answer'}</button>
      <button class="b sm" type="button" data-uhgo="sources">Listening and sources</button></div>
  </section>`;
}
