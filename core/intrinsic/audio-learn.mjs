// What this account's playlists sound like, learned from their own members.
//
// WP-L1 of docs/AUDIO-BUILD-PLAN.md: the part that makes the audio "learn".
// `audio.mjs` (WP-E1) scores a track by plain cosine to each playlist's
// centroid. This module trains, in the page, on the account's own analysed
// playlist members, and answers with a probability per playlist that
// `calibrate.mjs` can band:
//
//   1. prototypes: the centroid baseline phase 0 measured (58% top-1, 76%
//      top-2 from nine examples), turned into probabilities by a softmax whose
//      temperature is fitted on a held-out fold
//   2. a multinomial logistic regression on the standardised embeddings, with
//      L2 regularisation, a class-balanced loss, and early stopping on the
//      same held-out fold
//
// Both are fitted, both are scored on the held-out fold, and the learner keeps
// whichever explained it better (lower class-balanced log loss). Logistic
// regression has to beat the baseline honestly on tracks it did not see; it is
// not assumed to. Then the winner is refitted on every example (logistic
// regression for the epoch count early stopping chose), so a playlist with
// five analysed members is not trained on four.
//
// Rules inherited from audio.mjs and CLAUDE.md:
//   - no records, no learner: `learnAudio` returns null and `learnedScores`
//     null, so the engine adds nothing and its output is byte-identical
//   - a playlist with fewer than MIN_AUDIO_MEMBERS analysed members is not a
//     class; it scores null, never 0
//   - deterministic: the held-out fold comes from a hash of the track id, not
//     Math.random, so the same library trains the same model
//   - nothing leaves the account: the training data is this account's own
//     playlist structure over Deezer audio embeddings, and the model is never
//     shared or pooled (docs/SMARTER-GENRES-PLAN.md §3)
//
// No import from space.mjs, for the reason audio.mjs gives (WP-E2 wires both
// into space.mjs; bundler.mjs refuses a cycle).
import { MIN_AUDIO_MEMBERS } from './audio.mjs';

export const AUDIO_LEARN_VERSION = '1.0.0';

export const LEARN_DEFAULTS = {
  /** A playlist needs this many analysed members to be a class (= audio.mjs's floor). */
  minMembers: MIN_AUDIO_MEMBERS,
  /** Share of each class held out for early stopping and model choice. */
  holdout: 0.2,
  /** L2 strengths tried on the held-out fold; the best is kept. Per unit of
   *  standardised weight, so they mean the same at any dimension. */
  l2: [1, 3],
  /** Adam on the full batch. */
  lr: 0.01,
  maxEpochs: 150,
  /** Stop when held-out loss has not improved for this many epochs. */
  patience: 12,
  /** Prototype softmax temperatures tried (cosines live in a narrow band). */
  temperatures: [0.01, 0.015, 0.02, 0.03, 0.04, 0.05, 0.075, 0.1, 0.15, 0.2],
  /** 'auto' keeps the held-out winner; 'prototype' or 'logistic' forces one. */
  model: 'auto',
  /** Standardise each dimension (true) or only centre and scale globally (false). */
  perDim: true,
  /** Start from, and regularise toward, the prototype model instead of zero. */
  prior: true,
  /** Training examples kept per playlist (deterministic sample). Bounds the
   *  cost of one fit to about K · maxPerClass · 1280 · epochs multiply-adds
   *  whatever the library size; the learning curve flattens long before. */
  maxPerClass: 200,
  /** In 'auto', logistic regression is only tried when every playlist has at
   *  least this many analysed members. Below it the held-out fold is one or
   *  two tracks a playlist, too few to choose between models on: measured on
   *  the phase 0 fixture, 'auto' at 5 per playlist picked logistic 8 times in
   *  10 and lost a point of top-1 to the baseline (57.6% vs 58.8%). */
  minForLogistic: 10,
};

const idOf = t => (typeof t === 'string' ? t : t?.id) || null;

function memberIdsOf(d) {
  if (d?.trackIds) return d.trackIds;
  if (Array.isArray(d?.tracks)) return d.tracks;
  return null;
}

/** FNV-1a, salted: a track's place in the held-out fold, independent of anything else. */
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h;
}

/* ------------------------------------------------------------------ data */

