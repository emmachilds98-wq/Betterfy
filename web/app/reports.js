/* ---------- reports (mirrors dupes.mjs / misfile.mjs) ---------- */

/**
 * Betterfy's own "All Songs" playlist is a mirror of the library, not a place
 * anything was filed: by construction it holds a copy of every track you own,
 * liked songs included. Reading it as an ordinary playlist meant that building
 * it once quietly broke three screens at the same time — every liked song
 * counted as filed, so the File queue emptied; every track was suddenly "in
 * more than one playlist", so Cross-filed swelled to the whole library; and
 * any two pressings of the same record landed in it together and were reported
 * as a repeat. It stays a shuffle source and nothing else.
 *
 * Which playlist that is, is remembered by id — syncAllSongsPlaylist() writes
 * it under ALL_SONGS_KEY. Recognised by name alone, renaming the mirror turned
 * it straight back into an ordinary playlist as far as every report was
 * concerned, and re-broke all three screens above.
 */
const ALL_SONGS_KEY = 'bf_allsongs';
const pinnedAllSongs = () => LS.getItem(ALL_SONGS_KEY) || null;
const isMirrorPlaylist = p => !!p && (p.name === ALL_SONGS_NAME || p.id === pinnedAllSongs());

/** A row of tag chips with everything that is not a genre drawn back, so the
 *  tags a suggestion was actually made from are the ones you notice. `thin`
 *  adds a note that this track's evidence is a little Last.fm data, not none
 *  — a real suggestion, just one worth a second look before trusting fully. */
const tagChips = (list, thin) => `<div class="tagrow">${(list ?? []).map(t => {
  const f = tagFacet(t);
  return `<span class="tag${f === 'genre' ? '' : ' f-off'}" title="${f} tag">${esc(t)}</span>`;
}).join('')}${thin ? `<span class="tag" style="opacity:.65" title="Only a little Last.fm data behind this artist — treat the suggestion as a guess, not a verdict.">thin data</span>` : ''}</div>`;

function describe(rows) {
  const isrcs = new Set(rows.map(r => r.isrc).filter(Boolean));
  const durs = rows.map(r => r.duration_ms).filter(x => x != null);
  const spread = durs.length > 1 ? Math.max(...durs) - Math.min(...durs) : 0;
  const types = new Set(rows.map(r => r.albumType).filter(Boolean));
  if (isrcs.size === 1 && rows.every(r => r.isrc))
    return { verdict:'same-recording', why: types.size > 1
      ? `Identical recording, issued on a ${[...types].join(' and a ')}.` : 'Identical recording on two releases.' };
  if (spread > 20000) return { verdict:'different-length', why:`Lengths differ by ${mmss(spread)} — likely an edit versus a longer cut.` };
  if (isrcs.size > 1) return { verdict:'different-recording', why: spread > 3000
    ? `Different recordings, ${mmss(spread)} apart in length.` : 'Different recordings of near-identical length — usually a remaster or re-issue.' };
  return { verdict:'unknown', why:'Same title; no identifier to separate them.' };
}

