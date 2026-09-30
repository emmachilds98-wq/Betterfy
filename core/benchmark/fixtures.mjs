// Benchmark fixtures — §26 and Task 10.
//
// §26 asks for ~500 manually reviewed tracks growing to 2,000+. This is not
// that, and says so plainly: it is the seed, and more importantly it is the
// *harness* those 500 will be loaded into, built first so that the reviewing
// has somewhere to go. Every case here is a synthetic reconstruction of a
// failure mode that is real — each one names the shape of library data it
// stands for — rather than a real track's real tags, because real tags cannot
// be committed to a public repo without republishing a third party's data and
// would go stale the next time Last.fm's crowd moved.
//
// Two kinds of case, and both matter (Task 10 asks for both):
//
//   known-good  the right answer is knowable from the evidence, and the
//               engine should find it.
//   known-bad   the evidence is genuinely insufficient or contradictory, and
//               the engine should SAY SO rather than guess. §26 is explicit:
//               do not optimise for "every track gets a label".
//
// The `evidence` field is written in provider-response shape and run through
// the real adapters, so a fixture exercises normalisation, weighting and
// reconciliation rather than hand-built evidence records that could quietly
// stop resembling what a provider sends.

/**
 * @typedef {object} BenchmarkCase
 * @property {string} id
 * @property {string} why                 the real-world failure this stands for
 * @property {object} track               library-track shape
 * @property {object[]} evidence          [{ provider, entityType, entityId, matchedBy, response }]
 * @property {string|null} expectGenre    the correct primary genre, null when there is none
 * @property {string[]} [acceptGenre]     also correct — §26's "acceptable secondary genres"
 * @property {string[]} [expectConfidence] acceptable confidence bands
 * @property {string} [expectMood]
 * @property {string} [expectEra]
 */

const lfm = tags => ({ toptags: { tag: tags.map(([name, count]) => ({ name, count })) } });
const dgs = styles => ({ results: styles.map(s => ({ style: Array.isArray(s) ? s : [s] })) });

const track = (id, name, artists, released = null) => ({
  id, name, released,
  artists: artists.map((n, i) => ({ id: `${id}-a${i}`, name: n })),
});

