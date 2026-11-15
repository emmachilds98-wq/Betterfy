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

/** Fill what Wikidata knows. `quiet` for the background run: no toast unless it found something. */
async function fillFromWikidata({ quiet = false } = {}) {
  const cached = (await idb.get('tags_extra')) ?? {};
  // Asked before and Wikidata had nothing: not asked again until that answer is stale.
  const todo = [...untaggedArtists().keys()].filter(id => !(cached[id]?.source === 'wikidata' && !worthReasking(cached[id])));
  if (!todo.length) { if (!quiet) toast('Every artist Wikidata could know about has been asked already.'); return 0; }
  await engineLoad();
  const W = BetterfyWikidata;
  const ids = todo.filter(W.isSpotifyId);
  let found = 0, failed = 0;
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
        if (tags.length) { TAGS[id] = { tags, source: 'wikidata' }; found++; }
      }
    } catch { failed += batch.length; }
    if (i + W.BATCH < ids.length) await new Promise(r => setTimeout(r, 1000));
  }
  await idb.set('tags_extra', cached);
  if (found) R = buildReports(LIB, CFG, TAGS);
  if (!quiet || found) {
    $('#land').hidden = true; $('#app').hidden = false;
    toast(`Wikidata had genres for ${found.toLocaleString()} of ${ids.length.toLocaleString()} untagged artists.`
      + (failed ? ` ${failed.toLocaleString()} could not be reached — try again later.` : ''));
    render();
  }
  return found;
}

