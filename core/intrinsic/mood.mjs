// @bundle engine BetterfyMood 108
// Mood "also fits" chips (docs/review/ENGINE-REVIEW.md layer 5, item 7).
//
// Mood, context and occasion playlists ("Late Night", "Gym", "Sad Bangers")
// get no suggestions today: they are multi-label, so they cannot compete with
// the genre pick. Here each one is its own yes/no question, answered by sound
// only: how close a track sits to that playlist's nearest heard members.
//
// A playlist earns a chip only on the account's own filing:
//   - at least MOOD_GATE.minMembers heard members;
//   - a threshold fitted on one half of its heard tracks (members against
//     tracks filed elsewhere) and checked on the other half: the chip is used
//     only where the checked precision is at least MOOD_GATE.minPrecision.
// It never changes the genre pick. Model mood labels play no part (they stay
// explanations until the owner's label review passes).
//
// Tempo and energy ranges are left out: the BPM display is still hidden
// behind its own gate, so the chip is sound alone.

export const MOOD_VERSION = '1.0.0';

export const MOOD_GATE = Object.freeze({
  minMembers: 12,      // heard members a playlist needs before it is fitted
  minPrecision: 0.8,   // checked on held-out tracks
  fitPrecision: 0.85,  // the fitted threshold aims a little higher than the check
  minHits: 3,          // tracks above the threshold, in each half, before a precision counts
  k: 5,                // nearest members averaged
  maxMembers: 150,     // members compared, for cost
  maxOthers: 400,      // tracks filed elsewhere used as the "no" side, for cost
});

const AXES = new Set(['mood', 'context']);

const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };
const half = id => hash(id) & 1;
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const sample = (ids, n) => ids.length <= n ? ids : [...ids].sort((a, b) => hash(a) - hash(b)).slice(0, n);

/** Mean similarity of `emb` to its k nearest among `members` (unit embeddings), skipping `self`. */
export function nearScore(emb, members, k = MOOD_GATE.k, self = null) {
  const sims = [];
  for (const [id, e] of members) if (id !== self) sims.push(dot(emb, e));
  if (!sims.length) return null;
  sims.sort((x, y) => y - x);
  const top = sims.slice(0, Math.min(k, sims.length));
  return top.reduce((s, v) => s + v, 0) / top.length;
}

/** The lowest threshold at which `scored` ([score, isMember]) reaches `want` precision with `minHits` above it. */
function fitThreshold(scored, want, minHits) {
  const s = [...scored].sort((a, b) => b[0] - a[0]);
  let tp = 0, best = null;
  for (let i = 0; i < s.length; i++) {
    if (s[i][1]) tp++;
    const n = i + 1;
    if (n >= minHits && tp / n >= want && (i + 1 === s.length || s[i + 1][0] < s[i][0])) best = s[i][0];
  }
  return best;
}

function precisionAt(scored, tau) {
  let n = 0, tp = 0;
  for (const [x, m] of scored) if (x >= tau) { n++; if (m) tp++; }
  return { n, right: tp, precision: n ? +(tp / n).toFixed(4) : null };
}

/**
 * Fit every mood/context playlist that has enough heard members.
 *
 * @param {{ playlists: Array<{id, name, tracks}> }} lib
 * @param {Map<string, {emb: Float32Array}>} index  heard tracks (audio.mjs audioIndex)
 * @param {(id: string) => string|null} axisOf  playlist id → axis ('genre', 'mood', 'context', …)
 * @returns {{ version, rows: Array<{id, name, members, tau, fit, checked, use, why}> }}
 */
export function fitMoods(lib, index, axisOf, gate = MOOD_GATE) {
  const g = { ...MOOD_GATE, ...gate };
  const rows = [];
  if (!(index instanceof Map) || !index.size) return { version: MOOD_VERSION, rows };
  const filed = new Set();
  for (const p of lib?.playlists ?? []) for (const t of p.tracks ?? []) if (t?.id && index.has(t.id)) filed.add(t.id);
  for (const p of lib?.playlists ?? []) {
    if (!AXES.has(axisOf?.(p.id))) continue;
    const memberIds = [...new Set((p.tracks ?? []).map(t => t?.id).filter(id => id && index.has(id)))];
    const row = { id: p.id, name: p.name, members: memberIds.length, tau: null, fit: null, checked: null, use: false, why: null };
    rows.push(row);
    if (memberIds.length < g.minMembers) { row.why = `only ${memberIds.length} of ${g.minMembers} heard`; continue; }
    const inP = new Set(memberIds);
    const members = sample(memberIds, g.maxMembers).map(id => [id, index.get(id).emb]);
    const others = sample([...filed].filter(id => !inP.has(id)), g.maxOthers);
    if (!others.length) { row.why = 'nothing filed elsewhere to compare against'; continue; }
    const halves = [[], []];
    for (const id of memberIds) { const x = nearScore(index.get(id).emb, members, g.k, id); if (x != null) halves[half(id)].push([x, true]); }
    for (const id of others) { const x = nearScore(index.get(id).emb, members, g.k); if (x != null) halves[half(id)].push([x, false]); }
    const tau = fitThreshold(halves[0], g.fitPrecision, g.minHits);
    if (tau == null) { row.why = 'no threshold reaches the precision bar'; continue; }
    row.tau = +tau.toFixed(6);
    row.fit = precisionAt(halves[0], tau);
    row.checked = precisionAt(halves[1], tau);
    row.use = row.checked.n >= g.minHits && row.checked.precision >= g.minPrecision;
    row.why = row.use ? null : row.checked.n < g.minHits ? 'too few held-out tracks above the threshold'
      : `held-out precision ${Math.round(row.checked.precision * 100)}%`;
  }
  return { version: MOOD_VERSION, rows };
}

/** Is any chip in use? */
export const moodInUse = fit => !!fit?.rows?.some(r => r.use);

/**
 * The "also fits" chips for one heard track: playlists in use whose threshold it
 * clears and that it is not already in, closest first, at most `limit`.
 * @returns {Array<{id, name, score}>}
 */
export function moodChips(trackId, fit, index, lib, { limit = 2 } = {}) {
  const row = index?.get?.(trackId);
  if (!row || !moodInUse(fit)) return [];
  const byId = new Map((lib?.playlists ?? []).map(p => [p.id, p]));
  const out = [];
  for (const r of fit.rows) {
    if (!r.use) continue;
    const p = byId.get(r.id);
    if (!p || (p.tracks ?? []).some(t => t?.id === trackId)) continue;
    const members = sample((p.tracks ?? []).map(t => t?.id).filter(id => id && index.has(id)), MOOD_GATE.maxMembers)
      .map(id => [id, index.get(id).emb]);
    const x = nearScore(row.emb, members, MOOD_GATE.k, trackId);
    if (x != null && x >= r.tau) out.push({ id: r.id, name: r.name, score: +x.toFixed(4) });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** The Score line: what was measured and whether it is used. */
export function moodLine(fit) {
  const rows = fit?.rows ?? [];
  if (!rows.length) return '';
  const used = rows.filter(r => r.use);
  const pc = x => `${Math.round(x * 100)}%`;
  const head = `Mood chips: ${used.length} of ${rows.length} mood playlists earned an "also fits" chip`;
  const list = rows.map(r => r.use ? `${r.name} (right ${pc(r.checked.precision)} of ${r.checked.n} held out)`
                                   : `${r.name} (not used: ${r.why})`);
  return `${head}. ${list.join('; ')}.`;
}
