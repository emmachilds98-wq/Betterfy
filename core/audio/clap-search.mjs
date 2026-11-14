// Naming "new genre?" groups and "find tracks that sound like ___"
// (docs/AUDIO-BUILD-PLAN.md WP-C3).
//
// Both read two things WP-C2 makes and nothing else:
//
//  - **The text table** (`docs/models/clap-text-table.json`): a reviewed list
//    of prompts — every ontology genre by name, plus descriptions such as
//    "dark rolling bassline" — embedded once, at build time, by
//    laion/larger_clap_music_and_speech's text encoder. Shape:
//      { v, model, revision?, dim, template?, prompts: [{ text, kind: 'genre'|'description',
//        concept?, emb: {s, q} }] }
//    with each `emb` L2-normalised before `packEmbedding`.
//  - **The record's `clap` field**: `{ model, emb: {s, q} }`, the same model's
//    *audio* embedding of the Deezer preview, in the same space as the text.
//    Absent or null means CLAP has not heard that track. A bare `{s, q}` is
//    read too.
//
// Text is never embedded in the page. CLAP's text encoder is a RoBERTa-base
// (~125M parameters, well over the 30 MB the brief allows quantised), so the
// search box takes the table's prompts only, with autocomplete. Nothing typed
// leaves the device: it is matched against the table and that is all.
//
// Names are suggestions and search only ranks: neither moves, files or
// creates anything, so neither waits on WP-E2's gate. Only this account's
// records are read (docs/SMARTER-GENRES-PLAN.md §3 R2), and no Spotify
// content goes into a model (R1): CLAP hears Deezer's audio, and the prompts
// are ours.
//
// With no CLAP records every function answers empty (null, [] or an empty
// Map), so the screens that call them render what they did before.
import { unpackEmbedding } from './record.mjs';

export const CLAP_SEARCH_VERSION = '1.0.0';

export const CLAP_SEARCH = Object.freeze({
  /** A group needs at least this many tracks heard by CLAP, and… */
  minHeard: 4,
  /** …at least this share of its tracks, before it gets a suggested name. */
  minShare: 0.5,
  /** Name suggestions offered: the first, plus this many alternatives. */
  alts: 2,
  /** Search results shown. */
  limit: 20,
  /** Autocomplete entries offered for a partial query. */
  suggest: 8,
  /** A stored name belongs to a fresh group when this share of the smaller of the two overlaps. */
  sameGroup: 0.6,
  /** Track ids kept with a confirmed name: enough to recognise the group again. */
  keepIds: 200,
});

const r4 = x => +x.toFixed(4);

function unit(v) {
  let ss = 0;
  for (let i = 0; i < v.length; i++) ss += v[i] * v[i];
  if (!(ss > 0) || !Number.isFinite(ss)) return null;
  const inv = 1 / Math.sqrt(ss), out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] * inv;
  return out;
}

function dot(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d;
}

/** "Dark, rolling  Bassline!" → "dark rolling bassline". */
export function normPrompt(s) {
  return String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}

/** The template's fixed words around `{name}` ("{name} music" → ['', ' music']), lowercased. */
function templateParts(template) {
  if (typeof template !== 'string' || !template.includes('{name}')) return null;
  const [pre, post] = template.split('{name}');
  return [normPrompt(pre), normPrompt(post)];
}

/** A genre prompt's name as a person would say it: the template's words taken off, if the text carries them. */
function labelOf(text, kind, parts) {
  let s = String(text ?? '').trim();
  if (kind === 'genre' && parts) {
    const n = normPrompt(s);
    const [pre, post] = parts;
    if ((pre && n.startsWith(pre + ' ')) || (post && n.endsWith(' ' + post))) {
      let words = n.split(' ');
      if (pre) words = words.slice(pre.split(' ').length);
      if (post) words = words.slice(0, words.length - post.split(' ').length);
      if (words.length) s = words.join(' ');
    }
  }
  return s;
}

/**
 * The table as this module uses it, or null when it is missing or malformed.
 * Never throws: a bad table means no names and no search, not a broken screen.
 *
 * @returns {null | { model: string, dim: number, prompts: { text: string, label: string, kind: string,
 *   concept: string|null, emb: Float32Array }[], byText: Map<string, number> }}
 */
export function readTable(json) {
  try {
    if (!json || !Array.isArray(json.prompts) || !(json.dim > 0)) return null;
    const parts = templateParts(json.template);
    const prompts = [], byText = new Map();
    for (const p of json.prompts) {
      if (!p || typeof p.text !== 'string' || !p.text.trim()) continue;
      const kind = p.kind === 'genre' ? 'genre' : 'description';
      let emb;
      try { emb = unit(unpackEmbedding(p.emb)); } catch { emb = null; }
      if (!emb || emb.length !== json.dim) continue;
      const label = labelOf(p.text, kind, parts);
      const i = prompts.length;
      prompts.push({ text: p.text, label, kind, concept: typeof p.concept === 'string' ? p.concept : null, emb });
      // Typed as the label, as the full prompt, or as the concept's slug: all the same prompt.
      for (const k of [label, p.text, p.concept?.replace(/-/g, ' ')]) {
        const n = normPrompt(k);
        if (n && !byText.has(n)) byText.set(n, i);
      }
    }
    if (!prompts.length) return null;
    return { model: String(json.model ?? ''), dim: json.dim, prompts, byText };
  } catch { return null; }
}

