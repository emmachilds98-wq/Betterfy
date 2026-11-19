// @bundle engine BetterfyCalibrate 100
// How sure the engine is allowed to be — measured on this account's own filing.
//
// docs/SMARTER-GENRES-PLAN.md §4.2. A score of 0.42 means nothing to anybody,
// and the bands it used to come with (HIGH, LIKELY…) were thresholds somebody
// picked. This replaces both with three answers whose meaning is checked:
//
//   confident  one playlist, and suggestions this sure were right at least
//              `target` of the time on tracks this account already filed —
//              with a lower confidence bound, not just an average, so a lucky
//              handful cannot buy the label
//   choose     a short list (at most `maxChoices`) that held the right playlist
//              at least 1 − `alpha` of the time (split conformal prediction)
//   unsure     neither: the engine says so rather than guessing
//
// Everything is fitted on held-out placements from `placementAccuracy(…,
// { collect: true })`, so the account grades the engine with its own answer
// key, as everywhere else in core/intrinsic. And the number shown to the
// listener is never the number it was fitted on: `calibrationReport` fits on
// one half of the tracks and checks on the other, then swaps.
//
// Nothing here is trained: it is a threshold and a quantile over this account's
// own held-out scores, shown back to the same account (plan §3, R3).

export const CALIBRATE_VERSION = '1.0.0';

export const DEFAULTS = {
  /** What "confident" must mean: right this often, as a lower bound. */
  target: 0.9,
  /** Conformal miss rate for the short list: it holds the answer 1 − alpha of the time. */
  alpha: 0.1,
  /** Fewer held-out tracks than this above a threshold cannot vouch for it. */
  minConfident: 20,
  /** A list longer than this is not a choice, it is a shrug. */
  maxChoices: 3,
  /** One-sided 95% for the Wilson bound. */
  z: 1.645,
  /** What "confident" must mean inside one agreement level (agree.mjs): a
   *  little above `target`, so the held-out check (AGREE_GATE, 95%) has room. */
  agreeTarget: 0.92,
};

/** Probability step the confident threshold is fitted on (see fitCalibration). */
export const BIN = 0.05;

/**
 * A track's raw scores, highest first: [[playlistId, score], …] over every
 * destination that scored. Raw, not normalised: how sharply to read them is
 * itself fitted (`fitTemperature`), because combine() scores are similarities
 * whose spread differs from one library to the next. Measured on a simulated
 * scene library: score/sum put the leader at ~0.2 for most tracks, which made
 * every short list too long to be a choice.
 */
export function scoresOf(results) {
  return (results ?? [])
    .filter(r => r && Number.isFinite(r.score))
    .map(r => [r.playlistId, +r.score.toFixed(5)])
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
}

/** Softmax at temperature T: [[playlistId, p], …], same order. */
export function softmax(scores, T) {
  if (!scores?.length) return [];
  const m = scores[0][1];
  const e = scores.map(([id, x]) => [id, Math.exp((x - m) / T)]);
  const z = e.reduce((s, [, v]) => s + v, 0);
  return e.map(([id, v]) => [id, v / z]);
}

/** Temperatures tried. Low = trust small score gaps a lot; high = barely. */
export const TEMPERATURES = [0.005, 0.01, 0.02, 0.03, 0.05, 0.075, 0.1, 0.15, 0.2, 0.3, 0.5, 1];

/**
 * The temperature that best explains where this account's held-out tracks
 * really went: lowest mean −log P(truth), P(truth) being the mass on any of the
 * track's real playlists. Temperature scaling — one number, fitted on held-out
 * data, which changes how sure the engine sounds and never what it ranks first.
 */
export function fitTemperature(rows) {
  let best = null;
  for (const T of TEMPERATURES) {
    let nll = 0, n = 0;
    for (const r of rows) {
      const mass = softmax(r.scores, T).filter(([id]) => r.truth.includes(id)).reduce((s, [, p]) => s + p, 0);
      nll -= Math.log(Math.max(mass, 1e-9));
      n++;
    }
    if (n && (!best || nll / n < best.nll)) best = { T, nll: nll / n };
  }
  return best?.T ?? 0.1;
}

