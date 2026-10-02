// What the engine can honestly do for *this* account, today.
//
// An account with nothing filed contains no structure to learn from. That is
// arithmetic, not a shortcoming to engineer around, and the plan says so
// rather than hiding it (§7). What follows from it is that the engine must know
// which rung it is standing on and **say so**, because silently degrading is
// how a tool loses trust: "low confidence" and "not enough of your library
// filed yet to be confident" are different sentences, and only the second tells
// somebody what would fix it.
//
// The rungs are about evidence, not about library size. A listener with 4,000
// tracks in two enormous buckets is on a lower rung than one with 400 tracks
// across twenty, because the second has told the engine far more about what
// they mean.
import { MIN_DEFINITION_TRACKS } from './space.mjs';
import { registrantOf, formatOf, eraOf } from './features.mjs';
import { mirrorPredicate } from '../playlists/mirror.mjs';

export const COLDSTART_VERSION = '4.0.0';

export const RUNGS = {
  /** Nothing filed. There is nowhere to place anything, so the engine does not
   *  try — it helps build a taxonomy instead. */
  NOTHING: 0,
  /** A few buckets. Too sparse for co-occurrence to mean anything, so placement
   *  runs on artist identity and shape, and says so. */
  SPARSE: 1,
  /** Enough buckets and enough cross-bucket artists for the graph to work. */
  WORKING: 2,
  /** Established: the graph is dense and labels carry real signal too. */
  ESTABLISHED: 3,
};

export const RUNG_NAMES = {
  0: 'nothing filed yet',
  1: 'a few buckets',
  2: 'enough to learn from',
  3: 'established',
};

/** Below this many filing destinations, pairwise co-occurrence is guesswork:
 *  with five buckets, two artists sharing one is a coincidence away from
 *  sharing none. */
export const MIN_BUCKETS_FOR_GRAPH = 10;

/** And the graph has to have actually found something. An artist seen in one
 *  bucket contributes no co-occurrence evidence, so if nearly every artist is
 *  like that the graph is a formality. */
export const MIN_CONNECTED_SHARE = 0.15;

/** Above this, labels are worth leaning on: enough registrants are concentrated
 *  rather than smeared across everything. */
export const RICH_CONNECTED_SHARE = 0.4;

/**
 * Which rung this account is on, with the reason stated in the same object.
 *
 * The reason is not decoration. Every caller that shows a confidence should be
 * able to show what would raise it, and that string is the only place that
 * information exists.
 */
export function rungOf(lib, space) {
  const destinations = space?.destinations?.size ?? 0;
  const seen = space?.graph?.df?.size ?? 0;
  const connected = space?.graph?.artists ?? 0;
  const connectedShare = seen ? connected / seen : 0;

  let rung = RUNGS.ESTABLISHED;
  let reason = 'your filing is detailed enough for the engine to learn from it';

  if (!destinations) {
    rung = RUNGS.NOTHING;
    reason = 'nothing is filed into a bucket big enough to have a meaning yet, '
           + `so there is nowhere to place anything (a bucket needs ${MIN_DEFINITION_TRACKS} tracks)`;
  } else if (destinations < MIN_BUCKETS_FOR_GRAPH || connectedShare < MIN_CONNECTED_SHARE) {
    rung = RUNGS.SPARSE;
    reason = destinations < MIN_BUCKETS_FOR_GRAPH
      ? `only ${destinations} bucket${destinations === 1 ? '' : 's'} to compare against, `
        + 'so which artists go together is still mostly guesswork'
      : `${Math.round(connectedShare * 100)}% of your artists appear in more than one bucket, `
        + 'so there is little for co-occurrence to find';
  } else if (connectedShare < RICH_CONNECTED_SHARE) {
    rung = RUNGS.WORKING;
    reason = `${destinations} buckets and ${connected} artists with a neighbourhood — `
           + 'enough for the artist graph to carry real weight';
  }

  return {
    rung,
    name: RUNG_NAMES[rung],
    reason,
    destinations,
    artistsSeen: seen,
    artistsConnected: connected,
    connectedShare: +connectedShare.toFixed(4),
    /** Whether an outside tag source may break ties at this rung. Confined to
     *  the rungs where the intrinsic gap is genuinely arithmetic, and never
     *  allowed to override intrinsic evidence above them (§7). */
    mayUseExternalTiebreak: rung <= RUNGS.SPARSE,
    version: COLDSTART_VERSION,
  };
}