function buildReports(lib, cfg, tags) {
  // Same gate classify() applies, recomputed fresh here since tags can change
  // mid-session (a fetch, a correction) without cfg being rebuilt.
  tags = gateTags(tags, tagGate(tags));
  const shape = t => ({ id:t.id, album:t.album, albumType:t.albumType, released:t.released, art:t.art,
                        duration_ms:t.duration_ms, dur:mmss(t.duration_ms), isrc:t.isrc, name:t.name });
  const within = [], where = new Map(), meta = new Map();
  // Which copy of a repeat to keep. "The most popular" stopped meaning
  // anything when Spotify removed `popularity` (February 2026), so: the release
  // you filed in more playlists, then the one added first, then playlist order.
  const plCount = new Map();
  for (const p of lib.playlists) { if (isMirrorPlaylist(p)) continue;
    for (const id of new Set((p.tracks ?? []).map(t => t?.id).filter(Boolean))) plCount.set(id, (plCount.get(id) ?? 0) + 1); }
  const addedAt = t => { const x = Date.parse(t?.added_at); return Number.isFinite(x) ? x : Infinity; };
  for (const p of lib.playlists) {
    if (isMirrorPlaylist(p)) continue;
    const groups = new Map();
    for (const t of p.tracks) {
      if (!t?.id) continue;
      const k = trackKey(t);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(t);
      meta.set(t.id, t);
      if (!where.has(k)) where.set(k, []);
      where.get(k).push({ playlist:p.name, playlistId:p.id, ...shape(t) });
    }
    for (const [, rows] of groups) {
      if (rows.length < 2) continue;
      const shaped = rows.map(shape);
      const d = describe(shaped);
      const order = rows.map((t, i) => ({ i, n: plCount.get(t.id) ?? 0, at: addedAt(t) }))
        .sort((a, b) => (b.n - a.n) || (a.at - b.at) || (a.i - b.i));
      const keep = shaped[order[0].i];
      within.push({ playlist:p.name, playlistId:p.id, artist:rows[0].artists?.[0]?.name, title:rows[0].name, art:rows[0].art,
        verdict:d.verdict, why:d.why, keep, options:shaped, drop:shaped.filter(r => r.id !== keep.id) });
    }
  }
  const across = [...where.entries()].filter(([,r]) => new Set(r.map(x=>x.playlist)).size > 1).map(([,rows]) => {
    const t = meta.get(rows[0].id);
    const byPl = [...new Map(rows.map(r => [r.playlist, r])).values()];
    return { artist:t.artists?.[0]?.name, title:t.name, id:t.id, art:t.art,
      placements: byPl.map(r => ({ playlist:r.playlist, playlistId:r.playlistId, axis:cfg[r.playlistId]?.axis ?? 'other',
                                   trackId:r.id, dur:r.dur })),
      mixedReleases: new Set(rows.map(r=>r.id)).size > 1,
      mixedRecordings: new Set(rows.map(r=>r.isrc).filter(Boolean)).size > 1 };
  }).sort((a,b) => b.placements.length - a.placements.length);

  const targets = new Set(Object.entries(cfg).filter(([,v]) => v.target).map(([id]) => id));
  const axisOf = id => cfg[id]?.axis ?? null;
  const { profiles, idf } = buildProfiles(lib, tags, targets, axisOf);

  // Shared with the Node pipeline (misfile.mjs) via profile.mjs, bundled in
  // verbatim — the two builds cannot silently drift into different answers.
  const misfiled = findMisfiled(lib, tags, targets, profiles, idf, axisOf).map(m => ({
    id: m.track.id, artist: m.track.artists?.[0]?.name, title: m.track.name, art: m.track.art, dur: m.track.duration_ms,
    current: m.playlistName, currentPlaylistId: m.playlistId, currentScore: +m.ownScore.toFixed(3), confidence: m.confidence,
    suggest: m.suggest.map(b => ({ id: b.id, name: b.name, score: +b.score.toFixed(3) })), tags: topTags(m.track, tags, idf),
    // A real suggestion, just built on very little Last.fm data — worth
    // knowing before trusting or dismissing the move.
    thinData: isThinSignal(m.track, tags),
    artists: (m.track.artists ?? []).filter(a => a.id).map(a => ({ id: a.id, name: a.name })) }))
    // A track you said to keep where it is ("Keep here", either Tidy tier) is
    // not offered as wrong there again.
    .filter(m => !keptHere(m.id, m.currentPlaylistId));

  // Filed means filed as any release of it: a liked single whose album copy
  // (same ISRC, or the same trackKey — artist, title and version) already sits
  // in a playlist is not waiting to be filed, whatever its Spotify id.
  const filed = new Set(), filedIsrc = new Set(), filedKey = new Set();
  for (const p of lib.playlists) { if (isMirrorPlaylist(p)) continue;
    for (const t of p.tracks) { if (!t) continue; filed.add(t.id);
      if (t.isrc) filedIsrc.add(t.isrc); if (t.name) filedKey.add(trackKey(t)); } }
  const isFiled = t => filed.has(t.id) || (!!t.isrc && filedIsrc.has(t.isrc)) || (!!t.name && filedKey.has(trackKey(t)));
  const unfiled = lib.liked.filter(t => t?.id && !isFiled(t));
  // Rejections by artist, read once for the whole queue (backlogSuggest).
  const rejected = artistRejectMemory(FB, lib);
  const backlog = unfiled.map(t => {
    const fb = FB[t.id];
    const suggest = backlogSuggest(t, lib, cfg, tags, profiles, idf, targets, rejected);
    return { id:t.id, artist:(t.artists??[]).map(a=>a.name).join(', '), title:t.name,
      album:t.album, released:t.released, added:(t.added_at??'').slice(0,10), dur:t.duration_ms, art:t.art,
      tags: topTags(t, tags, idf),
      thinData: isThinSignal(t, tags),
      artists: (t.artists ?? []).filter(a => a.id).map(a => ({ id:a.id, name:a.name })),
      skips: fb?.skips ?? 0,
      suggest };
  })
    // Newest first, but anything already skipped sinks below everything you
    // have not seen yet — so the queue moves on instead of reopening on the
    // same track you passed on last time.
    .sort((a,b) => (a.skips - b.skips) || (b.added??'').localeCompare(a.added??''));

  // Listening x uncertainty, once listening has landed (fileOrderCtx below).
  { const oc = fileOrderCtx(); if (oc) backlog.splice(0, backlog.length, ...orderBacklog(backlog, oc)); }

  // clusters with no home
  const homeless = backlog.filter(b => !b.suggest.length || b.suggest[0].score < 0.30);
  // Indexed rather than searched: unfiled.find() inside a map over the homeless
  // rows is a full scan per row, which on a real backlog of a few thousand
  // liked songs is millions of comparisons for a lookup a Map answers flat.
  const unfiledById = new Map(unfiled.map(t => [t.id, t]));
  const vecs = homeless.map(h => ({ h, v: applyIdf(trackVec(unfiledById.get(h.id) ?? {}, tags), idf) })).filter(x => x.v.size >= 3);
  const clusters = []; const used = new Set();
  for (const seed of vecs) {
    if (used.has(seed.h.id)) continue;
    const members = vecs.filter(x => !used.has(x.h.id) && cosine(seed.v, x.v) > 0.45);
    if (members.length >= 6) {
      members.forEach(m => used.add(m.h.id));
      const tally = new Map();
      for (const m of members) for (const tg of m.h.tags) tally.set(tg, (tally.get(tg)??0)+1);
      clusters.push({ size:members.length, ids:members.map(m=>m.h.id),
        tags:[...tally].sort((a,b)=>b[1]-a[1]).slice(0,6).map(([k])=>k),
        tracks:members.slice(0,8).map(m => `${m.h.artist} — ${m.h.title}`) });
    }
  }
  clusters.sort((a,b) => b.size - a.size);

  // Playlists whose recent additions read differently from what came before —
  // the other shape of "goes against the pattern", at the playlist level
  // rather than one track. Cheap and synchronous, needs no listening data,
  // so it's always current rather than something to fetch separately.
  const drift = findDrift(lib, tags, targets, idf);

  // profiles/idf come out too: Discover ranks tracks that are not in the
  // library at all, and must score them against the same centroids the inbox
  // uses rather than a second, subtly different model.
  return { within, across, misfiled, backlog, clusters, drift, profiles, idf };
}

