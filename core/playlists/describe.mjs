// @bundle engine BetterfyDescribe 113
// Names that say what a playlist holds (owner's ask, 2026-11-18): "renaming of
// playlists to help describe what's in there ... malleable to any user, so
// don't follow my naming conventions".
//
// Two rules keep it general:
//
//  1. What a playlist holds is read only from what every account has: its
//     tracks' artists' tags (Last.fm, built-in key), release years from
//     Spotify, and, once listening has heard enough, the playlist's sound
//     profile (styles, BPM, energy). Nothing names a venue, a scene or a
//     playlist of anyone's.
//  2. How a name is written is learned from the account's own playlist names:
//     lower case or Title Case, which separator they use, "&" or "and". A
//     suggestion is written the way that listener already writes, and a name
//     that is theirs (not "My Playlist #7") is kept and added to, not replaced.
//
// Nothing here writes anything. The page shows the suggestions; a rename is
// one tap, logged in History and undone from there.
import { resolveConcept, lineageOf } from '../ontology/index.mjs';
import { conceptLabel, playlistGenres } from '../recommend/gaps.mjs';

export const DESCRIBE_VERSION = '1.0.0';

/** Spotify's own limit on a playlist name. */
export const NAME_MAX = 100;
/** Fewer tagged tracks than this and nothing is said about a playlist. */
export const MIN_TAGGED = 5;
/** Tags read per artist, strongest first (as gaps.mjs artistGenre). */
const TAGS_READ = 8;
/** Genres too wide to name a playlist by on their own. */
const UMBRELLA = new Set(['electronic']);

/** A mood concept as a word in a name. */
const MOOD_WORDS = { relaxed: 'Chill', dark: 'Dark', melancholic: 'Melancholy', uplifting: 'Feel-Good',
  energetic: 'High-Energy', euphoric: 'Euphoric', aggressive: 'Heavy', dreamy: 'Dreamy', hypnotic: 'Hypnotic',
  nostalgic: 'Nostalgic', romantic: 'Romantic', dramatic: 'Cinematic' };

/* ---------- what a playlist holds ---------- */

/** One artist's strongest genre and mood, from their tag cloud. */
function readArtist(tags) {
  const strongest = (tags ?? []).filter(Array.isArray).slice().sort((a, b) => (Number(b[1]) || 0) - (Number(a[1]) || 0));
  let genre = null, mood = null;
  for (const [t] of strongest.slice(0, TAGS_READ)) {
    const r = resolveConcept(String(t));
    if (!r.concept) continue;
    if (!genre && r.facet === 'genre') genre = r.concept;
    if (!mood && r.facet === 'mood') mood = r.concept;
    if (genre && mood) break;
  }
  return { genre, mood };
}

const yearOf = t => { const m = /^(\d{4})/.exec(String(t?.released ?? '')); return m ? +m[1] : null; };

/**
 * What one playlist holds, in shares of its tracks.
 *
 * A track's genre is its first-billed artist's that has one (as gaps.mjs
 * trackGenre); its mood is that same artist's. Genres are also rolled up their
 * lineage, so a playlist that is a third deep house, a third tech house and a
 * third house reads as House rather than as three small things.
 *
 * @param {{ tracks?: object[] }} playlist
 * @param {(artistId:string) => Array<[string, number]>|undefined} tagsOf
 * @param {{ memo?: Map }} [opts]  memo: shared across playlists, artist id → reading
 * @returns {{ n:number, tagged:number, genres:{concept,share}[], parents:{concept,share}[],
 *            mood:{concept,share}|null, decade:{start,share}|null }}
 */
