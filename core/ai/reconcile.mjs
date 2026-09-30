// AI reconciliation — §24.
//
// §24 is mostly a list of things AI must not be allowed to do, so this module
// is mostly a constraint layer. The shape it enforces:
//
//   AI never sees a question the evidence already answered.  Asking is
//     restricted to the cases the deterministic layer said it could not
//     settle. That is both §24's "use AI selectively" and the only cost
//     control that matters.
//   AI chooses; it does not propose.  The request carries a CLOSED set of
//     candidates, every one of them already produced by the deterministic
//     classifier from real evidence. A response naming anything else is
//     rejected, which makes "inventing genres from a title" structurally
//     impossible rather than merely discouraged.
//   AI cannot manufacture certainty.  A reconciled answer is capped at
//     LIKELY. If two independent sources genuinely disagree, a language model
//     agreeing with one of them is not new evidence and must not read as if
//     it were.
//   AI never touches the evidence.  Reconciliation reorders a decision among
//     existing candidates; it adds no weight, no records, and nothing that
//     survives into the next classification run.
//
// Nothing here calls a vendor. `ask` is injected, so the constraint layer is
// testable against a deliberately badly-behaved model — which is the only
// kind worth testing against.
import { GENRE_INDEX, resolveConcept } from '../ontology/index.mjs';
import { CONFIDENCE } from '../analysis/classify.mjs';

export const AI_VERSION = '3.0.0';

/** The jobs §24 lists as good ones. Anything else is out of scope by design. */
export const TASKS = ['reconcile-genre', 'interpret-playlist-name', 'propose-concept', 'explain'];

/**
 * Whether this profile is worth asking about at all.
 *
 * Deliberately narrow. A HIGH or LIKELY answer is one the evidence already
 * settled, and re-opening it with a language model is how a good answer gets
 * talked out of. INSUFFICIENT_DATA is not a reconciliation problem either —
 * there is nothing to reconcile, and a model asked to pick from an empty set
 * will pick something.
 */
export function shouldAsk(profile) {
  if (!profile) return false;
  if (profile.genre?.confidence === CONFIDENCE.AMBIGUOUS && (profile.genre?.candidates?.length ?? 0) >= 2) return true;
  // An unmapped concept is a different question — "what does this tag mean" —
  // and its answer goes to a human for approval, never straight into use.
  return (profile.unknown?.length ?? 0) > 0;
}

/**
 * The request. Everything a model needs to choose, and nothing it could use
 * to introduce something new.
 *
 * `choices` is the contract: a closed list of concept slugs, each one already
 * backed by evidence in this profile. The evidence summary is per candidate
 * and names what kind of source said it at what specificity, because that is
 * the actual reconciliation question — "an artist tag says techno, a release
 * says jungle, which kind of statement is more likely right about this
 * record" — and not "what genre do you think this is".
 */
export function buildRequest(profile, { task = 'reconcile-genre', maxChoices = 5 } = {}) {
  if (!TASKS.includes(task)) throw new Error(`unknown AI task: ${task}`);
  const candidates = (profile?.genre?.candidates ?? []).slice(0, maxChoices);
  return Object.freeze({
    task,
    version: AI_VERSION,
    // The closed set. A response outside it is invalid, not merely unwelcome.
    choices: candidates.map(c => c.concept),
    // Plus the two answers that are always allowed and are never failures:
    // the evidence really can be too divided, and a human really can be the
    // right next step.
    allowAbstain: true,
    candidates: candidates.map(c => ({
      concept: c.concept,
      parents: GENRE_INDEX.get(c.concept)?.ancestors ?? [],
      score: c.score,
      assertedDirectly: c.direct > 0,
      inheritedFromSubgenres: c.lifted > c.direct,
      independentSources: c.groups?.length ?? 0,
      supportingRecords: c.records ?? 0,
    })),
    evidence: (profile?.explanation ?? []).map(e => e.text),
    unknownTags: (profile?.unknown ?? []).map(u => u.raw),
    identity: {
      title: profile?.identity?.title ?? null,
      artists: (profile?.identity?.artists ?? []).map(a => a.name),
      year: profile?.identity?.album?.year ?? null,
      versionKind: profile?.identity?.versionKind ?? null,
    },
  });
}

/** Why a response was rejected. Kept as codes so the caller can count them. */
export const REJECTIONS = {
  MALFORMED: 'the response was not the expected shape',
  NOT_A_CHOICE: 'it named a concept that was not among the candidates',
  NOT_IN_ONTOLOGY: 'it named a concept the ontology does not contain',
  NO_REASON: 'it gave no reason referring to the evidence',
  OVERCONFIDENT: 'it claimed more certainty than the evidence supports',
  UNSUPPORTED_CONCEPT: 'it proposed a mapping to a concept the ontology does not contain',
};

/**
 * Validate a model's answer against the request.
 *
 * Every check here exists because §24 names the corresponding failure. The
 * function returns a verdict rather than throwing, because a badly-behaved
 * model is an expected condition — one bad answer should be counted and
 * discarded, not crash a library pass.
 *
 * @returns {{ok: boolean, reason?: string, value?: object}}
 */
