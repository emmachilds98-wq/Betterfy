// Key and tempo experiments over keytempo-features.mjs output: fit on half A
// (beatport-eval.mjs halfOf), report half B with 95% CIs, and compare with
// the shipped DSP on the same tracks (paired bootstrap of the difference).
//
//   node scripts/audio-dsp/keytempo-lab.mjs <features.jsonl> key|tempo [--json out]
//
// Nothing here ships by itself; key.mjs / tempo.mjs take a change only when
// its half-B number clears the bar (docs/BUILD-5-PROGRESS.md, 2026-11-16).
import { readFileSync, writeFileSync } from 'node:fs';
import { toCamelot, relation, CAMELOT } from '../../core/audio/dsp/key.mjs';

const [file, what = 'key'] = process.argv.slice(2);
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const seen = new Set(); const all = rows.filter(r => !seen.has(r.id) && seen.add(r.id));

// ---------- stats ----------
const MIREX = { same: 1, 'fifth-up': 0.5, 'fifth-down': 0.5, relative: 0.3, parallel: 0.2 };
const mirexOf = (est, ref) => est ? (est === ref ? 1 : MIREX[relation(est, ref)] ?? 0) : 0;
const pct = x => (100 * x).toFixed(1);
const ci = xs => { const n = xs.length, m = xs.reduce((a, b) => a + b, 0) / n, v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1); return [m, 1.96 * Math.sqrt(v / n)]; };
let seed = 12345; const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
function pairedBoot(a, b, B = 2000) {   // 95% interval of mean(a - b)
  const n = a.length, d = a.map((x, i) => x - b[i]), ms = [];
  for (let k = 0; k < B; k++) { let s = 0; for (let i = 0; i < n; i++) s += d[Math.floor(rnd() * n)]; ms.push(s / n); }
  ms.sort((x, y) => x - y);
  return [d.reduce((x, y) => x + y, 0) / n, ms[Math.floor(0.025 * B)], ms[Math.floor(0.975 * B)]];
}
function report(label, est, ref, base) {
  const ex = est.map((e, i) => +(e === ref[i])), mx = est.map((e, i) => mirexOf(e, ref[i]));
  const [e, eh] = ci(ex), [m, mh] = ci(mx);
  let s = `${label.padEnd(34)} n=${est.length} exact ${pct(e)}% ±${pct(eh)}  MIREX ${pct(m)}% ±${pct(mh)}`;
  if (base) {
    const bx = base.map((e, i) => +(e === ref[i])), bm = base.map((e, i) => mirexOf(e, ref[i]));
    const [d, lo, hi] = pairedBoot(ex, bx), [dm, lom, him] = pairedBoot(mx, bm);
    s += `  | vs shipped: exact ${d >= 0 ? '+' : ''}${pct(d)} [${pct(lo)}, ${pct(hi)}], MIREX ${dm >= 0 ? '+' : ''}${pct(dm)} [${pct(lom)}, ${pct(him)}]`;
  }
  console.log(s);
  return { e, m };
}

// ---------- key ----------
const fold2 = id => { let h = 5381; for (const c of String(id)) h = (Math.imul(h, 33) ^ c.charCodeAt(0)) >>> 0; return (h >>> 3) % 2; };
const norm = c => { let t = 0; for (const x of c) t += x; return Array.from(c, x => t > 0 ? (x / t - 1 / 12) * 12 : 0); };
const KEYS = ['major', 'minor'].flatMap(mode => Array.from({ length: 12 }, (_, pc) => ({ pc, mode, cam: toCamelot(pc, mode) })));
const camIndex = new Map(KEYS.map((k, i) => [k.cam, i]));

/** Feature groups (each 12 pitch classes, index 0 = C) for one track. */
const GROUPS = {
  chroma: r => norm(r.key.chroma),
  b0: r => norm(r.key.band[0]), b1: r => norm(r.key.band[1]), b2: r => norm(r.key.band[2]),
  b3: r => norm(r.key.band[3]), b4: r => norm(r.key.band[4]),
  bass: r => norm(r.key.bass),
  wide: r => norm(r.key.band.reduce((a, b) => a.map((x, i) => x + b[i]), new Array(12).fill(0))),
  lowmid: r => norm(r.key.band[0].map((x, i) => x + r.key.band[1][i])),
  log: r => { const c = r.key.chroma, m = c.reduce((a, b) => a + b, 0) / 12 || 1; const l = Array.from(c, x => Math.log(1 + x / m)); const lm = l.reduce((a, b) => a + b, 0) / 12; return l.map(x => x - lm); },
};

