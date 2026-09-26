// Raw provider strings -> canonical concepts, as evidence records.
//
// §8: normalise aggressively where providers only differ in spelling, never
// where they differ in meaning, and never throw an unfamiliar tag away. An
// unmapped string becomes an `unknown` record carrying its raw value, so the
// review queue can surface "forty of your tracks are tagged `hard groove` and
// the ontology has no concept for it" instead of the tag simply vanishing.
import { resolveConcept } from '../ontology/index.mjs';
import { evidence } from './evidence.mjs';
import { usableTag } from '../../profile.mjs';

/** Last.fm's tag counts run 0-100 relative to the artist's own top tag. */
const LASTFM_SCALE = 100;

/**
 * How strongly a provider asserts one value out of a weighted list.
 *
 * Providers hand back counts on their own scales — Last.fm 0-100 against the
 * top tag, Discogs a raw tally of releases carrying that style — so the value
 * is normalised against the strongest claim in the same list. What survives
 * is the shape of the answer ("this one is the headline, these three are
 * minor"), which is what actually transfers between sources.
 */
export function relativeStrength(count, max) {
  const c = Number(count), m = Number(max);
  if (!Number.isFinite(c) || !Number.isFinite(m) || m <= 0) return 0.5;
  return Math.max(0, Math.min(1, c / m));
}

/** The evidence `field` a resolved facet belongs in. */
const FIELD_OF_FACET = { genre: 'genre', mood: 'mood', context: 'context', era: 'era', descriptor: 'descriptor' };

// An exact alias hit is the provider's own word for a concept we know. A
// suffix hit ("dark techno" -> techno) is an inference we made, correct far
// more often than not but still ours rather than theirs, so it is discounted
// and its provenance says so.
// A person telling us what a tag means is not a provider claim at all — it is
// the most reliable statement available about their own library, and it is
// not discounted.
const VIA_FACTOR = { alias: 1, year: 1, fallback: 1, suffix: 0.7, descriptor: 1, unknown: 1, user: 1, empty: 0 };

/**
 * Turn one provider's weighted value list into evidence records.
 *
 * @param {[string, number][]} values  [raw, count] pairs, any scale
 * @param {object} ctx
 * @param {string} ctx.source          provider id
 * @param {string} ctx.entityType      what the values are about
 * @param {string|null} ctx.entityId
 * @param {number} ctx.identityConfidence
 * @param {number} [ctx.sourceReliability] how much this endpoint is trusted at all, 0-1
 * @param {number} [ctx.retrievedAt]
 * @param {object} [ctx.provenance]
 * @returns {Readonly<import('./evidence.mjs').Evidence>[]}
 */
export function normaliseValues(values, {
  source, entityType, entityId = null, identityConfidence = 0.5,
  sourceReliability = 1, retrievedAt = Date.now(), provenance = {},
  conceptMap = null,
} = {}) {
  const list = (values ?? []).filter(v => Array.isArray(v) && v[0] != null);
  if (!list.length) return [];
  const max = Math.max(...list.map(([, c]) => Number(c) || 0), 0) || LASTFM_SCALE;

  const out = [];
  for (const [raw, count] of list) {
    const text = String(raw).trim();
    if (!text) continue;
    // Collection cruft — "seen live", "albums i own", "…_batch_26". Dropped
    // here and not carried as unknown: these are not concepts the ontology is
    // missing, they are statements about the tagger. One rule, shared with v1.
    if (!usableTag(text.toLowerCase())) continue;

    let c = resolveConcept(text);
    // §8's loop, closed: the review queue surfaces a tag the ontology cannot
    // place, a person says what it means, and their answer resolves it from
    // then on — for THEIR runs only. It is applied here rather than written
    // into the ontology because §23 is explicit that a personal taxonomy must
    // not corrupt the global model: somebody's idea of what "hard groove"
    // covers is true of their library and not necessarily of the world.
    // Only ever consulted for a string the ontology itself declined, so a
    // correction can fill a gap and never overrule a known concept.
    if (!c.concept && conceptMap) {
      const own = conceptMap.get?.(text.toLowerCase());
      if (own) c = { ...resolveConcept(own), via: 'user', raw: text };
    }
    const field = c.concept ? FIELD_OF_FACET[c.facet] ?? 'unknown' : 'unknown';
    out.push(evidence({
      source, entityType, entityId,
      field,
      rawValue: text,
      concept: c.concept,
      facet: c.facet,
      sourceConfidence: relativeStrength(count, max) * sourceReliability * (VIA_FACTOR[c.via] ?? 1),
      identityConfidence,
      retrievedAt,
      provenance: { ...provenance, resolvedVia: c.via },
    }));
  }
  return out;
}

/**
 * Every raw string that reached us and resolved to nothing, with how often.
 * This is the input to the "unknown ontology concepts" row of the review
 * queue (§20, §35) — the mechanism by which the ontology is supposed to grow
 * from real libraries rather than from guesswork.
 * @param {Iterable<Readonly<import('./evidence.mjs').Evidence>>} records
 * @returns {{raw: string, count: number, sources: string[]}[]}
 */
export function unknownConcepts(records) {
  const tally = new Map();
  for (const r of records) {
    if (r.field !== 'unknown' || r.concept) continue;
    const k = String(r.rawValue).toLowerCase();
    const cur = tally.get(k) ?? { raw: k, count: 0, sources: new Set() };
    cur.count++;
    cur.sources.add(r.source);
    tally.set(k, cur);
  }
  return [...tally.values()]
    .map(u => ({ raw: u.raw, count: u.count, sources: [...u.sources] }))
    .sort((a, b) => b.count - a.count);
}
