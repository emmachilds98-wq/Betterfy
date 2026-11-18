// @bundle engine BetterfyFamily 107
// Family first, then sub-genre (docs/review/ENGINE-REVIEW.md layer 3).
//
// A flat choice among ~29 genre playlists counts Rollers-for-Jungle as wrong as
// Rollers-for-Techno, and the measured confusions are almost all inside a
// family. So the decision is made in two steps:
//
//   1. the family: drum & bass, garage, house, hip-hop… Its probability is the
//      sum of its playlists' (softmax with the calibrated temperature);
//   2. the playlist inside it.
//
// A card can then commit to the family and ask only the last step: "Drum &
// bass: Rollers or Jungle?". And "Sure" can be checked at the family level,
// on the account's own held-out filing, exactly like the playlist level.
//
// A playlist's family comes from the genre its name names (core/audio/match.mjs
// playlistConcepts), read at the level a person calls "the genre"
// (identify.mjs genreLevel: electronic's children, or a root elsewhere). A
// playlist whose name names no known genre is a family of its own, so it is
// never merged with anything it may not belong with.
//
// Nothing here is trained: a sum of probabilities and the same threshold fit
// calibrate.mjs makes, on the account's own held-out rows (plan §3, R3).
import { playlistConcepts } from '../audio/match.mjs';
import { resolveConcept } from '../ontology/index.mjs';
import { genreLevel } from '../audio/identify.mjs';
import { softmax, fitTemperature, fitCalibration, decide, DEFAULTS } from './calibrate.mjs';

export const FAMILY_VERSION = '1.0.0';

/**
 * Each playlist's family: `{ id, name }` (or a space's destinations, or `[id, name]`
 * pairs) → Map id → family key. The key is a genre slug, or `own:<id>` for a
 * playlist whose name names no genre.
 */
export function playlistFamilies(playlists) {
  const out = new Map();
  const list = playlists instanceof Map ? [...playlists.values()] : (playlists ?? []);
  for (const p of list) {
    const [id, name] = Array.isArray(p) ? p : [p?.id, p?.name];
    if (!id) continue;
    const fams = [...new Set(conceptsIn(name).map(genreLevel).filter(Boolean))];
    // A name that spans two families ("House & Garage") is its own family too:
    // it would be wrong to count it inside either.
    out.set(id, fams.length === 1 ? fams[0] : `own:${id}`);
  }
  return out;
}

/**
 * The genres a playlist's name names. playlistConcepts first (whole name, or
 * its "&" / "/" parts); failing that, every phrase of up to four words, longest
 * first, so "Dancehall Emma" or "Late Night House" still find their genre.
 */
export function conceptsIn(name) {
  const direct = playlistConcepts(name);
  if (direct.length) return direct;
  const words = String(name ?? '').split(/[\s/|,+]+/).filter(Boolean);
  const out = [], used = new Set();
  for (let len = Math.min(4, words.length); len >= 1; len--)
    for (let i = 0; i + len <= words.length; i++) {
      if ([...Array(len).keys()].some(k => used.has(i + k))) continue;
      const r = resolveConcept(words.slice(i, i + len).join(' '));
      if (r?.facet === 'genre' && r.concept) {
        if (!out.includes(r.concept)) out.push(r.concept);
        for (let k = 0; k < len; k++) used.add(i + k);
      }
    }
  return out;
}

const famOf = (map, id) => map.get(id) ?? `own:${id}`;

/**
 * One held-out row's family view: probabilities summed per family.
 * @param {{scores: Array<[string, number]>, truth?: string[]}} row
 * @returns {{ fams: Array<[string, number]>, truth: string[] }}  highest first
 */
export function familyRow(row, families, T) {
  const sum = new Map();
  for (const [id, p] of softmax(row.scores, T)) { const f = famOf(families, id); sum.set(f, (sum.get(f) ?? 0) + p); }
  return { fams: [...sum.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)),
           truth: [...new Set((row.truth ?? []).map(id => famOf(families, id)))] };
}

/** Log-probabilities as scores, so calibrate.mjs can fit a threshold on families like on playlists. */
const asScores = fams => fams.map(([f, p]) => [f, Math.log(Math.max(p, 1e-12))]);

/**
 * How family-first does on held-out rows (placementAccuracy collect rows):
 *   family     top-1 family right
 *   within     of tracks whose family was right, the playlist right inside it
 *   flat       the ordinary top-1, on the same rows, for comparison
 *   families   how many families the account's genre playlists form
 *   sure       family-level "confident" checked on rows it was not fitted on
 *              (calibrate.mjs calibrationReport on family scores)
 */
