// The audio gate: may sound change a suggestion on this account yet?
//
// docs/AUDIO-BUILD-PLAN.md §0.7 and WP-E2, from the handoff (issue #53):
// audio earns a say in filing only once the account's own library shows
//
//   1. at least +5 points top-1 on tracks by never-filed artists (the case
//      sound exists for: nobody has filed those artists yet, so the artist
//      graph has nothing to say), and
//   2. no loss overall.
//
// Both read from one `placementAccuracy(lib, { audio })` run, which scores
// every track twice on the same folds, so the difference is sound and nothing
// else. The bar was set before anyone saw a number, the same one the bridge
// was held to (`bridgeVerdict` on the page). It is meant to be able to fail;
// failing leaves audio shown but display-only, which is a result, not a bug
// (plan §6).
//
// Pure: no clock, no storage. A caller keeps the verdict next to the run it
// came from and passes `useAudio: audioInUse(verdict)` to `placements`.
import { calibrationReport } from '../intrinsic/calibrate.mjs';

export const GATE_VERSION = '1.0.0';

export const GATE = {
  /** Top-1 lift on never-filed artists that counts as earning it. */
  minLift: 0.05,
  /** Fewer never-filed tracks than this cannot show a 5-point lift from noise. */
  minNeverFiled: 20,
  /** And fewer of them heard than this means sound never really got a hearing. */
  minHeardNeverFiled: 10,
};

/** Rounding slack: rates arrive at 4 decimal places. */
const EPS = 1e-9;

const pts = x => `${x >= 0 ? '+' : '−'}${Math.abs(Math.round(x * 1000) / 10)} points`;

/**
 * Read a `placementAccuracy` result that was run with `audio`.
 *
 * `pass` is true, false, or null for "can't tell yet" (no audio, or too few
 * tracks to judge on). Only `true` lets sound change suggestions. `reason` is
 * a stable code for tests and storage; `text` is for people.
 *
 * @returns {{ pass: boolean|null, reason: string, lift: number|null, overall: number|null,
 *             neverFiled: number, heard: number, heardNeverFiled: number, text: string,
 *             bar: object, version: string }}
 */
export function audioGate(acc, opts = {}) {
  const bar = { ...GATE, ...opts };
  const w = acc?.withAudio;
  const nf = acc?.neverFiled;
  const out = (pass, reason, text, extra = {}) => ({
    pass, reason, text, lift: null, overall: null,
    neverFiled: nf?.scored ?? 0, heard: w?.heard ?? 0, heardNeverFiled: w?.heardNeverFiled ?? 0,
    bar, version: GATE_VERSION, ...extra,
  });

  if (!w || !nf) return out(null, 'NOT_RUN', 'Scored without sound, so there is nothing to compare.');
  if (!w.heard) return out(null, 'NOTHING_HEARD', 'None of the scored tracks has been listened to yet.');

  const lift = (w.neverFiled?.top1 ?? 0) - (nf.top1 ?? 0);
  const overall = (w.top1 ?? 0) - (acc.top1 ?? 0);
  const nums = { lift: +lift.toFixed(4), overall: +overall.toFixed(4) };

  if (nf.scored < bar.minNeverFiled) {
    return out(null, 'TOO_FEW_NEVER_FILED',
      `Only ${nf.scored} of the scored tracks are by artists not yet in a genre playlist, too few to judge it on.`, nums);
  }
  if ((w.heardNeverFiled ?? 0) < bar.minHeardNeverFiled) {
    return out(null, 'TOO_FEW_HEARD',
      `Only ${w.heardNeverFiled ?? 0} tracks by never-filed artists have been listened to so far, too few to judge it on.`, nums);
  }
  if (overall < -EPS) {
    return out(false, 'COSTS_OVERALL',
      `It changes never-filed artists by ${pts(lift)} but costs ${pts(overall)} overall, so it stays display-only.`, nums);
  }
  if (lift + EPS < bar.minLift) {
    return out(false, 'NOT_ENOUGH_LIFT',
      `Not enough lift on never-filed artists (${pts(lift)}; the bar is ${pts(bar.minLift)}), so it stays display-only.`, nums);
  }
  return out(true, 'PASS',
    `${pts(lift)} on tracks by artists you hadn't filed in a genre playlist yet, and ${pts(overall)} overall.`, nums);
}

/** The one question a caller asks: may `placements` use sound? Only a pass says yes. */
export const audioInUse = verdict => verdict?.pass === true;

/**
 * Both halves of a run through calibrate.mjs: how sure the engine may be
 * without sound and with it, each checked on tracks it was not fitted on.
 * Needs a run with `collect: true`. Null halves when there are no rows.
 */
export function audioCalibration(acc, opts = {}) {
  const without = acc?.rows?.length ? calibrationReport(acc.rows, opts) : null;
  const withAudio = acc?.withAudio?.rows?.length ? calibrationReport(acc.withAudio.rows, opts) : null;
  return { without, withAudio };
}
