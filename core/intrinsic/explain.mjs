// Why this bucket, in the account's own terms.
//
// The tag engine can say "cosine 0.71", which is not a reason, and "because
// Last.fm calls this artist tech house", which is somebody else's opinion
// restated. Neither is arguable: a listener who disagrees has nothing to push
// against.
//
// This layer says things the listener can check against their own library:
//
//   sits with Enzo Siragusa and Seb Zito, who are in this bucket 12 times ·
//   same label family as 7 tracks here · seven minutes, like most of this
//   bucket · 2023, and four in five here are from the 2020s
//
// Every clause is a countable fact about their own filing, with no genre word
// anywhere. That matters beyond presentation: an explanation nobody can check
// is also an explanation nobody can correct, and corrections are what the whole
// engine learns from.
import { registrantOf, registrantWeight, formatOf, eraOf } from './features.mjs';
import { trackVector } from './cooccurrence.mjs';

export const EXPLAIN_VERSION = '4.0.0';

/** Marks match the ones `classifyGenre()`'s explanations already use, so a UI
 *  can render both with one component. */
export const MARKS = { strong: '✓', neutral: '·', weak: '!' };

/** Name at most this many artists before summarising the rest. Three is about
 *  where a list stops being read and starts being skimmed. */
export const MAX_NAMED_ARTISTS = 3;

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "seven minutes" reads better than "7.2 minutes" and is just as true at the
 *  resolution anybody cares about. */
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven',
               'eight', 'nine', 'ten', 'eleven', 'twelve'];
const minutesPhrase = m => {
  if (m === null || m === undefined) return null;
  const r = Math.round(m);
  return r <= 12 ? `${WORDS[r]} minutes` : `${r} minutes`;
};

/**
 * The artists this track shares with a bucket, directly or through the graph.
 *
 * Direct credits first, because "this is by someone already in here" is the
 * strongest and most checkable statement available. Graph neighbours second,
 * and labelled differently — "sits with" is a weaker claim than "is by", and
 * blurring them would overstate the evidence.
 */
export function sharedArtists(track, destination, space) {
  const credited = new Set((track?.artists ?? []).map(a => a?.id).filter(Boolean));
  const direct = [], nearby = [];

  for (const id of credited) {
    const row = destination?.artistCounts?.get(id);
    if (row) direct.push({ id, name: row.name ?? id, n: row.n });
  }

  // Neighbourhood: artists in the bucket that the track's own artists co-occur
  // with elsewhere in this library. Excludes the direct hits so nothing is
  // counted twice.
  const vec = trackVector(track, space?.graph);
  for (const [id, weight] of vec) {
    if (credited.has(id)) continue;
    const row = destination?.artistCounts?.get(id);
    if (row) nearby.push({ id, name: row.name ?? id, n: row.n, weight });
  }

  direct.sort((a, b) => b.n - a.n);
  nearby.sort((a, b) => b.weight - a.weight || b.n - a.n);
  return { direct, nearby };
}

const joinNames = names => (names.length > 1
  ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
  : names[0]);

/**
 * A count must refer unambiguously to the artists it is next to.
 *
 * The first version read "sits with A, B and C and 1 more, who are in this
 * bucket 13 times", where 13 counted only the three named — so the sentence
 * claimed something about four artists using a number about three. Now the
 * named ones carry the count and the remainder is stated separately.
 */
const named = rows => {
  const shown = rows.slice(0, MAX_NAMED_ARTISTS);
  const rest = rows.length - shown.length;
  return { list: joinNames(shown.map(r => r.name)),
           n: shown.reduce((s, r) => s + r.n, 0), rest };
};

/** How much more common something is here than across the whole library.
 *  Below this the clause is true of everything and explains nothing. */
export const DISTINGUISHING_LIFT = 0.15;

/**
 * Explain one placement as a list of `{mark, text}` lines.
 *
 * Returns only clauses that are actually true of this pair. A line that would
 * read "0 tracks here share its label" is not an explanation, it is noise, and
 * the absence of a clause already says it.
 */
export function explain(track, destination, space) {
  const out = [];
  if (!track || !destination) return out;

  const { direct, nearby } = sharedArtists(track, destination, space);

  if (direct.length) {
    const d = named(direct);
    out.push({ mark: MARKS.strong,
      text: `by ${d.list}, already here ${plural(d.n, 'time')}`
          + (d.rest ? `, plus ${d.rest} more of its credits` : '') });
  }
  if (nearby.length) {
    const nb = named(nearby);
    out.push({ mark: direct.length ? MARKS.neutral : MARKS.strong,
      text: `sits with ${nb.list}, who appear here ${plural(nb.n, 'time')}`
          + (nb.rest ? `, and ${nb.rest} more of this bucket's artists ${nb.rest === 1 ? 'is' : 'are'} nearby` : '') });
  }

  // Label family. Only worth a line when the registrant actually distinguishes
  // anything — a distributor code shared with half the library explains nothing,
  // and saying it anyway would dress noise up as a reason.
  const reg = registrantOf(track);
  if (reg && registrantWeight(reg, space?.registrants) > 0) {
    const n = destination.registrantCounts?.get(reg) ?? 0;
    if (n > 0) out.push({ mark: MARKS.neutral, text: `same label family as ${plural(n, 'track')} here` });
  }

  // Format. Phrased as a comparison rather than a number, because "seven
  // minutes, like most of this bucket" is checkable and "0.82" is not.
  const f = formatOf(track);
  const mean = destination.profile?.minutes?.mean ?? null;
  const phrase = minutesPhrase(f.minutes);
  if (phrase && mean !== null) {
    const close = Math.abs(f.minutes - mean) <= Math.max(1, (destination.profile.minutes.sd ?? 1));
    out.push({ mark: close ? MARKS.neutral : MARKS.weak,
      text: close ? `${phrase}, like most of this bucket`
                  : `${phrase}, where this bucket averages ${minutesPhrase(mean)}` });
  }

  // Format and era are only worth saying when they *distinguish* this bucket.
  // In a library where every record is a single, "a single, and 100% of this
  // bucket is too" is true, useless, and appears identically under every
  // alternative — which makes the explanation look thorough while helping
  // nobody choose. Compared against the library-wide rate for exactly that
  // reason.
  const base = space?.baseline;
  const typeShare = f.albumType ? (destination.profile?.albumType?.get(f.albumType) ?? 0) : 0;
  const typeBase = f.albumType ? (base?.albumType?.get(f.albumType) ?? 0) : 0;
  if (f.albumType && typeShare >= 0.5 && typeShare - typeBase >= DISTINGUISHING_LIFT) {
    out.push({ mark: MARKS.neutral,
      text: `a ${f.albumType}, and ${Math.round(typeShare * 100)}% of this bucket is too `
          + `against ${Math.round(typeBase * 100)}% across your library` });
  }

  const era = eraOf(track);
  const eraShare = era ? (destination.profile?.era?.get(era) ?? 0) : 0;
  const eraBase = era ? (base?.era?.get(era) ?? 0) : 0;
  if (era && eraShare >= 0.4 && eraShare - eraBase >= DISTINGUISHING_LIFT) {
    out.push({ mark: MARKS.neutral,
      text: `${era}, and so is ${Math.round(eraShare * 100)}% of this bucket `
          + `against ${Math.round(eraBase * 100)}% elsewhere` });
  }

  return out;
}

/** The same thing as one line, for a list row that has no space for four. */
export function summarise(lines) {
  return lines.map(l => l.text).join(' · ');
}
