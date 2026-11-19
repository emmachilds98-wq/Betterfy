/* ---------- genres with no key at all: docs/SMARTER-GENRES-PLAN.md §4.1(c) ----------
 * An artist with no tags gives today's engine nothing to file by, and for an
 * account outside the shipped table with no Last.fm key that is most of them.
 * Wikidata links ~71,000 artists to their Spotify id, knows genres for about a
 * third of the owner's artists (measured: 1,631 of 4,866), answers 300 at a time,
 * needs no key and is CORS-open. It knows established artists far better than
 * scene producers, so it fills gaps rather than replacing anything: only artists
 * with no tags at all, never a corrected one, and Last.fm still wins when asked.
 * Not offered to the shared table either — that takes Last.fm's answers only. */
const untaggedArtists = () => {
  const out = new Map();
  const add = t => { for (const a of t?.artists ?? []) if (a?.id && !(TAGS?.[a.id]?.tags?.length)) out.set(a.id, a.name); };
  for (const p of LIB?.playlists ?? []) for (const t of p.tracks ?? []) add(t);
  for (const t of LIB?.liked ?? []) add(t);
  return out;
};

/* The share of this account's artists Wikidata knew before W1's fills ran, kept once on this
 * device so Settings and the Score report can say "knows X% (was Y%)". */
const WD_BASE_KEY = 'bf_wd_base';
async function noteWikidataBaseline() {
  try {
    if (LS.getItem(WD_BASE_KEY)) return;
    await loadSourceCoverage();
    const c = SRC_COV.data ? SCREEN_MODS.sources.artistCoverage(SRC_COV.data) : null;
    if (c?.total) LS.setItem(WD_BASE_KEY, JSON.stringify({ pct: c.wikidataPct, at: Date.now() }));
  } catch { /* no baseline: the row shows only the current share */ }
}

/** What Wikidata knows of this account's artists now, and what it knew before (null until measured). */
function wikidataKnows() {
  try {
    const c = SRC_COV?.data ? SCREEN_MODS.sources.artistCoverage(SRC_COV.data) : null;
    if (!c?.total || !c.wikidataAsked) return null;
    let was = null; try { was = JSON.parse(LS.getItem(WD_BASE_KEY))?.pct ?? null; } catch { /* none kept */ }
    return { pct: c.wikidataPct, was, asked: c.wikidataAsked, total: c.total, musicbrainz: c.musicbrainz ?? 0 };
  } catch { return null; }
}

/* Artists Wikidata could not be asked (429, resting) are not written down as asked, so
 * the next run has them; this also asks again by itself once the rest is over, a few
 * times per visit, only while the tab is showing. */
const WD_LATER = { timer: 0, tries: 0 };
function wikidataRetryLater() {
  if (WD_LATER.timer || WD_LATER.tries >= 3 || typeof setTimeout !== 'function') return;
  WD_LATER.tries++;
  const wait = Math.max(60000, (typeof WD !== 'undefined' ? WD.restUntil : 0) - Date.now() + 5000);
  WD_LATER.timer = setTimeout(() => {
    WD_LATER.timer = 0;
    const go = () => fillFromWikidata({ quiet: true }).catch(() => {});
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden')
      document.addEventListener('visibilitychange', function f() { if (document.visibilityState !== 'hidden') { document.removeEventListener('visibilitychange', f); go(); } });
    else go();
  }, wait);
}

