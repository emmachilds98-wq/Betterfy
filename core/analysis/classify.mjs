// The deterministic classifier — §12 of the v3 plan.
//
// Reads an EvidenceSet, writes a classification. No provider is named
// anywhere in this file and none can be: every property of a source that
// matters has already been folded into the records (specificity, identity
// confidence, source confidence) or is looked up through the registry's
// capability declarations (reliability, independence).
//
// The two things this does that v1's cosine model structurally cannot:
//
//  1. It reconciles up and down a hierarchy. Evidence split between Tech
//     House, Deep House and Progressive House is not an ambiguous track; it
//     is a confident House track. v1 sees three unrelated tag strings.
//  2. It is allowed to say it does not know (§4.6). v1 always produces a
//     ranking, so a track with two tags from one thin artist answer looks the
//     same as one with twelve agreeing across three sources.
import { GENRE_INDEX, lineageOf, ancestorsOf, isWithin, contradicts, ONTOLOGY_VERSION } from '../ontology/index.mjs';
import { evidenceWeight, agreementFactor, CONTRADICTION_PENALTY, LINEAGE_LIFT, LINEAGE_DESCENT, WEIGHTS_VERSION } from '../evidence/weights.mjs';

export const CLASSIFIER_VERSION = '3.0.0';

/** §27: calibrated bands, not a similarity score dressed up as a probability. */
export const CONFIDENCE = {
  HIGH: 'HIGH',
  LIKELY: 'LIKELY',
  AMBIGUOUS: 'AMBIGUOUS',
  INSUFFICIENT_DATA: 'INSUFFICIENT_DATA',
};

/* The thresholds. Every one of these is a starting point to be re-fitted
 * against the benchmark (§26) — they are gathered here, named, and read from
 * exactly one place so that re-fitting them is a diff a reviewer can check
 * rather than an archaeology exercise. */
export const THRESHOLDS = {
  // Below this total weight there is not enough evidence to say anything.
  // Calibrated against the weakest case worth answering: a single artist-level
  // Last.fm answer matched by name (0.35 specificity x 0.55 identity) with one
  // headline tag ~= 0.14.
  MIN_TOTAL_WEIGHT: 0.12,
  // The leader must hold this share of all genre weight to be anything but
  // ambiguous.
  MIN_LEADER_SHARE: 0.30,
  // Two candidates from different branches this close together are a genuine
  // disagreement, not a winner and a runner-up.
  AMBIGUOUS_RATIO: 0.80,
  // HIGH additionally needs a clear margin and more than one independent
  // source saying so.
  HIGH_LEADER_SHARE: 0.45,
  HIGH_MARGIN_RATIO: 0.60,
  HIGH_MIN_GROUPS: 2,
  HIGH_MIN_WEIGHT: 0.45,
  // Promote from a parent to one of its children when the child is backed by
  // this share of the parent's score in its own right.
  SPECIFIC_ENOUGH: 0.45,
};

/**
 * Accumulate one facet's evidence into per-concept scores.
 *
 * `direct` is weight from evidence naming the concept itself; `lifted` is
 * weight inherited through the hierarchy. They are kept apart because the
 * reconciliation step needs to know the difference — a genre that is only
 * ever inherited has never actually been asserted by anybody.
 *
 * @returns {Map<string, {concept: string, direct: number, lifted: number, score: number,
 *                        groups: Set<string>, records: object[]}>}
 */