/** Rotation-shared multinomial logistic regression: score(pc, mode) = b_mode + Σ_g w_{g,mode} · rot(f_g, pc). */
// 'v:<name>': a chroma variant merged into r.key.var by a measurement script.
const groupFn = g => GROUPS[g] ?? (g.startsWith('v:') ? (r => norm(r.key.var[g.slice(2)])) : null);
function fitKey(train, groups, { l2 = 1e-3, iters = 600, lr = 0.05, quad = false } = {}) {
  const G = groups.length, D = G * 12 + (quad ? 78 : 0);
  const X = train.map(r => groups.map(g => groupFn(g)(r)));
  const y = train.map(r => camIndex.get(r.cam));
  const W = { major: new Float64Array(D), minor: new Float64Array(D), bias: 0 };
  // quad: products of the first group's rotated values (tonic×fifth, third×seventh, ...), scaled down.
  const feat = (x, pc) => {
    const f = new Float64Array(D); for (let g = 0; g < G; g++) for (let i = 0; i < 12; i++) f[g * 12 + i] = x[g][(i + pc) % 12];
    if (quad) { let k = G * 12; for (let i = 0; i < 12; i++) for (let j = i; j < 12; j++) f[k++] = 0.25 * f[i] * f[j]; }
    return f;
  };
  const F = X.map(x => KEYS.map(k => feat(x, k.pc)));
  // Adam
  const m = { major: new Float64Array(D), minor: new Float64Array(D), bias: 0 }, v = { major: new Float64Array(D), minor: new Float64Array(D), bias: 0 };
  for (let it = 1; it <= iters; it++) {
    const g = { major: new Float64Array(D), minor: new Float64Array(D), bias: 0 };
    for (let n = 0; n < F.length; n++) {
      const sc = KEYS.map((k, j) => { let s = k.mode === 'minor' ? W.bias : 0; const w = W[k.mode], f = F[n][j]; for (let d = 0; d < D; d++) s += w[d] * f[d]; return s; });
      const mx = Math.max(...sc); let z = 0; const p = sc.map(s => (z += Math.exp(s - mx), Math.exp(s - mx))); for (let j = 0; j < 24; j++) p[j] /= z;
      for (let j = 0; j < 24; j++) {
        const e = p[j] - (j === y[n] ? 1 : 0); if (Math.abs(e) < 1e-6) continue;
        const k = KEYS[j], gw = g[k.mode], f = F[n][j];
        for (let d = 0; d < D; d++) gw[d] += e * f[d];
        if (k.mode === 'minor') g.bias += e;
      }
    }
    const N = F.length;
    for (const mode of ['major', 'minor']) for (let d = 0; d < D; d++) g[mode][d] = g[mode][d] / N + l2 * W[mode][d];
    g.bias /= N;
    const b1 = 0.9, b2 = 0.999, a = lr * Math.sqrt(1 - b2 ** it) / (1 - b1 ** it);
    for (const mode of ['major', 'minor']) for (let d = 0; d < D; d++) {
      m[mode][d] = b1 * m[mode][d] + (1 - b1) * g[mode][d]; v[mode][d] = b2 * v[mode][d] + (1 - b2) * g[mode][d] ** 2;
      W[mode][d] -= a * m[mode][d] / (Math.sqrt(v[mode][d]) + 1e-8);
    }
    m.bias = b1 * m.bias + (1 - b1) * g.bias; v.bias = b2 * v.bias + (1 - b2) * g.bias ** 2; W.bias -= a * m.bias / (Math.sqrt(v.bias) + 1e-8);
  }
  const predict = r => {
    const x = groups.map(g => groupFn(g)(r));
    const sc = KEYS.map(k => { let s = k.mode === 'minor' ? W.bias : 0; const w = W[k.mode], f = feat(x, k.pc); for (let d = 0; d < D; d++) s += w[d] * f[d]; return s; });
    const mx = Math.max(...sc); let z = 0; const p = sc.map(s => (z += Math.exp(s - mx), Math.exp(s - mx))).map(e => e / z);
    const order = p.map((pp, j) => [pp, j]).sort((a, b) => b[0] - a[0]);
    return { cam: KEYS[order[0][1]].cam, p: order[0][0], ranked: order.map(([pp, j]) => ({ cam: KEYS[j].cam, p: pp })) };
  };
  return { W, predict };
}

