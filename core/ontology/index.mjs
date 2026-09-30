// The ontology as the rest of the engine sees it: one resolve() that turns a
// provider's raw string into a canonical concept, plus the derived structure
// (children, ancestry, related closure) the classifier reconciles against.
//
// Everything here is derived from the declarations in genres.mjs and
// facets.mjs at module load. Nothing is hand-maintained twice, and
// validateOntology() — run by the test suite, not at runtime — is what stops
// a typo in a parent name from silently producing an orphan genre nobody can
// ever reach.
import { GENRES, GENRE_ONTOLOGY_VERSION } from './genres.mjs';
import { MOODS, CONTEXTS, ERAS, FACET_ONTOLOGY_VERSION, facetOf, eraOfYear } from './facets.mjs';

export { facetOf, eraOfYear, FACETS } from './facets.mjs';
export { GENRES } from './genres.mjs';

/** One version string for the whole ontology — stamped onto every profile. */
export const ONTOLOGY_VERSION = `genres@${GENRE_ONTOLOGY_VERSION}+facets@${FACET_ONTOLOGY_VERSION}`;

/**
 * The lookup key for a raw provider string.
 *
 * Whitespace and punctuation are removed entirely rather than collapsed,
 * because providers disagree about them constantly and meaninglessly:
 * "tech house", "tech-house" and "techhouse" are one concept, and no pair of
 * genuinely different genres is separated only by a space. "&" becomes "and"
 * first so "drum & bass" and "drum and bass" land together.
 */
export const normKey = s => String(s ?? '').toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, '');

/* ---------- derived genre structure ---------- */

function buildGenreIndex() {
  const index = new Map();
  for (const [slug, node] of Object.entries(GENRES))
    index.set(slug, { slug, parent: node.parent ?? null, children: [], ancestors: [], depth: 0,
                      related: new Set(node.related ?? []), contradicts: new Set(node.contradicts ?? []) });

  for (const g of index.values())
    if (g.parent && index.has(g.parent)) index.get(g.parent).children.push(g.slug);

  // Ancestry, walked once per genre with a depth cap so a declaration cycle
  // (which validateOntology() reports) cannot hang a caller at runtime.
  for (const g of index.values()) {
    const seen = new Set();
    let cur = g.parent;
    while (cur && index.has(cur) && !seen.has(cur) && g.ancestors.length < 16) {
      seen.add(cur);
      g.ancestors.push(cur);
      cur = index.get(cur).parent;
    }
    g.depth = g.ancestors.length;
  }

  // `related` is symmetric whether or not both sides declared it. Declaring
  // it once is the point; a one-way relation is always a typo.
  for (const g of index.values())
    for (const r of g.related) if (index.has(r)) index.get(r).related.add(g.slug);
  for (const g of index.values())
    for (const c of g.contradicts) if (index.has(c)) index.get(c).contradicts.add(g.slug);

  return index;
}

/** slug -> { slug, parent, children, ancestors, depth, related, contradicts } */
export const GENRE_INDEX = buildGenreIndex();

function buildAliasIndex() {
  const byKey = new Map();
  const collisions = [];
  const put = (raw, slug) => {
    const k = normKey(raw);
    if (!k) return;
    const prev = byKey.get(k);
    if (prev && prev !== slug) { collisions.push({ key: k, between: [prev, slug] }); return; }
    byKey.set(k, slug);
  };
  for (const [slug, node] of Object.entries(GENRES)) {
    put(slug, slug);
    put(slug.replace(/-/g, ' '), slug);
    for (const a of node.aliases ?? []) put(a, slug);
  }
  return { byKey, collisions };
}

const GENRE_ALIASES = buildAliasIndex();
/** normKey(raw) -> genre slug */
export const GENRE_ALIAS_INDEX = GENRE_ALIASES.byKey;