/**
 * The training set: every analysed member of every destination with enough
 * analysed members. A track filed in two playlists is one example whose target
 * is split between them, not two contradicting examples.
 *
 * @param {object|Map|Array} destinations  a space, its `.destinations` Map, or [{ id, tracks|trackIds }]
 * @param {Map} index  from audio.mjs `audioIndex` (unit embeddings)
 * @param {{ skip?: Set<string>, minMembers?: number }} [opts]
 * @returns {{ classes: string[], ids: string[], X: Float32Array[], Y: number[][], counts: number[], short: string[] }}
 *          `Y[i]` lists the class indices example i belongs to. `short` names
 *          destinations that had some, but too few, analysed members.
 */
export function trainingSet(destinations, index, { skip = null, minMembers = LEARN_DEFAULTS.minMembers } = {}) {
  const src = destinations?.destinations ?? destinations;
  const list = src instanceof Map ? [...src.values()] : [...(src ?? [])];
  const members = [], short = [];
  for (const d of list) {
    if (!d?.id) continue;
    const ids = new Set();
    for (const t of memberIdsOf(d) ?? []) {
      const id = idOf(t);
      if (id && !skip?.has(id) && index?.has(id)) ids.add(id);
    }
    if (ids.size >= minMembers) members.push([d.id, ids]);
    else if (ids.size) short.push(d.id);
  }
  members.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const classes = members.map(([id]) => id);
  const rows = new Map();
  members.forEach(([, ids], c) => { for (const id of ids) (rows.get(id) ?? rows.set(id, []).get(id)).push(c); });
  const ids = [...rows.keys()].sort();
  return {
    classes, ids,
    X: ids.map(id => index.get(id).emb),
    Y: ids.map(id => rows.get(id)),
    counts: members.map(([, s]) => s.size),
    short,
  };
}

/** Subset of a training set by example index (classes kept, counts recomputed). */
export function subset(set, keep) {
  const counts = new Array(set.classes.length).fill(0);
  for (const i of keep) for (const c of set.Y[i]) counts[c]++;
  return { classes: set.classes, ids: keep.map(i => set.ids[i]), X: keep.map(i => set.X[i]),
           Y: keep.map(i => set.Y[i]), counts, short: set.short ?? [] };
}

/**
 * Deterministic held-out split: about `share` of each class's examples, never
 * all of one (a class keeps at least one training example), always at least
 * one held out when the class has two or more. An example is assigned by its
 * first class. `groupOf` (e.g. id → artist) keeps a group on one side, so an
 * artist cannot be learned in training and recognised in the fold.
 */
export function holdoutSplit(set, { share = LEARN_DEFAULTS.holdout, groupOf = null, salt = 'audio-learn' } = {}) {
  const byClass = new Map();
  set.ids.forEach((id, i) => {
    const c = set.Y[i][0];
    (byClass.get(c) ?? byClass.set(c, []).get(c)).push(i);
  });
  const train = [], val = [];
  for (const [, idx] of [...byClass].sort((a, b) => a[0] - b[0])) {
    const key = i => `${salt}:${groupOf ? (groupOf(set.ids[i]) ?? set.ids[i]) : set.ids[i]}`;
    const groups = new Map();
    for (const i of idx) (groups.get(key(i)) ?? groups.set(key(i), []).get(key(i))).push(i);
    const order = [...groups].sort((a, b) => hash(a[0]) - hash(b[0]) || (a[0] < b[0] ? -1 : 1));
    const want = idx.length >= 2 ? Math.max(1, Math.round(idx.length * share)) : 0;
    let held = 0;
    for (const [, g] of order) {
      if (held < want && held + g.length < idx.length) { val.push(...g); held += g.length; }
      else train.push(...g);
    }
  }
  return { train: train.sort((a, b) => a - b), val: val.sort((a, b) => a - b) };
}

/** Per-class weight so every playlist counts equally, whatever its size: N / (K · n_c). */
function classWeights(set) {
  const K = set.classes.length, N = set.ids.length;
  return set.counts.map(n => (n > 0 ? N / (K * n) : 0));
}

/** Soft target: an example's mass split equally over its playlists. */
function targetOf(y, K) {
  const t = new Float64Array(K);
  for (const c of y) t[c] += 1 / y.length;
  return t;
}

/* ------------------------------------------------------------ prototypes */

function unitInto(sum) {
  let ss = 0;
  for (let i = 0; i < sum.length; i++) ss += sum[i] * sum[i];
  if (!(ss > 0)) return null;
  const inv = 1 / Math.sqrt(ss), out = new Float32Array(sum.length);
  for (let i = 0; i < sum.length; i++) out[i] = sum[i] * inv;
  return out;
}