/**
 * Isotonic regression of outcomes on a score: pool adjacent violators. Points
 * are [x, y] for one 0/1 outcome, or [x, sum, n] for n of them pooled.
 * Returns blocks in increasing score order, each { x: lowest score in it,
 * sum, n }, whose rates sum/n never decrease. Equal scores are pooled first,
 * so a threshold can never split a tie.
 */
export function isotonic(points) {
  const sorted = [...points].sort((a, b) => a[0] - b[0]);
  const blocks = [];
  for (const [x, y, w = 1] of sorted) {
    const last = blocks[blocks.length - 1];
    if (last && last.xmax === x) { last.sum += y; last.n += w; }
    else blocks.push({ x, xmax: x, sum: y, n: w });
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1], a = blocks[blocks.length - 2];
      if (a.sum / a.n < b.sum / b.n) break;
      blocks.splice(-2, 2, { x: a.x, xmax: b.xmax, sum: a.sum + b.sum, n: a.n + b.n });
    }
  }
  return blocks.map(({ x, sum, n }) => ({ x, sum, n }));
}

/** Wilson score interval, lower end: what a success rate of right/n is at
 *  least, with one-sided confidence z. */
export function wilsonLower(right, n, z = DEFAULTS.z) {
  if (!n) return 0;
  const p = right / n, z2 = z * z;
  return (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
}

const inTruth = (row, id) => row.truth.includes(id);

/**
 * Fit the temperature and two thresholds on held-out rows: { scores, truth }.
 *
 * `tau`: the lowest top-probability whose own isotonic estimate of being right
 * reaches `target`, and above which every track together was right with a
 * Wilson lower bound of at least `target` over at least `minConfident` tracks.
 * Null when nothing earns it, so nothing is ever called confident on hope.
 *
 * `pmin`: split-conformal (least-ambiguous sets). Nonconformity of a row is
 * 1 − p of its best true playlist; the ⌈(n+1)(1−alpha)⌉-th smallest of those is
 * q̂, and a playlist joins a track's set when 1 − p ≤ q̂.
 */
export function fitCalibration(rows, opts = {}) {
  const { target, alpha, minConfident } = { ...DEFAULTS, ...opts };
  const usable = (rows ?? []).filter(r => r?.scores?.length && r.truth?.length);
  const n = usable.length;
  const T = fitTemperature(usable);
  const probs = usable.map(r => ({ r, top: softmax(r.scores, T) }));

  // Where "confident" starts. Not simply the lowest threshold whose tracks are
  // right 90% of the time overall: that lets the easy tracks carry a band of
  // coin-flips in just above the line, which then get called confident at 50%.
  // Isotonic regression (pool adjacent violators) first estimates how often a
  // track at each probability is right; only probabilities whose OWN estimate
  // reaches the target qualify. Then the Wilson bound has to hold for
  // everything at or above, over enough tracks, or the threshold moves up.
  // Binned to steps of BIN first: probabilities that differ only by noise in
  // the scores of also-rans must not form a block of their own — measured, a
  // pile of coin-flips at p≈0.58 split into a "right" tail and a "wrong" one by
  // differences in the third decimal, and the right tail qualified.
  const bins = new Map();
  for (const { r, top } of probs) {
    const k = Math.min(Math.floor(top[0][1] / BIN), Math.round(1 / BIN) - 1);
    const b = bins.get(k) ?? { x: Infinity, sum: 0, n: 0 };
    b.x = Math.min(b.x, top[0][1]); b.sum += inTruth(r, top[0][0]) ? 1 : 0; b.n++;
    bins.set(k, b);
  }
  const blocks = isotonic([...bins.values()].map(b => [b.x, b.sum, b.n]));
  let tau = null, confidentN = 0, confidentRight = 0;
  const start = blocks.findIndex(b => b.sum / b.n >= target);
  if (start >= 0) {
    for (let i = start; i < blocks.length; i++) {
      const above = blocks.slice(i);
      const k = above.reduce((s, b) => s + b.n, 0), right = above.reduce((s, b) => s + b.sum, 0);
      if (k < minConfident) break;
      if (wilsonLower(right, k) >= target) { tau = blocks[i].x; confidentN = k; confidentRight = right; break; }
    }
  }

  const scores = probs.map(({ r, top }) => {
    const best = Math.max(0, ...top.filter(([id]) => inTruth(r, id)).map(([, p]) => p));
    return 1 - best;
  }).sort((a, b) => a - b);
  const rank = Math.ceil((n + 1) * (1 - alpha));
  const qhat = n && rank <= n ? scores[rank - 1] : 1;

  const out = { version: CALIBRATE_VERSION, n, T, tau: tau == null ? null : +tau.toFixed(5),
                pmin: +(1 - qhat).toFixed(5), target, alpha, confidentN, confidentRight };
  // Package 4 (docs/archive/NEXT-WORKPLAN.md): rows that carry an agreement level
  // (core/intrinsic/agree.mjs) get a "confident" threshold of their own per
  // level, fitted the same way on only that level's rows. A card where sound,
  // filing history and tags all rank the same playlist first is right far
  // more often than its margin says; this is where that is measured.
  if (opts.byLevel !== false && usable.some(r => r.agree)) {
    const byLevel = {};
    for (const level of AGREE_LEVELS) {
      const mine = usable.filter(r => r.agree === level);
      if (mine.length < minConfident) continue;
      const c = fitCalibration(mine, { ...opts, target: opts.agreeTarget ?? DEFAULTS.agreeTarget, byLevel: false });
      if (c.tau != null) byLevel[level] = { T: c.T, tau: c.tau, n: c.n, confidentN: c.confidentN, confidentRight: c.confidentRight };
    }
    if (Object.keys(byLevel).length) out.byLevel = byLevel;
  }
  // Build 8 I2: the same idea for any pocket a row names (`pockets`, see
  // pocketKeys): fitted on only that pocket's rows, kept when it earns a tau.
  // Whether they are USED is decided on held-out rows in calibrationReport.
  if (opts.pockets !== false && usable.some(r => r.pockets?.length)) {
    const groups = new Map();
    for (const r of usable) for (const k of r.pockets ?? []) {
      if (opts.pocketAllow && !opts.pocketAllow.has(k)) continue;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    const pockets = {};
    for (const [k, mine] of groups) {
      if (mine.length < minConfident) continue;
      const c = fitCalibration(mine, { ...opts, target: opts.agreeTarget ?? DEFAULTS.agreeTarget, byLevel: false, pockets: false });
      if (c.tau != null) pockets[k] = { T: c.T, tau: c.tau, n: c.n, confidentN: c.confidentN, confidentRight: c.confidentRight };
    }
    if (Object.keys(pockets).length) out.pockets = pockets;
  }
  return out;
}

/**
 * Build 8 I2 (docs/BUILD-8-PLAN.md): pockets. A pocket is a group of tracks
 * the account can name WITHOUT knowing the answer, so "Sure" can be fitted
 * inside it (Mondrian calibration) instead of over everyone at once:
 *   sit:filed | sit:fresh       the artist is already filed / never filed
 *   fam:<family>                the leading playlist's family
 *   size:small | mid | large    the leading playlist's size
 *   agree:<level>|sit:<s>       how the sources line up, within a situation
 * Most specific first: a card is credited to the first pocket that vouches.
 * Anything not given is left out.
 */
export function pocketKeys({ sit = null, fam = null, size = null, agree = null } = {}) {
  const out = [];
  if (agree && agree !== 'split' && sit) out.push(`agree:${agree}|sit:${sit}`);
  if (fam) out.push(`fam:${fam}`);
  if (size) out.push(`size:${size}`);
  if (sit) out.push(`sit:${sit}`);
  return out;
}

/** Size band of a playlist by its track count. */
export const sizeBand = n => (n < 25 ? 'small' : n < 80 ? 'mid' : 'large');

/**
 * Put `pockets` on held-out rows (copied). Context, all optional:
 *   fresh(id)   true when the track's artist was never filed
 *   famOf(pl)   the family of a playlist id
 *   sizeOf(pl)  the playlist's track count
 * Reads the row's own lead playlist (its top score), never its truth.
 */
export function withPockets(rows, { fresh = null, famOf = null, sizeOf = null } = {}) {
  return (rows ?? []).map(r => {
    const lead = r.scores?.[0]?.[0] ?? null;
    const n = lead != null && sizeOf ? sizeOf(lead) : null;
    const pockets = pocketKeys({
      sit: fresh ? (fresh(r.id) ? 'fresh' : 'filed') : null,
      fam: lead != null && famOf ? famOf(lead) ?? null : null,
      size: Number.isFinite(n) ? sizeBand(n) : null,
      agree: r.agree ?? null,
    });
    return { ...r, pockets };
  });
}

/**
 * What pocket-earned Sure must do on held-out rows: every Sure card together
 * (pockets included) right at least `minPrecision` of the time on at least
 * `minN` cards covering at least `coverage` of tracks, and each pocket used
 * right at least `minPrecision` on at least `minN` cards of its own. The same
 * bar as AGREE_GATE and the plan's (ENGINE-REVIEW): grouping changes, strictness does not.
 */
export const POCKET_GATE = Object.freeze({ minPrecision: 0.95, minN: 20, coverage: 0.25 });

/** The agreement levels that may earn their own "confident" (agree.mjs LEVELS minus `split`). */
export const AGREE_LEVELS = Object.freeze(['agree', 'single']);

/**
 * What agreement-earned "Sure" must do on held-out rows before it is used:
 * right at least `minPrecision` of the time over at least `minN` cards.
 * Set before any owner run (docs/archive/NEXT-WORKPLAN.md package 4 gate).
 */
export const AGREE_GATE = Object.freeze({ minPrecision: 0.95, minN: 20, coverage: 0.25 });

/**
 * What to say about one track: { kind, playlists, p }.
 *
 *   confident → one playlist        choose → one to `maxChoices` playlists
 *   unsure    → none worth naming
 */
export function decide(scores, cal, opts = {}) {
  const { maxChoices } = { ...DEFAULTS, ...opts };
  if (!scores?.length || !cal) return { kind: 'unsure', playlists: [], p: 0 };
  const top = softmax(scores, cal.T);
  const [lead, p] = top[0];
  const r = x => +x.toFixed(4);
  if (cal.tau != null && p >= cal.tau) return { kind: 'confident', playlists: [lead], p: r(p) };
  // The sources agree (opts.agree, a level from agree.mjs) and this account's
  // held-out cards at that level were right often enough: confident on that.
  const lv = opts.agree ? cal.byLevel?.[opts.agree] : null;
  if (lv && lv.tau != null) {
    const pl = softmax(scores, lv.T)[0][1];
    if (pl >= lv.tau) return { kind: 'confident', playlists: [lead], p: r(pl), via: 'agree' };
  }
  // Build 8 I2: a pocket this track belongs to that earned its own threshold.
  for (const k of Array.isArray(opts.pockets) ? opts.pockets : []) {
    const pk = cal.pockets?.[k];
    if (!pk || pk.tau == null) continue;
    const pl = softmax(scores, pk.T)[0][1];
    if (pl >= pk.tau) return { kind: 'confident', playlists: [lead], p: r(pl), via: 'pocket', pocket: k };
  }
  const set = top.filter(([, q]) => q >= cal.pmin && q > 0).map(([id]) => id);
  if (set.length >= 1 && set.length <= maxChoices) return { kind: 'choose', playlists: set, p: r(p) };
  return { kind: 'unsure', playlists: [], p: r(p) };
}

/** How the decisions did on rows they were not fitted on. */
export function evaluate(rows, cal, opts = {}) {
  const out = { n: 0, confident: { n: 0, right: 0 }, choose: { n: 0, contains: 0, size: 0 }, unsure: { n: 0 },
                agree: { n: 0, right: 0 }, pocket: { n: 0, right: 0, byKey: {} }, levels: {} };
  for (const r of rows ?? []) {
    if (!r?.scores?.length || !r.truth?.length) continue;
    out.n++;
    if (r.agree) out.levels[r.agree] = (out.levels[r.agree] ?? 0) + 1;
    const d = decide(r.scores, cal, { ...opts, ...(r.agree ? { agree: r.agree } : {}), ...(r.pockets?.length ? { pockets: r.pockets } : {}) });
    if (d.kind === 'confident') {
      const ok = inTruth(r, d.playlists[0]);
      out.confident.n++; if (ok) out.confident.right++;
      if (d.via === 'agree') { out.agree.n++; if (ok) out.agree.right++; }
      if (d.via === 'pocket') {
        out.pocket.n++; if (ok) out.pocket.right++;
        const b = out.pocket.byKey[d.pocket] ??= { n: 0, right: 0 };
        b.n++; if (ok) b.right++;
      }
    }
    else if (d.kind === 'choose') {
      out.choose.n++; out.choose.size += d.playlists.length;
      if (d.playlists.some(id => inTruth(r, id))) out.choose.contains++;
    } else out.unsure.n++;
  }
  return out;
}

const half = id => {
  // Its own hash, salted, so the split is independent of the fold assignment.
  let h = 0x811c9dc5;
  const s = `calibrate:${id}`;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h & 1;
};
const rate = (a, b) => (b > 0 ? +(a / b).toFixed(4) : null);

/**
 * Fit for use on every row, and report how it does on tracks it never saw.
 *
 * Cross-fitted: thresholds fitted on half A are checked on half B and vice
 * versa, and the two checks are pooled. The thresholds actually used are fitted
 * on all rows, which can only make them steadier than the ones checked.
 *
 * `holds` is the plan's phase 2 gate (§7): the checked rate of confident
 * suggestions within 3 points of the target, over enough tracks to mean it.
 */
export function calibrationReport(rows, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const usable = (rows ?? []).filter(r => r?.id && r.scores?.length && r.truth?.length);
  const hasLevels = usable.some(r => r.agree);
  let run = crossCheck(usable, { ...o, pockets: false });
  let oBase = { ...o };
  let agree = null;
  if (hasLevels) {
    // The agreement gate (AGREE_GATE): cards made "Sure" only by agreement,
    // checked on the half they were not fitted on. When it fails, the
    // per-level thresholds are not used, and everything reported (and the
    // calibration handed back) is exactly what it would be without levels.
    const { n, right } = run.agreeSure;
    const precision = rate(right, n);
    const fitted = !!run.cal.byLevel;
    const use = fitted && n >= AGREE_GATE.minN && precision != null && precision >= AGREE_GATE.minPrecision;
    const why = use ? null
      : !fitted ? 'no agreement level cleared its bar'
      : !n ? 'no held-out card earned it'
      : n < AGREE_GATE.minN ? `only ${n} held-out cards, ${AGREE_GATE.minN} needed`
      : `held-out precision ${Math.round(precision * 100)}%, ${Math.round(AGREE_GATE.minPrecision * 100)}% needed`;
    const levels = Object.fromEntries(Object.entries(run.levels).map(([k, v]) => [k, rate(v, run.checked.n)]));
    agree = { use, n, right: precision, share: rate(n, run.checked.n), why, levels };
    if (!use) { oBase = { ...o, byLevel: false }; run = crossCheck(usable, { ...oBase, pockets: false }); }
    // Every Sure card together (by margin or by agreement), as File shows them.
    agree.sure = { share: run.checked.confidentShare, right: run.checked.confidentRight, n: run.checked.confidentN };
  }
  // Build 8 I2: pockets, on top of whatever the agreement stage settled on.
  let pockets = null;
  if (usable.some(r => r.pockets?.length)) {
    const before = { n: run.checked.confidentN, right: run.checked.confidentRight, share: run.checked.confidentShare };
    const G = POCKET_GATE;
    const probe = crossCheck(usable, oBase);
    const keep = Object.entries(probe.pocketSure.byKey)
      .filter(([, v]) => v.n >= G.minN && v.right / v.n >= G.minPrecision).map(([k]) => k);
    if (!keep.length) {
      pockets = { use: false, keys: [], before, why: probe.pocketSure.n
        ? `no pocket was right ${Math.round(G.minPrecision * 100)}% on ${G.minN} held-out cards`
        : 'no pocket earned a threshold of its own', share: before.share, right: before.right, n: before.n };
    } else {
      const fin = crossCheck(usable, { ...oBase, pocketAllow: new Set(keep) });
      const c = fin.checked;
      const keys = Object.entries(fin.pocketSure.byKey).map(([key, v]) => ({ key, n: v.n, right: rate(v.right, v.n) }))
        .sort((a, b) => b.n - a.n || (a.key < b.key ? -1 : 1));
      const pass = fin.pocketSure.n > 0 && c.confidentN >= G.minN && c.confidentRight != null
        && c.confidentRight >= G.minPrecision && c.confidentShare != null && c.confidentShare >= G.coverage;
      const pc = x => `${Math.round((x ?? 0) * 100)}%`;
      const why = pass ? null
        : fin.pocketSure.n === 0 ? 'no held-out card was earned by a pocket'
        : c.confidentRight == null || c.confidentRight < G.minPrecision ? `Sure right ${pc(c.confidentRight)}, ${pc(G.minPrecision)} needed`
        : `Sure on ${pc(c.confidentShare)} of tracks, ${pc(G.coverage)} needed`;
      pockets = { use: pass, keys, before, why, share: c.confidentShare, right: c.confidentRight, n: c.confidentN };
      if (pass) run = fin;
    }
  }
  const { checked, cal } = run;
  const holds = checked.confidentN >= o.minConfident && checked.confidentRight != null
    ? checked.confidentRight >= o.target - 0.03 : null;
  return { version: CALIBRATE_VERSION, cal, checked, holds, target: o.target, ...(agree ? { agree } : {}), ...(pockets ? { pockets } : {}) };
}

/** Fit on one half, check on the other, both ways, pooled; plus the fit on everything. */
function crossCheck(usable, o) {
  const a = usable.filter(r => half(r.id) === 0), b = usable.filter(r => half(r.id) === 1);
  const ea = evaluate(a, fitCalibration(b, o), o), eb = evaluate(b, fitCalibration(a, o), o);
  const pool = {
    n: ea.n + eb.n,
    confident: { n: ea.confident.n + eb.confident.n, right: ea.confident.right + eb.confident.right },
    choose: { n: ea.choose.n + eb.choose.n, contains: ea.choose.contains + eb.choose.contains,
              size: ea.choose.size + eb.choose.size },
    unsure: { n: ea.unsure.n + eb.unsure.n },
  };
  const checked = {
    n: pool.n,
    confidentShare: rate(pool.confident.n, pool.n),
    confidentRight: rate(pool.confident.right, pool.confident.n),
    confidentN: pool.confident.n,
    chooseShare: rate(pool.choose.n, pool.n),
    chooseContains: rate(pool.choose.contains, pool.choose.n),
    chooseSize: pool.choose.n ? +(pool.choose.size / pool.choose.n).toFixed(2) : null,
    unsureShare: rate(pool.unsure.n, pool.n),
  };
  const levels = {};
  for (const e of [ea, eb]) for (const [k, v] of Object.entries(e.levels)) levels[k] = (levels[k] ?? 0) + v;
  const byKey = {};
  for (const e of [ea, eb]) for (const [k, v] of Object.entries(e.pocket.byKey)) {
    const b = byKey[k] ??= { n: 0, right: 0 };
    b.n += v.n; b.right += v.right;
  }
  return { checked, cal: fitCalibration(usable, o), levels,
           agreeSure: { n: ea.agree.n + eb.agree.n, right: ea.agree.right + eb.agree.right },
           pocketSure: { n: ea.pocket.n + eb.pocket.n, right: ea.pocket.right + eb.pocket.right, byKey } };
}

/** A pocket key in words. `nameOf` can rename a family. */
export function pocketLabel(key, nameOf = x => x) {
  const one = k => {
    const [kind, v] = [k.slice(0, k.indexOf(':')), k.slice(k.indexOf(':') + 1)];
    if (kind === 'sit') return v === 'fresh' ? 'never-filed artists' : 'filed artists';
    if (kind === 'fam') return String(nameOf(v));
    if (kind === 'size') return `${v} playlists`;
    if (kind === 'agree') return v === 'agree' ? 'sources agree' : 'one source';
    return k;
  };
  return String(key).split('|').map(one).join(', ');
}

/**
 * Score line for I2, from a calibrationReport's `pockets`:
 *   "Sure earned: pockets X, Y — Z% of tracks at P%."
 * or, when none cleared the bar, how close it got. '' when pockets were not tried.
 */
export function pocketsLine(report, nameOf) {
  const p = report?.pockets;
  if (!p) return '';
  const pc = x => `${Math.round((x ?? 0) * 100)}%`;
  if (p.use) {
    const names = p.keys.slice(0, 3).map(k => pocketLabel(k.key, nameOf)).join('; ');
    return `Sure earned: pockets ${names} — ${pc(p.share)} of tracks at ${pc(p.right)}.`;
  }
  const close = p.n ? ` Closest: ${pc(p.share)} of tracks at ${pc(p.right)}.` : '';
  return `Sure earned: none yet (${p.why}).${close}`;
}
