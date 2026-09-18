// How much one piece of evidence counts — §9 of the v3 plan.
//
// The plan is explicit that this must not be a hard-coded global ranking of
// providers, and the reason is worth restating: "Last.fm beats Discogs" is
// only ever true *on average*, and the cases that actually misfile a track
// are the ones where it is false — a thin autocorrected artist answer against
// a dozen agreeing release styles. So no provider is named anywhere in this
// file. What is weighed is the *shape* of the claim:
//
//   how specific   a track-level statement beats an artist-level one
//   how well tied  matched by ISRC beats matched by a name with autocorrect
//   how strongly   the provider's own confidence in its answer
//   how fresh      tag clouds and catalogues both grow
//
// Providers declare their own reliability and independence group through the
// capability interface (core/sources/provider.mjs); this module consumes
// those declarations without knowing what produced them.

export const WEIGHTS_VERSION = '3.0.0';

/**
 * Entity specificity. §9's conceptual hierarchy, made numeric.
 *
 * The gap between release-level and artist-level is the single most
 * consequential number in the engine: it is what stops a diverse artist
 * making every track they ever touched look like one genre (§4.1). It is
 * deliberately wide.
 */
export const SPECIFICITY = {
  'track': 1.00,          // an analysis or tag about this recording
  'recording': 1.00,
  'release': 0.70,        // the single/EP it came out on
  'release-group': 0.55,
  'album': 0.55,
  'artist': 0.35,         // contextual evidence, never the canonical unit
  'playlist': 0.20,       // where the listener put it — see personal layer
  'library': 0.10,
};

/** Evidence older than this starts to decay; it never decays below FLOOR. */
export const RECENCY_HALFLIFE_MS = 1000 * 60 * 60 * 24 * 365 * 3; // ~3 years
export const RECENCY_FLOOR = 0.7;

/**
 * How much the age of a claim discounts it. Gentle and floored: a genre does
 * not stop being true because it was fetched in 2023, but a tag cloud that
 * was thin three years ago may well have filled out since, so fresher
 * evidence about the same entity should edge ahead of staler evidence.
 */
export function recencyFactor(retrievedAt, now = Date.now()) {
  const age = Math.max(0, now - (retrievedAt ?? 0));
  const decayed = Math.pow(0.5, age / RECENCY_HALFLIFE_MS);
  return RECENCY_FLOOR + (1 - RECENCY_FLOOR) * decayed;
}

/**
 * The weight of one evidence record, before any agreement between records is
 * considered.
 *
 * @param {Readonly<import('./evidence.mjs').Evidence>} r
 * @param {{now?: number, reliabilityOf?: (source: string) => number}} [opts]
 *   `reliabilityOf` comes from the provider registry — a capability
 *   declaration, not a table in the classifier.
 * @returns {number} unbounded-above but in practice 0-1
 */
export function evidenceWeight(r, { now = Date.now(), reliabilityOf = () => 1 } = {}) {
  if (!r) return 0;
  const specificity = SPECIFICITY[r.entityType] ?? 0.2;
  return specificity
    * (r.identityConfidence ?? 0)
    * (r.sourceConfidence ?? 0)
    * (reliabilityOf(r.source) ?? 1)
    * recencyFactor(r.retrievedAt, now);
}

/**
 * Independent agreement, de-correlated.
 *
 * Two sources agreeing is the strongest thing that can happen to a
 * classification — but only if they are actually independent. Last.fm's
 * artist tags and Last.fm's track tags are the same crowd answering twice;
 * counting that as corroboration is how a confident wrong answer gets made.
 * So agreement is counted over *independence groups*, which providers declare
 * (see provider.mjs), not over source names.
 *
 * The curve is deliberately flat after the second group: going from one
 * source to two is the difference between a claim and a corroborated claim;
 * going from three to four is barely anything.
 *
 * @param {number} groups how many independent groups asserted the same concept
 * @returns {number} multiplier, 1 for a single group
 */
export const AGREEMENT_BONUS = 0.45;
export function agreementFactor(groups) {
  const g = Math.max(1, groups | 0);
  return 1 + AGREEMENT_BONUS * (1 - 1 / g);
}

/**
 * How much a contradicting concept costs. Applied when two candidates are
 * declared to argue against each other in the ontology (contradicts()), which
 * is rare by design — garage-rock vs uk-garage is the shape: tag clouds
 * confuse them constantly and records never are both.
 */
export const CONTRADICTION_PENALTY = 0.5;

/**
 * The share of a parent's score that a child genre's evidence passes upward.
 *
 * Evidence for Tech House is evidence for House. It is not *equal* evidence
 * for House — a listener with a Tech House playlist and a House playlist
 * wants those kept apart — but a hierarchy that passed nothing up would score
 * a track with evidence spread over three sibling subgenres as having no
 * opinion at all, when it plainly has a strong one about the parent.
 */
export const LINEAGE_LIFT = 0.6;

/**
 * And the reverse: how much a parent's evidence supports each of its
 * children. Much smaller, and for a different reason — "house" on a record
 * genuinely is weak evidence for "tech house", but it is weak evidence for
 * every other house subgenre equally, so it must never be enough to pick one.
 */
export const LINEAGE_DESCENT = 0.15;