if (what === 'key') {
  const kt = all.filter(r => r.cam && r.key?.tonalWeight > 0);
  const A = kt.filter(r => r.half === 'A'), B = kt.filter(r => r.half === 'B');
  console.log(`key tracks: A ${A.length}, B ${B.length}`);
  const ref = B.map(r => r.cam), base = B.map(r => r.dsp?.camelot ?? null);
  report('shipped v3 (half B)', base, ref);
  report('shipped v3 (half A)', A.map(r => r.dsp?.camelot ?? null), A.map(r => r.cam));
  // How often is the tonic right?
  const tonicOk = B.filter(r => r.dsp?.camelot && CAMELOT[r.dsp.camelot].pc === CAMELOT[r.cam].pc).length;
  console.log(`shipped: tonic right ${pct(tonicOk / B.length)}%, relative-key errors ${B.filter(r => r.dsp?.camelot && relation(r.dsp.camelot, r.cam) === 'relative').length}`);
  const configs = (arg('--configs', '') || [
    'chroma', 'wide', 'chroma,bass', 'chroma,b0,b1,b2,b3', 'chroma,b0,b1,b2,b3,b4,bass', 'chroma,lowmid,bass', 'chroma,log',
    'chroma,b0,b1,b2,bass,log',
  ].join(';')).split(';');
  const l2s = String(arg('--l2', '0.001')).split(',').map(Number);
  const results = [];
  for (const c0 of configs) for (const l2 of l2s) {
    const quad = c0.endsWith('+quad'), c = c0.replace('+quad', ''), gs = c.split(',');
    // Model selection on half A only: 2-fold CV inside A (folds by a second hash).
    let cvE = 0, cvM = 0;
    for (const fold of [0, 1]) {
      const tr = A.filter(r => fold2(r.id) !== fold), te = A.filter(r => fold2(r.id) === fold);
      const { predict: p } = fitKey(tr, gs, { l2, quad });
      for (const r of te) { const e = p(r).cam; cvE += +(e === r.cam); cvM += mirexOf(e, r.cam); }
    }
    console.log(`  A-CV exact ${pct(cvE / A.length)}%  MIREX ${pct(cvM / A.length)}%`);
    const { predict } = fitKey(A, gs, { l2, quad });
    const est = B.map(r => predict(r).cam);
    const res = report(`[${c0}] l2=${l2}`, est, ref, base);
    results.push({ c, l2, cvE: cvE / A.length, cvM: cvM / A.length, ...res });
  }
  if (arg('--json', null)) writeFileSync(arg('--json'), JSON.stringify(results, null, 1));
}

