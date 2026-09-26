// How playlists relate to each other — §18 and §19.
//
// The worked example from the plan: a 600-track "Tech House" playlist and a
// 74-track "Ibiza 2026", 68 of whose tracks are in the first. v1 has no
// concept of this at all; it would model both as filing destinations, rank
// tracks against both, and flag half of "Ibiza 2026" as misfiled out of a
// playlist it is a deliberate copy of.
//
// The answer is that "Ibiza 2026" is an EVENT playlist that is an
// event-specific derivative of "Tech House" — and crucially, that does NOT
// make it a genre playlist. Membership overlap says they are related;
// classification says what each one is; and the two together say which way
// the derivation runs.
//
// Two signals, kept apart on purpose:
//
//   membership   which exact recordings they share. Cheap, exact, and the
//                only thing that can establish a subset.
//   musical      how alike their fingerprints are. This is what spots a
//                variant that shares no tracks at all — the "Tech House" and
//                "Tech House 2" case where one continues the other.
import { dnaSimilarity } from '../analysis/music-dna.mjs';
import { commonAncestor, GENRE_INDEX } from '../ontology/index.mjs';
import { splitQualifier } from './name.mjs';

export const RELATIONSHIPS_VERSION = '3.0.0';

export const THRESHOLDS = {
  DUPLICATE: 0.90,        // containment, both directions
  NEAR_DUPLICATE: 0.75,   // containment, both directions
  SUBSET: 0.70,           // of the smaller playlist's tracks
  SUBSET_SIZE_RATIO: 0.70,// and it must actually be smaller than this
  MUSICAL_VARIANT: 0.80,  // fingerprint similarity with little overlap
  RELATED: 0.60,          // fingerprint similarity, no structural claim
  // A shared ROOT genre is not a relationship. In an electronic library
  // every playlist "sits under electronic", and reporting that for every
  // pair buries the findings that mean something.
  RELATED_DEEP_FAMILY: true,
  MIN_TRACKS: 5,          // below this, every ratio is noise
};

/** Track ids in a playlist, de-duplicated. */
const idsOf = p => new Set((p?.tracks ?? []).map(t => t?.id).filter(Boolean));

/**
 * Overlap between two id sets, reported from both sides.
 *
 * Containment, not Jaccard, is the number that matters here: a 74-track
 * playlist can be almost entirely inside a 600-track one while their Jaccard
 * similarity is 0.11. Jaccard would call that "unrelated", which is exactly
 * backwards.
 */
export function overlap(a, b) {
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const id of small) if (big.has(id)) shared++;
  return {
    shared,
    ofA: a.size ? shared / a.size : 0,
    ofB: b.size ? shared / b.size : 0,
    jaccard: (a.size + b.size - shared) ? shared / (a.size + b.size - shared) : 0,
  };
}

/** Fingerprint similarity: the genre centroids, compared as DNA vectors. */
export const musicalSimilarity = (fpA, fpB) =>
  dnaSimilarity({ genre: fpA?.centroid ?? {} }, { genre: fpB?.centroid ?? {} });

/**
 * Whether two names look like views of one collection — §19.
 *
 * "TECH HOUSE", "TECH HOUSE — FAVOURITES", "TECH HOUSE — DRIVING". The shared
 * base is the signal; the qualifier says which view. Deliberately structural:
 * it does not need to understand "favourites", only that one name is the
 * other plus a qualifier.
 */
export function viewOf(nameA, nameB) {
  const a = splitQualifier(nameA), b = splitQualifier(nameB);
  const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (!norm(a.base) || norm(a.base) !== norm(b.base)) return null;
  // The one with no qualifier is the parent collection.
  if (!a.qualifier && b.qualifier) return { parent: 'a', view: b.qualifier };
  if (!b.qualifier && a.qualifier) return { parent: 'b', view: a.qualifier };
  if (a.qualifier && b.qualifier) return { parent: null, view: `${a.qualifier} / ${b.qualifier}` };
  return null;
}

