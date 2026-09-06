// Tag-vector model of the library.
//
// Spotify supplies no genre data any more, so a track's genre signal is the
// union of its artists' Last.fm tags. A playlist is the centroid of its
// members. Tags are IDF-weighted across playlists, otherwise "electronic" —
// which is true of half this library — would dominate every comparison and
// every playlist would look like every other one.
// No imports: this module is bundled verbatim into the browser build by
// build-web.mjs, so it must stay free of anything Node-specific.
// Tag loading lives in tagstore.mjs (Node) and in the web app (fetch).

// Last.fm tags are user-submitted, so they carry personal-collection cruft
// ("funk_add_to_lidarr_batch_26", "albums i own", "seen live"). These describe
// the tagger, not the music, and skew a centroid badly at low tag counts.
const JUNK = /_|^seen live$|^albums? i|^my |^favou?rites?$|^\d+$|^under \d|lidarr|spotify|^check out|^to listen|^love(d)?$|^awesome$|^cool$|^good$|^best|^all$/i;
const usableTag = t => t.length > 1 && t.length < 32 && !JUNK.test(t);

/** Tag weights for one track, averaged over its credited artists. */
export function trackVec(track, tags) {
  const v = new Map();
  const artists = (track.artists ?? []).filter(a => tags[a.id]?.tags?.length);
  if (!artists.length) return v;
  for (const a of artists)
    for (const [tag, count] of tags[a.id].tags) {
      if (!usableTag(tag)) continue;
      v.set(tag, (v.get(tag) ?? 0) + count / 100 / artists.length);
    }
  return v;
}

const dot = (a, b) => {
  let s = 0;
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  for (const [k, x] of small) { const y = big.get(k); if (y) s += x * y; }
  return s;
};
const mag = v => Math.sqrt([...v.values()].reduce((s, x) => s + x * x, 0));

export function cosine(a, b) {
  const m = mag(a) * mag(b);
  return m ? dot(a, b) / m : 0;
}

/** Scale a vector by IDF so ubiquitous tags stop drowning out distinctive ones. */
export const applyIdf = (v, idf) => {
  const out = new Map();
  for (const [k, x] of v) out.set(k, x * (idf.get(k) ?? 1));
  return out;
};

/**
 * Build per-playlist centroids plus the IDF table.
 * `targets` limits which playlists are modelled as filing destinations.
 */
export function buildProfiles(lib, tags, targets, axisOf = null) {
  // document frequency: how many playlists contain each tag at all
  const df = new Map();
  const raw = new Map();

  for (const p of lib.playlists) {
    if (targets && !targets.has(p.id)) continue;
    const vecs = p.tracks.map(t => trackVec(t, tags)).filter(v => v.size);
    if (!vecs.length) continue;

    const c = new Map();
    for (const v of vecs) for (const [k, x] of v) c.set(k, (c.get(k) ?? 0) + x / vecs.length);
    raw.set(p.id, { name: p.name, axis: axisOf ? axisOf(p.id) : null, vec: c, n: vecs.length, total: p.tracks.length });
    for (const k of c.keys()) df.set(k, (df.get(k) ?? 0) + 1);
  }

  const N = raw.size || 1;
  const idf = new Map();
  for (const [k, d] of df) idf.set(k, Math.log(1 + N / d));

  const profiles = new Map();
  for (const [id, p] of raw) profiles.set(id, { ...p, vec: applyIdf(p.vec, idf) });
  return { profiles, idf };
}

/** Rank playlists by fit for one track. */
export function rank(track, tags, profiles, idf, { exclude = null, top = 5, axis = null } = {}) {
  const v = applyIdf(trackVec(track, tags), idf);
  if (!v.size) return [];
  const out = [];
  for (const [id, p] of profiles) {
    if (id === exclude) continue;
    // Only compare like with like: a genre playlist competes with genre
    // playlists, a mood playlist with mood playlists. Comparing across axes
    // flags every track in a mood playlist as misfiled, which it is not.
    if (axis && p.axis && p.axis !== axis) continue;
    const s = cosine(v, p.vec);
    if (s > 0) out.push({ id, name: p.name, score: s });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, top);
}

/** The strongest tags on a track, for explaining a suggestion. */
export function topTags(track, tags, idf, n = 5) {
  const v = applyIdf(trackVec(track, tags), idf);
  return [...v].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
}

// Flagged only when another playlist beats the current one by a wide margin,
// so ordinary cross-genre overlap doesn't generate noise.
const MISFILE_MARGIN = 1.6;
const MISFILE_FLOOR = 0.25;

/**
 * Tracks that fit another playlist on the same axis far better than the one
 * they are actually filed in — "goes against the pattern of this playlist".
 * Shared between the Node pipeline (misfile.mjs) and the browser build so the
 * two cannot silently drift into different answers about the same library.
 *
 * Only ever compares a track against playlists on its own axis (a metal track
 * in a mood playlist is not "misfiled" relative to the metal bucket), and
 * only within `targets` — a playlist below the size gate, or on an axis that
 * doesn't take suggestions at all, is never treated as a home to be misfiled
 * from or a destination to be misfiled to.
 */
