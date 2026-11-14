// WP-L2's learning curve: how much the sound learner gains from a listener
// accepting and rejecting its suggestions, simulated on the phase 0 embeddings
// (test/fixtures/audio-learn-phase0.json: 747 Deezer previews, 15 genres).
//
// For each artist-grouped fold: the fold is the test set, never touched. Of
// the rest, `start` tracks per genre are the playlist's members, and the others
// are the inbox. The simulated listener works through the inbox in a fixed
// order; for each track the learner suggests its best playlist (never one
// already rejected for that track, as the page does), and the listener, who
// knows the true genre, accepts it if right and rejects it if wrong. A
// rejected track goes to the back of the inbox for another suggestion. The
// learner retrains every `batch` verdicts. Top-1/top-2 on the test fold are
// read at each `rounds` count of verdicts.
//
// Three listeners, each its own simulation (what gets suggested depends on
// what was learned):
//   full          accepts and rejects both reach the learner (WP-L2)
//   acceptsOnly   only accepts (what v1 already learned: an accepted track
//                 joins the playlist and the next sync counts it)
//   rejectsOnly   only rejects (what WP-L2 adds on its own)
//
//   node scripts/audio-learn/feedback-curve.mjs [--start 5] [--folds 5] [--model auto] [--batch 10]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { learnAudio, learnedScores } from '../../core/intrinsic/audio-learn.mjs';
import { unpackEmbedding } from '../../core/audio/record.mjs';

function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h;
}
const unit = v => { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n); return Float32Array.from(v, x => x / n); };
const byHash = salt => (a, b) => hash(`${salt}:${a}`) - hash(`${salt}:${b}`) || (a < b ? -1 : 1);

/**
 * @param {object} F  the phase 0 fixture ({ rows: [{ label, artist, deezerId, emb }] })
 * @param {{ start?: number, rounds?: number[], folds?: number, batch?: number, model?: string, l2?: number[] }} [opts]
 * @returns {Array<{ verdicts, accepts, rejects, top1, top2, acceptsOnly: {top1, top2}, rejectsOnly: {top1, top2} }>}
 */
export function feedbackCurve(F, { start = 5, rounds = [0, 25, 50, 100, 200, 400], folds = 5, batch = 10,
                                   model = 'auto', l2 = undefined } = {}) {
  const truth = new Map(), artist = new Map(), index = new Map();
  for (const r of F.rows) {
    const id = String(r.deezerId);
    truth.set(id, r.label); artist.set(id, r.artist.toLowerCase());
    index.set(id, { emb: unit(Array.from(unpackEmbedding(r.emb))) });
  }
  const labels = [...new Set(truth.values())].sort();
  const ids = [...truth.keys()].sort();
  const foldOf = id => hash(`curve:${artist.get(id)}`) % folds;
  const opts = { model, groupOf: id => artist.get(id), ...(l2 ? { l2 } : {}) };

  const variants = { full: { a: true, r: true }, acceptsOnly: { a: true, r: false }, rejectsOnly: { a: false, r: true } };
  const tot = Object.fromEntries(Object.keys(variants).map(k => [k, rounds.map(() => ({ n: 0, top1: 0, top2: 0, accepts: 0, rejects: 0 }))]));

  for (let f = 0; f < folds; f++) {
    const test = ids.filter(id => foldOf(id) === f);
    const pool = ids.filter(id => foldOf(id) !== f);
    const members = new Map(labels.map(l => [l, []]));
    const inbox0 = [];
    for (const l of labels) {
      const mine = pool.filter(id => truth.get(id) === l).sort(byHash(`start:${f}`));
      members.get(l).push(...mine.slice(0, start));
      inbox0.push(...mine.slice(start));
    }
    inbox0.sort(byHash(`inbox:${f}`));
    const dests = labels.map(l => ({ id: l, trackIds: members.get(l) }));

    for (const [name, use] of Object.entries(variants)) {
      const said = {}; // the page's feedback state: { id: { accepted, rejected } }
      const given = {}; // what this listener lets the learner see
      const inbox = inbox0.slice();
      let verdicts = 0, accepts = 0, rejects = 0;
      const train = () => learnAudio(dests, index, { ...opts, feedback: given });
      let learner = train();
      rounds.forEach((target, ri) => {
        while (verdicts < target && inbox.length) {
          const stop = Math.min(target, verdicts + batch);
          while (verdicts < stop && inbox.length) {
            const id = inbox.shift();
            const no = said[id]?.rejected ?? [];
            const s = learnedScores(id, learner);
            const pick = [...s].filter(([p, v]) => v != null && !no.includes(p)).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0];
            if (!pick) continue;
            const e = (said[id] ??= { accepted: [], rejected: [] });
            verdicts++;
            if (pick === truth.get(id)) {
              e.accepted.push(pick); accepts++;
              if (use.a) ((given[id] ??= { accepted: [], rejected: [] }).accepted.push(pick));
            } else {
              e.rejected.push(pick); rejects++;
              if (use.r) ((given[id] ??= { accepted: [], rejected: [] }).rejected.push(pick));
              inbox.push(id);
            }
          }
          learner = train();
        }
        const b = tot[name][ri];
        b.accepts += accepts; b.rejects += rejects;
        for (const id of test) {
          const order = [...learnedScores(id, learner)].filter(([, v]) => v != null).sort((x, y) => y[1] - x[1]).map(([p]) => p);
          b.n++;
          if (order[0] === truth.get(id)) b.top1++;
          if (order.slice(0, 2).includes(truth.get(id))) b.top2++;
        }
      });
    }
  }
  const fin = b => ({ top1: +(b.top1 / b.n).toFixed(4), top2: +(b.top2 / b.n).toFixed(4) });
  return rounds.map((verdicts, i) => ({
    verdicts, n: tot.full[i].n,
    accepts: +(tot.full[i].accepts / folds).toFixed(1), rejects: +(tot.full[i].rejects / folds).toFixed(1),
    ...fin(tot.full[i]), acceptsOnly: fin(tot.acceptsOnly[i]), rejectsOnly: fin(tot.rejectsOnly[i]),
  }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
  const F = JSON.parse(readFileSync(new URL('../../test/fixtures/audio-learn-phase0.json', import.meta.url), 'utf8'));
  const rounds = arg('rounds', '0,25,50,100,200,400').split(',').map(Number);
  const t0 = Date.now();
  const curve = feedbackCurve(F, { start: +arg('start', 5), folds: +arg('folds', 5), batch: +arg('batch', 10),
                                   model: arg('model', 'auto'), rounds });
  console.log(`start ${arg('start', 5)} per genre, model ${arg('model', 'auto')}, ${arg('folds', 5)} artist-grouped folds, ${Math.round((Date.now() - t0) / 1000)} s`);
  console.log('| verdicts | accepts | rejects | full top-1 | full top-2 | accepts only top-1 | rejects only top-1 |');
  console.log('|---:|---:|---:|---:|---:|---:|---:|');
  for (const p of curve) console.log(`| ${p.verdicts} | ${p.accepts} | ${p.rejects} | ${(p.top1 * 100).toFixed(1)}% | ${(p.top2 * 100).toFixed(1)}% | ${(p.acceptsOnly.top1 * 100).toFixed(1)}% | ${(p.rejectsOnly.top1 * 100).toFixed(1)}% |`);
}