/**
 * Classify the relationship between two playlists.
 *
 * `classA`/`classB` are classifyPlaylist() outputs and are what let this
 * distinguish an event copy from a plain subset — the structural facts are
 * identical in both cases, and only the type tells them apart.
 *
 * @returns {{kind: string, confidence: number, why: string, direction: string|null} | null}
 *   null when there is nothing worth saying.
 */
export function relate(a, b, { fpA, fpB, classA = null, classB = null } = {}) {
  const idsA = idsOf(a), idsB = idsOf(b);
  if (idsA.size < THRESHOLDS.MIN_TRACKS || idsB.size < THRESHOLDS.MIN_TRACKS) return null;

  const ov = overlap(idsA, idsB);
  const sim = musicalSimilarity(fpA, fpB);
  const view = viewOf(a?.name, b?.name);
  const sizeRatio = Math.min(idsA.size, idsB.size) / Math.max(idsA.size, idsB.size);
  // Which is the smaller, and how much of it sits inside the larger.
  const smallerIsA = idsA.size <= idsB.size;
  const containment = smallerIsA ? ov.ofA : ov.ofB;
  const direction = smallerIsA ? 'a-in-b' : 'b-in-a';
  const smaller = smallerIsA ? { p: a, cls: classA } : { p: b, cls: classB };
  const larger = smallerIsA ? { p: b, cls: classB } : { p: a, cls: classA };
  const pct = x => Math.round(x * 100) + '%';

  if (ov.ofA >= THRESHOLDS.DUPLICATE && ov.ofB >= THRESHOLDS.DUPLICATE)
    return { kind: 'duplicate', confidence: Math.min(ov.ofA, ov.ofB), direction: null,
             why: `${pct(ov.ofA)} of one and ${pct(ov.ofB)} of the other are the same tracks` };

  if (ov.ofA >= THRESHOLDS.NEAR_DUPLICATE && ov.ofB >= THRESHOLDS.NEAR_DUPLICATE)
    return { kind: 'near-duplicate', confidence: Math.min(ov.ofA, ov.ofB), direction: null,
             why: `nearly the same tracks (${pct(ov.ofA)} / ${pct(ov.ofB)}), differing by ${Math.abs(idsA.size - idsB.size)}` };

  if (containment >= THRESHOLDS.SUBSET && sizeRatio <= THRESHOLDS.SUBSET_SIZE_RATIO) {
    // A subset, but of what kind? The smaller playlist's own type decides,
    // and this is the whole point: an EVENT playlist that is a subset of a
    // genre playlist is an event copy, and calling it a genre playlist —
    // which is what treating it as a plain subset would invite — is the
    // error §18 is warning about.
    const kind = view ? 'view'
      : smaller.cls?.type === 'EVENT' ? 'event-copy'
      : smaller.cls?.type === 'DJ_SET' ? 'set-drawn-from'
      : smaller.cls?.type === 'MOOD' ? 'mood-variant'
      : smaller.cls?.type === 'ERA' ? 'era-variant'
      : 'subset';
    return {
      kind, confidence: containment, direction,
      why: `${pct(containment)} of "${smaller.p?.name}" (${idsOf(smaller.p).size} tracks) is inside `
         + `"${larger.p?.name}" (${idsOf(larger.p).size})`
         + (view ? `, and its name is that one plus "${view.view}"` : '')
         + (smaller.cls?.type && kind !== 'subset' && kind !== 'view' ? `, and it reads as ${smaller.cls.type}` : ''),
      parentId: larger.p?.id ?? null,
      childId: smaller.p?.id ?? null,
    };
  }

  if (view)
    return { kind: 'view', confidence: 0.6, direction: null,
             why: `both names share the base "${splitQualifier(a?.name).base}"`,
             parentId: (view.parent === 'a' ? a : view.parent === 'b' ? b : null)?.id ?? null };

  // No structural overlap worth the name, but the same music. This is the
  // continuation case — "Tech House" filled up and "Tech House 2" started —
  // and membership alone can never see it.
  //
  // Only between playlists organised on the same axis, though. An ARTIST or
  // EVENT or MOOD playlist drawn from a genre you own is *expected* to look
  // like that genre — that is what it is made of — and calling it a variant
  // of the genre bucket says nothing and buries the real continuations.
  const GENREISH = new Set(['GENRE', 'SUBGENRE']);
  const comparableAxis = classA?.type && classB?.type
    ? classA.type === classB.type || (GENREISH.has(classA.type) && GENREISH.has(classB.type))
    : true;
  if (sim >= THRESHOLDS.MUSICAL_VARIANT && comparableAxis)
    return { kind: 'variant', confidence: sim, direction: null,
             why: `almost the same musical profile (${sim.toFixed(2)}) with only ${ov.shared} tracks in common` };

  if (sim >= THRESHOLDS.RELATED) {
    const family = commonAncestor(fpA?.primaryGenre ?? '', fpB?.primaryGenre ?? '');
    // A root-level family is the whole library, not a relationship.
    const meaningful = family && GENRE_INDEX.get(family)?.parent;
    if (!meaningful) return null;
    return { kind: 'related', confidence: sim, direction: null, why: `both sit under ${family}` };
  }
  return null;
}