function dot(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d;
}

/**
 * Centroid per class, from unit embeddings (the geometry audio.mjs and phase 0
 * use). `T` is the softmax temperature that turns cosines into probabilities.
 */
export function trainPrototypes(set, { T = 0.05 } = {}) {
  const K = set.classes.length, D = set.X[0]?.length ?? 0;
  const sums = Array.from({ length: K }, () => new Float64Array(D));
  set.X.forEach((x, i) => { for (const c of set.Y[i]) for (let k = 0; k < D; k++) sums[c][k] += x[k]; });
  return { kind: 'prototype', classes: set.classes, centroids: sums.map(unitInto), T };
}

/* ------------------------------------------------------- logistic model */

/** Mean and standard deviation per dimension, over the training examples. */
function standardiser(X, perDim = true) {
  const D = X[0].length, N = X.length;
  const mean = new Float64Array(D), sd = new Float64Array(D);
  for (const x of X) for (let k = 0; k < D; k++) mean[k] += x[k] / N;
  for (const x of X) for (let k = 0; k < D; k++) sd[k] += (x[k] - mean[k]) ** 2 / N;
  if (!perDim) {
    // One scale for every dimension: centred, total variance D, geometry kept.
    const tot = Math.sqrt(sd.reduce((a, b) => a + b, 0) / D) || 1;
    sd.fill(tot * tot);
  }
  for (let k = 0; k < D; k++) sd[k] = Math.sqrt(sd[k]) || 1;
  return { mean: Float32Array.from(mean), inv: Float32Array.from(sd, s => 1 / s) };
}

function standardise(X, { mean, inv }) {
  const D = mean.length, out = new Float32Array(X.length * D);
  X.forEach((x, i) => { const o = i * D; for (let k = 0; k < D; k++) out[o + k] = (x[k] - mean[k]) * inv[k]; });
  return out;
}

/** Logits for row r of a flat [N × D] matrix into `z` (length K). */
function logitsInto(z, W, b, Z, r, D, K) {
  const o = r * D;
  for (let c = 0; c < K; c++) {
    let s = b[c];
    const w = c * D;
    for (let k = 0; k < D; k++) s += W[w + k] * Z[o + k];
    z[c] = s;
  }
}

function softmaxInPlace(z) {
  let m = -Infinity;
  for (const v of z) if (v > m) m = v;
  let s = 0;
  for (let c = 0; c < z.length; c++) { z[c] = Math.exp(z[c] - m); s += z[c]; }
  for (let c = 0; c < z.length; c++) z[c] /= s;
  return z;
}

/**
 * Class-balanced cross-entropy of probability rows against targets:
 * Σ_i Σ_c w_c t_ic (−log p_ic) / Σ_i Σ_c w_c t_ic.
 */
function balancedLoss(P, T, w) {
  let loss = 0, mass = 0;
  for (let i = 0; i < P.length; i++) {
    for (let c = 0; c < w.length; c++) {
      if (!T[i][c]) continue;
      loss -= w[c] * T[i][c] * Math.log(Math.max(P[i][c], 1e-12));
      mass += w[c] * T[i][c];
    }
  }
  return mass ? loss / mass : 0;
}

/**
 * Multinomial logistic regression, full-batch Adam.
 *
 * Loss: class-balanced cross-entropy (each playlist weighs the same, so a big
 * playlist cannot win every track by being big) + (l2/2)·‖W‖², bias
 * unregularised. With `val`, stops when the held-out balanced loss has not
 * improved for `patience` epochs and keeps the best epoch's weights.
 *
 * @param {object} set  training set (from `trainingSet`/`subset`)
 * @param {{ l2?: number, lr?: number, maxEpochs?: number, patience?: number, val?: object, epochs?: number }} [opts]
 *        `epochs` trains exactly that many with no early stopping (the refit)
 */
