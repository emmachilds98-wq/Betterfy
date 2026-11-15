/** One source card: name, a status pill, one line of what it is for, then its
 *  controls. `state` is ok (working), idle (optional, not set up) or warn. */
function sourceCard(id, name, state, status, line, body) {
  return `<section class="srccard" id="src-${id}" aria-labelledby="src-${id}-h">
    <div class="srchead"><h2 id="src-${id}-h">${name}</h2><span class="tag ${state}">${status}</span></div>
    <p class="srcline">${line}</p>
    ${body}
  </section>`;
}

/** Where genre data and (later) listening come from — moved out of Playlists,
 *  which had grown into two screens in one (UI-BUILD-PLAN R3). Same controls,
 *  same ids, same handlers as before; only the location changed. */
function vSources() {
  const cov = tagCoverage();
  const { base } = playlistMixes();
  const genreShare = base.tracks ? Math.round(base.genre * 100) : null;
  const lfm = LS.getItem('bf_lfm') || '', discogs = LS.getItem('bf_discogs') || '';
  return `<h1>Sources</h1>
    <p class="lede">Where your genre data comes from, and how to fill the gaps.</p>
    <details class="how"><summary>How this works</summary>
      <p>Spotify provides no genre data, so tags come from Last.fm. This page ships a prebuilt set covering many
        artists; the sources below fill in the rest, into this device only. A Last.fm tag always wins; Wikidata and
        Discogs only ever fill an artist with no tags at all. To fix an artist that has tags but has them wrong, tap
        <b>Wrong tags?</b> under it on a Tidy or File row.</p>
      ${genreShare === null ? '' : `<p>Of all the tag weight across your library, <b>${genreShare}%</b> describes a
        sound — the rest is moods, decades, occasions and things like nationality, which are not counted as
        evidence of genre.</p>`}
    </details>
    <p class="srccov"><b class="mono">${cov.have.toLocaleString()}</b> of <span class="mono">${cov.total.toLocaleString()}</span>
      artists have genre tags (${cov.pct}%).${cov.pct < 85 ? ' Suggestions will be thin until this improves.' : ''}</p>

    <div class="srcgrid">
    ${sourceCard('lastfm', 'Last.fm', lfm ? 'ok' : 'idle', lfm ? 'Key saved' : 'No key',
      'Crowd genre tags for the artists the shipped set doesn\'t cover. Needs a free API key.',
      `<div class="rowbtns">
        <input id="lfmKey" placeholder="Last.fm API key" size="34" value="${esc(lfm)}" aria-label="Last.fm API key">
        <button class="b" id="saveLfm">Save key</button>
        <a class="b sm" href="https://www.last.fm/api/account/create" target="_blank" rel="noopener">Get a key</a>
      </div>
      <div class="rowbtns"><button class="b p" id="enrich" ${lfm ? '' : 'disabled'}>Fetch missing tags (${cov.missing.toLocaleString()})</button></div>`)}

    ${sourceCard('wikidata', 'Wikidata', 'ok', 'Free · no key',
      'Genres for about a third of artists, mostly established ones. Runs once by itself after the library loads.',
      `<div class="rowbtns"><button class="b" id="fillWikidata">Fill missing genres free</button></div>`)}

    ${sourceCard('discogs', 'Discogs', discogs ? 'ok' : 'idle', discogs ? 'Token saved' : 'Optional',
      'Styles from an artist\'s own releases, finer than one flat tag. Only fills total gaps, as part of Fetch missing tags.',
      `<div class="rowbtns">
        <input id="discogsKey" placeholder="Discogs personal access token" size="34" value="${esc(discogs)}" aria-label="Discogs personal access token">
        <button class="b" id="saveDiscogs">Save token</button>
        <a class="b sm" href="https://www.discogs.com/settings/developers" target="_blank" rel="noopener">Get a token</a>
      </div>`)}

    <section class="srccard srclisten" id="src-listening" aria-labelledby="src-listening-h">${audioPanelHTML()}</section>${labelCheckHTML()}
    </div>`;
}

function tagCoverage() {
  const ids = new Set();
  for (const p of LIB.playlists) for (const t of p.tracks) for (const a of t.artists ?? []) if (a.id) ids.add(a.id);
  for (const t of LIB.liked) for (const a of t.artists ?? []) if (a.id) ids.add(a.id);
  const have = [...ids].filter(id => TAGS[id]?.tags?.length).length;
  return { total: ids.size, have, missing: ids.size - have, pct: ids.size ? Math.round(100*have/ids.size) : 0 };
}