export function familyAccuracy(rows, families, opts = {}) {
  const usable = (rows ?? []).filter(r => r?.id && r.scores?.length && r.truth?.length);
  if (!usable.length) return null;
  const T = fitTemperature(usable);
  let fam = 0, within = 0, flat = 0;
  const famRows = [];
  for (const r of usable) {
    const truth = new Set(r.truth);
    if (truth.has(r.scores[0][0])) flat++;
    const fr = familyRow(r, families, T);
    famRows.push({ id: r.id, scores: asScores(fr.fams), truth: fr.truth });
    if (!fr.truth.includes(fr.fams[0][0])) continue;
    fam++;
    // Inside the family it chose: the best-scoring playlist of that family.
    const lead = fr.fams[0][0];
    const inside = r.scores.find(([id]) => famOf(families, id) === lead);
    if (inside && truth.has(inside[0])) within++;
  }
  const rate = (a, b) => (b ? +(a / b).toFixed(4) : null);
  const n = usable.length;
  return {
    version: FAMILY_VERSION, n,
    family: rate(fam, n), within: rate(within, fam), flat: rate(flat, n),
    families: new Set([...families.values()]).size,
    rows: famRows,
    ...(opts.report ? { sure: opts.report(famRows) } : {}),
  };
}

/** Bars set before the owner's numbers: family top-1 at least this, else the card stays flat. */
export const FAMILY_GATE = Object.freeze({ minFamily: 0.85 });

/**
 * Build 8 I1 (docs/BUILD-8-PLAN.md): the second bar, on the family calls the
 * engine is confident about, checked on held-out rows (`familyAccuracy`'s
 * `sure`, a calibrationReport). The same shape as AGREE_GATE: right at least
 * `minPrecision` of the time, on at least `minN` tracks, covering at least
 * `coverage` of them. decideCard already abstains when the family is not
 * confident, so this judges the population the card actually speaks for,
 * where the top-1 bar judged every track. Set before the owner's run.
 */
export const FAMILY_CONFIDENT_GATE = Object.freeze({ minPrecision: 0.95, minN: 20, coverage: 0.25 });

/**
 * Which bar family-first clears on one Score run, and why not when neither:
 *   { use, by: 'top1' | 'confident' | null, why }
 * `why` is plain words for the Score line, null when in use.
 */
export function familyGate(acc, bar = FAMILY_GATE, conf = FAMILY_CONFIDENT_GATE) {
  if (!acc || acc.family == null) return { use: false, by: null, why: 'not measured' };
  if (!(acc.families >= 2)) return { use: false, by: null, why: 'fewer than two families' };
  if (acc.family >= bar.minFamily) return { use: true, by: 'top1', why: null };
  const c = acc.sure?.checked ?? acc.sure ?? null;
  const n = c?.confidentN ?? 0, right = c?.confidentRight ?? null, share = c?.confidentShare ?? null;
  const pc = x => `${Math.round(x * 100)}%`;
  if (n >= conf.minN && right != null && right >= conf.minPrecision && share != null && share >= conf.coverage)
    return { use: true, by: 'confident', why: null };
  const why = !n ? `family top-1 under ${pc(bar.minFamily)} and no confident family calls yet`
    : n < conf.minN ? `family top-1 under ${pc(bar.minFamily)}; only ${n} confident family calls, ${conf.minN} needed`
    : right == null || right < conf.minPrecision ? `confident family calls right ${pc(right ?? 0)}, ${pc(conf.minPrecision)} needed`
    : `confident on ${pc(share ?? 0)} of tracks, ${pc(conf.coverage)} needed`;
  return { use: false, by: null, why };
}

/** May File commit to a family and ask only the last step? Read from one Score run. */
export function familyInUse(acc, bar = FAMILY_GATE, conf = FAMILY_CONFIDENT_GATE) {
  return familyGate(acc, bar, conf).use;
}

/**
 * Fit the family-level calibration on held-out family rows (from familyAccuracy).
 * Same rules as the playlist level: "confident" only where held-out rows this
 * sure were right at least `target` of the time, by a lower bound.
 */
export function fitFamilyCalibration(famRows, opts = {}) {
  return fitCalibration(famRows, { ...DEFAULTS, ...opts });
}

/**
 * What the File card says, in three states (USER-REVIEW "abstain out loud"):
 *   { kind: 'sure', playlists: [id] }                     the playlist itself is confident
 *   { kind: 'family', family, playlists: [a, b?] }        the family is confident; pick inside it
 *   { kind: 'choose' | 'unsure', playlists }              as calibrate.mjs decide()
 *
 * @param {Array<[string, number]>} scores  raw scores, highest first
 * @param {object} cal     playlist-level calibration (calibrate.mjs fitCalibration)
 * @param {object|null} famCal  family-level calibration, or null when family-first is not in use
 * @param {Map<string,string>} families
 */