/* ---------- File's queue order (BUILD-5-PLAN §5.2) ----------
 * How much you play it x how little the engine knows it, from the listening
 * fetch every account already has (top artists, top tracks, recently played).
 * Until that has landed the queue keeps its newest-first order; fileOrderKick()
 * asks for it once and re-sorts in place, keeping the card on screen where it is. */
const engineDecisions = new WeakMap();
/** The Engine's calibrated verdict for one liked track, when it has judged it. */
function engineDecisionOf(id) {
  const sh = typeof ENG !== 'undefined' ? ENG.shadow : null;
  if (!sh?.rows) return null;
  let m = engineDecisions.get(sh);
  if (!m) { m = new Map(sh.rows.map(r => [r.id, r.decision])); engineDecisions.set(sh, m); }
  return m.get(id) ?? null;
}
function fileOrderCtx() {
  const L = typeof LISTENING_CACHE !== 'undefined' ? LISTENING_CACHE : null;
  if (!L?.weights) return null;
  return { weights: L.weights, tracks: L.tracks ?? null,
           bandOf: row => DECISION_BAND[engineDecisionOf(row.id)?.kind] ?? null };
}
function fileReorder() {
  const oc = fileOrderCtx();
  if (!oc || !R?.backlog?.length) return false;
  const keep = R.backlog[Math.min(S.inboxAt | 0, R.backlog.length - 1)]?.id;
  R.backlog = orderBacklog(R.backlog, oc);
  S.inboxAt = Math.max(0, R.backlog.findIndex(b => b.id === keep));
  return true;
}
/** Once per library load: fetch listening if it is not here yet, then re-sort and repaint. */
function fileOrderKick() {
  if (!R || R.ordered || typeof getListening !== 'function') return;
  R.ordered = true;
  getListening().then(() => { if (fileReorder()) store.touch('ui.inbox'); }).catch(() => { /* ordered newest-first, as before */ });
}