/**
 * How much of this account's artists an outside tag table actually covers.
 *
 * The single best predictor of how well the *tag* engine will treat a given
 * listener, and it is currently computed nowhere they can see. `docs/tags.json`
 * ships 4,866 artists built from one library, so a listener whose taste
 * overlaps is well served and one whose does not falls off a cliff — through
 * the same interface, with the same confidence language, and no way to tell
 * which they are. This is that way.
 */
export function tagCoverage(lib, tags, { isMirror = null } = {}) {
  const mirror = mirrorPredicate(lib, { also: isMirror ?? undefined });
  const artists = new Map();

  const note = t => {
    for (const a of t?.artists ?? []) {
      if (a?.id) artists.set(a.id, a.name ?? a.id);
    }
  };
  for (const p of lib?.playlists ?? []) {
    if (mirror(p)) continue;
    for (const t of p.tracks ?? []) note(t);
  }
  for (const t of lib?.liked ?? []) note(t);

  let covered = 0;
  const missing = [];
  for (const [id, name] of artists) {
    if (tags?.[id]?.tags?.length) covered++;
    else missing.push({ id, name });
  }

  return {
    artists: artists.size,
    covered,
    share: artists.size ? +(covered / artists.size).toFixed(4) : null,
    missing: missing.slice(0, 50),
    version: COLDSTART_VERSION,
  };
}

/* ---------- rung 0: help build a taxonomy, do not pretend to file ---------- */

/** A proposal smaller than this is a handful of records, not a bucket. */
export const MIN_PROPOSAL = 4;

/**
 * Group tracks into candidate buckets using only what exists before any filing
 * has happened: who made them, what kind of object they are, and when.
 *
 * Deliberately not the placement engine. At rung 0 there are no buckets to
 * place into, so the useful question is not "where does this go" but "what
 * groups are already here" — and answering the first when only the second is
 * well-posed is how an empty account gets shown confident nonsense.
 *
 * Grouped on the primary artist first, because billing order carries the
 * record, then merged where two groups share a format and era. Crude by design:
 * this output is a suggestion a person names, not a decision.
 */
export function proposeBuckets(tracks, { minProposal = MIN_PROPOSAL, limit = 12 } = {}) {
  const byArtist = new Map();
  for (const t of tracks ?? []) {
    const lead = (t?.artists ?? [])[0];
    if (!t?.id || !lead?.id) continue;
    if (!byArtist.has(lead.id)) byArtist.set(lead.id, { artist: lead.name ?? lead.id, tracks: [] });
    byArtist.get(lead.id).tracks.push(t);
  }

  // An artist with enough records is a proposal on their own; the rest are
  // pooled by the shape of the record, which is the only other thing known.
  const proposals = [];
  const leftovers = [];
  for (const { artist, tracks: rows } of byArtist.values()) {
    if (rows.length >= minProposal) {
      proposals.push({ kind: 'artist', label: artist, tracks: rows });
    } else {
      leftovers.push(...rows);
    }
  }

  const byShape = new Map();
  for (const t of leftovers) {
    const f = formatOf(t);
    const era = eraOf(t) ?? 'unknown era';
    // Long-and-few versus short-and-many is the club/album split, and it is the
    // one shape distinction that survives having no other information at all.
    const length = f.minutes === null ? 'unknown length' : f.minutes >= 5.5 ? 'long' : 'short';
    const key = `${era} · ${length} · ${f.albumType ?? 'unknown release'}`;
    if (!byShape.has(key)) byShape.set(key, []);
    byShape.get(key).push(t);
  }
  for (const [label, rows] of byShape) {
    if (rows.length >= minProposal) proposals.push({ kind: 'shape', label, tracks: rows });
  }

  return proposals
    .sort((a, b) => b.tracks.length - a.tracks.length)
    .slice(0, limit)
    .map(p => ({
      kind: p.kind,
      label: p.label,
      size: p.tracks.length,
      // A label family shared across a proposal is worth showing: it is often
      // the thing that makes a group obvious to its owner.
      labels: [...new Set(p.tracks.map(registrantOf).filter(Boolean))].slice(0, 3),
      examples: p.tracks.slice(0, 4).map(t => ({
        id: t.id, name: t.name ?? null,
        artists: (t.artists ?? []).map(a => a?.name ?? a?.id).filter(Boolean),
      })),
    }));
}