export function accumulate(records, { now = Date.now(), reliabilityOf, independenceOf, hierarchy = false } = {}) {
  const acc = new Map();
  const bump = (concept, field, w, r, group) => {
    if (!concept || !(w > 0)) return;
    const cur = acc.get(concept) ?? { concept, direct: 0, lifted: 0, score: 0, groups: new Set(), records: [] };
    cur[field] += w;
    // 'descent' is a parent's weight borrowed downward and is nobody's
    // assertion about the child, so it never brings corroboration with it.
    if (field !== 'descent') { cur.groups.add(group); cur.records.push(r); }
    acc.set(concept, cur);
  };

  for (const r of records) {
    if (!r.concept) continue;
    const w = evidenceWeight(r, { now, reliabilityOf });
    if (!(w > 0)) continue;
    const group = independenceOf ? independenceOf(r.source) : r.source;
    bump(r.concept, 'direct', w, r, group);
    if (!hierarchy) continue;
    // Evidence for a child is evidence for its parents, discounted per level
    // so a deep subgenre does not swamp the root of the tree. Lifted weight
    // carries its supporting records and its independence group with it: two
    // sources naming two different house subgenres really do independently
    // corroborate House, and a parent candidate has to be able to explain
    // itself from the evidence underneath it.
    let lift = LINEAGE_LIFT;
    for (const up of ancestorsOf(r.concept)) { bump(up, 'lifted', w * lift, r, group); lift *= LINEAGE_LIFT; }
  }

  // And downward, but only onto children that already have evidence of their
  // own: "house" is weak support for "tech house" and equally weak support
  // for every other house subgenre, so it may strengthen a candidate and must
  // never create one.
  if (hierarchy) {
    for (const [concept, node] of [...acc]) {
      for (const child of GENRE_INDEX.get(concept)?.children ?? []) {
        const c = acc.get(child);
        if (c?.direct > 0) c.lifted += node.direct * LINEAGE_DESCENT;
      }
      void node;
    }
  }

  for (const c of acc.values()) {
    const base = c.direct + c.lifted;
    // Independent corroboration is applied to the whole candidate rather than
    // per record, because it is a property of the agreement, not of any one
    // source. Groups, not source names: two Last.fm endpoints are one voice.
    c.score = base * agreementFactor(c.groups.size);
  }
  return acc;
}

/** Apply the ontology's declared contradictions between surviving candidates. */
function applyContradictions(acc) {
  const entries = [...acc.values()];
  for (const a of entries)
    for (const b of entries) {
      if (a === b || !contradicts(a.concept, b.concept)) continue;
      // Both are penalised, in proportion to the other's strength: two genres
      // that never co-occur on one record cannot both be right, and which is
      // wrong is exactly what we do not know yet.
      a.score *= 1 - CONTRADICTION_PENALTY * Math.min(1, b.score / (a.score + b.score));
    }
  return acc;
}

/**
 * Hierarchical reconciliation: prefer the most specific genre the evidence
 * supports in its own right, and otherwise stay at the level it does.
 *
 * Two tests, and the second is the one that matters. A child clearing
 * SPECIFIC_ENOUGH against its parent is not sufficient on its own, because
 * the parent's score is largely lift from that same child — the test is
 * partly circular, and on a three-way sibling split it fires for whichever
 * subgenre happened to poll one point higher. So a promotion also has to beat
 * the strongest *sibling* by a clear margin. Evidence spread evenly over Tech
 * House, Deep House and Progressive House stays "House", which is the true
 * answer and the one a listener can file on.
 */
export const SIBLING_DOMINANCE = 1.4;

function reconcile(ranked) {
  const leader = ranked[0];
  if (!leader) return null;
  const byConcept = new Map(ranked.map(c => [c.concept, c]));
  for (const c of ranked) {
    if (c === leader || !isWithin(c.concept, leader.concept)) continue;
    // Substantially backed relative to the answer it would replace. Without
    // this, a weak node deep in the tree can hijack a broad parent that only
    // leads on lift from several unrelated branches.
    if (c.direct < THRESHOLDS.SPECIFIC_ENOUGH * leader.score) continue;
    // And asserted more than the parent was in its own right. A catalogue
    // that says "Techno" on three releases and "Minimal Techno" on two has
    // named the parent more often than the child, and the majority reading is
    // the one to file on — Minimal Techno stays visible as an alternative.
    // Comparing direct against direct, rather than against the parent's total
    // score, also breaks the circularity of a parent whose score is mostly
    // lift from this very child.
    if (c.direct <= leader.direct) continue;
    const parent = GENRE_INDEX.get(c.concept)?.parent;
    const bestSibling = Math.max(0, ...(GENRE_INDEX.get(parent)?.children ?? [])
      .filter(s => s !== c.concept)
      .map(s => byConcept.get(s)?.direct ?? 0));
    if (c.direct >= SIBLING_DOMINANCE * bestSibling) return c;  // ranked is score-ordered: the first hit is the strongest
  }
  return leader;
}

/**
 * Classify one facet's worth of evidence.
 *
 * @param {Readonly<import('../evidence/evidence.mjs').Evidence>[]} records
 * @param {{registry?: import('../sources/provider.mjs').ProviderRegistry, now?: number, hierarchy?: boolean}} opts
 */
