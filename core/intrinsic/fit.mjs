// Which of the intrinsic weights the library actually constrains.
//
// `core/benchmark/fit.mjs` sweeps the tag engine against twelve synthetic
// cases, and reports four of fifteen parameters as FLAT — uncontradicted rather
// than validated, because twelve rows cannot distinguish them. That is not a
// shortage of effort; it is what twelve rows can do.
//
// This sweep has a different fitness surface: held-out placement accuracy over
// the account's own library, which is thousands of graded rows that nobody had
// to review. A weight that changes nothing across its whole range here is flat
// against real filing rather than against a fixture, which is a much stronger
// statement — and a weight that has a clear optimum can simply be set to it.
//
// Same reporting discipline as the tag-engine sweep: say which parameters are
// constrained, say plainly which are not, and never let "no evidence against"
// read as "validated".
import { WEIGHTS } from './space.mjs';
import { placementAccuracy, DEFAULT_FOLDS } from '../validate/loo.mjs';

export const INTRINSIC_FIT_VERSION = '4.0.0';

/** The range each weight is swept over. Zero is always included, because
 *  "does this component earn its place at all" is the first question. */
export const SWEEP = {
  graph:       [0, 0.25, 0.5, 0.75, 1, 1.5, 2],
  registrant:  [0, 0.25, 0.5, 0.75, 1, 1.5],
  minutes:     [0, 0.1, 0.25, 0.5, 1],
  era:         [0, 0.1, 0.3, 0.6, 1],
  albumType:   [0, 0.1, 0.2, 0.5, 1],
  albumTracks: [0, 0.15, 0.3, 0.6],
  popularity:  [0, 0.1, 0.25, 0.5],
};

/**
 * Sweep one weight at a time, holding the rest at their current values.
 *
 * One at a time rather than jointly, for the same reason the tag-engine sweep
 * does it: a joint search over seven parameters on a fitness surface this
 * expensive would take longer than anybody will wait, and the question being
 * asked is "is this number doing anything", which a single-axis sweep answers
 * honestly. It cannot find an interaction between two weights, and saying so
 * here is cheaper than implying otherwise.
 */
export function sweepWeights(lib, { folds = DEFAULT_FOLDS, limit = null,
                                    base = WEIGHTS, onStep = null } = {}) {
  const rows = [];

  for (const [name, values] of Object.entries(SWEEP)) {
    const scores = [];
    for (const v of values) {
      const weights = { ...base, [name]: v };
      const r = placementAccuracy(lib, { folds, limit, weights });
      scores.push({ value: v, top1: r.top1 ?? 0 });
      onStep?.({ name, value: v, top1: r.top1 });
    }

    const best = scores.reduce((a, b) => (b.top1 > a.top1 ? b : a));
    const worst = scores.reduce((a, b) => (b.top1 < a.top1 ? b : a));
    const current = base[name];
    const atCurrent = scores.find(s => s.value === current)?.top1 ?? null;
    const spread = +(best.top1 - worst.top1).toFixed(4);

    rows.push({
      name, current, atCurrent,
      best: best.value, bestScore: best.top1,
      spread,
      // FLAT means the library could not tell any value in the range apart.
      // It is a statement about the evidence, never about the number being fine.
      verdict: spread === 0 ? 'FLAT — the library does not constrain this at all'
             : atCurrent !== null && atCurrent >= best.top1 ? 'at its best value'
             : `better at ${best.value} (+${((best.top1 - (atCurrent ?? 0)) * 100).toFixed(1)} points)`,
      scores,
    });
  }

  return { rows, folds, version: INTRINSIC_FIT_VERSION };
}

/**
 * Whether a component earns its place at all: accuracy with the weight at zero
 * against accuracy with it where it is.
 *
 * Worth separating from the sweep because it is the question a reader actually
 * has. "Popularity is best at 0.1" invites tuning; "removing popularity
 * entirely costs nothing" invites deleting it, which is usually the better
 * answer and is never the one a sweep volunteers.
 */
export function componentValue(lib, { folds = DEFAULT_FOLDS, limit = null, base = WEIGHTS } = {}) {
  const withAll = placementAccuracy(lib, { folds, limit, weights: base }).top1 ?? 0;
  const out = [];
  for (const name of Object.keys(base)) {
    const without = placementAccuracy(lib, {
      folds, limit, weights: { ...base, [name]: 0 },
    }).top1 ?? 0;
    out.push({ name, withAll, without, costOfRemoving: +(withAll - without).toFixed(4) });
  }
  return out.sort((a, b) => b.costOfRemoving - a.costOfRemoving);
}