// ---------- tempo ----------
// The octave decision: take the shipped answer T and choose among T, 2T, T/2
// (inside 60–200) with a softmax over per-candidate features fitted on half A.
const FPS = 62.5;
const within4 = (a, b) => Math.abs(a - b) / b <= 0.04;
const ok1 = (a, b) => Math.abs(a - b) <= 1;
const acfAt = (a, lag) => { if (!a || lag > a.length - 2) return 0; const i = Math.floor(lag), f = lag - i; return a[i] * (1 - f) + a[i + 1] * f; };
function candFeatures(r, c, opts) {
  const P = 60 * FPS / c, l = Math.log2(c / 120);
  const f = [l, l * l];
  for (let b = 0; b < 4; b++) {
    let a1 = 0, a2 = 0, aH = 0, n = 0;
    for (const w of r.tempo) { const a = w.acf?.[b]; if (!a) continue; n++; a1 += acfAt(a, P); a2 += acfAt(a, 2 * P); aH += acfAt(a, P / 2); }
    n = n || 1;
    if (opts.acf) f.push(a1 / n, a2 / n, aH / n);
  }
  if (opts.genre) for (const g of GENRES) { const on = r.genre === g ? 1 : 0; f.push(on * l, on * l * l); }
  return f;
}
const GENRES = ['Drum & Bass', 'Dubstep', 'Hip-Hop / R&B', 'Electronica / Downtempo', 'Breaks', 'Hard Dance', 'Psy-Trance', 'Trance'];
const candsOf = r => { const T = r.dsp.bpm; return [T, 2 * T, T / 2].filter(c => c >= 60 - 1e-6 && c <= 200 + 1e-6); };
function fitTempo(train, opts, { l2 = 1e-3, iters = 800, lr = 0.05 } = {}) {
  const data = train.map(r => { const cs = candsOf(r); return { cs, F: cs.map(c => candFeatures(r, c, opts)), y: cs.findIndex(c => within4(c, r.bpm)) }; }).filter(d => d.y >= 0);
  const D = data[0].F[0].length + 1;   // + "is the shipped answer"
  const w = new Float64Array(D), m = new Float64Array(D), v = new Float64Array(D);
  const fx = (d, j) => [...d.F[j], j === 0 ? 1 : 0];
  for (let it = 1; it <= iters; it++) {
    const g = new Float64Array(D);
    for (const d of data) {
      const sc = d.F.map((_, j) => fx(d, j).reduce((s, x, k) => s + x * w[k], 0));
      const mx = Math.max(...sc); let z = 0; const p = sc.map(s => (z += Math.exp(s - mx), Math.exp(s - mx))).map(e => e / z);
      d.F.forEach((_, j) => { const e = p[j] - (j === d.y ? 1 : 0); fx(d, j).forEach((x, k) => g[k] += e * x); });
    }
    const a = lr * Math.sqrt(1 - 0.999 ** it) / (1 - 0.9 ** it);
    for (let k = 0; k < D; k++) { const gk = g[k] / data.length + l2 * w[k]; m[k] = 0.9 * m[k] + 0.1 * gk; v[k] = 0.999 * v[k] + 0.001 * gk * gk; w[k] -= a * m[k] / (Math.sqrt(v[k]) + 1e-8); }
  }
  const predict = r => { const cs = candsOf(r); const sc = cs.map((c, j) => [...candFeatures(r, c, opts), j === 0 ? 1 : 0].reduce((s, x, k) => s + x * w[k], 0)); return cs[sc.indexOf(Math.max(...sc))]; };
  return { w, predict };
}
function tempoReport(label, est, ref, base) {
  const ex = est.map((e, i) => +ok1(e, ref[i])), oc = est.filter((e, i) => !within4(e, ref[i]) && [2, 0.5].some(k => within4(e, ref[i] * k))).length;
  const [e, eh] = ci(ex);
  let s = `${label.padEnd(30)} n=${est.length} ±1 BPM ${pct(e)}% ±${pct(eh)}  octave errors ${oc}`;
  if (base) { const bx = base.map((b, i) => +ok1(b, ref[i])); const [d, lo, hi] = pairedBoot(ex, bx); s += `  | vs shipped ${d >= 0 ? '+' : ''}${pct(d)} [${pct(lo)}, ${pct(hi)}]  fixed ${ex.filter((x, i) => x && !bx[i]).length} broke ${ex.filter((x, i) => !x && bx[i]).length}`; }
  console.log(s);
}
if (what === 'tempo') {
  const tt = all.filter(r => r.bpm && r.dsp?.bpm);
  const A = tt.filter(r => r.half === 'A'), B = tt.filter(r => r.half === 'B');
  console.log(`tempo tracks: A ${A.length}, B ${B.length}`);
  const ref = B.map(r => r.bpm), base = B.map(r => r.dsp.bpm);
  tempoReport('shipped (half B)', base, ref);
  tempoReport('shipped (half A)', A.map(r => r.dsp.bpm), A.map(r => r.bpm));
  // Where the octave errors are.
  const errs = tt.filter(r => !within4(r.dsp.bpm, r.bpm) && [2, 0.5].some(k => within4(r.dsp.bpm, r.bpm * k)));
  const byG = {}; for (const r of errs) { const k = `${r.genre} ${r.dsp.bpm > r.bpm ? 'x2' : '/2'}`; byG[k] = (byG[k] ?? 0) + 1; }
  console.log('octave errors (A+B) by genre/direction:', JSON.stringify(Object.entries(byG).sort((a, b) => b[1] - a[1])));
  const oracle = B.map(r => candsOf(r).find(c => ok1(c, r.bpm)) ?? r.dsp.bpm);
  tempoReport('oracle octave choice', oracle, ref, base);
  // The shipped rule (combine.mjs SLOW_FOLD): double a reading under X. X is
  // picked on half A; the dsp in the features file must predate the fold.
  const up = (T, x) => T < x && 2 * T <= 200 ? 2 * T : T;
  const accA = x => A.filter(r => ok1(up(r.dsp.bpm, x), r.bpm)).length / A.length;
  const xs = Array.from({ length: 21 }, (_, i) => 66 + 2 * i), bestX = xs.reduce((b, x) => accA(x) > accA(b) ? x : b);
  console.log(`double-below sweep on A: ${xs.map(x => `${x}:${pct(accA(x))}`).join(' ')}`);
  tempoReport(`[double below ${bestX}] (A-picked)`, B.map(r => up(r.dsp.bpm, bestX)), ref, base);
  for (const [name, opts] of [['prior only', {}], ['acf', { acf: true }], ['acf+genre', { acf: true, genre: true }], ['genre', { genre: true }]]) {
    for (const l2 of String(arg('--l2', '0.001')).split(',').map(Number)) {
      let cv = 0;
      for (const fold of [0, 1]) {
        const { predict: p } = fitTempo(A.filter(r => fold2(r.id) !== fold), opts, { l2 });
        for (const r of A.filter(r => fold2(r.id) === fold)) cv += +ok1(p(r), r.bpm);
      }
      const { predict } = fitTempo(A, opts, { l2 });
      console.log(`  A-CV ±1 BPM ${pct(cv / A.length)}%`);
      tempoReport(`[${name}] l2=${l2}`, B.map(predict), ref, base);
    }
  }
}

export { fitKey, GROUPS, report, pairedBoot, ci, mirexOf };