export function describeTracks(playlist, tagsOf, { memo = new Map(), now = new Date() } = {}) {
  const tracks = (playlist?.tracks ?? []).filter(t => t?.id);
  const g = new Map(), up = new Map(), md = new Map(), dec = new Map();
  let tagged = 0, dated = 0;
  const read = id => { if (!memo.has(id)) memo.set(id, readArtist(tagsOf?.(id))); return memo.get(id); };
  for (const t of tracks) {
    let hit = null;
    for (const a of t.artists ?? []) {
      if (!a?.id) continue;
      const r = read(a.id);
      if (r.genre || r.mood) { hit = r; break; }
    }
    if (hit) {
      tagged++;
      if (hit.genre) {
        g.set(hit.genre, (g.get(hit.genre) ?? 0) + 1);
        for (const anc of lineageOf(hit.genre).slice(1)) up.set(anc, (up.get(anc) ?? 0) + 1);
      }
      if (hit.mood) md.set(hit.mood, (md.get(hit.mood) ?? 0) + 1);
    }
    const y = yearOf(t);
    if (y) { dated++; const d = Math.floor(y / 10) * 10; dec.set(d, (dec.get(d) ?? 0) + 1); }
  }
  const shares = (m, of) => [...m].map(([concept, k]) => ({ concept, share: of ? k / of : 0 }))
    .sort((a, b) => b.share - a.share || String(a.concept).localeCompare(String(b.concept)));
  const moods = shares(md, tagged);
  const decs = shares(dec, dated);
  const thisDecade = Math.floor(now.getFullYear() / 10) * 10;
  // A decade names a playlist only when most of it is from one, and that
  // decade is not this one ("2020s" says nothing about a playlist of new music).
  const decade = dated >= 8 && decs[0] && decs[0].share >= 0.6 && decs[0].concept !== thisDecade
    ? { start: decs[0].concept, share: decs[0].share } : null;
  return { n: tracks.length, tagged, genres: shares(g, tagged), parents: shares(up, tagged),
    mood: moods[0] && moods[0].share >= 0.5 ? moods[0] : null, decade };
}

/* ---------- how this listener writes names ---------- */

const SEPARATORS = [' · ', ' | ', ' - ', ' – ', ' — ', ' / ', ': '];
const lettersOf = s => String(s ?? '').replace(/[^\p{L}]/gu, '');

/**
 * How an account writes its playlist names, learned from those names:
 * `case` ('lower' | 'upper' | 'title'), the separator it uses between parts,
 * and whether it writes "&" or "and". Defaults when the names do not say.
 * @param {string[]} names
 */
export function nameStyle(names) {
  const ns = (names ?? []).map(n => String(n ?? '').trim()).filter(n => lettersOf(n).length >= 3);
  const lower = ns.filter(n => { const l = lettersOf(n); return l === l.toLowerCase() && l !== l.toUpperCase(); }).length;
  const upper = ns.filter(n => { const l = lettersOf(n); return l === l.toUpperCase() && l !== l.toLowerCase(); }).length;
  const share = k => (ns.length ? k / ns.length : 0);
  const kase = ns.length >= 3 && share(lower) >= 0.6 ? 'lower' : ns.length >= 3 && share(upper) >= 0.6 ? 'upper' : 'title';
  const counts = SEPARATORS.map(s => [s, ns.filter(n => n.includes(s)).length]).sort((a, b) => b[1] - a[1]);
  const sep = counts[0][1] >= 2 ? counts[0][0] : ' · ';
  const amp = ns.filter(n => /&/.test(n)).length, and = ns.filter(n => /\band\b/i.test(n)).length;
  return { case: kase, sep, amp: and >= 2 && and > amp ? 'and' : '&' };
}

/** A name written in an account's style. */
export function styled(text, style = {}) {
  let s = String(text ?? '');
  if (style.amp === 'and') s = s.replace(/\s&\s/g, ' and ');
  if (style.case === 'lower') s = s.toLowerCase();
  else if (style.case === 'upper') s = s.toUpperCase();
  return s;
}

/* ---------- names that say nothing ---------- */

