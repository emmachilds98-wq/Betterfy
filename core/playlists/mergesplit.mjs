// The merge/split playlist wizard's planning (BUILD-6-PLAN §4.1/§4.2 F4).
//
// Two offers already existed and had no one place to act on them: "twins",
// pairs of playlists the engine cannot tell apart (lists.mjs twinsOf, from
// bucketPairs), and "two genres", a playlist whose tracks split into two
// (core/audio/plprofile.mjs by sound, core/recommend/gaps.mjs splitCandidates
// by tags). The wizard puts both behind one preview and writes only new
// private playlists: the originals are never edited.
//
// Everything here is pure: plans in, plans out, no Spotify and no storage.
// The page (web/screens/lists.mjs) draws a plan, lets you rename and move
// tracks, and writes `writesOf(plan)` as one History group.
//
// Counts on the account's own playlists only (SMARTER-GENRES-PLAN §3, R3):
// nothing is learned, nothing leaves the device.

/** A track's identity for de-duplication: its ISRC (the recording, the same
 *  under any relinked pressing) when it has one, else its Spotify id. */
export function trackKey(t) {
  const isrc = typeof t?.isrc === 'string' ? t.isrc : t?.external_ids?.isrc;
  if (typeof isrc === 'string' && isrc.trim()) return 'isrc:' + isrc.trim().toUpperCase();
  return t?.id ? 'id:' + t.id : null;
}

const artistLine = t => (t?.artists ?? []).map(a => a?.name).filter(Boolean).join(', ');
const row = (t, from) => ({ id: t.id, title: t.name ?? t.id, artist: artistLine(t), from });

/** Tracks with an id, in order, each recording once (by id and by ISRC). */
function uniq(tracks, seenId = new Set(), seenKey = new Set()) {
  const out = [];
  for (const t of tracks ?? []) {
    if (!t?.id || seenId.has(t.id)) continue;
    const k = trackKey(t);
    if (k && seenKey.has(k)) continue;
    seenId.add(t.id); if (k) seenKey.add(k);
    out.push(t);
  }
  return out;
}

/** "Deep House + House Classics", kept under Spotify's 100-character limit. */
export function mergeName(a, b) {
  return `${String(a?.name ?? '').trim() || 'Playlist'} + ${String(b?.name ?? '').trim() || 'Playlist'}`.slice(0, 100);
}

/**
 * Two playlists as one: every track of `a` in its order, then every track of
 * `b` that `a` does not already hold, the same recording counted once whether
 * it is the same id or the same ISRC under another id.
 * @returns {{ kind:'merge', sources:[{id,name,n}], name, parts:[{name, rows, include}],
 *            counts:{ a, b, both, total, dupes } }}
 */
export function mergePlan(a, b, { name } = {}) {
  const seenId = new Set(), seenKey = new Set();
  const fromA = uniq(a?.tracks, seenId, seenKey);
  const aKeys = new Set(fromA.map(trackKey).filter(Boolean));
  const aIds = new Set(fromA.map(t => t.id));
  const fromB = [], bothSeen = new Set();
  for (const t of b?.tracks ?? []) {
    if (!t?.id) continue;
    const k = trackKey(t);
    if (aIds.has(t.id) || (k && aKeys.has(k))) { bothSeen.add(k ?? t.id); continue; }
    if (seenId.has(t.id) || (k && seenKey.has(k))) continue;
    seenId.add(t.id); if (k) seenKey.add(k);
    fromB.push(t);
  }
  const both = bothSeen.size;
  const rows = [...fromA.map(t => row(t, 'a')), ...fromB.map(t => row(t, 'b'))];
  const raw = (a?.tracks ?? []).filter(t => t?.id).length + (b?.tracks ?? []).filter(t => t?.id).length;
  return {
    kind: 'merge',
    sources: [a, b].map(p => ({ id: p?.id, name: p?.name ?? p?.id, n: (p?.tracks ?? []).length })),
    parts: [{ name: (name ?? mergeName(a, b)).slice(0, 100), rows, include: true }],
    counts: { a: fromA.length, b: fromB.length, both, total: rows.length, dupes: raw - rows.length },
  };
}

