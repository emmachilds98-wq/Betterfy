// What a playlist's name says — §14's "extract semantic clues".
//
// The hard constraint here is the one v1 fails. axes.mjs reads playlist names
// through a regex naming Drumsheds, Fabric, Printworks and E1, plus an
// OVERRIDE table of one person's exact playlist titles. That is a excellent
// classifier for one library and worth nothing for the next account, which is
// the opposite of what this project needs.
//
// So nothing here names a venue, a festival or a playlist. Two things are
// read instead, and both are universal:
//
//  1. The ontology. A name's words go through the same resolveConcept() every
//     provider tag does, so "Deep House Vibes" yields a genre and a mood from
//     a global vocabulary rather than from a list somebody maintained.
//  2. Structure. A date is a date in every library; "vol. 2" and "b2b" are
//     DJ-set words everywhere; a qualifier after a dash is a variant marker
//     whatever the words either side happen to be. An event is recognised by
//     *shape* — a name with a date in it and words the ontology does not know
//     — because the unknown word is exactly the venue we cannot enumerate.
//
// Artists are the third universal source, and they come from the listener's
// own library rather than from this module (see `knownArtists`).
import { resolveConcept } from '../ontology/index.mjs';

export const NAME_VERSION = '3.0.0';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
                'august', 'september', 'october', 'november', 'december'];
const MONTH_RE = new RegExp(`\\b(${MONTHS.map(m => `${m}|${m.slice(0, 3)}`).join('|')})\\.?\\b`, 'i');
const YEAR_RE = /\b(19|20)\d{2}\b/;
const SHORT_YEAR_RE = /\b'\d{2}\b/;
const NUMERIC_DATE_RE = /\b\d{1,2}[./\-]\d{1,2}(?:[./\-]\d{2,4})?\b/;
const SEASON_RE = /\b(spring|summer|autumn|fall|winter)\b/i;

// DJ-set vocabulary. These are words about the *form* of a collection, not
// about music, and they mean the same thing in every language community that
// uses them — unlike a venue name.
const DJSET_RE = /\b(mix|mixtape|set|setlist|b2b|back to back|vol\.?|volume|pt\.?|part|live at|recorded|rekordbox|promo|warm ?up|closing|opening)\b|\b\d{2,3}\s?bpm\b/i;

// An inflow, not a destination. Every one of these is a Spotify-generated
// playlist name or a near-universal convention, so unlike a venue list this
// does generalise — these exact strings appear in millions of accounts.
const INBOX_RE = /^(discover weekly|release radar|on repeat|repeat rewind|daily mix|your top songs|new music friday|you may have missed|time capsule|inbox|liked (songs )?from radio)\b|\bshazam\b|^to (sort|file|listen)\b/i;