/** @type {BenchmarkCase[]} */
export const CASES = [
  /* ---------- known-good ---------- */
  {
    id: 'good-corroborated-subgenre',
    why: 'Two independent sources at different specificities agree on a subgenre. '
       + 'The commonest good case, and the one HIGH confidence has to be reserved for.',
    track: track('t-001', 'Pressure', ['Producer One'], '2021-06-01'),
    evidence: [
      { provider: 'lastfm', entityType: 'artist', entityId: 't-001-a0', response: lfm([['tech house', 100], ['house', 70]]) },
      { provider: 'discogs', entityType: 'release', entityId: 'r-001', matchedBy: 'discogs-id', response: dgs([['Tech House'], ['Tech House', 'House']]) },
    ],
    expectGenre: 'tech-house',
    expectConfidence: ['HIGH'],
    expectEra: '2020s',
  },
  {
    id: 'good-track-beats-diverse-artist',
    why: 'The v1 defect this engine exists for: a diverse artist hands the same cloud to every '
       + 'track they made. A track-level answer must win over the artist cloud.',
    track: track('t-002', 'Glass', ['Wide Ranging Artist'], '2018-01-01'),
    evidence: [
      { provider: 'lastfm', entityType: 'artist', entityId: 't-002-a0', response: lfm([['drum and bass', 100], ['jungle', 90], ['breakbeat', 60]]) },
      { provider: 'lastfm', entityType: 'track', entityId: 't-002', matchedBy: 'mbid-recording', response: lfm([['ambient', 100], ['downtempo', 60]]) },
    ],
    expectGenre: 'ambient',
    acceptGenre: ['downtempo'],
    expectConfidence: ['HIGH', 'LIKELY'],
  },
  {
    id: 'good-siblings-resolve-to-parent',
    why: 'Evidence spread evenly over three house subgenres is not an ambiguous track — it is a '
       + 'confident House track. v1 sees three unrelated strings and picks whichever polled highest.',
    track: track('t-003', 'Four Four', ['House Artist'], '2016-01-01'),
    evidence: [
      { provider: 'lastfm', entityType: 'artist', entityId: 't-003-a0', response: lfm([['tech house', 100], ['deep house', 95], ['progressive house', 90]]) },
    ],
    expectGenre: 'house',
    expectConfidence: ['LIKELY', 'HIGH'],
  },
  {
    id: 'good-spelling-variants-are-one-genre',
    why: 'Providers disagree about punctuation constantly and meaninglessly. Three spellings of '
       + 'one genre must not look like three genres splitting the vote.',
    track: track('t-004', 'Rollers', ['Jungle Artist'], '1996-01-01'),
    evidence: [
      { provider: 'lastfm', entityType: 'artist', entityId: 't-004-a0', response: lfm([['dnb', 100], ['drum & bass', 80], ['drum and bass', 60]]) },
      { provider: 'discogs', entityType: 'release', entityId: 'r-004', matchedBy: 'discogs-id', response: dgs([['Drum n Bass'], ['Jungle']]) },
    ],
    expectGenre: 'drum-and-bass',
    acceptGenre: ['jungle'],
    expectConfidence: ['HIGH', 'LIKELY'],
    expectEra: '1990s',
  },
  {
    id: 'good-mood-is-not-genre',
    why: '§4.3: "summer" must not be treated like "House". A cloud that is half mood and occasion '
       + 'words still has one genre in it, and the rest belong on other axes.',
    track: track('t-005', 'Sundown', ['Balearic Artist'], '2014-07-01'),
    evidence: [
      { provider: 'lastfm', entityType: 'artist', entityId: 't-005-a0',
        response: lfm([['deep house', 100], ['chill', 90], ['summer', 85], ['ibiza', 70], ['female vocalists', 60]]) },
    ],
    expectGenre: 'deep-house',
    acceptGenre: ['house'],
    expectMood: 'relaxed',
    expectEra: '2010s',
  },
  {
    id: 'good-release-style-outranks-thin-artist',
    why: '§7: Discogs is not a fallback. A dozen agreeing release styles beat one thin, '
       + 'autocorrected artist tag, which is exactly the case v1 gets backwards.',
    track: track('t-006', 'Basement', ['Ambiguously Named Act'], '2005-01-01'),
    evidence: [
      { provider: 'lastfm', entityType: 'artist', entityId: 't-006-a0', response: lfm([['pop', 100]]) },
      { provider: 'discogs', entityType: 'release', entityId: 'r-006', matchedBy: 'discogs-id',
        response: dgs([['Techno'], ['Techno'], ['Minimal Techno'], ['Techno'], ['Minimal Techno']]) },
    ],
    expectGenre: 'techno',
    acceptGenre: ['minimal-techno'],
  },
  {
    id: 'good-compound-tag-resolves-to-parent',
    why: 'Last.fm is full of "dark techno", "melodic dubstep", "deep dnb". Discarding them as '
       + 'unknown throws away most of a real cloud; they are shades of a genre we do know.',
    track: track('t-007', 'Nightshift', ['Techno Artist'], '2022-01-01'),
    evidence: [
      { provider: 'lastfm', entityType: 'artist', entityId: 't-007-a0', response: lfm([['dark techno', 100], ['hypnotic techno', 80]]) },
    ],
    expectGenre: 'techno',
    expectConfidence: ['LIKELY', 'HIGH'],
  },

  /* ---------- known-bad: the engine should decline ---------- */
  {
    id: 'bad-no-evidence-at-all',
    why: 'An artist no source has anything on. v1 returns an empty ranking, which reads downstream '
       + 'as "no suggestion"; v3 must distinguish that from "we looked and it is genuinely unclear".',
    track: track('t-100', 'Untitled', ['Nobody Has Tagged This'], null),
    evidence: [],
    expectGenre: null,
    expectConfidence: ['INSUFFICIENT_DATA'],
  },
  {
    id: 'bad-only-junk-tags',
    why: 'A cloud made entirely of collection cruft. There is no genre here and the engine must '
       + 'not manufacture one from "seen live".',
    track: track('t-101', 'Filler', ['Personally Tagged Artist'], null),
    evidence: [
      { provider: 'lastfm', entityType: 'artist', entityId: 't-101-a0',
        response: lfm([['seen live', 100], ['albums i own', 80], ['favourites', 70], ['my music', 60]]) },
    ],
    expectGenre: null,
    expectConfidence: ['INSUFFICIENT_DATA'],
  },
  {
    id: 'bad-genuine-cross-branch-disagreement',
    why: 'Two comparably-weighted sources from unrelated branches. §4.6: this is a valid result, '
       + 'not a tie to be broken. Forcing one is how a confidently wrong misfile gets made.',
    track: track('t-102', 'Crossover', ['Two Scenes At Once'], '2019-01-01'),
    evidence: [
      { provider: 'lastfm', entityType: 'artist', entityId: 't-102-a0', response: lfm([['techno', 100]]) },
      { provider: 'shared-tags', entityType: 'artist', entityId: 't-102-a0', response: lfm([['hip hop', 100]]) },
    ],
    expectGenre: null,          // any single answer here is a guess
    acceptGenre: ['techno', 'hip-hop'],
    expectConfidence: ['AMBIGUOUS'],
  },
  {
    id: 'bad-mood-only-cloud',
    why: 'A cloud of pure mood words. There is a real mood answer and no genre answer, and the '
       + 'engine must return the first without inventing the second.',
    track: track('t-103', 'Drift', ['Mood Tagged Artist'], null),
    evidence: [
      { provider: 'lastfm', entityType: 'artist', entityId: 't-103-a0',
        response: lfm([['melancholic', 100], ['sad', 90], ['emotional', 70]]) },
    ],
    expectGenre: null,
    expectConfidence: ['INSUFFICIENT_DATA'],
    expectMood: 'melancholic',
  },
  {
    id: 'bad-unknown-concepts-are-kept',
    why: '§8 and §41.13: an unfamiliar tag is retained as a candidate concept, never silently '
       + 'dropped. This is the mechanism by which the ontology grows from real libraries.',
    track: track('t-104', 'Outlier', ['Niche Scene Artist'], null),
    evidence: [
      { provider: 'lastfm', entityType: 'artist', entityId: 't-104-a0',
        response: lfm([['hard groove', 100], ['schranz', 80], ['funky tekno', 60]]) },
    ],
    expectGenre: null,
    expectConfidence: ['INSUFFICIENT_DATA', 'LIKELY'],
    expectUnknown: ['hard groove', 'schranz'],
  },
];

/** Split for reporting: the two halves are judged on opposite things. */
export const KNOWN_GOOD = CASES.filter(c => c.expectGenre !== null);
export const KNOWN_BAD = CASES.filter(c => c.expectGenre === null);