export function findMisfiled(lib, tags, targets, profiles, idf, axisOf) {
  const misfiled = [];
  for (const p of lib.playlists) {
    if (!targets.has(p.id)) continue;
    const home = profiles.get(p.id);
    if (!home) continue;
    for (const t of p.tracks) {
      const v = applyIdf(trackVec(t, tags), idf);
      if (v.size < 3) continue;                    // too little signal to trust
      const own = cosine(v, home.vec);
      const best = rank(t, tags, profiles, idf, { exclude: p.id, top: 3, axis: axisOf(p.id) });
      if (!best.length) continue;
      if (best[0].score > own * MISFILE_MARGIN && best[0].score > MISFILE_FLOOR) {
        // Confidence tiers. The raw margin test produces a long uncertain
        // tail; banding it keeps the convincing cases from being buried.
        const confidence =
          own < 0.12 && best[0].score > 0.55 ? 'high'
          : own < 0.25 && best[0].score > 0.40 ? 'medium'
          : 'low';
        misfiled.push({ track: t, playlistId: p.id, playlistName: p.name, ownScore: own, confidence, suggest: best });
      }
    }
  }
  const RANK = { high: 0, medium: 1, low: 2 };
  misfiled.sort((a, b) => RANK[a.confidence] - RANK[b.confidence]
    || (b.suggest[0].score - b.ownScore) - (a.suggest[0].score - a.ownScore));
  return misfiled;
}

// ---------- listening weight ----------
// How much you actually play an artist, not just how much of them you have
// filed. Node and the browser fetch the raw numbers differently (spotify.mjs's
// api() vs the browser's own sp()), but combine them the same way — this is
// the shared half, kept pure so it can be tested without a network at all.

/**
 * `topWindows`: [{ weight, items }] — items is an artist-name array already in
 * Spotify's own rank order for that window (short/medium/long_term).
 * `recentArtists`: flat artist-name list from recently-played.
 * `libraryArtists`: every artist name across the library — the floor, so an
 * artist you have filed counts for something with no recent activity at all,
 * scaled by the biggest count so one enormous playlist can't outvote someone
 * you've actually been playing this month.
 * Returns a Map(artist name -> weight), unbounded and relative, not a 0-1 score.
 */
export function listeningWeights({ topWindows = [], recentArtists = [], libraryArtists = [] } = {}) {
  const w = new Map();
  const bump = (name, x) => { if (name) w.set(name, (w.get(name) ?? 0) + x); };
  for (const { items, weight } of topWindows)
    (items ?? []).forEach((name, i) => bump(name, weight * (1 - i / 60)));
  for (const name of recentArtists) bump(name, 0.6);

  const filed = new Map();
  for (const name of libraryArtists) filed.set(name, (filed.get(name) ?? 0) + 1);
  const most = Math.max(1, ...filed.values());
  for (const [name, n] of filed) bump(name, n / most);
  return w;
}

/**
 * Sort entries most-played first, so an interrupted run (a tag fetch that
 * times out, a page closed halfway through) has already covered what
 * actually matters to this listener rather than whatever came first in
 * playlist order. Untracked or unweighted entries sort last, stable
 * otherwise — never reordered at random.
 */
export function byListening(entries, weights, nameOf = e => e[1]) {
  const w = e => weights?.get?.(nameOf(e)) ?? 0;
  return [...entries]
    .map((e, i) => [e, i])
    .sort(([a, i], [b, j]) => (w(b) - w(a)) || (i - j))
    .map(([e]) => e);
}

// ---------- playlist drift ----------
// A single wrong track is what findMisfiled catches. This catches the other
// shape of "goes against the pattern": a playlist whose recent additions
// read differently from the identity it had before, one ordinary-looking
// track at a time until the whole thing has quietly changed.

const DRIFT_RECENT_FRACTION = 0.25; // "recent" = newest quarter of the playlist
const DRIFT_RECENT_MIN = 8;         // below this, a "recent" centroid is noise
const DRIFT_OLDER_MIN = 8;          // same for the established "older" half
// A first-pass number, not yet checked against a real library the way the
// misfile margin was (see the rejected-rules note in the browser build's
// classify()). Treat it as a starting point to tune once real drift — or
// real false positives — actually show up.
const DRIFT_THRESHOLD = 0.35;

/**
 * Playlists whose most recent additions score low against the centroid of
 * everything added before them. `idf` should be the same table `rank()` and
 * `findMisfiled()` use, so this reads on the same scale as everything else
 * in the app — not a second, differently-calibrated model.
 */
export function findDrift(lib, tags, targets, idf) {
  const centroidOf = list => {
    const vecs = list.map(t => trackVec(t, tags)).filter(v => v.size);
    if (!vecs.length) return null;
    const c = new Map();
    for (const v of vecs) for (const [k, x] of v) c.set(k, (c.get(k) ?? 0) + x / vecs.length);
    return applyIdf(c, idf);
  };

  const drift = [];
  for (const p of lib.playlists) {
    if (!targets.has(p.id)) continue;
    const dated = p.tracks.filter(t => t?.added_at).sort((a, b) => Date.parse(a.added_at) - Date.parse(b.added_at));
    if (dated.length < DRIFT_RECENT_MIN + DRIFT_OLDER_MIN) continue;

    const cut = Math.max(DRIFT_RECENT_MIN, Math.round(dated.length * DRIFT_RECENT_FRACTION));
    const recent = dated.slice(-cut), older = dated.slice(0, -cut);
    if (recent.length < DRIFT_RECENT_MIN || older.length < DRIFT_OLDER_MIN) continue;

    const recentC = centroidOf(recent), olderC = centroidOf(older);
    if (!recentC || !olderC) continue;

    const similarity = cosine(recentC, olderC);
    if (similarity < DRIFT_THRESHOLD) {
      const topOf = c => [...c].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k);
      drift.push({
        playlistId: p.id, playlistName: p.name, similarity,
        recentCount: recent.length, olderCount: older.length,
        recentTags: topOf(recentC), olderTags: topOf(olderC),
      });
    }
  }
  drift.sort((a, b) => a.similarity - b.similarity);
  return drift;
}