export function trainLogistic(set, opts = {}) {
  const { l2 = LEARN_DEFAULTS.l2[0], lr = LEARN_DEFAULTS.lr, maxEpochs = LEARN_DEFAULTS.maxEpochs,
          patience = LEARN_DEFAULTS.patience, val = null, epochs = null,
          perDim = LEARN_DEFAULTS.perDim, prior = LEARN_DEFAULTS.prior, T0 = 0.05 } = opts;
  const K = set.classes.length, D = set.X[0].length, N = set.X.length;
  const std = standardiser(set.X, perDim);
  const Z = standardise(set.X, std);
  const w = classWeights(set);
  const T = set.Y.map(y => targetOf(y, K));
  const sw = T.map(t => t.reduce((s, v, c) => s + v * w[c], 0));
  const S = sw.reduce((a, b) => a + b, 0) || 1;

  const W = new Float32Array(K * D), b = new Float32Array(K);
  // Prior: the prototype model written as logistic weights. cos(x, c)/T0 is
  // linear in x, so in the standardised space z = (x − μ)·inv it is
  // W0·z + b0 with W0[c,k] = c_k / (inv_k·T0) and b0_c = μ·c / T0. Training
  // starts there and the L2 penalty pulls toward it instead of toward zero:
  // with few examples the model stays the baseline, with more it moves only
  // where the held-out loss says moving pays.
  let W0 = null;
  if (prior) {
    const proto = trainPrototypes(set);
    W0 = new Float32Array(K * D);
    for (let c = 0; c < K; c++) {
      const cen = proto.centroids[c];
      if (!cen) continue;
      let mb = 0;
      for (let k = 0; k < D; k++) { W0[c * D + k] = cen[k] / (std.inv[k] * T0); mb += std.mean[k] * cen[k]; }
      b[c] = mb / T0;
    }
    W.set(W0);
  }
  const gW = new Float32Array(K * D), gb = new Float64Array(K);
  const mW = new Float32Array(K * D), vW = new Float32Array(K * D);
  const mb = new Float64Array(K), vb = new Float64Array(K);
  const b1 = 0.9, b2 = 0.999, eps = 1e-8;
  const z = new Float64Array(K);

  let Zv = null, Tv = null;
  if (val && !epochs) { Zv = standardise(val.X, std); Tv = val.Y.map(y => targetOf(y, K)); }
  const wv = val ? classWeights({ ...val, classes: set.classes }) : null;
  const valLoss = () => {
    const P = [];
    for (let i = 0; i < val.X.length; i++) { logitsInto(z, W, b, Zv, i, D, K); P.push(Float64Array.from(softmaxInPlace(z))); }
    return balancedLoss(P, Tv, wv.map((x, c) => (set.counts[c] ? x : 0)));
  };

  const limit = epochs ?? maxEpochs;
  let best = { loss: Infinity, epoch: 0, W: null, b: null }, since = 0, ran = 0;
  for (let e = 1; e <= limit; e++) {
    gW.fill(0); gb.fill(0);
    for (let i = 0; i < N; i++) {
      logitsInto(z, W, b, Z, i, D, K);
      softmaxInPlace(z);
      const o = i * D;
      for (let c = 0; c < K; c++) {
        const g = (sw[i] * z[c] - w[c] * T[i][c]) / S;
        if (!g) continue;
        gb[c] += g;
        const r = c * D;
        for (let k = 0; k < D; k++) gW[r + k] += g * Z[o + k];
      }
    }
    const c1 = 1 - b1 ** e, c2 = 1 - b2 ** e;
    for (let j = 0; j < W.length; j++) {
      const g = gW[j] + l2 * (W0 ? W[j] - W0[j] : W[j]);
      mW[j] = b1 * mW[j] + (1 - b1) * g;
      vW[j] = b2 * vW[j] + (1 - b2) * g * g;
      W[j] -= (lr * (mW[j] / c1)) / (Math.sqrt(vW[j] / c2) + eps);
    }
    for (let c = 0; c < K; c++) {
      mb[c] = b1 * mb[c] + (1 - b1) * gb[c];
      vb[c] = b2 * vb[c] + (1 - b2) * gb[c] * gb[c];
      b[c] -= (lr * (mb[c] / c1)) / (Math.sqrt(vb[c] / c2) + eps);
    }
    ran = e;
    if (Zv) {
      const l = valLoss();
      if (l < best.loss - 1e-6) { best = { loss: l, epoch: e, W: W.slice(), b: b.slice() }; since = 0; }
      else if (++since >= patience) break;
    }
  }
  const model = { kind: 'logistic', classes: set.classes, mean: std.mean, inv: std.inv, l2,
                  W: best.W ?? W, b: best.b ?? b, epochs: best.W ? best.epoch : ran };
  if (Zv) model.valLoss = +best.loss.toFixed(6);
  return model;
}