/** Variant markers: "Tech House — Favourites", "Jungle (old)", "Techno: new". */
const SEPARATOR_RE = /\s*[—–\-:|/]+\s*|\s*[(\[]/;

const words = s => String(s ?? '').toLowerCase().split(/[^a-z0-9'&]+/i).filter(Boolean);

/**
 * Every concept the ontology can find in a name, longest phrase first.
 *
 * Longest-first matters: "deep house" must win over "house", and "drum and
 * bass" over "bass". Once a phrase matches, its words are consumed so the
 * same ground is not claimed twice.
 */
export function conceptsIn(name, { maxPhrase = 4 } = {}) {
  const w = words(name);
  const taken = new Array(w.length).fill(false);
  const found = [];
  for (let len = Math.min(maxPhrase, w.length); len >= 1; len--) {
    for (let i = 0; i + len <= w.length; i++) {
      if (taken.slice(i, i + len).some(Boolean)) continue;
      const phrase = w.slice(i, i + len).join(' ');
      const c = resolveConcept(phrase);
      if (!c.concept) continue;
      // A suffix match ("nostalgia rock" -> rock) is rejected at phrase
      // length, not accepted: taking it would consume "nostalgia" as part of
      // a genre and lose the era the name is actually carrying. Left alone,
      // the shorter passes below find both halves — which for a playlist
      // NAME is the right reading, since "Dark Techno" really is a techno
      // playlist with a mood qualifier. (Inside a provider's tag cloud the
      // opposite is true, which is why resolveConcept still offers it.)
      if (c.via === 'suffix') continue;
      for (let k = i; k < i + len; k++) taken[k] = true;
      found.push({ ...c, phrase, at: i, length: len });
    }
  }
  return found.sort((a, b) => a.at - b.at);
}

/** The date-ish material in a name, if any. */
export function datesIn(name) {
  const s = String(name ?? '');
  const year = s.match(YEAR_RE)?.[0] ?? null;
  const out = {
    year: year ? Number(year) : null,
    shortYear: SHORT_YEAR_RE.test(s),
    month: s.match(MONTH_RE)?.[0]?.toLowerCase() ?? null,
    numeric: s.match(NUMERIC_DATE_RE)?.[0] ?? null,
    season: s.match(SEASON_RE)?.[0]?.toLowerCase() ?? null,
  };
  out.any = !!(out.year || out.shortYear || out.month || out.numeric || out.season);
  // A year on its own is an era ("1994", "2010s"); a year with a month or a
  // day is an occasion ("Fabric September 2026", "12.04 Warehouse").
  out.specific = !!(out.month || out.numeric);
  return out;
}

/**
 * The words in a name that nothing could account for — not a concept, not a
 * date, not set vocabulary, not a known artist.
 *
 * This is the signal that stands in for a venue list. A name carrying a date
 * and a word the ontology has never heard of is the universal shape of
 * "Fabric September 2026", and it stays that shape for a club in Seoul that
 * no hand-written regex would ever have contained.
 */
export function unaccountedWords(name, { concepts = [], knownArtists = null } = {}) {
  const claimed = new Set(concepts.flatMap(c => c.phrase.split(' ')));
  const s = String(name ?? '');
  return words(name).filter(w =>
    !claimed.has(w)
    && w.length > 2
    && !DJSET_RE.test(w)
    && !YEAR_RE.test(w)
    && !MONTH_RE.test(w)
    && !SEASON_RE.test(w)
    && !/^\d+$/.test(w)
    && !(knownArtists?.has?.(w)));
}

/**
 * Split a name into a base and a qualifier: "Tech House — Favourites" ->
 * { base: "Tech House", qualifier: "Favourites" }. §19's "views of a parent
 * collection" is detected from these, not from the words in them.
 */
export function splitQualifier(name) {
  const s = String(name ?? '').trim();
  const m = s.split(SEPARATOR_RE);
  if (m.length < 2 || !m[0]?.trim()) return { base: s, qualifier: null };
  const qualifier = m.slice(1).join(' ').replace(/[)\]]/g, '').trim();
  return { base: m[0].trim(), qualifier: qualifier || null };
}

/**
 * Everything a name has to say, as dimensions rather than one verdict.
 *
 * §15: a playlist can carry several dimensions without being wrongly labelled
 * as one genre. "Summer 2026" is an era and a context; saying it is one or
 * the other is a lie either way. So this returns them all and lets the
 * classifier weigh them against what the tracks actually are.
 *
 * @param {string} name
 * @param {{knownArtists?: Set<string>}} [opts] lowercased artist names from
 *   the listener's own library — universal, since every account has one.
 */
export function readName(name, { knownArtists = null } = {}) {
  const raw = String(name ?? '').trim();
  const concepts = conceptsIn(raw);
  const dates = datesIn(raw);
  const { base, qualifier } = splitQualifier(raw);
  const unaccounted = unaccountedWords(raw, { concepts, knownArtists });

  const byFacet = f => concepts.filter(c => c.facet === f).map(c => c.concept);
  const dimensions = [];
  const add = (kind, value, confidence, why) => dimensions.push({ kind, value, confidence, why });

  if (INBOX_RE.test(raw)) add('inbox', null, 0.95, 'a generated or staging playlist name');

  for (const g of byFacet('genre')) add('genre', g, 0.8, `"${g}" in the name`);
  for (const m of byFacet('mood')) add('mood', m, 0.7, `"${m}" in the name`);
  for (const c of byFacet('context')) add('context', c, 0.7, `"${c}" in the name`);
  for (const e of byFacet('era')) add('era', e, 0.75, `"${e}" in the name`);

  // Only when no era concept already covered it — "Summer 2026" should not
  // report both "2020s" and "2026" as separate era claims.
  if (dates.year && !dates.specific && !byFacet('era').length)
    add('era', String(dates.year), 0.6, `the year ${dates.year}`);
  if (DJSET_RE.test(raw)) add('djset', null, 0.7, 'set or mix vocabulary in the name');

  // The event shape: a date, plus at least one word nothing else accounted
  // for. Either half alone is much weaker — "Summer 2026" is a date with no
  // unknown word, "Warehouse" is an unknown word with no date.
  if (dates.any && unaccounted.length)
    add('event', unaccounted.join(' '), dates.specific ? 0.8 : 0.6,
        `a date and "${unaccounted.join(' ')}", which names nothing the ontology knows`);
  else if (dates.specific)
    add('event', null, 0.5, 'a specific date in the name');

  if (knownArtists && unaccounted.length === 0) {
    const artist = words(raw).filter(w => knownArtists.has(w));
    if (artist.length && artist.length === words(raw).filter(w => w.length > 2).length)
      add('artist', artist.join(' '), 0.6, 'the whole name is an artist you own');
  }

  return {
    raw, base, qualifier,
    concepts, dates, unaccounted,
    dimensions,
    // A name that said nothing is a real and common answer, and the caller
    // must be able to tell it from a name that said something weak.
    silent: dimensions.length === 0,
    version: NAME_VERSION,
  };
}