export function decideCard(scores, cal, famCal, families, opts = {}) {
  const flat = decide(scores, cal, opts);
  if (flat.kind === 'confident') return { kind: 'sure', playlists: flat.playlists, p: flat.p };
  if (!famCal || !families || !scores?.length || !cal) return flat;
  const fr = familyRow({ scores }, families, cal.T);
  const lead = fr.fams[0];
  const fd = decide(asScores(fr.fams), famCal);
  if (fd.kind !== 'confident' || fd.playlists[0] !== lead[0]) return flat;
  // Inside the family: its playlists in score order, the top two offered.
  const inside = scores.filter(([id]) => famOf(families, id) === lead[0]).map(([id]) => id);
  if (inside.length === 1) return { kind: 'sure', playlists: inside, p: +lead[1].toFixed(4), via: 'family' };
  return { kind: 'family', family: lead[0], playlists: inside.slice(0, 2), p: +lead[1].toFixed(4) };
}

/**
 * S1 (docs/BUILD-7-PLAN.md): the family a track's ranking is confident about,
 * or null. The family-level "confident" of `decideCard`, on its own: the
 * playlists' probabilities (temperature `T`) summed per family, and the leader
 * confident under `famCal` (fitFamilyCalibration). Used to keep a pick inside
 * that family when this account's Score run said doing so helps.
 */
export function familyConfident(scores, families, T, famCal) {
  if (!scores?.length || !famCal || !families || !Number.isFinite(T)) return null;
  const fr = familyRow({ scores }, families, T);
  const d = decide(asScores(fr.fams), famCal);
  return d.kind === 'confident' && d.playlists[0] === fr.fams[0]?.[0] ? fr.fams[0][0] : null;
}

/** A ranking kept to one family's playlists; the ranking itself when none of it is. */
export function narrowToFamily(ids, family, families) {
  if (!family) return ids;
  const kept = ids.filter(id => famOf(families, id) === family);
  return kept.length ? kept : ids;
}

/** Build 8 A1: rows needed before the confusion line names anything. */
export const CONFUSION_MIN = 40;

/**
 * Build 8 A1, confusion by family: of held-out rows whose first pick was wrong,
 * where it went. Each miss is counted once, against the track's first true
 * playlist, as a playlist pair (sibling when both sit in one family) and as a
 * family pair when the families differ. Top `top` of each, most first.
 * Counts only; no placement changes.
 * @returns {{ n, misses, need, pairs: [{from, to, n, sibling}], families: [{from, to, n}] }}
 */
export function familyConfusion(rows, families, { inScope = null, top = 3, min = CONFUSION_MIN } = {}) {
  const ok = id => !!id && (!inScope || inScope(id));
  const pairs = new Map(), fams = new Map();
  let n = 0, misses = 0;
  for (const r of rows ?? []) {
    const ranked = (r?.scores ?? []).filter(x => ok(x?.[0]));
    const truth = (r?.truth ?? []).filter(ok);
    if (!ranked.length || !truth.length) continue;
    n++;
    const first = ranked[0][0];
    if (truth.includes(first)) continue;
    misses++;
    const from = truth[0], ff = famOf(families, from), tf = famOf(families, first);
    const sibling = ff === tf && !ff.startsWith('own:');
    const pk = `${from}\u0000${first}`;
    const p = pairs.get(pk) ?? { from, to: first, n: 0, sibling };
    p.n++; pairs.set(pk, p);
    if (ff !== tf) {
      const fk = `${ff}\u0000${tf}`;
      const f = fams.get(fk) ?? { from: ff, to: tf, n: 0 };
      f.n++; fams.set(fk, f);
    }
  }
  const order = (a, b) => b.n - a.n || (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : 1);
  return { n, misses, need: Math.max(0, min - n),
           pairs: n >= min ? [...pairs.values()].filter(p => p.n >= 2).sort(order).slice(0, top) : [],
           families: n >= min ? [...fams.values()].filter(f => f.n >= 2).sort(order).slice(0, top) : [] };
}

/** A family key in words: "drum-and-bass" → "Drum and bass"; a playlist on its own by its name. */
const famWords = (key, nameOf) => String(key).startsWith('own:') ? nameOf(String(key).slice(4))
  : String(key).replace(/-/g, ' ').replace(/^./, c => c.toUpperCase());

/** The Score line for A1: playlist names and counts only. */
export function confusionLine(c, nameOf = id => id) {
  if (!c) return '';
  if (c.need > 0) return `Mix-ups by family: needs ${c.need} more scored tracks`;
  if (!c.pairs.length) return `Mix-ups by family: no mix-up repeats on ${c.n} tracks`;
  const pairs = c.pairs.map(p => `${nameOf(p.from)} read as ${nameOf(p.to)} ${p.n} times${p.sibling ? ' (same family)' : ''}`);
  const fams = c.families.map(f => `${famWords(f.from, nameOf)} → ${famWords(f.to, nameOf)} ${f.n}`);
  return `Mix-ups by family (${c.misses} misses of ${c.n}): ${pairs.join('; ')}${fams.length ? `. Across families: ${fams.join(', ')}` : ''}`;
}