/* -------------------------------------------------------------- predict */

/**
 * Class probabilities for one unit embedding, in `model.classes` order.
 * @returns {Float64Array}
 */
export function predictProba(model, emb) {
  const K = model.classes.length, z = new Float64Array(K);
  if (model.kind === 'prototype') {
    for (let c = 0; c < K; c++) z[c] = model.centroids[c] ? dot(emb, model.centroids[c]) / model.T : -Infinity;
    return softmaxInPlace(z);
  }
  const D = model.mean.length, x = new Float32Array(D);
  for (let k = 0; k < D; k++) x[k] = (emb[k] - model.mean[k]) * model.inv[k];
  logitsInto(z, model.W, model.b, x, 0, D, K);
  return softmaxInPlace(z);
}

/** Held-out balanced log loss and top-1 of a model on a set. */
function heldOut(model, set) {
  const K = set.classes.length;
  const P = set.X.map(x => predictProba(model, x));
  const T = set.Y.map(y => targetOf(y, K));
  const w = classWeights(set);
  let right = 0;
  P.forEach((p, i) => { let a = 0; for (let c = 1; c < K; c++) if (p[c] > p[a]) a = c; if (set.Y[i].includes(a)) right++; });
  return { loss: balancedLoss(P, T, w), top1: set.X.length ? right / set.X.length : null };
}

/** The prototype temperature with the lowest held-out balanced loss. */
function fitPrototypeT(train, val, temperatures) {
  const base = trainPrototypes(train);
  let best = null;
  for (const T of temperatures) {
    const { loss } = heldOut({ ...base, T }, val);
    if (!best || loss < best.loss) best = { T, loss };
  }
  return best;
}

/* ---------------------------------------------------------------- learn */

/**
 * Fit both models on a training set and keep the honest winner.
 *
 * Splits a held-out fold (`holdoutSplit`), fits the prototype temperature and
 * the logistic model (each L2 in `opts.l2`, early-stopped) on the rest, picks
 * by held-out balanced log loss, then refits the winner on every example.
 * With too few examples to hold any out, it falls back to prototypes at the
 * middle temperature — the baseline needs no tuning to be sane.
 *
 * @returns {object|null} a model plus `{ chosen, held: { prototype, logistic } }`, or null with fewer than two classes
 */
export function fitSet(set, opts = {}) {
  const o = { ...LEARN_DEFAULTS, ...opts };
  if (!set || set.classes.length < 2 || !set.X.length) return null;
  const { train, val } = holdoutSplit(set, { share: o.holdout, groupOf: o.groupOf });
  const trainSet = subset(set, train), valSet = subset(set, val);
  const fallbackT = o.temperatures[Math.floor(o.temperatures.length / 2)];

  if (!val.length || trainSet.counts.some(n => n === 0)) {
    const m = trainPrototypes(set, { T: fallbackT });
    return { ...m, chosen: 'prototype', held: null };
  }

  const proto = fitPrototypeT(trainSet, valSet, o.temperatures);
  const held = { prototype: { loss: +proto.loss.toFixed(6), top1: heldOut({ ...trainPrototypes(trainSet), T: proto.T }, valSet).top1, T: proto.T } };

  let lr = null;
  const tryLogistic = o.model === 'logistic' || (o.model === 'auto' && Math.min(...set.counts) >= o.minForLogistic);
  if (tryLogistic) {
    for (const l2 of [].concat(o.l2)) {
      const m = trainLogistic(trainSet, { ...o, l2, val: valSet, T0: proto.T });
      const h = heldOut(m, valSet);
      if (!lr || h.loss < lr.loss) lr = { l2, epochs: m.epochs, loss: h.loss, top1: h.top1 };
    }
    held.logistic = { loss: +lr.loss.toFixed(6), top1: lr.top1, l2: lr.l2, epochs: lr.epochs };
  }

  const useLogistic = o.model === 'logistic' || (o.model === 'auto' && lr != null && lr.loss < proto.loss);
  const model = useLogistic
    ? trainLogistic(set, { ...o, l2: lr.l2, T0: proto.T, epochs: Math.max(1, lr.epochs) })
    : trainPrototypes(set, { T: proto.T });
  return { ...model, chosen: model.kind, held };
}

