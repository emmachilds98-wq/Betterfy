// @bundle engine BetterfyWeak 110
// The playlists it understands least, and why (docs/NEXT-WORKPLAN.md, after #154).
//
// The Score card's old "Weakest" list was measured on the account-native
// engine alone (no tags, no similar artists, no sound), which is not what File
// places with, and it named playlists without saying what was wrong with them.
// This reads the held-out rows of the engine that places (the same rows
// family-first and the pair checks are fitted on) and, for each playlist the
// engine rarely offers in its top three, works out the likeliest reason from
// the account's own library:
//
//   view      most of its tracks are also in one other playlist
//   working   it is mixed up with one playlist, and a pair check now tells them apart
//   few       too few tracks to have a sound or a scene of its own yet
//   twin      mixed up with one playlist that shares its artists, or that sound can't separate
//   unheard   listening has heard too few of its tracks to compare by sound
//   partner   mixed up with one playlist, for no reason the library shows
//   scattered its misses go everywhere: artists new to the library, nothing to go on
//
// and the honest fix: merge (tap-only, through Library's merge wizard), add a
// few more example tracks, or wait for listening. Nothing here changes a
// playlist or a pick. It is counts over this account's own filing; nothing is
// trained or pooled across accounts.
//
// The dominant partner of each weak playlist also becomes a pair-check
// candidate (pairs.mjs `extra`), so a small playlist that never makes the top
// two still gets its own sound check. Its answer decides the advice: two
// playlists that sound alike are a merge question, two that sound different
// need examples that show it.
import { pairKey } from './pairs.mjs';
import { WEAK, weakWords } from '../review/weakwords.mjs';

export { WEAK, weakWords };

export const WEAK_VERSION = '1.0.0';

const rate = (a, b) => (b > 0 ? +(a / b).toFixed(4) : null);

/**
 * Per playlist, from held-out rows ({ id, scores: [[pid, s]...] best first, truth: [pid] }):
 * how often it came first, how often it was in the top three, and where its misses went.
 * `inScope(id)` limits it to the genre playlists. Credited to every playlist a track is in.
 */
export function playlistStats(rows, { inScope = null } = {}) {
  const ok = id => !!id && (!inScope || inScope(id));
  const out = new Map();
  for (const r of rows ?? []) {
    const ranked = (r?.scores ?? []).filter(x => ok(x?.[0]));
    const truth = new Set((r?.truth ?? []).filter(ok));
    if (!ranked.length || !truth.size) continue;
    const first = ranked[0][0], top3 = ranked.slice(0, 3).map(x => x[0]);
    const miss = !truth.has(first);
    for (const pid of truth) {
      const s = out.get(pid) ?? { id: pid, n: 0, top1: 0, inTop3: 0, misses: 0, missTo: new Map() };
      s.n++;
      if (first === pid) s.top1++;
      if (top3.includes(pid)) s.inTop3++;
      if (miss) { s.misses++; s.missTo.set(first, (s.missTo.get(first) ?? 0) + 1); }
      out.set(pid, s);
    }
  }
  return out;
}

/** The playlist that takes most of `s`'s misses, when one does. */
function partnerOf(s, g) {
  let best = null;
  for (const [id, n] of s.missTo) if (!best || n > best.misses || (n === best.misses && id < best.id)) best = { id, misses: n };
  if (!best || best.misses < g.partnerMin || best.misses / s.misses < g.partnerShare) return null;
  return { ...best, share: rate(best.misses, s.misses) };
}

/**
 * The weakest playlists, weakest first: offered in the top three on fewer than
 * `below` of their scored tracks, with at least `minN` scored.
 * @returns {Array<{id, n, top1, inTop3, misses, partner: {id, misses, share}|null}>}
 */
export function weakPlaylists(rows, { inScope = null, gate = WEAK } = {}) {
  const g = { ...WEAK, ...gate };
  return [...playlistStats(rows, { inScope }).values()]
    .filter(s => s.n >= g.minN && s.inTop3 / s.n < g.below)
    .map(s => ({ id: s.id, n: s.n, top1: rate(s.top1, s.n), inTop3: rate(s.inTop3, s.n), misses: s.misses,
                 partner: partnerOf(s, g) }))
    .sort((a, b) => a.inTop3 - b.inTop3 || b.n - a.n || (a.id < b.id ? -1 : 1))
    .slice(0, g.max);
}

/** Each weak playlist and the playlist it is mistaken for, as pair-check candidates. */
export function weakPairs(weak) {
  const seen = new Set(), out = [];
  for (const w of weak ?? []) {
    if (!w?.partner?.id || w.partner.id === w.id) continue;
    const key = pairKey(w.id, w.partner.id);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ a: w.id < w.partner.id ? w.id : w.partner.id, b: w.id < w.partner.id ? w.partner.id : w.id,
               key, misses: w.partner.misses, weak: w.id });
  }
  return out;
}

/** What the library says about one playlist: its tracks, its artists, how many are heard. */
function facts(p, index) {
  const ids = new Set(), artists = new Map();
  for (const t of p?.tracks ?? []) {
    if (!t?.id || ids.has(t.id)) continue;
    ids.add(t.id);
    for (const a of t.artists ?? []) if (a?.id) artists.set(a.id, (artists.get(a.id) ?? 0) + 1);
  }
  let heard = 0;
  if (index) for (const id of ids) if (index.has?.(id)) heard++;
  return { ids, artists, size: ids.size, heard };
}