export function classifyFacet(records, { registry = null, now = Date.now(), hierarchy = false } = {}) {
  const acc = accumulate(records, {
    now,
    reliabilityOf: registry?.reliabilityOf,
    independenceOf: registry?.independenceOf,
    hierarchy,
  });
  if (hierarchy) applyContradictions(acc);

  const ranked = [...acc.values()].sort((a, b) => b.score - a.score || a.concept.localeCompare(b.concept));
  const total = ranked.reduce((s, c) => s + c.score, 0);
  return { ranked, total, groups: new Set(ranked.flatMap(c => [...c.groups])) };
}

/**
 * The confidence band for a genre answer. Split out so the benchmark can
 * report band-by-band accuracy — §27 is explicit that a band only means
 * something if it has been validated against measured performance.
 */
/** Candidates that genuinely compete with the answer — its own lineage does not. */
const rivalsOf = (primary, ranked) => ranked.filter(c =>
  c !== primary && !isWithin(c.concept, primary.concept) && !isWithin(primary.concept, c.concept));

/**
 * The share of *competing* evidence the answer holds.
 *
 * Measured against rivals rather than against every candidate, because
 * "House" and "Electronic" scoring highly alongside "Tech House" is the
 * hierarchy agreeing with itself at three resolutions, not three claims
 * splitting the vote. Dividing by the lot made a unanimously-sourced track
 * look less certain the deeper its genre sat in the tree.
 */
export function leaderShare(primary, ranked) {
  if (!primary) return 0;
  const competing = rivalsOf(primary, ranked).reduce((s, c) => s + c.score, 0);
  const denom = primary.score + competing;
  return denom > 0 ? primary.score / denom : 0;
}

export function calibrate({ primary, ranked, total, groupCount }) {
  if (!primary || total < THRESHOLDS.MIN_TOTAL_WEIGHT) return CONFIDENCE.INSUFFICIENT_DATA;

  const share = leaderShare(primary, ranked);
  // The strongest candidate that is *not* part of the answer. A parent or a
  // child of the primary is agreement about the same music at a different
  // resolution, not a competing claim.
  const rival = rivalsOf(primary, ranked)[0];
  const marginRatio = rival ? rival.score / primary.score : 0;

  if (share < THRESHOLDS.MIN_LEADER_SHARE || marginRatio > THRESHOLDS.AMBIGUOUS_RATIO) return CONFIDENCE.AMBIGUOUS;
  if (share >= THRESHOLDS.HIGH_LEADER_SHARE
      && marginRatio <= THRESHOLDS.HIGH_MARGIN_RATIO
      && groupCount >= THRESHOLDS.HIGH_MIN_GROUPS
      && primary.score >= THRESHOLDS.HIGH_MIN_WEIGHT) return CONFIDENCE.HIGH;
  return CONFIDENCE.LIKELY;
}

/** Human-readable reasons, built from the records that actually did the work. */
function explain(primary, ranked) {
  const lines = [];
  if (!primary) {
    lines.push({ mark: 'x', text: 'no source supplied a genre we could map to the ontology' });
    return lines;
  }
  const bySpecificity = [...primary.records].sort((a, b) =>
    (b.identityConfidence * b.sourceConfidence) - (a.identityConfidence * a.sourceConfidence));
  const seen = new Set();
  for (const r of bySpecificity) {
    const k = `${r.source}:${r.entityType}`;
    if (seen.has(k)) continue;
    seen.add(k);
    lines.push({
      mark: r.entityType === 'artist' ? 'note' : 'tick',
      text: `${r.entityType}-level ${r.source} evidence: "${r.rawValue}"`
        + (r.provenance?.matchedBy ? ` (matched by ${r.provenance.matchedBy})` : ''),
    });
    if (lines.length >= 4) break;
  }
  if (primary.lifted > primary.direct)
    lines.push({ mark: 'note', text: `mostly inherited from subgenres rather than named directly` });
  const rival = rivalsOf(primary, ranked)[0];
  if (rival) lines.push({ mark: 'warn', text: `${rival.concept} evidence is present but weaker` });
  if (primary.groups.size < 2)
    lines.push({ mark: 'warn', text: 'only one independent source — nothing corroborates it' });
  return lines;
}