/** Keep at most `cap` examples per (first) class, chosen by id hash. Counts are of what is kept. */
export function capPerClass(set, cap) {
  if (!(cap > 0) || !set.counts.some(n => n > cap)) return set;
  const by = new Map();
  set.ids.forEach((id, i) => { const c = set.Y[i][0]; (by.get(c) ?? by.set(c, []).get(c)).push(i); });
  const keep = [];
  for (const [, idx] of by) keep.push(...idx.sort((a, b) => hash(`cap:${set.ids[a]}`) - hash(`cap:${set.ids[b]}`) || a - b).slice(0, cap));
  return subset(set, keep.sort((a, b) => a - b));
}

/**
 * Learn this account's playlists' sound. The entry point for WP-E2.
 *
 * `destinations` is the space (or its destinations), as for audio.mjs's
 * `buildAudioProfiles`, so the learner judges exactly the buckets the rest of
 * the engine does. `skip` leaves tracks out as if never filed (fold-level
 * leave-out for `placementAccuracy`).
 *
 * @param {object|Map|Array} destinations
 * @param {Map} index  audio.mjs `audioIndex`
 * @param {object} [opts]  LEARN_DEFAULTS overrides, plus `skip` and `groupOf`
 * @returns {null | { version, model, classes: string[], counts: number[], short: string[], examples: number, index: Map, chosen, held }}
 *          null when there is nothing to learn (no index, or fewer than two
 *          playlists with `minMembers` analysed members)
 */
export function learnAudio(destinations, index, opts = {}) {
  if (!index?.size) return null;
  const o = { ...LEARN_DEFAULTS, ...opts };
  const set = capPerClass(trainingSet(destinations, index, { skip: o.skip, minMembers: o.minMembers }), o.maxPerClass);
  const fitted = fitSet(set, o);
  if (!fitted) return null;
  const { chosen, held, ...model } = fitted;
  return {
    version: AUDIO_LEARN_VERSION, model, classes: set.classes, counts: set.counts,
    short: set.short, examples: set.ids.length, index, chosen, held,
  };
}

/**
 * Per-playlist probabilities for one track: destination id → P(belongs there),
 * summing to 1 over the learned playlists, plus `null` for each destination
 * that had analysed members but too few to learn (null, never 0).
 *
 * Null outright when there is no learner or the track has not been heard, so
 * the caller adds nothing and the placement is byte-identical.
 *
 * @param {string|{id:string}} track
 * @param {object|null} learner  from `learnAudio`, or a space carrying `.learned`
 * @param {{ index?: Map }} [opts]  index to read the track's embedding from (default: the learner's)
 * @returns {Map<string, number|null> | null}
 */
export function learnedScores(track, learner, { index = null } = {}) {
  const L = learner?.model ? learner : learner?.learned;
  if (!L?.model) return null;
  const id = idOf(track);
  const row = id ? (index ?? L.index)?.get(id) : null;
  if (!row) return null;
  const p = predictProba(L.model, row.emb);
  const out = new Map();
  L.classes.forEach((c, i) => out.set(c, +p[i].toFixed(6)));
  for (const s of L.short ?? []) if (!out.has(s)) out.set(s, null);
  return out;
}

/**
 * The hook WP-E2's `buildSpace(lib, { audio: { learn } })` calls once per
 * space (so once per fold in `placementAccuracy`): `learn({ index, profiles,
 * minMembers })`, with `profiles` from audio.mjs `buildAudioProfiles` — their
 * `.ids` are the analysed members with the fold already left out, so this
 * trains on exactly those and nothing else.
 *
 *   buildSpace(lib, { audio: { records, learn: trainLearner } })
 *
 * @returns {null | { learner, learnedScores: (track) => Map<string, number|null> | null }}
 */
export function trainLearner({ index, profiles, minMembers } = {}, opts = {}) {
  if (!index?.size || !profiles?.size) return null;
  const dests = [...profiles].map(([id, p]) => ({ id, trackIds: [...(p?.ids ?? [])] }));
  const learner = learnAudio(dests, index, { ...opts, minMembers: minMembers ?? opts.minMembers ?? LEARN_DEFAULTS.minMembers });
  if (!learner) return null;
  return { learner, learnedScores: track => learnedScores(track, learner) };
}

