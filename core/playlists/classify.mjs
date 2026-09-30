// What a playlist actually is — §15.
//
// Two rules shape this, and both are corrections to v1.
//
// §14: "Do not classify playlists purely from their names." v1 does, with a
// content fallback only when the name says nothing at all. Here the name is
// one source of evidence among four — name, dates, content, structure — and a
// name can be outvoted.
//
// §15: "A playlist can have multiple dimensions without being incorrectly
// labelled as one genre." So the output is a list of dimensions with a
// dominant one, not a single label. "Summer 2026" is an era and a context;
// picking one of those is wrong either way.
//
// And §34: what the playlist is *called* is reported separately from what the
// music inside it actually represents, always, because the interesting
// playlists are exactly the ones where those differ.
import { entropy } from './fingerprint.mjs';
import { clusterVerdict } from './clustering.mjs';
import { readName } from './name.mjs';
import { GENRE_INDEX } from '../ontology/index.mjs';
import { CONFIDENCE } from '../analysis/classify.mjs';

export const PLAYLIST_CLASSIFIER_VERSION = '3.0.0';

/** §15's type vocabulary, plus INBOX which v1 already needed. */
export const TYPES = ['GENRE', 'SUBGENRE', 'MOOD', 'OCCASION', 'EVENT', 'ERA',
                      'ARTIST', 'DJ_SET', 'MIXED', 'HYBRID', 'INBOX', 'UNKNOWN'];

export const THRESHOLDS = {
  // Built in one sitting and left alone. The vocabulary-free event signal,
  // carried over from v1's addedShape() where it is the one content rule that
  // held up. Both halves are needed: "added in one go" alone catches a
  // playlist somebody built last week, which is what a new listener does.
  EVENT_SPAN_DAYS: 4,
  EVENT_SETTLED_DAYS: 45,
  // One artist dominating. A compilation of one producer's records is an
  // artist playlist however its name reads.
  ARTIST_CONCENTRATION: 0.55,
  // Content lift, read against the listener's own library rather than a fixed
  // share — the reasoning v1 already arrived at and the only part of its
  // content rule that generalises.
  CONTENT_LIFT: 1.8,
  CONTENT_MIN_SHARE: 0.10,
  // A playlist whose genre weight is spread this evenly is not one genre.
  MIXED_ENTROPY: 0.80,
  // How much a perfectly uniform playlist strengthens its own genre claim
  // over an evenly-spread one.
  COHERENCE_BONUS: 0.45,
  // Two dimensions this close together make a hybrid rather than a winner.
  HYBRID_MARGIN: 0.80,
  // Filing destinations, carried over from v1 unchanged: a centroid built
  // from a handful of tracks matches almost anything.
  MIN_FOR_TARGET: 12,
};

/**
 * Which type each dimension kind argues for.
 *
 * Note there is no 'subgenre' kind. GENRE and SUBGENRE are one dimension at
 * two resolutions, not two competing claims — scoring them separately made
 * every coherent genre playlist a HYBRID of itself, since the name said
 * "genre: tech-house" and the tracks said "subgenre: tech-house". Which of
 * the two a playlist is gets read off the winning value's depth at the end.
 */
const TYPE_OF_KIND = {
  genre: 'GENRE', mood: 'MOOD', context: 'OCCASION',
  event: 'EVENT', era: 'ERA', artist: 'ARTIST', djset: 'DJ_SET',
  mixed: 'MIXED', inbox: 'INBOX',
};

/**
 * The library's own average distribution per facet — the baseline every
 * playlist is read against, so "28% mood" means something. Taken over
 * fingerprints rather than raw tracks, and skipping any mirror playlist,
 * which holds a copy of the whole library by construction and would count it
 * twice.
 */
export function libraryBaseline(fingerprints, { isMirror = () => false } = {}) {
  const totals = { mood: new Map(), context: new Map(), era: new Map() };
  let n = 0;
  for (const fp of fingerprints.values ? fingerprints.values() : fingerprints) {
    if (!fp?.enoughToDescribe || isMirror(fp)) continue;
    n++;
    for (const facet of ['mood', 'context', 'era'])
      for (const [k, v] of Object.entries(fp[facet] ?? {}))
        totals[facet].set(k, (totals[facet].get(k) ?? 0) + v);
  }
  const out = { playlists: n };
  for (const facet of ['mood', 'context', 'era']) {
    const sum = [...totals[facet].values()].reduce((a, b) => a + b, 0);
    // The share of all facet weight this facet's strongest concepts carry, per
    // playlist — the number a single playlist's share is compared against.
    out[facet] = n ? Object.fromEntries([...totals[facet]].map(([k, v]) => [k, v / n])) : {};
    out[`${facet}Total`] = n ? sum / n : 0;
  }
  return out;
}

const lift = (share, base) => (base > 0 ? share / base : (share > 0 ? Infinity : 0));

