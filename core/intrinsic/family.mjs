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

/** May File commit to a family and ask only the last step? Read from one Score run. */
export function familyInUse(acc, bar = FAMILY_GATE) {
  return !!acc && acc.family != null && acc.family >= bar.minFamily && acc.families >= 2;
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