/** A record's CLAP audio embedding, unit length, or null. */
export function clapOf(rec, dim = null) {
  const c = rec?.clap;
  if (!c || rec.miss) return null;
  const packed = c.emb ?? (c.q ? c : null);
  if (!packed) return null;
  try {
    const v = unit(unpackEmbedding(packed));
    return v && (!dim || v.length === dim) ? v : null;
  } catch { return null; }
}

const recordsOf = records => (!records ? [] : records instanceof Map ? records.values()
  : Array.isArray(records) ? records : typeof records[Symbol.iterator] === 'function' ? records : Object.values(records));

/** Map<trackId, unit CLAP embedding> over the records CLAP has heard, newest record per id. */
export function clapIndex(records, { dim = null } = {}) {
  const index = new Map(), at = new Map();
  for (const rec of recordsOf(records)) {
    if (!rec || typeof rec.id !== 'string') continue;
    const v = clapOf(rec, dim);
    if (!v) continue;
    if (index.has(rec.id) && !((rec.at ?? 0) > (at.get(rec.id) ?? 0))) continue;
    index.set(rec.id, v);
    at.set(rec.id, rec.at ?? 0);
  }
  return index;
}

/** How many records CLAP has heard, without unpacking anything. Cheap enough to call on every redraw. */
export function clapHeard(records) {
  let n = 0;
  for (const rec of recordsOf(records)) if (rec && !rec.miss && rec.clap && (rec.clap.emb ?? rec.clap.q)) n++;
  return n;
}

/** The prompt this text names, exactly (after normalising), or null. */
export function findPrompt(query, table) {
  if (!table) return null;
  const i = table.byText.get(normPrompt(query));
  return i == null ? null : { i, ...pub(table.prompts[i]) };
}

const pub = p => ({ text: p.text, label: p.label, kind: p.kind, concept: p.concept });

/**
 * Autocomplete: prompts whose words start with what has been typed, best
 * first (the whole label starts with it, then every typed word starts one
 * of its words), genres before descriptions on a tie, then alphabetical.
 * Only word starts: "ph" offering "euphoric" is noise, not help.
 */
export function suggestPrompts(query, table, { limit = CLAP_SEARCH.suggest } = {}) {
  if (!table) return [];
  const q = normPrompt(query);
  if (!q) return [];
  const words = q.split(' ');
  const rows = [];
  table.prompts.forEach((p, i) => {
    const n = normPrompt(p.label), have = n.split(' ');
    let rank;
    if (n === q) rank = 0;
    else if (n.startsWith(q)) rank = 1;
    else if (words.every(w => have.some(h => h.startsWith(w)))) rank = 2;
    else return;
    rows.push([rank, p.kind === 'genre' ? 0 : 1, n, i]);
  });
  rows.sort((a, b) => a[0] - b[0] || a[1] - b[1] || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : a[3] - b[3]));
  return rows.slice(0, limit).map(r => ({ i: r[3], ...pub(table.prompts[r[3]]) }));
}

/**
 * The library's tracks ranked by how well they sound like a prompt, keeping
 * only those above the library's own average for it.
 *
 * @param {string|number} prompt  the prompt's text (as typed) or its index in the table
 * @param {Map} index             from clapIndex
 * @param {object} table          from readTable
 * @returns {{ prompt: object|null, results: { id: string, score: number }[], heard: number }}
 *          `prompt` null when the text is not one of the table's prompts.
 */
export function soundsLike(prompt, index, table, { limit = CLAP_SEARCH.limit, exclude = null } = {}) {
  const heard = index?.size ?? 0;
  const found = typeof prompt === 'number' ? (table?.prompts[prompt] ? { i: prompt, ...pub(table.prompts[prompt]) } : null)
    : findPrompt(prompt, table);
  if (!found || !heard) return { prompt: found, results: [], heard };
  const t = table.prompts[found.i].emb;
  const rows = [];
  for (const [id, v] of index) {
    if (exclude?.has?.(id) || v.length !== t.length) continue;
    rows.push({ id, score: r4(dot(v, t)) });
  }
  rows.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  // Only tracks closer to the prompt than the library is on average: "sounds
  // like phonk" should not pad itself out with everything else you own.
  const avg = rows.reduce((t, x) => t + x.score, 0) / (rows.length || 1);
  return { prompt: found, results: rows.filter(x => x.score > avg).slice(0, limit), heard };
}