/**
 * One playlist as two or more: each proposed part takes the tracks its `ids`
 * name, in the playlist's order; a track no part names (not heard, no genre
 * in its tags) goes to part `restTo` (the half the playlist's name owns), or
 * is left out with `restTo: -1`. A track two parts name goes to the first.
 * @param playlist {id, name, tracks}
 * @param parts [{ name, ids }]
 * @returns {{ kind:'split', sources:[{id,name,n}], parts:[{name, rows, include}], rest:number }}
 */
export function splitPlan(playlist, parts, { restTo = 0 } = {}) {
  const want = (parts ?? []).map(p => new Set(p?.ids ?? []));
  const out = (parts ?? []).map(p => ({ name: String(p?.name ?? '').slice(0, 100), rows: [], include: true }));
  let rest = 0;
  for (const t of uniq(playlist?.tracks)) {
    const k = want.findIndex(s => s.has(t.id));
    if (k >= 0) { out[k].rows.push(row(t, 'named')); continue; }
    rest++;
    if (out[restTo]) out[restTo].rows.push(row(t, 'rest'));
  }
  return { kind: 'split', sources: [{ id: playlist?.id, name: playlist?.name ?? playlist?.id, n: (playlist?.tracks ?? []).length }], parts: out, rest };
}

/** A plprofile split ({ keep, move }) as wizard parts: "House — House", "House — Jungle". */
export function partsFromSound(playlistName, split) {
  const base = String(playlistName ?? '').trim() || 'Playlist';
  return [split?.keep, split?.move].filter(Boolean).map(g => ({ name: `${base} — ${g.name ?? g.slug ?? 'part'}`.slice(0, 100), ids: g.ids ?? [] }));
}

/** A gaps.mjs split ({ name, parts:[{label, ids, rest}] }) as wizard parts. */
export function partsFromTags(split) {
  const base = String(split?.name ?? '').trim() || 'Playlist';
  return (split?.parts ?? []).map(x => ({ name: `${base} — ${x.rest ? 'rest of ' : ''}${x.label ?? x.concept ?? 'part'}`.slice(0, 100), ids: x.ids ?? [] }));
}

/** The plan with one track moved to part `to` (pure; an unknown track or part changes nothing). */
export function moveTrack(plan, id, to) {
  if (!plan?.parts?.[to]) return plan;
  const from = plan.parts.findIndex(p => p.rows.some(r => r.id === id));
  if (from < 0 || from === to) return plan;
  const r = plan.parts[from].rows.find(x => x.id === id);
  return { ...plan, parts: plan.parts.map((p, k) =>
    k === from ? { ...p, rows: p.rows.filter(x => x.id !== id) }
    : k === to ? { ...p, rows: [...p.rows, r] } : p) };
}

/** The plan with part `k` renamed (trimmed later, when written). */
export function renamePart(plan, k, name) {
  if (!plan?.parts?.[k]) return plan;
  return { ...plan, parts: plan.parts.map((p, i) => (i === k ? { ...p, name: String(name ?? '').slice(0, 100) } : p)) };
}

/** The plan with part `k` in or out of what gets made. */
export function includePart(plan, k, on) {
  if (!plan?.parts?.[k]) return plan;
  return { ...plan, parts: plan.parts.map((p, i) => (i === k ? { ...p, include: !!on } : p)) };
}

/**
 * What the wizard would make: one new private playlist per included part
 * with at least one track. `problems` says why Create is not offered yet
 * (a part with no name, two parts with one name, nothing to make).
 * @returns {{ writes:[{ name, ids }], problems:string[] }}
 */
export function writesOf(plan) {
  const writes = [], problems = [];
  for (const p of plan?.parts ?? []) {
    if (!p.include || !p.rows.length) continue;
    const name = String(p.name ?? '').trim();
    if (!name) { problems.push('Every playlist it makes needs a name.'); continue; }
    writes.push({ name, ids: p.rows.map(r => r.id) });
  }
  const names = writes.map(w => w.name.toLowerCase());
  if (new Set(names).size !== names.length) problems.push('Two of the new playlists have the same name.');
  if (!writes.length && !problems.length) problems.push('Nothing to make: every part is empty or left out.');
  return { writes, problems: [...new Set(problems)] };
}