/**
 * Classify one track's genre from its evidence.
 *
 * @param {import('../evidence/evidence.mjs').EvidenceSet} set
 * @param {{registry?, now?: number}} [opts]
 * @returns {{primary: string|null, parents: string[], secondary: string[], alternatives: string[],
 *            confidence: string, score: number, share: number, candidates: object[], explanation: object[]}}
 */
export function classifyGenre(set, { registry = null, now = Date.now() } = {}) {
  const records = (set?.current?.() ?? set?.records ?? []).filter(r => r.field === 'genre' && r.concept);
  const { ranked, total } = classifyFacet(records, { registry, now, hierarchy: true });
  const primary = reconcile(ranked);
  const groupCount = primary ? primary.groups.size : 0;
  const confidence = calibrate({ primary, ranked, total, groupCount });

  const parents = primary ? ancestorsOf(primary.concept) : [];
  const inLineage = new Set(primary ? lineageOf(primary.concept) : []);
  // A secondary genre is a real second claim: outside the primary's lineage
  // and strong enough to be worth naming.
  const secondary = ranked
    .filter(c => c !== primary && !inLineage.has(c.concept) && !isWithin(c.concept, primary?.concept ?? ''))
    .slice(0, 2).map(c => c.concept);
  // An alternative is the same music read at a different point in the tree:
  // the "did you mean Minimal Techno" row. Which way to look depends on how
  // the answer was reached. When reconciliation settled on a parent because
  // its children split the evidence, the children ARE the alternatives and
  // naming them is the whole value of the answer ("House — mostly Tech House,
  // some Deep House"). When the answer is already specific, the alternatives
  // are its siblings.
  const node = primary ? GENRE_INDEX.get(primary.concept) : null;
  const children = new Set(node?.children ?? []);
  const fromChildren = ranked.filter(c => children.has(c.concept) && c.direct > 0);
  const alternatives = (fromChildren.length ? fromChildren
    : ranked.filter(c => c !== primary && node?.parent && GENRE_INDEX.get(c.concept)?.parent === node.parent))
    .slice(0, 3).map(c => c.concept);

  return {
    primary: primary?.concept ?? null,
    parents,
    secondary,
    alternatives,
    confidence,
    score: primary ? +primary.score.toFixed(4) : 0,
    share: +leaderShare(primary, ranked).toFixed(3),
    sources: primary ? [...new Set(primary.records.map(r => r.source))] : [],
    independentGroups: groupCount,
    candidates: ranked.slice(0, 6).map(c => ({
      concept: c.concept, score: +c.score.toFixed(4),
      direct: +c.direct.toFixed(4), lifted: +c.lifted.toFixed(4),
      groups: [...c.groups], records: c.records.length,
    })),
    explanation: explain(primary, ranked),
    versions: { classifier: CLASSIFIER_VERSION, ontology: ONTOLOGY_VERSION, weights: WEIGHTS_VERSION },
  };
}

/**
 * Classify a flat facet (mood, context, era) — no hierarchy, multi-label.
 * Returns everything that cleared the floor, because a track can genuinely be
 * both dark and hypnotic and forcing one would be the same mistake §4.3 is
 * about, one dimension over.
 */
export function classifyFlatFacet(set, facetField, { registry = null, now = Date.now(), max = 4 } = {}) {
  const records = (set?.current?.() ?? set?.records ?? []).filter(r => r.field === facetField && r.concept);
  const { ranked, total } = classifyFacet(records, { registry, now, hierarchy: false });
  if (!ranked.length || total <= 0) return { primary: null, values: [], confidence: CONFIDENCE.INSUFFICIENT_DATA };
  const values = ranked.slice(0, max).map(c => ({ concept: c.concept, weight: +(c.score / total).toFixed(3) }));
  return {
    primary: values[0]?.concept ?? null,
    values,
    confidence: total < THRESHOLDS.MIN_TOTAL_WEIGHT ? CONFIDENCE.INSUFFICIENT_DATA
      : values.length > 1 && values[1].weight / values[0].weight > THRESHOLDS.AMBIGUOUS_RATIO ? CONFIDENCE.AMBIGUOUS
      : CONFIDENCE.LIKELY,
  };
}
