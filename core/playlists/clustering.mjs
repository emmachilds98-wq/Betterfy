// Musical regions inside one playlist — §17.
//
// "Do not rely only on a single centroid." A centroid over a playlist that is
// half Tech House and half Garage describes neither half; it describes a
// point between them that nothing in the playlist sounds like. Worse, the
// misfile model then flags both halves as poor fits for their own home.
//
// Clusters are found on Music DNA genre vectors rather than on raw tags, so
// two tracks in neighbouring subgenres are near each other by construction —
// they share most of their lineage — and the clusters that come out are
// describable ("48% Tech House") rather than being anonymous groups.
import { dnaSimilarity } from '../analysis/music-dna.mjs';
import { commonAncestor, GENRE_INDEX } from '../ontology/index.mjs';

/* Greedy agglomeration, the same shape misfile.mjs already uses for finding
 * candidate new playlists. Kept greedy deliberately: k-means needs a k nobody
 * can supply, and hierarchical clustering needs a cut height that is the same
 * problem wearing a hat. A seed-and-absorb pass has one parameter, and it is
 * a similarity threshold that can be read off the same scale as every other
 * number in the engine. */
export const CLUSTER_THRESHOLD = 0.55;   // DNA similarity to join a seed
export const MIN_CLUSTER_SHARE = 0.10;   // below this it is a tail, not a region
export const MIN_CLUSTER_TRACKS = 3;

/**
 * The genre that describes a group: the concept every member sits under, at
 * the most specific level that still covers them all.
 *
 * Reducing by commonAncestor rather than taking the modal genre matters — a
 * cluster of Tech House, Deep House and Disco House tracks is a House
 * cluster, and calling it "Tech House because there were more of those" is
 * the same overreach the track classifier's sibling rule exists to prevent.
 */
export function describeCluster(members) {
  const genres = members.map(m => m.dna?.primaryGenre).filter(Boolean);
  if (!genres.length) return { genre: null, label: 'unclassified' };
  const genre = genres.reduce((a, b) => (a && b ? (commonAncestor(a, b) ?? null) : null));
  return {
    genre,
    label: genre ?? 'mixed',
    spread: new Set(genres).size,
    depth: genre ? (GENRE_INDEX.get(genre)?.depth ?? 0) : 0,
  };
}

/**
 * Find the musical regions in a set of profiled tracks.
 *
 * @param {{id: string, dna: object}[]} members
 * @returns {{share: number, size: number, genre: string|null, label: string,
 *            examples: string[], trackIds: string[]}[]}
 */
export function clusterTracks(members, { threshold = CLUSTER_THRESHOLD,
                                         minShare = MIN_CLUSTER_SHARE,
                                         minTracks = MIN_CLUSTER_TRACKS } = {}) {
  const usable = (members ?? []).filter(m => m?.dna && Object.keys(m.dna.genre ?? {}).length);
  if (!usable.length) return [];

  // Seed from the most confidently classified track outward, so a cluster
  // forms around a track the engine is sure about rather than around whichever
  // happened to come first in playlist order.
  const order = [...usable].sort((a, b) =>
    Object.keys(b.dna.genre).length - Object.keys(a.dna.genre).length
    || String(a.id).localeCompare(String(b.id)));

  const used = new Set();
  const clusters = [];
  for (const seed of order) {
    if (used.has(seed.id)) continue;
    const members = order.filter(m => !used.has(m.id) && dnaSimilarity(seed.dna, m.dna) >= threshold);
    if (members.length < minTracks) continue;
    members.forEach(m => used.add(m.id));
    clusters.push(members);
  }

  const total = usable.length;
  return clusters
    .map(members => ({
      ...describeCluster(members),
      size: members.length,
      share: +(members.length / total).toFixed(3),
      trackIds: members.map(m => m.id),
      examples: members.slice(0, 4).map(m => m.name ?? m.id),
    }))
    .filter(c => c.share >= minShare)
    .sort((a, b) => b.share - a.share);
}

/**
 * Whether a playlist's clusters say it is one musical thing or several.
 *
 * "Mixed" is a real answer about a playlist and forcing it into a single
 * genre is the playlist-level version of forcing a track (§17, §4.6). The
 * test is deliberately about the *second* cluster: one dominant region with a
 * long tail is still one thing, two comparable regions are not.
 */
export const MIXED_SECOND_SHARE = 0.25;

export function clusterVerdict(clusters) {
  if (!clusters.length) return { shape: 'unknown', dominant: null, regions: 0 };
  const [first, second] = clusters;
  // A shared ROOT is not a family: half house and half jungle share only
  // "electronic", which is true of the whole library and is exactly the split
  // a listener would want pulled apart. "Broad" means one family seen widely
  // — tech house beside deep house — so the shared ancestor must itself sit
  // under something.
  const family = second && first.genre && second.genre
    ? commonAncestor(first.genre, second.genre) : null;
  const sameFamily = !!(family && GENRE_INDEX.get(family)?.parent);
  return {
    shape: !second || second.share < MIXED_SECOND_SHARE ? 'single'
      // Two big regions that share a root are one broad bucket, not a mixed
      // playlist — "House and Techno" is an electronic playlist.
      : sameFamily ? 'broad' : 'mixed',
    dominant: first.genre,
    dominantShare: first.share,
    regions: clusters.length,
  };
}