/** Twin pairs (bucketPairs' "indistinguishable" verdict) as merge offers, one per pair. */
export function twinOffers(pairs) {
  const out = [], seen = new Set();
  for (const p of Array.isArray(pairs) ? pairs : []) {
    if (p?.verdict !== 'indistinguishable' || !p.a?.id || !p.b?.id || p.a.id === p.b.id) continue;
    const key = offerKey('merge', [p.a.id, p.b.id]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, a: { id: p.a.id, name: p.a.name ?? p.a.id }, b: { id: p.b.id, name: p.b.name ?? p.b.id }, similarity: p.similarity ?? null });
  }
  return out;
}

/** One key per offer, the same whichever screen showed it: "merge:A+B" (sorted), "split:A". */
export function offerKey(kind, ids) {
  const xs = (Array.isArray(ids) ? ids : [ids]).map(String);
  return kind === 'merge' ? 'merge:' + [...xs].sort().join('+') : kind + ':' + xs[0];
}

/* ---------- the measure: how often an offer is waved away ----------
 * Kept on this device only (`bf_mergesplit`): for each offer key, when it was
 * first shown, and whether it was dismissed or made. The bar (BUILD-6-PLAN
 * §3.1, §4.1 F4) is a dismiss rate of at most 25% over at least 10 offers;
 * above a third, the split constants in plprofile.mjs are too eager. */
export const DISMISS_BAR = 0.25;
export const DISMISS_MIN = 10;

const emptyMeasure = () => ({ shown: {}, dismissed: {}, made: {} });

/** A stored measure, repaired: anything unreadable is an empty one. */
export function readMeasure(raw) {
  let m = raw;
  if (typeof raw === 'string') { try { m = JSON.parse(raw); } catch { m = null; } }
  const out = emptyMeasure();
  if (m && typeof m === 'object') for (const k of Object.keys(out))
    if (m[k] && typeof m[k] === 'object') for (const [key, at] of Object.entries(m[k])) if (Number.isFinite(at)) out[k][key] = at;
  return out;
}

/** The measure with `what` ('shown' | 'dismissed' | 'made') recorded for `key`, once (the first time stands).
 *  Dismissing or making an offer also counts it as shown. Null when that was already recorded. */
export function recordOffer(measure, what, key, now = Date.now()) {
  const m = readMeasure(measure);
  if (!key || !(what in m) || (m[what][key] && m.shown[key])) return null;
  m[what][key] ??= now;
  m.shown[key] ??= now;
  return m;
}

/** Shown, dismissed, made, and the dismiss rate against its bar. Merges and splits apart and together. */
export function dismissRate(measure) {
  const m = readMeasure(measure);
  const count = (o, kind) => Object.keys(o).filter(k => !kind || k.startsWith(kind + ':')).length;
  const one = kind => {
    const shown = count(m.shown, kind), dismissed = count(m.dismissed, kind), made = count(m.made, kind);
    const rate = shown ? dismissed / shown : null;
    return { shown, dismissed, made, rate, enough: shown >= DISMISS_MIN, ok: rate === null ? null : rate <= DISMISS_BAR };
  };
  return { ...one(null), merge: one('merge'), split: one('split') };
}

/** The line the Library footer prints for the owner, or '' before any offer was shown. */
export function dismissLine(measure) {
  const r = dismissRate(measure);
  if (!r.shown) return '';
  const pct = Math.round(r.rate * 100);
  return `Merge/split offers: ${r.shown} shown, ${r.dismissed} dismissed (${pct}%), ${r.made} made. ` +
    (r.enough ? (r.ok ? `Within the ${DISMISS_BAR * 100}% bar.` : `Above the ${DISMISS_BAR * 100}% bar: the offers are too eager.`)
      : `Not enough data yet (${r.shown} of ${DISMISS_MIN}); the bar is ${DISMISS_BAR * 100}% or fewer dismissed.`);
}