/**
 * Classify one playlist.
 *
 * @param {object} fp                fingerprint()
 * @param {object} opts
 * @param {object[]} [opts.clusters] clusterTracks() output
 * @param {object} [opts.baseline]   libraryBaseline()
 * @param {Set<string>} [opts.knownArtists]
 * @param {boolean} [opts.isMirror]
 */
export function classifyPlaylist(fp, { clusters = [], baseline = null, knownArtists = null,
                                       isMirror = false, now = Date.now() } = {}) {
  const name = readName(fp?.name ?? '', { knownArtists });
  const scores = new Map();
  const bump = (kind, value, score, why, from) => {
    const cur = scores.get(kind) ?? { kind, score: 0, values: new Map(), why: [] };
    cur.score += score;
    if (value) cur.values.set(value, (cur.values.get(value) ?? 0) + score);
    cur.why.push({ from, why, score: +score.toFixed(2) });
    scores.set(kind, cur);
  };

  /* ---- 1. the name ---- */
  for (const d of name.dimensions) bump(d.kind, d.value, d.confidence, d.why, 'name');

  /* ---- 2. structure: when it was built ---- */
  const shape = fp?.added;
  if (shape && shape.spanDays <= THRESHOLDS.EVENT_SPAN_DAYS && shape.sinceDays >= THRESHOLDS.EVENT_SETTLED_DAYS)
    bump('event', null, 0.9,
      `built in ${shape.spanDays < 1 ? 'a day' : Math.round(shape.spanDays) + ' days'} and untouched for `
      + `${Math.round(shape.sinceDays)} days`, 'structure');

  /* ---- 3. structure: whose records are in it ---- */
  const conc = fp?.artists?.concentration ?? 0;
  if (conc >= THRESHOLDS.ARTIST_CONCENTRATION && (fp?.tracks ?? 0) >= 5) {
    const top = fp.artists.top[0];
    bump('artist', top?.name ?? null, 0.85,
      `${Math.round((top?.share ?? 0) * 100)}% of it is ${top?.name ?? 'one artist'}`, 'structure');
  }

  /* ---- 4. content: what the music in it actually is ---- */
  if (fp?.enoughToDescribe) {
    // Genre, from the tracks rather than the title. A subgenre is only
    // claimed when the playlist really does sit at that level — a bucket
    // spread over three house subgenres is a House playlist (the same
    // reconciliation the track classifier does, one level up).
    const primary = fp.primaryGenre;
    if (primary) {
      const share = fp.primaryGenres[primary] ?? fp.genre[primary] ?? 0;
      const tight = fp.genreEntropy < THRESHOLDS.MIXED_ENTROPY;
      // How strong the claim is depends on how much of one thing the playlist
      // actually is, and on how sure the engine was about the tracks it is
      // reading. A uniform bucket of confident answers is the strongest
      // content evidence there is; the same shape built from AMBIGUOUS tracks
      // is not evidence of anything.
      const uniform = 1 + (1 - fp.genreEntropy) * THRESHOLDS.COHERENCE_BONUS;
      const score = (tight ? 0.7 : 0.4) * uniform * Math.max(0.3, fp.confidentShare ?? 1);
      bump('genre', primary, score,
        (tight
          ? `${Math.round(share * 100)}% of its tracks classify as ${primary}`
          : `its tracks spread across several genres, leading with ${primary}`)
        + ((fp.confidentShare ?? 1) < 0.6
          ? `, though only ${Math.round((fp.confidentShare ?? 0) * 100)}% of them confidently` : ''),
        'content');
    }
    // Mood / context / era, by lift against this listener's own library.
    for (const [facet, kind] of [['mood', 'mood'], ['context', 'context'], ['era', 'era']]) {
      const dist = fp[facet] ?? {};
      for (const [concept, share] of Object.entries(dist).slice(0, 2)) {
        if (share < THRESHOLDS.CONTENT_MIN_SHARE) continue;
        const l = lift(share, baseline?.[facet]?.[concept] ?? 0);
        if (l < THRESHOLDS.CONTENT_LIFT) continue;
        bump(kind, concept, 0.6,
          `${Math.round(share * 100)}% ${concept}, against ${Math.round((baseline?.[facet]?.[concept] ?? 0) * 100)}% across your library`,
          'content');
      }
    }
    // Several comparable musical regions: a real answer, not a tie to break.
    const verdict = clusterVerdict(clusters);
    if (verdict.shape === 'mixed')
      bump('mixed', null, 0.65,
        `${verdict.regions} distinct musical regions, the largest only ${Math.round(verdict.dominantShare * 100)}%`,
        'content');
    else if (fp.genreEntropy >= THRESHOLDS.MIXED_ENTROPY)
      bump('mixed', null, 0.5,
        `its tracks are spread evenly across ${Object.keys(fp.primaryGenres).length} genres`, 'content');
  }

  /* ---- decide ----
   *
   * The type is how a playlist is ORGANISED; the musical identity below is
   * what it is MADE OF. Keeping those apart is the whole of §34, and it is
   * also what makes the decision tractable, because every playlist is made
   * of some genre and mood — those claims are present for all of them and so
   * discriminate between none.
   *
   * So evidence is ranked in two tiers. Anything the name or the structure
   * claimed (a title, a date, a burst of additions, one artist dominating)
   * says how the listener organised it. Anything only the tracks claimed
   * says what went in. A content claim decides the type only when nothing
   * organisational speaks at all — which is exactly the case v1 needs a
   * hand-written OVERRIDE table for, and gets wrong for every other account.
   *
   * Note this does NOT let a name overrule the music about the genre's
   * *value*: a playlist called "Tech House" that is full of jungle is still
   * a genre playlist, just a mislabelled one, and nameVsMusic() reports the
   * disagreement rather than either side silently winning. */
  const organisational = d => d.why.some(w => w.from === 'name' || w.from === 'structure');
  const byScore = (a, b) => b.score - a.score || a.kind.localeCompare(b.kind);
  const all = [...scores.values()].sort(byScore);
  const tier1 = all.filter(organisational);
  const deciding = tier1.length ? tier1 : all;
  const ranked = [...deciding, ...all.filter(d => !deciding.includes(d))];
  const top = deciding[0] ?? null;
  const runner = deciding[1] ?? null;

  const valueOf = d => d && d.values.size
    ? [...d.values].sort((a, b) => b[1] - a[1])[0][0] : null;

  let type = top ? (TYPE_OF_KIND[top.kind] ?? 'UNKNOWN') : 'UNKNOWN';
  // A genre playlist that sits at a subgenre level is a SUBGENRE playlist.
  // Read off the answer rather than competed for, per TYPE_OF_KIND above.
  if (type === 'GENRE' && GENRE_INDEX.get(valueOf(top))?.parent) type = 'SUBGENRE';
  // Two comparable dimensions from the same tier is a hybrid, and saying so
  // is more useful than picking one — "Summer 2026" is an era AND a context.
  // 'mixed' is a verdict about how the genre dimension is spread, not a
  // dimension that can pair with another one: "mixed AND 1990s" is not a
  // hybrid, it is a mixed playlist that happens to lean old. It can win
  // outright; it never forms a hybrid.
  const pairable = d => d && d.kind !== 'mixed' && top.kind !== 'mixed';
  const hybrid = !!(runner && pairable(runner) && runner.score >= THRESHOLDS.HYBRID_MARGIN * top.score);
  if (hybrid && type !== 'INBOX') type = 'HYBRID';
  const hybridOf = hybrid ? [top.kind, runner.kind] : null;

  const dimensions = ranked.map(d => ({
    kind: d.kind,
    value: valueOf(d),
    score: +d.score.toFixed(3),
    // Whether this dimension says how the playlist was organised, or only
    // what went into it. The UI needs the difference as much as the engine.
    from: organisational(d) ? 'organisation' : 'content',
    why: d.why,
  }));

  const confidence =
    !top ? CONFIDENCE.INSUFFICIENT_DATA
    : top.score >= 1.4 && !hybrid ? CONFIDENCE.HIGH
    : hybrid ? CONFIDENCE.AMBIGUOUS
    : top.score >= 0.7 ? CONFIDENCE.LIKELY
    : CONFIDENCE.AMBIGUOUS;

  // §34: reported always and separately, because the playlists worth looking
  // at are the ones where the name and the music disagree.
  const musicalIdentity = {
    primary: fp?.primaryGenre ?? null,
    secondary: Object.keys(fp?.genre ?? {}).slice(1, 3),
    shape: clusterVerdict(clusters).shape,
    clusters: clusters.map(c => ({ genre: c.genre, share: c.share })),
    coherence: fp?.coherence ?? 0,
    entropy: fp?.genreEntropy ?? 0,
    mood: Object.keys(fp?.mood ?? {})[0] ?? null,
    era: Object.keys(fp?.era ?? {})[0] ?? null,
  };

  return {
    id: fp?.id ?? null,
    name: fp?.name ?? '',
    type,
    ...(hybridOf ? { hybridOf } : {}),
    dimensions,
    primaryDimension: top ? { kind: top.kind, value: valueOf(top) } : null,
    confidence,
    nameSaid: name.dimensions.map(d => ({ kind: d.kind, value: d.value })),
    nameSilent: name.silent,
    musicalIdentity,
    // Only genre and mood buckets take filing suggestions, and only above the
    // size gate. Unchanged from v1 in effect; the difference is that the axis
    // behind it was reached from four kinds of evidence rather than a regex.
    //
    // Read from the leading dimension rather than the composite type, so a
    // playlist that is a genuine HYBRID of two axes is still a filing
    // destination when the axis it leads on is one that takes suggestions.
    isTarget: ['genre', 'mood'].includes(top?.kind)
      && (fp?.tracks ?? 0) >= THRESHOLDS.MIN_FOR_TARGET
      && !isMirror,
    version: PLAYLIST_CLASSIFIER_VERSION,
  };
}