/** Fill what Wikidata knows. `quiet` for the background run: no toast unless it found something. */
async function fillFromWikidata({ quiet = false } = {}) {
  await noteWikidataBaseline();
  const cached = (await idb.get('tags_extra')) ?? {};
  await engineLoad();
  const W = BetterfyWikidata;
  // Never asked, or asked and empty long enough ago to look again (45 days).
  const untagged = untaggedArtists();
  const todo = W.wikidataTodo([...untagged.keys()], cached);
  if (!todo.length) { if (!quiet) toast('Every artist Wikidata could know about has been asked already.'); return 0; }
  // Most-listened first (D9): Wikidata answers 300 at a time, so on a big
  // library the first answer is the one that matters most.
  const ids = (await inEnrichOrder(todo.filter(W.isSpotifyId).map(id => [id, untagged.get(id)]))).map(([id]) => id);
  let found = 0, failed = 0;
  const empties = [];            // asked by Spotify id, answered, no genres: the name fallback's list
  for (let i = 0; i < ids.length; i += W.BATCH) {
    const batch = ids.slice(i, i + W.BATCH);
    if (!quiet) stage(`Asking Wikidata about ${ids.length.toLocaleString()} artists… ${i.toLocaleString()} done`, i / ids.length);
    try {
      const req = W.genreRequest(batch);
      const out = W.genresFrom(await corsJson(req.url, req.init));
      if (!out.answered) { failed += batch.length; continue; }
      for (const id of batch) {
        const tags = W.genreTags(out.genres.get(id) ?? []);
        cached[id] = { tags, checkedAt: Date.now(), source: 'wikidata' };
        if (tags.length) { TAGS[id] = { tags, source: 'wikidata' }; found++; } else empties.push(id);
      }
    } catch { failed += batch.length; }
    if (i + W.BATCH < ids.length) await new Promise(r => setTimeout(r, 1000));
  }
  // Fallback for artists with no Spotify link on Wikidata: an exact, unique English label that
  // also carries a MusicBrainz artist id and genres. Only for those just answered empty (so an
  // unanswered batch does not get a second spend); two artists sharing a name get nothing.
  for (let i = 0; i < empties.length && !(typeof WD !== 'undefined' && Date.now() < WD.restUntil); i += W.NAME_BATCH) {
    const batch = empties.slice(i, i + W.NAME_BATCH);
    try {
      const req = W.nameRequest(batch.map(id => untagged.get(id)));
      const out = W.genresByName(await corsJson(req.url, req.init));
      if (!out.answered) continue;
      for (const id of batch) {
        const tags = W.genreTags(out.genres.get(W.nameKey(untagged.get(id))) ?? []);
        if (!tags.length) continue;
        cached[id] = { tags, checkedAt: Date.now(), source: 'wikidata', via: 'name' };
        TAGS[id] = { tags, source: 'wikidata' }; found++;
      }
    } catch { /* the empty answers stand; asked again when stale */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  await idb.set('tags_extra', cached);
  if (failed) wikidataRetryLater();
  if (found) await refreshReports();
  if (!quiet || found) {
    $('#land').hidden = true; $('#app').hidden = false;
    toast(`Wikidata had genres for ${found.toLocaleString()} of ${ids.length.toLocaleString()} untagged artists.`
      + (failed ? ` ${failed.toLocaleString()} could not be reached — asking again later.` : ''));
    store.touch('reports');
  }
  return found;
}

/* ---------- MusicBrainz genres, through ListenBrainz: a bonus (BUILD-8 W1, SOUND-ENGINE G3) ----------
 * Probe: musicbrainz.org/ws/2 answers a browser GET but wants a User-Agent a page cannot set
 * and 1 request a second. ListenBrainz serves the same MusicBrainz tags for up to 25 MBIDs per
 * GET, CORS-open, rate-limit headers exposed. One queue, 1.5 s apart; Remaining 0 or a 429/503
 * rests it ten minutes; only while the tab is showing and Data Saver is off, 150 artists per
 * visit, most-listened first. Only artists that already have an MBID (from Wikidata's exact
 * Spotify-id link, never a name) and no tags at all. Without those, nothing is asked. */
const MB = { chain: Promise.resolve(), last: 0, restUntil: 0 };
function mbJson(url) {
  const run = MB.chain.then(async () => {
    if (Date.now() < MB.restUntil) throw new Error('api.listenbrainz.org is busy');
    const wait = MB.last + BetterfyMbWeb.MB_SPACING_MS - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    MB.last = Date.now();
    const r = await fetch(url);
    const left = Number(r.headers?.get?.('X-RateLimit-Remaining'));
    if (Number.isFinite(left) && left <= 0 && r.headers?.get?.('X-RateLimit-Remaining') !== null)
      MB.last = Date.now() + (Number(r.headers.get('X-RateLimit-Reset-In')) || 5) * 1000;   // wait out the window
    if (!r.ok) {
      if (r.status === 429 || r.status === 503) MB.restUntil = Date.now() + BetterfyMbWeb.MB_REST_MS;
      throw new Error(`api.listenbrainz.org answered ${r.status}`);
    }
    return r.json();
  });
  MB.chain = run.catch(() => {});
  return run;
}
const mbVisible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

async function fillFromMusicBrainz() {
  if (!mbVisible() || (typeof navigator !== 'undefined' && navigator.connection?.saveData)) return 0;
  let raw = {};
  try { raw = (await idb.get(BRIDGE_KEY))?.raw ?? {}; } catch { return 0; }
  const untagged = untaggedArtists();
  if (!untagged.size) return 0;
  await engineLoad();
  const M = BetterfyMbWeb;
  const order = (await inEnrichOrder([...untagged])).map(([id]) => id);
  const todo = M.mbTodo(order, { mbidOf: id => raw[id]?.mbid, hasTags: id => !!TAGS[id]?.tags?.length,
    cached: (await idb.get('tags_extra')) ?? {} });
  if (!todo.length) return 0;
  const got = {};
  const byMbid = new Map(todo.map(([id, mbid]) => [mbid, id]));
  const mbids = [...byMbid.keys()];
  for (let i = 0; i < mbids.length; i += M.TAGS_BATCH) {
    if (!mbVisible()) break;
    const batch = mbids.slice(i, i + M.TAGS_BATCH);
    try {
      const out = M.tagsFrom(await mbJson(M.tagsUrl(batch)));
      if (!out) continue;
      // An MBID the answer leaves out is an honest "no tags" for that artist, written down as asked.
      for (const m of batch) got[byMbid.get(m)] = out.get(m) ?? [];
    } catch { if (Date.now() < MB.restUntil) break; }
  }
  const ids = Object.keys(got);
  if (!ids.length) return 0;
  const cached = (await idb.get('tags_extra')) ?? {};   // re-read: Last.fm may have written meanwhile
  let found = 0;
  for (const id of ids) {
    if (cached[id]?.tags?.length || TAGS[id]?.tags?.length) continue;
    cached[id] = { tags: got[id], checkedAt: Date.now(), source: 'musicbrainz' };
    if (got[id].length) { TAGS[id] = { tags: got[id], source: 'musicbrainz' }; found++; }
  }
  await idb.set('tags_extra', cached);
  if (found) { await refreshReports(); store.touch('reports'); }
  return found;
}