const DEFAULT_RE = /^(new playlist|my playlist|playlist|untitled|unnamed|new|test|misc|stuff|songs|music|tunes|tracks|mix|liked|likes|favs?|favou?rites|faves|random|bits|whatever|tbd|tmp|temp)\s*(?:#?\s*\d+)?$/i;

/**
 * True for a name that says nothing about what is in it: Spotify's own
 * defaults ("My Playlist #7", "New Playlist"), placeholders ("misc", "test 2"),
 * and names with no more than two letters (emoji, numbers, "x"). A name that
 * is somebody's own word, however private, is never called vague: "Bangers"
 * and "Sunday" mean something to whoever wrote them.
 */
export function isVagueName(name) {
  const s = String(name ?? '').trim();
  if (!s) return true;
  if (lettersOf(s).length <= 2) return true;
  return DEFAULT_RE.test(s.replace(/[^\p{L}\p{N}#\s]/gu, ' ').replace(/\s+/g, ' ').trim());
}

/** True when genre `a` sits inside `b`'s family, or `b` inside `a`'s. */
const related = (a, b) => a === b || lineageOf(a).includes(b) || lineageOf(b).includes(a);

/* ---------- the suggestions ---------- */

const pct = x => Math.round(x * 100);

/** The part of a name that says the music: one genre, two, or their family. */
function corePhrase(facts, sound) {
  const gs = (facts?.genres ?? []).filter(x => !UMBRELLA.has(x.concept));
  const [a, b] = gs;
  const fam = (facts?.parents ?? []).find(p => !UMBRELLA.has(p.concept) && p.share >= 0.6);
  // One genre when it clearly leads: most of the playlist, with no close second.
  if (a && (a.share >= 0.7 || (a.share >= 0.5 && !(b && b.share >= 0.25))))
    return { text: conceptLabel(a.concept), concepts: [a.concept], why: `${pct(a.share)}% ${conceptLabel(a.concept)}` };
  if (fam && (!a || fam.share >= a.share + 0.15)) return { text: conceptLabel(fam.concept), concepts: [fam.concept], why: `${pct(fam.share)}% ${conceptLabel(fam.concept)} or a style of it` };
  if (a && b && b.share >= 0.2 && a.share + b.share >= 0.55)
    return { text: `${conceptLabel(a.concept)} & ${conceptLabel(b.concept)}`, concepts: [a.concept, b.concept],
      why: `${pct(a.share)}% ${conceptLabel(a.concept)}, ${pct(b.share)}% ${conceptLabel(b.concept)}` };
  // Tags too thin or too spread: what listening heard, when it heard enough.
  const st = (sound?.styles ?? []).find(s => Array.isArray(s) && s[0] && s[1] >= 0.4);
  if (st) return { text: String(st[0]), concepts: [], why: `${pct(st[1])}% sound like ${st[0]}`, bySound: true };
  if (a && a.share >= 0.3) return { text: `${conceptLabel(a.concept)} & more`, concepts: [a.concept], why: `${pct(a.share)}% ${conceptLabel(a.concept)}, the rest mixed` };
  return null;
}

/** "Chill", "Dark", "High-Energy": from its artists' moods, else its measured energy. */
function qualifier(facts, sound) {
  if (facts?.decade) {
    const d = facts.decade.start;
    return { text: d < 2000 ? `${String(d).slice(2)}s` : `${d}s`, why: `${pct(facts.decade.share)}% released in the ${d}s` };
  }
  if (facts?.mood && MOOD_WORDS[facts.mood.concept]) return { text: MOOD_WORDS[facts.mood.concept], why: `${pct(facts.mood.share)}% by artists tagged ${MOOD_WORDS[facts.mood.concept].toLowerCase()}` };
  const en = sound?.energy;
  if (Array.isArray(en) && en.length === 2 && en.every(Number.isFinite)) {
    if (Math.max(...en) <= 0.4) return { text: 'Chill', why: 'low energy, as heard' };
    if (Math.min(...en) >= 0.6) return { text: 'High-Energy', why: 'high energy, as heard' };
  }
  return null;
}

/** "174 BPM" or "120–126 BPM", from the tempo its heard tracks settle on; null when unknown or too wide to say. */
function tempoPhrase(sound) {
  const b = sound?.bpm;
  const r = Array.isArray(b) ? b : Number.isFinite(b) ? [b, b] : null;
  if (!r || !r.every(x => Number.isFinite(x) && x > 0)) return null;
  const lo = Math.round(Math.min(...r)), hi = Math.round(Math.max(...r));
  if (hi - lo > 12) return null;
  return lo === hi ? `${lo} BPM` : `${lo}–${hi} BPM`;
}

const clip = s => String(s).trim().slice(0, NAME_MAX).trim();

/**
 * Up to four names for one playlist, best first, each with why.
 *
 * For a name that is the listener's own, the first suggestion keeps it and adds
 * what is in it ("Sunday · Chill Soul"): their word for it stays. For a vague
 * name ("My Playlist #7") the suggestions replace it. A name that already says
 * its main genre is marked `fits` and its suggestions only add a qualifier.
 *
 * @param {string} current  the playlist's name now
 * @param {ReturnType<describeTracks>} facts
 * @param {{ styles?, bpm?, energy? }|null} sound  the playlist's sound profile, if heard
 * @param {ReturnType<nameStyle>} style
 * @returns {{ names:{name:string, why:string}[], vague:boolean, fits:boolean, says:string|null, misleading:string|null }}
 */
export function suggestNames(current, facts, sound = null, style = {}) {
  const name = String(current ?? '').trim();
  const vague = isVagueName(name);
  const none = { names: [], vague, fits: false, says: null, misleading: null };
  const enough = (facts?.tagged ?? 0) >= MIN_TAGGED || (sound?.styles?.length ?? 0) > 0;
  if (!enough) return none;
  const core = corePhrase(facts, sound);
  const q = qualifier(facts, sound);
  const bpm = tempoPhrase(sound);
  if (!core && !q) return none;
  const sep = style.sep ?? ' · ';

  // Does the name already say it? Its genres (ontology words in it) against what is in it.
  const said = playlistGenres(name);
  const fits = !!core && core.concepts.length > 0 && core.concepts.some(c => said.some(s => related(s, c)));
  // "Techno" on a playlist that is mostly house: worth a second look, said plainly.
  let misleading = null;
  const top = (facts?.genres ?? [])[0];
  if (said.length && top && top.share >= 0.5 && (facts?.tagged ?? 0) >= 10) {
    const covered = (facts.genres ?? []).filter(x => said.some(s => related(s, x.concept))).reduce((s, x) => s + x.share, 0);
    if (covered < 0.1) misleading = `Its name says ${conceptLabel(said[0])}, but ${pct(top.share)}% is ${conceptLabel(top.concept)}`;
  }

  const out = [];
  // `keep` is the listener's own words, left exactly as written; only what is
  // added is written in their style.
  const add = (text, why, keep = '') => {
    const s = clip(keep ? `${keep}${sep}${styled(text, style)}` : styled(text, style));
    if (!s || s.toLowerCase() === name.toLowerCase() || out.some(x => x.name.toLowerCase() === s.toLowerCase())) return;
    out.push({ name: s, why });
  };
  const coreWhy = core ? core.why : '';
  const full = core && q ? `${q.text} ${core.text}` : core ? core.text : `${q.text} mix`;
  const fullWhy = [q?.why, coreWhy].filter(Boolean).join('; ');
  if (!vague && !fits && core && !misleading) {
    // Keep their word, add what is in it.
    add(full, `keeps your name and adds what's in it: ${fullWhy}`, name);
    if (q) add(core.text, `keeps your name: ${coreWhy}`, name);
  }
  // Already says its genre: offer only the qualifier, in front of their name.
  if (fits && q && !name.toLowerCase().includes(q.text.toLowerCase()))
    out.push(...[{ name: clip(`${styled(q.text, style)} ${name}`), why: q.why }].filter(x => x.name.toLowerCase() !== name.toLowerCase()));
  if (!fits || vague || misleading) {
    add(full, fullWhy);
    if (q && core) add(core.text, coreWhy);
  }
  if (bpm && core) add(fits ? bpm : `${core.text}${sep}${bpm}`, `${fits ? '' : coreWhy + '; '}its tracks settle at ${bpm}`, fits ? name : '');
  return { names: out.slice(0, 4), vague, fits, says: core ? core.text : null, misleading };
}

/**
 * The playlists whose names could say more, for Library: vague names first,
 * then names that say another genre than the one they hold. Each with its best
 * suggestion. `skip(p)` leaves a playlist out (mirrors, dismissed ones).
 */
export function namesToImprove(playlists, factsOf, { soundOf = () => null, style = {}, skip = () => false } = {}) {
  const out = [];
  for (const p of playlists ?? []) {
    if (!p?.id || skip(p) || (p.tracks?.length ?? 0) < MIN_TAGGED) continue;
    const s = suggestNames(p.name, factsOf(p), soundOf(p), style);
    if (!s.names.length || !(s.vague || s.misleading)) continue;
    out.push({ id: p.id, name: p.name, n: p.tracks.length, best: s.names[0], vague: s.vague,
      why: s.vague ? 'name says nothing about what is in it' : s.misleading });
  }
  return out.sort((a, b) => (a.vague === b.vague ? b.n - a.n : a.vague ? -1 : 1));
}