export function validateResponse(response, request) {
  if (!response || typeof response !== 'object') return { ok: false, reason: 'MALFORMED' };

  if (request.task === 'propose-concept') {
    const proposals = Array.isArray(response.proposals) ? response.proposals : null;
    if (!proposals) return { ok: false, reason: 'MALFORMED' };
    const clean = [];
    for (const p of proposals) {
      if (!p?.raw || !p?.concept) return { ok: false, reason: 'MALFORMED' };
      // The proposed target must be a real ontology concept. A model is
      // allowed to say "schranz is a kind of hard techno"; it is not allowed
      // to invent "industrial hard groove" as the thing it maps to.
      if (!GENRE_INDEX.has(p.concept) && !resolveConcept(p.concept).concept)
        return { ok: false, reason: 'UNSUPPORTED_CONCEPT' };
      if (!request.unknownTags.includes(p.raw)) return { ok: false, reason: 'NOT_A_CHOICE' };
      clean.push({ raw: p.raw, concept: GENRE_INDEX.has(p.concept) ? p.concept : resolveConcept(p.concept).concept,
                   reason: String(p.reason ?? '').slice(0, 400) });
    }
    return { ok: true, value: { proposals: clean } };
  }

  // Abstaining is a valid, and often the correct, answer.
  if (response.choice === null || response.choice === 'abstain')
    return { ok: true, value: { choice: null, reason: String(response.reason ?? '').slice(0, 400) } };

  if (typeof response.choice !== 'string') return { ok: false, reason: 'MALFORMED' };
  if (!GENRE_INDEX.has(response.choice)) return { ok: false, reason: 'NOT_IN_ONTOLOGY' };
  // The closed-set check. This is the one that makes "inventing a genre from
  // the title" impossible rather than discouraged: a real ontology concept
  // that nothing in this track's evidence supports is still rejected.
  if (!request.choices.includes(response.choice)) return { ok: false, reason: 'NOT_A_CHOICE' };

  const reason = String(response.reason ?? '').trim();
  if (reason.length < 10) return { ok: false, reason: 'NO_REASON' };
  // §24: "generating unsupported certainty" is a bad AI task. A model is not
  // a source, and nothing it says can make divided evidence undivided.
  if (response.confidence && !['LIKELY', 'AMBIGUOUS'].includes(response.confidence))
    return { ok: false, reason: 'OVERCONFIDENT' };

  return { ok: true, value: { choice: response.choice, reason: reason.slice(0, 400) } };
}

/**
 * Apply a validated reconciliation to a profile.
 *
 * Returns a NEW profile object; the original is untouched, same as everywhere
 * else in this engine. The reconciled answer is capped at LIKELY and carries
 * `reconciledBy: 'ai'` so that nothing downstream — the review queue, the
 * benchmark, a future re-fit — can mistake it for evidence.
 */
export function applyReconciliation(profile, validated, { model = 'unknown' } = {}) {
  if (!validated?.ok || !validated.value?.choice) return profile;
  const choice = validated.value.choice;
  const candidate = profile.genre.candidates.find(c => c.concept === choice);
  if (!candidate) return profile;   // belt and braces: validate already checked

  return {
    ...profile,
    genre: {
      ...profile.genre,
      primary: choice,
      parents: GENRE_INDEX.get(choice)?.ancestors ?? [],
      // Never HIGH. The evidence was divided before the model spoke and it is
      // divided still — what changed is which side we are acting on.
      confidence: CONFIDENCE.LIKELY,
      reconciledBy: 'ai',
      reconciliation: { model, reason: validated.value.reason, wasAmbiguousBetween: profile.genre.candidates.map(c => c.concept) },
    },
    explanation: [
      ...(profile.explanation ?? []),
      { mark: 'note', text: `reconciled by ${model} from ${profile.genre.candidates.length} divided candidates: ${validated.value.reason}` },
    ],
  };
}

/**
 * Reconcile one profile, given an `ask` that takes a request and returns a
 * response. Never throws, and never changes anything it could not validate.
 *
 * @param {object} profile
 * @param {(request: object) => Promise<object>} ask
 * @returns {Promise<{profile: object, asked: boolean, applied: boolean, rejected?: string}>}
 */
export async function reconcile(profile, ask, { model = 'unknown', task = 'reconcile-genre' } = {}) {
  if (!shouldAsk(profile)) return { profile, asked: false, applied: false };
  const request = buildRequest(profile, { task });
  if (task === 'reconcile-genre' && request.choices.length < 2)
    return { profile, asked: false, applied: false };

  let response;
  try { response = await ask(request); }
  catch { return { profile, asked: true, applied: false, rejected: 'MALFORMED' }; }

  const validated = validateResponse(response, request);
  if (!validated.ok) return { profile, asked: true, applied: false, rejected: validated.reason };
  if (task === 'propose-concept')
    // Proposals go to a human, never into use. This is the §35 review queue's
    // concept section, pre-filled — not an answer.
    return { profile, asked: true, applied: false, proposals: validated.value.proposals };
  return { profile: applyReconciliation(profile, validated, { model }), asked: true, applied: !!validated.value.choice };
}

/**
 * Reconcile a whole library, reporting what was asked and what was refused.
 *
 * The refusal counts are the point of the report: a model that is being
 * rejected often is one that should not be trusted with the answers that did
 * get through, and that is only visible in aggregate.
 */
export async function reconcileLibrary(profiles, ask, { model = 'unknown', limit = Infinity } = {}) {
  const rejections = {};
  let asked = 0, applied = 0, skipped = 0;
  const out = new Map();
  for (const [id, entry] of profiles) {
    if (asked >= limit || !shouldAsk(entry.profile)) { skipped++; out.set(id, entry); continue; }
    const r = await reconcile(entry.profile, ask, { model });
    if (r.asked) asked++;
    if (r.applied) applied++;
    if (r.rejected) rejections[r.rejected] = (rejections[r.rejected] ?? 0) + 1;
    out.set(id, { ...entry, profile: r.profile });
  }
  return { profiles: out, stats: { asked, applied, skipped, rejections,
                                   rejectedTotal: Object.values(rejections).reduce((a, b) => a + b, 0) } };
}