/**
 * Every meaningful relationship in a library.
 *
 * Each pair is examined once. Playlists below the size floor are skipped
 * rather than compared badly, and a mirror playlist — which contains
 * everything by construction — is excluded entirely: left in, it is a
 * superset of every playlist you own and would bury every real finding.
 *
 * @param {object} lib
 * @param {Map<string, object>} fingerprints
 * @param {Map<string, object>} classifications
 * @param {{isMirror?: (p: object) => boolean}} [opts]
 */
export function findRelationships(lib, fingerprints, classifications, { isMirror = () => false } = {}) {
  const playlists = (lib?.playlists ?? []).filter(p => p?.id && !isMirror(p)
    && (p.tracks?.length ?? 0) >= THRESHOLDS.MIN_TRACKS);
  const out = [];
  for (let i = 0; i < playlists.length; i++)
    for (let j = i + 1; j < playlists.length; j++) {
      const a = playlists[i], b = playlists[j];
      const rel = relate(a, b, {
        fpA: fingerprints.get(a.id), fpB: fingerprints.get(b.id),
        classA: classifications.get(a.id), classB: classifications.get(b.id),
      });
      if (rel) out.push({ a: { id: a.id, name: a.name, tracks: a.tracks.length },
                          b: { id: b.id, name: b.name, tracks: b.tracks.length }, ...rel });
    }
  const RANK = { duplicate: 0, 'near-duplicate': 1, view: 2, 'event-copy': 3, 'set-drawn-from': 4,
                 'mood-variant': 5, 'era-variant': 6, subset: 7, variant: 8, related: 9 };
  return out.sort((x, y) => (RANK[x.kind] - RANK[y.kind]) || (y.confidence - x.confidence));
}

/**
 * Collapse the relationships into §19's shape: a parent collection with the
 * views and derivatives hanging off it.
 *
 * This is what makes Tidy able to say "these four playlists are one musical
 * identity seen four ways" rather than treating them as four buckets that
 * suspiciously overlap.
 */
export function collections(relationships) {
  const children = new Map();   // parentId -> [{id, name, kind, ...}]
  for (const r of relationships) {
    if (!r.parentId || !r.childId) continue;
    if (!['view', 'event-copy', 'set-drawn-from', 'mood-variant', 'era-variant', 'subset'].includes(r.kind)) continue;
    const parent = r.a.id === r.parentId ? r.a : r.b;
    const child = r.a.id === r.childId ? r.a : r.b;
    const list = children.get(r.parentId) ?? { parent, views: [] };
    list.views.push({ ...child, kind: r.kind, confidence: +r.confidence.toFixed(3), why: r.why });
    children.set(r.parentId, list);
  }
  // Subsets are transitive: if A contains B and B contains C, then A contains
  // C too, and reporting C as a view of B as well makes the event playlist
  // look like a parent collection of its own. Only a playlist nothing else
  // contains heads a collection.
  const isChild = new Set([...children.values()].flatMap(c => c.views.map(v => v.id)));
  return [...children.entries()]
    .filter(([id]) => !isChild.has(id))
    .map(([, c]) => ({ ...c, views: c.views.sort((a, b) => b.confidence - a.confidence) }))
    .sort((a, b) => b.views.length - a.views.length);
}
