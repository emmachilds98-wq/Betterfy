// The provider interface — §7 and §36 of the v3 plan.
//
// Adding a source must mean writing an adapter, a mapper and tests, and
// nothing else (§36). That only holds if the classifier never has to know a
// provider exists, which in turn only holds if everything the classifier
// would otherwise want to special-case is something the provider *declares*:
// how much it is trusted, what it can answer, whether it is independent of
// the sources already consulted, and what version of itself produced an
// answer.
//
// Nothing here fetches. An adapter is split into a declaration plus pure
// mapping functions, and a separate thin fetch function, so the mapping — the
// part with all the judgement in it — is testable against a recorded fixture
// with no network at all (§41.6, §41.7).

/** What a provider can be asked for. Mirrors Evidence FIELDS plus 'identity'. */
export const CAPABILITIES = ['identity', 'genre', 'mood', 'context', 'era', 'descriptor',
                             'bpm', 'key', 'energy', 'valence', 'voice', 'instrumentation', 'similarity'];

/**
 * @typedef {object} ProviderCapability
 * @property {string} id                 stable provider id, used as Evidence.source
 * @property {string} version            bumped when the adapter's mapping changes
 * @property {string[]} capabilities     subset of CAPABILITIES
 * @property {string[]} entityTypes      what it can be asked about
 * @property {number} reliability        0-1, how much this source is trusted at all
 * @property {string} independenceGroup  sources sharing a group are NOT independent
 * @property {boolean} optional          true when absent-by-default costs nothing
 * @property {string} requires           human-readable: what a user must configure
 */

/**
 * Declare a provider. `reliability` is the one judgement call here and it is
 * deliberately shallow — a coarse prior, to be replaced by benchmark-measured
 * numbers (§9: "actual numerical weights must be validated using the
 * benchmark dataset"). It is not a ranking the classifier reads directly; it
 * is one factor among four in evidenceWeight().
 */
export function defineProvider(spec) {
  const p = {
    id: spec.id,
    version: spec.version ?? '0.0.0',
    capabilities: spec.capabilities ?? [],
    entityTypes: spec.entityTypes ?? [],
    reliability: spec.reliability ?? 0.5,
    // Default: every provider is its own group. Sharing one is the exception
    // and has to be stated, because getting it wrong inflates confidence.
    independenceGroup: spec.independenceGroup ?? spec.id,
    optional: spec.optional ?? true,
    requires: spec.requires ?? 'nothing',
  };
  for (const c of p.capabilities)
    if (!CAPABILITIES.includes(c)) throw new Error(`${p.id} declares unknown capability: ${c}`);
  return Object.freeze(p);
}

/**
 * A set of providers the engine may consult, and the two lookups the
 * weighting layer needs from them. Built per run, so a listener who has
 * configured no Discogs token simply has a registry without it — there is no
 * "disabled provider" state to reason about anywhere downstream.
 */
export class ProviderRegistry {
  constructor(providers = []) {
    this.providers = new Map();
    for (const p of providers) this.register(p);
  }

  register(p) {
    if (!p?.id) throw new Error('a provider needs an id');
    this.providers.set(p.id, p);
    return this;
  }

  get(id) { return this.providers.get(id) ?? null; }
  has(id) { return this.providers.has(id); }
  get ids() { return [...this.providers.keys()]; }

  /** For evidenceWeight(). Unknown sources are trusted at half. */
  reliabilityOf = source => this.providers.get(source)?.reliability ?? 0.5;

  /**
   * For agreementFactor(). An unregistered source is treated as its own
   * group — the conservative direction is to *under*-count correlation only
   * when we genuinely know two sources share a crowd.
   */
  independenceOf = source => this.providers.get(source)?.independenceGroup ?? source;

  /** Providers that can answer a given capability. */
  providing(capability) {
    return [...this.providers.values()].filter(p => p.capabilities.includes(capability));
  }

  /** The version stamp recorded on every profile this registry produced. */
  versions() {
    return Object.fromEntries([...this.providers.values()].map(p => [p.id, p.version]));
  }
}
