// Does a second ear beat the first on this library? (WP-C1's measurement.)
//
// The plan: MAEST "ships only if it beats B's ear on the owner's library",
// measured with the same with/without harness as WP-E2. So this runs
// placementAccuracy() twice on the same folds, once with sound from effnet's
// embedding and once from the second ear's, over the SAME tracks: both
// indexes hold only records that carry a current second ear, so neither ear
// gets credit for hearing more of the library than the other.
//
// The bar, set before any real number was seen: the second ear must add at
// least MIN_GAIN top-1 with sound overall, and lose nothing on tracks by
// never-filed artists (the ones sound is for). Too few paired tracks is
// "can't tell yet", never a pass. A pass is a measurement, not a switch: the
// engine keeps effnet's ear until a later change acts on it.
import { placementAccuracy } from './loo.mjs';
import { audioIndex } from '../intrinsic/audio.mjs';
import { GATE } from './gate.mjs';

export const EARS_VERSION = '1.0.0';
export const EAR_BAR = Object.freeze({
  /** Top-1 (with sound) the second ear must add overall. */
  minGain: 0.02,
  /** Paired heard tracks below this can't separate two ears from noise. */
  minPaired: 50,
  /** And never-filed ones among them, as the gate asks. */
  minPairedNeverFiled: GATE.minHeardNeverFiled,
});

const EPS = 1e-9;
const pts = x => `${x >= 0 ? '+' : '−'}${Math.abs(Math.round(x * 1000) / 10)} points`;

/**
 * @param {object} lib  as placementAccuracy takes it
 * @param {Iterable<object>} records  AudioRecords (misses are ignored)
 * @param {{ ear?: 'maest'|'clap', mel?: string, feedback?: object, learn?: any } & object} [opts]
 *        everything else (folds, limit, isMirror, targets, weights) goes to placementAccuracy
 * @returns {{ ear: string, paired: number, base: object|null, second: object|null, verdict: object, version: string }}
 */
export function earComparison(lib, records, { ear = 'maest', mel, feedback, learn, ...acc } = {}) {
  const recs = [...(records ?? [])];
  const second = audioIndex(recs, { mel, ear });
  const base = new Map([...audioIndex(recs, { mel })].filter(([id]) => second.has(id)));
  for (const id of [...second.keys()]) if (!base.has(id)) second.delete(id);
  const audioOf = index => ({ index, ...(feedback ? { feedback } : {}), ...(learn !== undefined ? { learn } : {}) });
  const run = index => (index.size ? placementAccuracy(lib, { ...acc, audio: audioOf(index) }) : null);
  const a = run(base), b = run(second);
  return { ear, paired: base.size, base: summary(a), second: summary(b), verdict: earVerdict(a, b), version: EARS_VERSION };
}

/** The with-sound numbers of one run, counts and rates only. */
function summary(r) {
  const w = r?.withAudio;
  if (!w) return null;
  return { top1: w.top1, top3: w.top3, neverFiled: w.neverFiled?.top1 ?? null,
           heard: w.heard, heardNeverFiled: w.heardNeverFiled, scored: r.scored };
}

/**
 * @returns {{ pass: boolean|null, reason: string, gain: number|null, neverFiledGain: number|null, text: string, bar: object }}
 */
export function earVerdict(a, b, bar = EAR_BAR) {
  const out = (pass, reason, text, extra = {}) => ({ pass, reason, text, gain: null, neverFiledGain: null, bar, ...extra });
  const wa = a?.withAudio, wb = b?.withAudio;
  if (!wa || !wb) return out(null, 'NOT_RUN', 'No track has been heard by both ears yet.');
  if ((wb.heard ?? 0) < bar.minPaired)
    return out(null, 'TOO_FEW_PAIRED', `Only ${wb.heard ?? 0} scored tracks have been heard by both ears, too few to tell them apart.`);
  const gain = (wb.top1 ?? 0) - (wa.top1 ?? 0);
  const nfGain = (wb.neverFiled?.top1 ?? 0) - (wa.neverFiled?.top1 ?? 0);
  const nums = { gain: +gain.toFixed(4), neverFiledGain: +nfGain.toFixed(4) };
  if ((wb.heardNeverFiled ?? 0) < bar.minPairedNeverFiled)
    return out(null, 'TOO_FEW_NEVER_FILED', `Only ${wb.heardNeverFiled ?? 0} of them are by never-filed artists, too few to judge it on.`, nums);
  if (nfGain < -EPS)
    return out(false, 'COSTS_NEVER_FILED', `${pts(gain)} overall, but ${pts(nfGain)} on never-filed artists, so it stays off.`, nums);
  if (gain + EPS < bar.minGain)
    return out(false, 'NOT_ENOUGH_GAIN', `${pts(gain)} overall (the bar is ${pts(bar.minGain)}), so it stays off.`, nums);
  return out(true, 'BEATS', `${pts(gain)} overall and ${pts(nfGain)} on never-filed artists, on the same tracks.`, nums);
}

/**
 * The comparison for a Score run, or null when no record carries the second
 * ear (so a listener without deep listen pays nothing). `audio` is what
 * placementAccuracy was given: records, or `{ records, feedback }`.
 */
export function earsIfAny(lib, audio, acc = {}, ear = 'maest') {
  const records = Array.isArray(audio) ? audio : audio?.records;
  if (!Array.isArray(records) || !records.some(r => r?.[ear] && !r.miss)) return null;
  const { audio: _drop, collect: _c, ...rest } = acc;
  return earComparison(lib, records, { ...rest, ear, ...(audio?.feedback ? { feedback: audio.feedback } : {}) });
}
