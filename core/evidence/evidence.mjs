// The common evidence record — §6 of the v3 plan.
//
// One shape for everything any provider ever says, so that the classifier can
// be written without a single `if (source === 'lastfm')` in it (§36). A
// provider adapter's whole job is to turn its own response into these; from
// here down, nothing knows or cares where a claim came from except as a
// string used for de-correlation and provenance.
//
// Records are frozen. §39: raw evidence is never destroyed and never
// overwritten — a reclassification produces a new derived layer, it does not
// edit what Last.fm said in March. Freezing makes that a property of the code
// rather than a convention nobody enforces.

export const EVIDENCE_VERSION = '3.0.0';

/** What a piece of evidence is *about*. Coarser = weaker (see weights.mjs). */
export const ENTITY_TYPES = ['track', 'recording', 'release', 'release-group', 'album', 'artist', 'playlist', 'library'];

/** What a piece of evidence *claims*. */
export const FIELDS = ['genre', 'mood', 'context', 'era', 'descriptor', 'unknown',
                       'bpm', 'key', 'energy', 'valence', 'voice', 'instrumentation', 'identity'];

/**
 * @typedef {object} Evidence
 * @property {string} source             provider id, e.g. 'lastfm'. Provenance only.
 * @property {string} entityType         one of ENTITY_TYPES
 * @property {string|null} entityId      the provider's id for that entity
 * @property {string} field              one of FIELDS
 * @property {*} rawValue                exactly what the provider said
 * @property {string|null} concept       canonical concept, null when unmapped
 * @property {number} sourceConfidence   0-1, how strongly the source asserts it
 * @property {number} identityConfidence 0-1, how sure we are it is about our track
 * @property {number} retrievedAt        epoch ms
 * @property {object} provenance         free-form: how it was matched, endpoint, version
 */

const clamp01 = x => Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));

/**
 * Build one frozen evidence record. Missing optional fields get conservative
 * defaults rather than throwing: a provider adapter that cannot say how
 * confident it is should not be able to accidentally claim certainty.
 * @returns {Readonly<Evidence>}
 */
export function evidence({
  source, entityType, entityId = null, field, rawValue,
  concept = null, facet = null, sourceConfidence = 0.5, identityConfidence = 0.5,
  retrievedAt = Date.now(), provenance = {},
} = {}) {
  if (!source) throw new Error('evidence() needs a source');
  if (!ENTITY_TYPES.includes(entityType)) throw new Error(`unknown entityType: ${entityType}`);
  if (!FIELDS.includes(field)) throw new Error(`unknown field: ${field}`);
  return Object.freeze({
    source, entityType, entityId, field,
    rawValue,
    concept, facet,
    sourceConfidence: clamp01(sourceConfidence),
    identityConfidence: clamp01(identityConfidence),
    retrievedAt,
    provenance: Object.freeze({ ...provenance }),
    version: EVIDENCE_VERSION,
  });
}

/**
 * Everything known about one track, as an append-only bag of records.
 *
 * Append-only on purpose. Re-running an enrichment adds newer records beside
 * the old ones rather than replacing them, so "what did we think last March,
 * and on what basis" stays answerable — which is what makes a reclassification
 * after an ontology change reviewable instead of a leap of faith.
 */
export class EvidenceSet {
  /** @param {import('../identity/track-identity.mjs').TrackIdentity} identity */
  constructor(identity, records = []) {
    this.identity = identity;
    this.records = [...records];
  }

  /** @param {...Readonly<Evidence>} records */
  add(...records) {
    for (const r of records) if (r) this.records.push(r);
    return this;
  }

  /** Records matching every supplied predicate field. */
  where({ field = null, source = null, entityType = null, facet = null } = {}) {
    return this.records.filter(r =>
      (field == null || r.field === field)
      && (source == null || r.source === source)
      && (entityType == null || r.entityType === entityType)
      && (facet == null || r.facet === facet));
  }

  /** The distinct providers that have said anything at all. */
  get sources() { return [...new Set(this.records.map(r => r.source))]; }

  /**
   * The freshest record per (source, entity, field, value). Re-running an
   * enrichment appends rather than replaces, so the classifier has to be told
   * which copy counts — otherwise fetching the same artist twice would double
   * that artist's vote.
   */
  current() {
    const best = new Map();
    for (const r of this.records) {
      const k = JSON.stringify([r.source, r.entityType, r.entityId, r.field, String(r.rawValue)]);
      const prev = best.get(k);
      if (!prev || r.retrievedAt >= prev.retrievedAt) best.set(k, r);
    }
    return [...best.values()];
  }

  /** How many distinct providers contributed to a given field. */
  coverage(field = 'genre') {
    return new Set(this.where({ field }).map(r => r.source)).size;
  }

  toJSON() { return { identity: this.identity, records: this.records }; }

  static fromJSON(json) {
    return new EvidenceSet(json?.identity ?? null,
      (json?.records ?? []).map(r => Object.freeze({ ...r, provenance: Object.freeze({ ...r.provenance }) })));
  }
}