/** "Keep here" was said for this track in this playlist (recordKeep). */
function keptHere(trackId, playlistId) { return !!FB[trackId]?.kept?.includes(playlistId); }

/**
 * The File queue's picks for one unfiled track: the tag engine's best three,
 * or, when none of them fits well enough to trust, where the artist's other
 * tracks are already filed. buildReports() makes every card's picks with this,
 * and rejecting a pick re-ranks the card through it too, so the slot a
 * rejection frees fills exactly the way the card was first filled — the
 * filing-history fallback and the `via` label included. `tags` are the gated
 * tags buildReports scores with. `rejected` is profile.mjs artistRejectMemory
 * over FB, passed in by buildReports so a queue of thousands reads FB once.
 */
function backlogSuggest(t, lib, cfg, tags, profiles, idf,
                        targets = new Set(Object.entries(cfg).filter(([,v]) => v.target).map(([id]) => id)),
                        rejected = artistRejectMemory(FB, lib)) {
  const fb = FB[t.id];
  // A playlist rejected for this artist's other tracks is lowered here, fading
  // with time and later accepts (profile.mjs rejectFactors, BUILD-5-PLAN §5.1).
  // Null with no such rejection, and then the picks are exactly what they were.
  const down = rejectFactors(t, rejected);
  // Ask for more than three, then drop the playlists already rejected for
  // this track, so a rejection promotes the next real candidate instead of
  // leaving a gap where the rejected one was.
  const ranked = downweightRejected(rank(t, tags, profiles, idf, { top: 8 }), down)
    .filter(b => !fb?.rejected?.includes(b.id))
    .slice(0, 3)
    .map(b => ({ ...b, axis: cfg[b.id]?.axis ?? null, via: 'tags' }));
  // Tag-based fit already found something worth trusting; the artist's own
  // filing history only ever steps in when it hasn't — no fetch, no third
  // party, just where the user already put this artist's other tracks.
  return (ranked.length && ranked[0].score >= 0.30) ? ranked
    : downweightRejected(artistHistory(t, lib, targets), down)
        .filter(h => !fb?.rejected?.includes(h.id))
        .map(h => ({ ...h, axis: cfg[h.id]?.axis ?? null, via: 'history' }));
}