/**
 * A suggested name for a group of tracks: the genre prompt its sound is most
 * *distinctively* like, compared with the rest of the account's heard library.
 *
 * Raw CLAP similarity is not enough on its own: broad prompts ("electronic")
 * sit close to almost everything, and would name every group the same. So
 * each genre prompt is scored by how much closer the group's centre is to it
 * than the library's tracks are on average, and the biggest lift wins.
 *
 * Returns null, and the group stays unnamed, when too few of its tracks have
 * been heard by CLAP or no prompt is closer to it than to the library.
 *
 * @param {string[]} ids
 * @param {Map} index    from clapIndex, over the whole account (the baseline)
 * @param {object} table from readTable
 * @returns {null | { name: string, concept: string|null, lift: number, heard: number,
 *                    alts: { name: string, concept: string|null, lift: number }[], sounds: string|null }}
 */
export function nameGroup(ids, index, table, { minHeard = CLAP_SEARCH.minHeard, minShare = CLAP_SEARCH.minShare,
                                                 alts = CLAP_SEARCH.alts, baseline = null } = {}) {
  if (!table || !index?.size || !ids?.length) return null;
  const vs = ids.map(id => index.get(id)).filter(v => v && v.length === table.dim);
  if (vs.length < minHeard || vs.length < minShare * ids.length) return null;
  const sum = new Float64Array(table.dim);
  for (const v of vs) for (let i = 0; i < sum.length; i++) sum[i] += v[i];
  const centre = unit(sum);
  if (!centre) return null;
  const base = baseline ?? libraryMean(index, table.dim);
  const lift = p => dot(centre, p.emb) - (base ? dot(base, p.emb) : 0);
  const rank = kind => table.prompts.map((p, i) => [i, lift(p)]).filter(([i]) => table.prompts[i].kind === kind)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const genres = rank('genre').filter(([, l]) => l > 0);
  if (!genres.length) return null;
  const seen = new Set(), named = [];
  for (const [i, l] of genres) {
    const p = table.prompts[i], key = p.concept ?? normPrompt(p.label);
    if (seen.has(key)) continue;
    seen.add(key);
    named.push({ name: p.label, concept: p.concept, lift: r4(l) });
    if (named.length > alts) break;
  }
  const desc = rank('description').find(([, l]) => l > 0);
  return { ...named[0], heard: vs.length, alts: named.slice(1), sounds: desc ? table.prompts[desc[0]].label : null };
}

/** The account's average heard sound (un-normalised mean of unit vectors), or null. */
export function libraryMean(index, dim) {
  if (!index?.size) return null;
  const m = new Float64Array(dim);
  let n = 0;
  for (const v of index.values()) {
    if (v.length !== dim) continue;
    for (let i = 0; i < dim; i++) m[i] += v[i];
    n++;
  }
  if (!n) return null;
  for (let i = 0; i < dim; i++) m[i] /= n;
  return m;
}

/* ---------- confirmed names, per account ----------
 * { [key]: { name, ids: [...], at } }: a name the listener confirmed or typed
 * for a group, with enough of its tracks to recognise the group next time,
 * when it has gained or lost a few. Plain stamped values, so the page's
 * newest-wins sync between the listener's own linked devices carries them
 * unchanged. Nothing here is shared between accounts. */

function overlap(a, b) {
  if (!a.length || !b.length) return 0;
  const s = new Set(a);
  let n = 0;
  for (const x of b) if (s.has(x)) n++;
  return n / Math.min(a.length, s.size, new Set(b).size);
}

/** The confirmed name for this group, if one was given to (most of) it before. */
export function confirmedName(ids, names, { sameGroup = CLAP_SEARCH.sameGroup } = {}) {
  let best = null, bestO = 0;
  for (const [key, e] of Object.entries(names ?? {})) {
    if (!e?.name || !Array.isArray(e.ids)) continue;
    const o = overlap(e.ids, ids ?? []);
    if (o >= sameGroup && (o > bestO || (o === bestO && (e.at ?? 0) > (best?.at ?? 0)))) { best = { key, ...e }; bestO = o; }
  }
  return best ? { key: best.key, name: best.name, at: best.at ?? 0 } : null;
}

/** A short stable key for a group, from its sorted ids. */
export function groupKey(ids) {
  let h = 2166136261;
  for (const id of [...ids].sort()) for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return 'g' + h.toString(36);
}

/**
 * Names after confirming `name` for this group. The entry for the same group,
 * if there is one, is replaced (renaming keeps its key, so the sync sees one
 * value changing, not a second group). Returns a new object.
 */
export function confirmName(names, ids, name, { at = Date.now(), keepIds = CLAP_SEARCH.keepIds } = {}) {
  const clean = String(name ?? '').trim();
  if (!clean || !ids?.length) return { ...(names ?? {}) };
  const prev = confirmedName(ids, names);
  const key = prev?.key ?? groupKey(ids);
  return { ...(names ?? {}), [key]: { name: clean, ids: [...ids].sort().slice(0, keepIds), at } };
}
