// MusicProfile and Music DNA — §11 and §13 of the v3 plan.
//
// The MusicProfile is the one derived object everything downstream reads:
// playlist fingerprints, misfile placement, similarity, recommendations. Its
// contract is that it is *derived and disposable*. Nothing here is ever
// written back over the evidence it came from (§39), and every profile
// carries the versions it was built under (§29) so a library can be told
// apart from one classified by an older ontology and reclassified rather than
// trusted blindly.
//
// §11 is explicit: do not force fields when data is unavailable. A field with
// nothing behind it is absent, not zero — a `bpm: 0` is a lie that scores,
// and a missing bpm is a fact that does not.
import { classifyGenre, classifyFlatFacet, CLASSIFIER_VERSION, CONFIDENCE } from './classify.mjs';
import { unknownConcepts } from '../evidence/normalise.mjs';
import { ONTOLOGY_VERSION } from '../ontology/index.mjs';
import { IDENTITY_VERSION } from '../identity/track-identity.mjs';
import { EVIDENCE_VERSION } from '../evidence/evidence.mjs';

export const PROFILE_VERSION = '3.0.0';

/** Numeric fields an audio-analysis provider would fill in, when one exists. */
const MEASURED_FIELDS = ['bpm', 'key', 'energy', 'valence'];

/**
 * The best numeric measurement for one field, or undefined.
 *
 * Numbers are not voted on the way concepts are: two providers disagreeing
 * about BPM by a factor of two is a known, specific failure (half/double
 * time), not something to average into a wrong answer in the middle. So the
 * strongest single measurement wins and the others stay visible in the
 * evidence for a human to look at.
 */
function measured(records, field) {
  const hits = records.filter(r => r.field === field && r.rawValue != null);
  if (!hits.length) return undefined;
  const best = hits.reduce((a, b) =>
    (b.identityConfidence * b.sourceConfidence) > (a.identityConfidence * a.sourceConfidence) ? b : a);
  return {
    value: best.rawValue,
    source: best.source,
    confidence: +(best.identityConfidence * best.sourceConfidence).toFixed(3),
    disputed: new Set(hits.map(r => String(r.rawValue))).size > 1,
  };
}

/**
 * Build a MusicProfile from an EvidenceSet.
 *
 * @param {import('../evidence/evidence.mjs').EvidenceSet} set
 * @param {{registry?, now?: number}} [opts]
 */
export function musicProfile(set, { registry = null, now = Date.now() } = {}) {
  const records = set?.current?.() ?? set?.records ?? [];
  const genre = classifyGenre(set, { registry, now });
  const mood = classifyFlatFacet(set, 'mood', { registry, now });
  const context = classifyFlatFacet(set, 'context', { registry, now });
  const era = classifyFlatFacet(set, 'era', { registry, now, max: 2 });

  const musical = {};
  for (const f of MEASURED_FIELDS) {
    const m = measured(records, f);
    if (m) musical[f] = m;              // absent, never zero
  }

  const sources = [...new Set(records.map(r => r.source))];
  const groups = new Set(records.map(r => registry?.independenceOf?.(r.source) ?? r.source));

  return {
    identity: set?.identity ?? null,
    genre: {
      primary: genre.primary,
      parents: genre.parents,
      secondary: genre.secondary,
      alternatives: genre.alternatives,
      confidence: genre.confidence,
      score: genre.score,
      share: genre.share,
      candidates: genre.candidates,
    },
    mood, context, era,
    musical,
    confidence: {
      genre: genre.confidence,
      identity: +(set?.identity?.confidence ?? 0).toFixed(3),
      // Coverage is how many independent voices contributed anything at all.
      // It is the number that says "this answer is one crowd's opinion"
      // without having to name the crowd.
      coverage: groups.size,
      sources,
    },
    explanation: genre.explanation,
    // Retained, never discarded (§8, §13). These are what grows the ontology.
    unknown: unknownConcepts(records).slice(0, 10),
    evidence: records.length,
    versions: {
      profile: PROFILE_VERSION,
      classifier: CLASSIFIER_VERSION,
      ontology: ONTOLOGY_VERSION,
      identity: IDENTITY_VERSION,
      evidence: EVIDENCE_VERSION,
      providers: registry?.versions?.() ?? {},
    },
    builtAt: now,
  };
}

/**
 * Music DNA: the compact, comparable part of a profile.
 *
 * A profile is for showing a person; DNA is for comparing two pieces of
 * music. It carries only what can be meaningfully compared — the genre
 * lineage as a weighted vector, mood and context distributions, era — and
 * deliberately drops explanations, provenance and candidate lists, which are
 * large and would be carried through every playlist centroid for nothing.
 */
export function musicDNA(profile) {
  if (!profile) return null;
  const genre = new Map();
  for (const c of profile.genre?.candidates ?? []) genre.set(c.concept, c.score);
  const total = [...genre.values()].reduce((a, b) => a + b, 0);
  if (total > 0) for (const [k, v] of genre) genre.set(k, v / total);

  const dist = facet => Object.fromEntries((facet?.values ?? []).map(v => [v.concept, v.weight]));

  return {
    id: profile.identity?.spotifyId ?? null,
    key: profile.identity?.key ?? null,
    genre: Object.fromEntries(genre),
    primaryGenre: profile.genre?.primary ?? null,
    genreConfidence: profile.genre?.confidence ?? CONFIDENCE.INSUFFICIENT_DATA,
    mood: dist(profile.mood),
    context: dist(profile.context),
    era: profile.era?.primary ?? null,
    ...(profile.musical?.bpm ? { bpm: profile.musical.bpm.value } : {}),
    ...(profile.musical?.key ? { musicalKey: profile.musical.key.value } : {}),
    ...(profile.musical?.energy ? { energy: profile.musical.energy.value } : {}),
    coverage: profile.confidence?.coverage ?? 0,
  };
}

/**
 * Cosine similarity over two DNA genre vectors, weighted by how much of the
 * lineage they share. Deliberately the same shape of number as v1's cosine,
 * so the two engines can be compared on the same scale (Task 11) rather than
 * argued about.
 */
export function dnaSimilarity(a, b) {
  if (!a || !b) return 0;
  const va = a.genre ?? {}, vb = b.genre ?? {};
  let dot = 0, ma = 0, mb = 0;
  for (const [k, x] of Object.entries(va)) { ma += x * x; const y = vb[k]; if (y) dot += x * y; }
  for (const y of Object.values(vb)) mb += y * y;
  const m = Math.sqrt(ma) * Math.sqrt(mb);
  // Clamped: floating-point error puts a vector's similarity to itself a hair
  // over 1, and a "similarity" above 1 would quietly outrank a real match
  // anywhere a caller compares or thresholds these.
  return m ? Math.min(1, dot / m) : 0;
}