function buildFacetAliases(table) {
  const byKey = new Map();
  const collisions = [];
  for (const [id, node] of Object.entries(table)) {
    for (const raw of [id, id.replace(/-/g, ' '), ...(node.aliases ?? [])]) {
      const k = normKey(raw);
      if (!k) continue;
      const prev = byKey.get(k);
      if (prev && prev !== id) { collisions.push({ key: k, between: [prev, id] }); continue; }
      byKey.set(k, id);
    }
  }
  return { byKey, collisions };
}

const MOOD_ALIASES = buildFacetAliases(MOODS);
const CONTEXT_ALIASES = buildFacetAliases(CONTEXTS);
const ERA_ALIASES = buildFacetAliases(ERAS);

/* ---------- resolution ---------- */

// A compound tag whose last word names a genre is nearly always a shade of
// that genre: "dark techno", "melodic dubstep", "deep dnb". Resolving it to
// the parent keeps real signal that would otherwise be thrown away as an
// unknown concept — but it is a weaker claim than an exact alias, so it is
// labelled `suffix` and the classifier discounts it (see weights.mjs).
// Bounded to the longest suffix that resolves, and never applied to a
// single-word tag, which would just be the exact match again.
function suffixGenre(raw) {
  const words = String(raw ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (words.length < 2) return null;
  for (let i = 1; i < words.length; i++) {
    const slug = GENRE_ALIAS_INDEX.get(normKey(words.slice(i).join(' ')));
    if (slug) return slug;
  }
  return null;
}

/** @typedef {{facet: string, concept: string|null, via: string, raw: string}} Concept */

/**
 * Resolve one raw provider string to a canonical concept.
 *
 * Never returns null and never throws: an unrecognised string comes back with
 * `concept: null` and its `raw` value intact, because §8 of the plan is
 * explicit that unknown tags are retained as candidates rather than silently
 * discarded. The facet is still filled in — v1's lexicon can usually tell
 * what *kind* of thing an unmapped tag is even when the ontology has no
 * concept for it.
 *
 * @param {string} raw
 * @returns {Concept}
 */
export function resolveConcept(raw) {
  const key = normKey(raw);
  const facet = facetOf(raw);
  if (!key) return { facet, concept: null, via: 'empty', raw: String(raw ?? '') };

  const inFacet = { mood: MOOD_ALIASES, context: CONTEXT_ALIASES, era: ERA_ALIASES }[facet];
  if (inFacet) {
    const hit = inFacet.byKey.get(key);
    if (hit) return { facet, concept: hit, via: 'alias', raw };
  }
  if (facet === 'era') {
    // A bare year that no decade alias covered — "1994" resolves, "1867" does not.
    const era = /^(19|20)\d{2}$/.test(key) ? eraOfYear(key) : null;
    if (era) return { facet: 'era', concept: era, via: 'year', raw };
  }
  if (facet === 'descriptor') return { facet, concept: null, via: 'descriptor', raw };

  const exact = GENRE_ALIAS_INDEX.get(key);
  if (exact) return { facet: 'genre', concept: exact, via: 'alias', raw };

  // v1's lexicon calls a tag a genre by *default*, not by recognising it, and
  // it deliberately leaves ambiguous words that carry sound with them —
  // "club", "rave", "acoustic" — on the genre side rather than demote real
  // genre signal. Where such a word turns out not to name a genre at all, the
  // facet tables get a second look before it is written off as unknown. This
  // only ever runs after the genre index has declined it, so a word that is
  // both ("rave", a hardcore alias) still resolves as the genre.
  for (const [f, table] of [['mood', MOOD_ALIASES], ['context', CONTEXT_ALIASES], ['era', ERA_ALIASES]]) {
    const hit = table.byKey.get(key);
    if (hit) return { facet: f, concept: hit, via: 'fallback', raw };
  }

  const suffix = suffixGenre(raw);
  if (suffix) return { facet: 'genre', concept: suffix, via: 'suffix', raw };

  return { facet, concept: null, via: 'unknown', raw: String(raw) };
}

/** The genre slugs above `slug`, nearest first. Empty for a root or unknown. */
export const ancestorsOf = slug => GENRE_INDEX.get(slug)?.ancestors ?? [];

/** `slug` plus everything above it — the set a piece of evidence supports. */
export const lineageOf = slug => (GENRE_INDEX.has(slug) ? [slug, ...ancestorsOf(slug)] : []);

/** True when `a` is `b` or sits underneath it. */
export const isWithin = (a, b) => a === b || ancestorsOf(a).includes(b);

/** The deepest genre that contains both, or null if they share no ancestry. */
export function commonAncestor(a, b) {
  if (!GENRE_INDEX.has(a) || !GENRE_INDEX.has(b)) return null;
  const upB = new Set(lineageOf(b));
  return lineageOf(a).find(g => upB.has(g)) ?? null;
}

/** True when two genres are declared to argue against each other. */
export const contradicts = (a, b) => !!GENRE_INDEX.get(a)?.contradicts.has(b);

/** True when two genres are declared neighbours. */
export const isRelated = (a, b) => !!GENRE_INDEX.get(a)?.related.has(b);

/* ---------- validation ---------- */

/**
 * Structural checks over the declarations. Called by the test suite rather
 * than at import time: a broken ontology should fail the build loudly, not
 * degrade a user's library quietly at runtime.
 * @returns {{errors: string[], warnings: string[]}}
 */
export function validateOntology() {
  const errors = [], warnings = [];

  for (const [slug, node] of Object.entries(GENRES)) {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) errors.push(`genre slug is not kebab-case: ${slug}`);
    if (node.parent && !GENRES[node.parent]) errors.push(`${slug} names a parent that does not exist: ${node.parent}`);
    for (const r of node.related ?? []) if (!GENRES[r]) errors.push(`${slug} names an unknown related genre: ${r}`);
    for (const c of node.contradicts ?? []) if (!GENRES[c]) errors.push(`${slug} names an unknown contradicting genre: ${c}`);
    if ((node.related ?? []).includes(slug)) errors.push(`${slug} is related to itself`);
    if ((node.contradicts ?? []).includes(slug)) errors.push(`${slug} contradicts itself`);
  }

  // Cycles: a genre that reaches itself by walking parents.
  for (const slug of Object.keys(GENRES)) {
    const seen = new Set([slug]);
    let cur = GENRES[slug].parent;
    while (cur && GENRES[cur]) {
      if (seen.has(cur)) { errors.push(`parent cycle through ${slug} -> ${cur}`); break; }
      seen.add(cur);
      cur = GENRES[cur].parent;
    }
  }

  for (const c of GENRE_ALIASES.collisions)
    errors.push(`alias "${c.key}" claimed by both ${c.between[0]} and ${c.between[1]}`);
  for (const [name, built] of [['mood', MOOD_ALIASES], ['context', CONTEXT_ALIASES], ['era', ERA_ALIASES]])
    for (const c of built.collisions)
      errors.push(`${name} alias "${c.key}" claimed by both ${c.between[0]} and ${c.between[1]}`);

  // A genre alias that v1's lexicon reads as a mood/context/era never gets
  // as far as the genre index — resolveConcept() branches on facet first — so
  // it is dead weight and, worse, a sign the two vocabularies disagree.
  for (const [slug, node] of Object.entries(GENRES))
    for (const a of [slug.replace(/-/g, ' '), ...(node.aliases ?? [])]) {
      const f = facetOf(a);
      if (f !== 'genre') warnings.push(`genre alias "${a}" (${slug}) is read as a ${f} tag by profile.mjs and will never resolve`);
    }

  // The same check the other way: a word claimed by two facet tables resolves
  // to whichever is consulted first, which is an ordering accident rather
  // than a decision anybody made.
  const tables = [['mood', MOOD_ALIASES], ['context', CONTEXT_ALIASES], ['era', ERA_ALIASES]];
  for (let i = 0; i < tables.length; i++)
    for (let j = i + 1; j < tables.length; j++)
      for (const k of tables[i][1].byKey.keys())
        if (tables[j][1].byKey.has(k))
          errors.push(`"${k}" is claimed by both the ${tables[i][0]} and ${tables[j][0]} tables`);

  return { errors, warnings };
}