/**
 * Why each weak playlist fails, and the honest fix.
 *
 * @param {Array} weak         weakPlaylists()
 * @param {object} o
 * @param {object} o.lib       the library ({ playlists: [{ id, tracks }] })
 * @param {Map}   [o.index]    heard tracks (id → { emb }); null when nothing is heard
 * @param {object}[o.pairs]    pairs.mjs fitPairs() result for this run
 * @param {Map}   [o.families] playlist id → family key (family.mjs playlistFamilies)
 * @param {Function}[o.inScope] the genre playlists
 * @returns {Array<{id, n, top1, inTop3, size, heard, partner, cause, fix, add, sharedArtists, sharedTracks, pair, loners}>}
 */
export function diagnoseWeak(weak, { lib, index = null, pairs = null, families = null, inScope = null, gate = WEAK } = {}) {
  const g = { ...WEAK, ...gate };
  const byId = new Map((lib?.playlists ?? []).map(p => [p.id, p]));
  // How many genre playlists each artist is filed in, for "new to the library".
  const homes = new Map();
  for (const p of lib?.playlists ?? []) {
    if (!p?.id || (inScope && !inScope(p.id))) continue;
    for (const a of facts(p, null).artists.keys()) homes.set(a, (homes.get(a) ?? 0) + 1);
  }
  const fam = id => families?.get?.(id) ?? `own:${id}`;
  return (weak ?? []).map(w => {
    const f = facts(byId.get(w.id), index);
    // Tracks by an artist with one track here and no other genre playlist: the
    // artist graph has nothing to say about them, only tags, sound and similar artists.
    let lonely = 0;
    for (const t of byId.get(w.id)?.tracks ?? []) {
      if (!t?.id) continue;
      const as = (t.artists ?? []).filter(a => a?.id);
      if (as.length && as.every(a => (f.artists.get(a.id) ?? 0) <= 1 && (homes.get(a.id) ?? 0) <= 1)) lonely++;
    }
    const out = { id: w.id, n: w.n, top1: w.top1, inTop3: w.inTop3, size: f.size, heard: index ? f.heard : null,
                  partner: w.partner, loners: rate(lonely, f.size), sharedArtists: null, sharedTracks: null,
                  sameFamily: null, pair: null, cause: null, fix: null, add: 0 };
    const q = w.partner ? facts(byId.get(w.partner.id), null) : null;
    if (q) {
      let a = 0; for (const id of f.artists.keys()) if (q.artists.has(id)) a++;
      let t = 0; for (const id of f.ids) if (q.ids.has(id)) t++;
      out.sharedArtists = rate(a, f.artists.size);
      out.sharedTracks = rate(t, f.size);
      out.sameFamily = fam(w.id) === fam(w.partner.id) && !String(fam(w.id)).startsWith('own:');
      const row = pairs?.rows?.find(r => r.key === pairKey(w.id, w.partner.id));
      if (row) out.pair = { use: !!row.use && !!pairs.use, accuracy: row.checked?.accuracy ?? null, n: row.checked?.n ?? null,
                            why: row.use && !pairs.use ? 'pair checks not used: they lowered top-1' : row.why ?? null,
                            swaps: !!row.use && !!pairs.use && (!row.weak || row.misses > 0) };
    }
    const few = f.size < g.few;
    const unheard = index && f.heard < Math.min(g.minHeard, f.size);
    const alike = out.pair?.accuracy != null && out.pair.accuracy < g.sameSound;
    if (q && out.sharedTracks >= g.viewShare) { out.cause = 'view'; out.fix = 'merge'; }
    else if (q && out.pair?.swaps) { out.cause = 'working'; out.fix = 'none'; }
    else if (few) { out.cause = 'few'; out.fix = 'add'; out.add = g.few - f.size; }
    else if (q && (out.sharedArtists >= g.shareArtists || alike)) { out.cause = 'twin'; out.fix = 'merge'; }
    else if (unheard) { out.cause = 'unheard'; out.fix = 'wait'; }
    else if (q) { out.cause = 'partner'; out.fix = 'add'; out.add = Math.max(5, Math.ceil(f.size * 0.25)); }
    else { out.cause = 'scattered'; out.fix = 'add'; out.add = Math.max(5, Math.ceil(f.size * 0.25)); }
    return out;
  });
}

const pc = x => (x == null ? '—' : `${Math.round(x * 100)}%`);

/** The Score paste line. Counts and the user's own playlist names only. */
export function weakLine(diag, nameOf = id => id) {
  if (!diag?.length) return '';
  return `Weakest, as File places: ${diag.map(d => {
    const w = weakWords(d, nameOf);
    return `${nameOf(d.id)} ${pc(d.inTop3)} of ${d.n} in its top 3 (${d.cause}${d.partner ? ` vs ${nameOf(d.partner.id)}` : ''}: ${w.fix})`;
  }).join('; ')}`;
}

/** What Library keeps: small, one row per weak playlist. */
export function weakSummary(diag, at = Date.now()) {
  return { v: WEAK_VERSION, at, rows: (diag ?? []).map(d => ({
    id: d.id, n: d.n, top1: d.top1, inTop3: d.inTop3, size: d.size, heard: d.heard, cause: d.cause, fix: d.fix, add: d.add,
    partner: d.partner?.id ?? null, sharedArtists: d.sharedArtists, sharedTracks: d.sharedTracks, loners: d.loners,
    pair: d.pair ? { use: d.pair.use, swaps: d.pair.swaps, accuracy: d.pair.accuracy, n: d.pair.n } : null })) };
}
