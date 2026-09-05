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