/**
 * `learnedScores` as `calibrate.mjs` rows want them: [[playlistId, log p], …],
 * highest first, nulls dropped. Log probabilities, because calibrate softmaxes
 * its scores at a fitted temperature, and softmax(log p) at T = 1 is p itself:
 * the fit can keep the learner's own confidence or sharpen or soften it.
 */
export function calibrationScores(scores) {
  if (!scores) return [];
  return [...scores]
    .filter(([, p]) => p != null)
    .map(([id, p]) => [id, +Math.log(Math.max(p, 1e-12)).toFixed(5)])
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
}

/* ------------------------------------------------------------- measure */

/**
 * k-fold cross-validated accuracy of the prototype baseline and the learner
 * (and which one `auto` chose) on a labelled set. Folds are by `groupOf` when
 * given (artist), so no artist is in both training and test.
 *
 * @param {object} set  from `trainingSet` or a fixture
 * @param {{ folds?: number, perClass?: number|null, repeats?: number, groupOf?: Function, salt?: string }} [opts]
 *        `perClass` subsamples each class's training examples to that many
 *        (a learning-curve point); the test fold is never subsampled
 * @returns {{ n, prototype: {top1, top2}, logistic: {top1, top2}, auto: {top1, top2, logistic: number} }}
 */
export function crossValidate(set, opts = {}) {
  const { folds = 5, perClass = null, repeats = 1, groupOf = null, salt = 'cv', ...fit } = opts;
  const acc = () => ({ n: 0, top1: 0, top2: 0 });
  const res = { prototype: acc(), logistic: acc(), auto: acc(), autoLogistic: 0, runs: 0 };
  const foldOf = i => hash(`${salt}:${groupOf ? groupOf(set.ids[i]) ?? set.ids[i] : set.ids[i]}`) % folds;
  const score = (bucket, model, test) => {
    test.X.forEach((x, i) => {
      const p = predictProba(model, x);
      const order = [...p.keys()].sort((a, b) => p[b] - p[a]);
      bucket.n++;
      if (test.Y[i].includes(order[0])) bucket.top1++;
      if (test.Y[i].includes(order[0]) || test.Y[i].includes(order[1])) bucket.top2++;
    });
  };
  for (let f = 0; f < folds; f++) {
    const testIdx = [], poolIdx = [];
    set.ids.forEach((_, i) => (foldOf(i) === f ? testIdx : poolIdx).push(i));
    if (!testIdx.length) continue;
    for (let r = 0; r < repeats; r++) {
      let trainIdx = poolIdx;
      if (perClass) {
        const by = new Map();
        for (const i of poolIdx) { const c = set.Y[i][0]; (by.get(c) ?? by.set(c, []).get(c)).push(i); }
        trainIdx = [];
        for (const [, idx] of by) {
          const ord = idx.slice().sort((a, b) => hash(`${salt}:${f}:${r}:${set.ids[a]}`) - hash(`${salt}:${f}:${r}:${set.ids[b]}`));
          trainIdx.push(...ord.slice(0, perClass));
        }
        trainIdx.sort((a, b) => a - b);
      }
      const train = subset(set, trainIdx), test = subset(set, testIdx);
      if (train.counts.some(n => n === 0)) continue;
      const gOf = groupOf;
      const proto = fitSet(train, { ...fit, model: 'prototype', groupOf: gOf });
      const logi = fitSet(train, { ...fit, model: 'logistic', groupOf: gOf });
      const auto = fitSet(train, { ...fit, model: 'auto', groupOf: gOf });
      score(res.prototype, proto, test);
      score(res.logistic, logi, test);
      score(res.auto, auto, test);
      if (auto.chosen === 'logistic') res.autoLogistic++;
      res.runs++;
    }
  }
  const fin = b => ({ n: b.n, top1: b.n ? +(b.top1 / b.n).toFixed(4) : null, top2: b.n ? +(b.top2 / b.n).toFixed(4) : null });
  return { n: res.prototype.n, runs: res.runs, prototype: fin(res.prototype), logistic: fin(res.logistic),
           auto: { ...fin(res.auto), logisticShare: res.runs ? +(res.autoLogistic / res.runs).toFixed(3) : null } };
}

/**
 * Learning curve: `crossValidate` at each training size per class.
 * @returns {Array<{ perClass: number, ...crossValidate }>}
 */
export function learningCurve(set, { sizes = [5, 10, 20, 40], ...opts } = {}) {
  return sizes.map(perClass => ({ perClass, ...crossValidate(set, { ...opts, perClass }) }));
}
