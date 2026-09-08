// Tag-vector model of the library.
//
// Spotify supplies no genre data any more, so a track's genre signal is the
// union of its artists' Last.fm tags. A playlist is the centroid of its
// members. Tags are IDF-weighted across playlists, otherwise "electronic" —
// which is true of half this library — would dominate every comparison and
// every playlist would look like every other one.
// No imports: this module is bundled verbatim into the browser build by
// build-web.mjs, so it must stay free of anything Node-specific.
// Tag loading lives in tagstore.mjs (Node) and in the web app (fetch).

// Last.fm tags are user-submitted, so they carry personal-collection cruft
// ("funk_add_to_lidarr_batch_26", "albums i own", "seen live"). These describe
// the tagger, not the music, and skew a centroid badly at low tag counts.
const JUNK = /_|^seen live$|^albums? i|^my |^favou?rites?$|^\d+$|^under \d|lidarr|spotify|^check out|^to listen|^love(d)?$|^awesome$|^cool$|^good$|^best|^all$/i;
const usableTag = t => t.length > 1 && t.length < 32 && !JUNK.test(t);

/* ---------- tag facets ----------
 *
 * Last.fm hands back one flat cloud per artist with no type on any of it:
 * "deep house", "chill", "90s", "workout", "female vocalists" and "british"
 * all arrive as the same kind of thing, and until now all counted equally as
 * evidence of what a track *sounds* like. They are not the same kind of thing.
 * Half of them describe how the music feels, when you'd play it, when it came
 * out, or who made it — and mixed into one vector they pull a track toward
 * whichever playlist happens to share its mood or its decade rather than its
 * genre.
 *
 * This is a global vocabulary, not one listener's: everybody's artists are
 * tagged out of the same Last.fm cloud, so a lexicon over that cloud works for
 * an account nobody has tuned for. (Contrast the playlist-name OVERRIDE table
 * in axes.mjs, which is one person's playlist names and generalises to nobody.)
 *
 * Two rules keep it honest:
 *
 *  - Whole tag only, never a substring. "chill" is a mood; "chillstep" and
 *    "chillwave" are genres. The same lesson the playlist-name MOOD regex
 *    learned the hard way, applied to tags.
 *  - When in doubt it stays a genre. A mood word wrongly demoted costs real
 *    genre signal; a genre left alone costs nothing but the status quo. So
 *    ambiguous tags that carry sound with them — "ambient", "psychedelic",
 *    "acoustic", "instrumental", "club", "rave" — are deliberately absent.
 */

/** Lowercase, and treat "feel-good" / "old_school" as "feel good" / "old school". */
const normTag = t => String(t).toLowerCase().trim().replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ');

// How it feels.
const MOOD_TAGS = new Set([
  'chill', 'chilled', 'chillout', 'chill out', 'mellow', 'laid back', 'laidback',
  'relaxing', 'relaxed', 'relax', 'calm', 'calming', 'soothing', 'peaceful', 'serene',
  'soft', 'gentle', 'warm', 'smooth', 'sleepy', 'dreamy', 'ethereal', 'meditative',
  'melancholy', 'melancholic', 'sad', 'sadness', 'bittersweet', 'wistful', 'longing',
  'moody', 'dark', 'darkness', 'gloomy', 'haunting', 'eerie', 'sombre', 'somber',
  'lonely', 'depressing', 'emotional', 'emotive', 'cathartic', 'nostalgic',
  'happy', 'happiness', 'joyful', 'feel good', 'feelgood', 'uplifting', 'upbeat',
  'euphoric', 'euphoria', 'blissful', 'sunny', 'hopeful', 'fun', 'playful',
  'energetic', 'high energy', 'hi energy', 'hype', 'hyped', 'intense', 'aggressive',
  'angry', 'dramatic', 'epic', 'powerful', 'motivational', 'empowering', 'confident',
  'sexy', 'sensual', 'seductive', 'romantic', 'hypnotic', 'trippy',
  'late night', 'groovy',
]);

// When you'd play it.
const OCCASION_TAGS = new Set([
  'party', 'partying', 'house party', 'clubbing', 'pregame', 'pre drinks', 'night out',
  'workout', 'work out', 'gym', 'running', 'jogging', 'exercise', 'fitness', 'yoga',
  'driving', 'road trip', 'roadtrip', 'travel', 'commute',
  'study', 'studying', 'focus', 'concentration', 'background', 'background music',
  'sleep', 'sleeping', 'bedtime', 'shower', 'cooking', 'dinner', 'gaming',
  'summer', 'winter', 'beach', 'poolside', 'bbq', 'barbecue', 'rainy day',
  'christmas', 'xmas', 'halloween', 'wedding', 'birthday', 'new year',
  'festival', 'festivals', 'holiday', 'holidays',
]);

// Who made it, or how you feel about owning it — never what it sounds like.
const DESCRIPTOR_TAGS = new Set([
  'female vocalists', 'female vocalist', 'female vocals', 'female fronted', 'female',
  'male vocalists', 'male vocalist', 'male vocals', 'male',
  'vocal', 'vocals', 'lyrics', 'band', 'bands', 'duo', 'solo', 'producer', 'dj',
  'british', 'english', 'scottish', 'irish', 'welsh', 'american', 'uk', 'usa',
  'german', 'french', 'italian', 'spanish', 'dutch', 'belgian', 'swedish',
  'norwegian', 'danish', 'finnish', 'icelandic', 'polish', 'russian', 'greek',
  'portuguese', 'australian', 'canadian', 'japanese', 'korean', 'chinese',
  'brazilian', 'mexican', 'argentinian', 'indian', 'african', 'european',
  'underground', 'mainstream', 'obscure', 'underrated', 'overrated', 'popular',
  'hipster', 'music', 'songs', 'tracks', 'albums', 'artist', 'artists',
]);

// When it came out. A bare decade or year is the common shape; the words are
// the rest of it. "classic rock" and "old school hip hop" stay genres, because
// only the whole tag is ever matched.
const ERA_TAGS = new Set([
  'oldies', 'old school', 'oldschool', 'classic', 'classics', 'retro', 'nostalgia',
  'throwback', 'vintage', 'contemporary', 'modern', 'new', 'old',
]);
const ERA_SHAPE = /^(the )?((19|20)?\d0s|(19|20)\d{2})$/;

/**
 * Which kind of thing a tag is: 'genre' (the default and the fallback),
 * 'mood', 'era', 'occasion' or 'descriptor'.
 */
export function tagFacet(tag) {
  const t = normTag(tag);
  if (MOOD_TAGS.has(t)) return 'mood';
  if (OCCASION_TAGS.has(t)) return 'occasion';
  if (ERA_TAGS.has(t) || ERA_SHAPE.test(t)) return 'era';
  if (DESCRIPTOR_TAGS.has(t)) return 'descriptor';
  return 'genre';
}

/**
 * How much each kind of tag counts when the question is "does this belong in
 * that playlist" — per axis, because the question is a different one on each.
 *
 * A genre bucket wants sound and almost nothing else: two tracks both tagged
 * "chill" and "90s" are not the same genre, and that coincidence used to score
 * as if they were. A mood bucket is the mirror image — it wants feel first,
 * with genre kept at a real weight underneath, because most artists carry only
 * a tag or two of mood and a mood centroid built from those alone would be
 * noise. Nothing is ever dropped to zero: an artist with no mood tags at all
 * still scores, just on what it does have.
 *
 * Axes that receive no suggestions (era, event, DJ set, context, inbox) never
 * reach this — nothing is ranked against them.
 */
export const FACET_WEIGHTS = {
  genre: { genre: 1,    mood: 0.15, occasion: 0.1, era: 0.3,  descriptor: 0.1 },
  mood:  { genre: 0.45, mood: 1,    occasion: 0.6, era: 0.15, descriptor: 0.1 },
};

/**
 * Re-weigh an already-built tag vector for one axis. Split out from axisVec so
 * a caller that needs the flat vector anyway — to count how much signal a
 * track carries at all — pays for trackVec once rather than twice.
 */
export function weighFacets(v, axis = null) {
  const w = FACET_WEIGHTS[axis];
  if (!w) return v;
  const out = new Map();
  for (const [tag, x] of v) {
    const s = x * (w[tagFacet(tag)] ?? 1);
    if (s > 0) out.set(tag, s);
  }
  return out;
}

/**
 * A track's tag vector as the given axis reads it. With no axis (or one that
 * takes no suggestions) this is exactly trackVec — the old behaviour, so
 * nothing that never had an axis to begin with changes.
 */
export function axisVec(track, tags, axis = null) {
  return weighFacets(trackVec(track, tags), axis);
}

/**
 * What a playlist is *made of*, as fractions of its total tag weight per
 * facet — the content half of "is this a genre playlist or a mood playlist".
 *
 * Note this is not the tag-coherence signal that was tried and rejected (see
 * the note above classify() in the browser build). Coherence asked how tightly
 * a playlist's tags agree with each other, and genre and mood playlists scored
 * indistinguishably because it really measures how broad a playlist is. This
 * asks a different question — which *kind* of tag the playlist is held
 * together by — and a playlist whose distinctive tags are moods is a mood
 * playlist whether it is broad or narrow.
 *
 * Weighted by IDF when a table is supplied, so "electronic" on every track
 * does not outvote the handful of tags that actually characterise the bucket.
 */
export function facetMix(tracks, tags, idf = null) {
  const total = new Map();
  let n = 0;
  for (const t of tracks ?? []) {
    const v = idf ? applyIdf(trackVec(t, tags), idf) : trackVec(t, tags);
    if (!v.size) continue;
    n++;
    for (const [tag, x] of v) {
      const f = tagFacet(tag);
      total.set(f, (total.get(f) ?? 0) + x);
    }
  }
  const sum = [...total.values()].reduce((a, b) => a + b, 0);
  const mix = { genre: 0, mood: 0, era: 0, occasion: 0, descriptor: 0, tracks: n };
  if (!sum) return mix;
  for (const [f, x] of total) mix[f] = x / sum;
  return mix;
}

// How many tags a Last.fm answer needs before it's trusted at full strength.
// An artist autocorrected onto with one tag just over the count>=10 floor is
// not "sure of one genre" — it is one crowd-tagger, and used to be weighted
// identically to an artist with fifteen tags at 80-100. Below this floor,
// trust scales down with how little there actually is (down to a third at a
// single tag) rather than snapping to all-or-nothing; at or above it, nothing
// changes from before this existed. Chosen to match REASK_TAG_FLOOR in
// cache.mjs — the same tag count that made an empty-ish answer worth asking
// Last.fm about again is the one this model stops fully trusting.
const CONFIDENT_TAG_COUNT = 3;
const confidenceOf = entry => Math.min(1, (entry.tags?.length ?? 0) / CONFIDENT_TAG_COUNT);

// A featured or "with" credit colours a track; it does not define its sound
// the way the primary, first-billed artist does. Spotify lists credited
// artists in billing order, so only the credit *position* decides this — never
// which artist happens to have the stronger Last.fm following, or a well-
// tagged guest vocalist would outvote the actual producer on their own track.
const FEATURE_CREDIT_WEIGHT = 0.5;
const creditWeight = i => i === 0 ? 1 : FEATURE_CREDIT_WEIGHT;

/**
 * Tag weights for one track: each credited, tagged artist's cloud, weighted
 * by billing order and scaled by how much data actually backs it. A single
 * confidently-tagged primary artist scores exactly as it always did — the
 * two effects only diverge from the old flat average on a multi-artist credit
 * or a thin Last.fm answer.
 */
export function trackVec(track, tags) {
  const v = new Map();
  const credited = (track.artists ?? [])
    .map((a, i) => [a, i])
    .filter(([a]) => tags[a.id]?.tags?.length);
  if (!credited.length) return v;
  const totalWeight = credited.reduce((s, [, i]) => s + creditWeight(i), 0);
  for (const [a, i] of credited) {
    const entry = tags[a.id];
    const w = (creditWeight(i) / totalWeight) * confidenceOf(entry);
    for (const [tag, count] of entry.tags) {
      if (!usableTag(tag)) continue;
      v.set(tag, (v.get(tag) ?? 0) + (count / 100) * w);
    }
  }
  return v;
}

/**
 * True when every tagged artist behind a track is below the confidence floor
 * — the suggestion is real, but built on very little Last.fm evidence, which
 * is worth knowing before trusting or dismissing it. A track with no tagged
 * artists at all is a different, already-visible case (no suggestion at all),
 * not this one.
 */
export function isThinSignal(track, tags) {
  const credited = (track.artists ?? []).filter(a => tags[a.id]?.tags?.length);
  if (!credited.length) return false;
  return credited.every(a => (tags[a.id].tags.length) < CONFIDENT_TAG_COUNT);
}

// A tag seen on only one artist in the whole library is indistinguishable, at
// the model level, from a misspelling, a stray scrobble, or a same-named-
// artist mismatch — exactly the "missing/bad data" failure this project has
// no curated genre list to check tags against. Requiring a tag to show up on
// at least this many distinct artists before it can shape a centroid costs
// nothing for a real genre with any following at all — the artists who play
// it share more than one tag — while quietly dropping the ones that are just
// noise from a single bad answer. The real cost: a genuinely one-artist niche
// genre in a small library loses its only distinguishing tag. Kept low
// deliberately, so that cost stays rare.
const TAG_GATE_MIN_ARTISTS = 2;

/**
 * Which tags are trusted enough to shape the model, from a library-wide pass
 * over every artist's tag list: seen on at least `min` distinct artists.
 * Call once per tag set and pass the result to gateTags().
 */
export function tagGate(tags, min = TAG_GATE_MIN_ARTISTS) {
  const byArtists = new Map();
  for (const entry of Object.values(tags)) {
    if (!entry?.tags?.length) continue;
    const seen = new Set(entry.tags.map(([tag]) => String(tag).toLowerCase()));
    for (const t of seen) byArtists.set(t, (byArtists.get(t) ?? 0) + 1);
  }
  const gate = new Set();
  for (const [t, n] of byArtists) if (n >= min) gate.add(t);
  return gate;
}

/** Drop every tag a gate (from tagGate()) doesn't trust, artist by artist. */
export function gateTags(tags, gate) {
  const out = {};
  for (const [id, entry] of Object.entries(tags)) {
    if (!entry?.tags?.length) { out[id] = entry; continue; }
    out[id] = { ...entry, tags: entry.tags.filter(([tag]) => gate.has(String(tag).toLowerCase())) };
  }
  return out;
}

const dot = (a, b) => {
  let s = 0;
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  for (const [k, x] of small) { const y = big.get(k); if (y) s += x * y; }
  return s;
};
const mag = v => Math.sqrt([...v.values()].reduce((s, x) => s + x * x, 0));

export function cosine(a, b) {
  const m = mag(a) * mag(b);
  return m ? dot(a, b) / m : 0;
}

/** Scale a vector by IDF so ubiquitous tags stop drowning out distinctive ones. */
export const applyIdf = (v, idf) => {
  const out = new Map();
  for (const [k, x] of v) out.set(k, x * (idf.get(k) ?? 1));
  return out;
};

/**
 * Build per-playlist centroids plus the IDF table.
 * `targets` limits which playlists are modelled as filing destinations.
 */
export function buildProfiles(lib, tags, targets, axisOf = null) {
  // document frequency: how many playlists contain each tag at all
  const df = new Map();
  const raw = new Map();

  for (const p of lib.playlists) {
    if (targets && !targets.has(p.id)) continue;
    // Built through the axis's own reading of a tag cloud, so a genre bucket's
    // centroid is made of what its tracks sound like and a mood bucket's of
    // what they feel like. rank() weights the track the same way before
    // comparing, and only ever compares within one axis, so both sides of
    // every cosine are on the same scale.
    const axis = axisOf ? axisOf(p.id) : null;
    const vecs = p.tracks.map(t => axisVec(t, tags, axis)).filter(v => v.size);
    if (!vecs.length) continue;

    const c = new Map();
    for (const v of vecs) for (const [k, x] of v) c.set(k, (c.get(k) ?? 0) + x / vecs.length);
    raw.set(p.id, { name: p.name, axis, vec: c, n: vecs.length, total: p.tracks.length });
    for (const k of c.keys()) df.set(k, (df.get(k) ?? 0) + 1);
  }

  const N = raw.size || 1;
  const idf = new Map();
  for (const [k, d] of df) idf.set(k, Math.log(1 + N / d));

  const profiles = new Map();
  for (const [id, p] of raw) profiles.set(id, { ...p, vec: applyIdf(p.vec, idf) });
  return { profiles, idf };
}

/** Rank playlists by fit for one track. */
export function rank(track, tags, profiles, idf, { exclude = null, top = 5, axis = null } = {}) {
  const flat = trackVec(track, tags);
  if (!flat.size) return [];
  // One weighting per axis in play, not per playlist — the inbox ranks an
  // unfiled track against genre and mood buckets in the same pass, and each
  // must see the track the way its own centroid was built.
  const cache = new Map();
  const vecFor = a => {
    if (!cache.has(a)) cache.set(a, applyIdf(weighFacets(flat, a), idf));
    return cache.get(a);
  };
  const out = [];
  for (const [id, p] of profiles) {
    if (id === exclude) continue;
    // Only compare like with like: a genre playlist competes with genre
    // playlists, a mood playlist with mood playlists. Comparing across axes
    // flags every track in a mood playlist as misfiled, which it is not.
    if (axis && p.axis && p.axis !== axis) continue;
    const v = vecFor(p.axis);
    if (!v.size) continue;
    const s = cosine(v, p.vec);
    if (s > 0) out.push({ id, name: p.name, score: s });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, top);
}

// An artist Last.fm has nothing on at all leaves rank() with an empty vector
// and nothing to say — the exact gap a brand-new account sees before ever
// touching a Last.fm key, since coverage at first login is only whatever the
// shipped tag table happens to already know. But the user's own playlists
// are themselves evidence, free of any third party: if most of this artist's
// other tracks already live in one place, that is worth suggesting even with
// zero tag data. Only the primary, first-billed artist is matched — the same
// billing-order reasoning trackVec() uses — so a guest feature's history
// never gets credited to someone else's track.
const HISTORY_MIN_TRACKS = 2;   // one placement is a coincidence, not a pattern
const HISTORY_MIN_SHARE = 0.6;  // the leading playlist needs a real majority

/**
 * Where an artist's other tracks already live, as a fallback suggestion for
 * one that isn't filed anywhere — needs no tag data at all. Only ever points
 * at a real filing target (`targets`), and only when the artist's own
 * placements agree strongly enough to trust: returns at most one pick, not a
 * ranked list of maybes, because a placement count is corroborating evidence
 * rather than a similarity score, and mixing it into rank()'s cosine scale
 * would misrepresent both.
 */
export function artistHistory(track, lib, targets) {
  const artistId = track?.artists?.[0]?.id;
  if (!artistId) return [];

  const counts = new Map(); // playlistId -> count
  let total = 0;
  for (const p of lib.playlists ?? []) {
    if (!targets.has(p.id)) continue;
    for (const t of p.tracks ?? []) {
      if (t.id === track.id) continue;
      if (t.artists?.[0]?.id !== artistId) continue;
      counts.set(p.id, (counts.get(p.id) ?? 0) + 1);
      total++;
    }
  }
  if (total < HISTORY_MIN_TRACKS) return [];

  const [topId, topCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const share = topCount / total;
  if (share < HISTORY_MIN_SHARE) return [];

  const home = lib.playlists.find(p => p.id === topId);
  return [{ id: topId, name: home?.name ?? topId, score: share, count: topCount, total }];
}

/** The strongest tags on a track, for explaining a suggestion. */
export function topTags(track, tags, idf, n = 5) {
  const v = applyIdf(trackVec(track, tags), idf);
  return [...v].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
}

// Flagged only when another playlist beats the current one by a wide margin,
// so ordinary cross-genre overlap doesn't generate noise.
const MISFILE_MARGIN = 1.6;
const MISFILE_FLOOR = 0.25;

/**
 * Tracks that fit another playlist on the same axis far better than the one
 * they are actually filed in — "goes against the pattern of this playlist".
 * Shared between the Node pipeline (misfile.mjs) and the browser build so the
 * two cannot silently drift into different answers about the same library.
 *
 * Only ever compares a track against playlists on its own axis (a metal track
 * in a mood playlist is not "misfiled" relative to the metal bucket), and
 * only within `targets` — a playlist below the size gate, or on an axis that
 * doesn't take suggestions at all, is never treated as a home to be misfiled
 * from or a destination to be misfiled to.
 */
export function findMisfiled(lib, tags, targets, profiles, idf, axisOf) {
  const misfiled = [];
  for (const p of lib.playlists) {
    if (!targets.has(p.id)) continue;
    const home = profiles.get(p.id);
    if (!home) continue;
    for (const t of p.tracks) {
      const flat = trackVec(t, tags);
      if (flat.size < 3) continue;                 // too little signal to trust
      // Scored against home through home's own axis, exactly as rank() scores
      // it against the alternatives below — otherwise the margin between them
      // would be comparing two differently-weighted numbers.
      const v = applyIdf(weighFacets(flat, home.axis), idf);
      if (!v.size) continue;
      const own = cosine(v, home.vec);
      const best = rank(t, tags, profiles, idf, { exclude: p.id, top: 3, axis: axisOf(p.id) });
      if (!best.length) continue;
      if (best[0].score > own * MISFILE_MARGIN && best[0].score > MISFILE_FLOOR) {
        // Confidence tiers. The raw margin test produces a long uncertain
        // tail; banding it keeps the convincing cases from being buried.
        const confidence =
          own < 0.12 && best[0].score > 0.55 ? 'high'
          : own < 0.25 && best[0].score > 0.40 ? 'medium'
          : 'low';
        misfiled.push({ track: t, playlistId: p.id, playlistName: p.name, ownScore: own, confidence, suggest: best });
      }
    }
  }
  const RANK = { high: 0, medium: 1, low: 2 };
  misfiled.sort((a, b) => RANK[a.confidence] - RANK[b.confidence]
    || (b.suggest[0].score - b.ownScore) - (a.suggest[0].score - a.ownScore));
  return misfiled;
}

// ---------- listening weight ----------
// How much you actually play an artist, not just how much of them you have
// filed. Node and the browser fetch the raw numbers differently (spotify.mjs's
// api() vs the browser's own sp()), but combine them the same way — this is
// the shared half, kept pure so it can be tested without a network at all.

/**
 * `topWindows`: [{ weight, items }] — items is an artist-name array already in
 * Spotify's own rank order for that window (short/medium/long_term).
 * `recentArtists`: flat artist-name list from recently-played.
 * `libraryArtists`: every artist name across the library — the floor, so an
 * artist you have filed counts for something with no recent activity at all,
 * scaled by the biggest count so one enormous playlist can't outvote someone
 * you've actually been playing this month.
 * Returns a Map(artist name -> weight), unbounded and relative, not a 0-1 score.
 */
export function listeningWeights({ topWindows = [], recentArtists = [], libraryArtists = [] } = {}) {
  const w = new Map();
  const bump = (name, x) => { if (name) w.set(name, (w.get(name) ?? 0) + x); };
  for (const { items, weight } of topWindows)
    (items ?? []).forEach((name, i) => bump(name, weight * (1 - i / 60)));
  for (const name of recentArtists) bump(name, 0.6);

  const filed = new Map();
  for (const name of libraryArtists) filed.set(name, (filed.get(name) ?? 0) + 1);
  const most = Math.max(1, ...filed.values());
  for (const [name, n] of filed) bump(name, n / most);
  return w;
}

/**
 * Sort entries most-played first, so an interrupted run (a tag fetch that
 * times out, a page closed halfway through) has already covered what
 * actually matters to this listener rather than whatever came first in
 * playlist order. Untracked or unweighted entries sort last, stable
 * otherwise — never reordered at random.
 */
export function byListening(entries, weights, nameOf = e => e[1]) {
  const w = e => weights?.get?.(nameOf(e)) ?? 0;
  return [...entries]
    .map((e, i) => [e, i])
    .sort(([a, i], [b, j]) => (w(b) - w(a)) || (i - j))
    .map(([e]) => e);
}

// ---------- playlist drift ----------
// A single wrong track is what findMisfiled catches. This catches the other
// shape of "goes against the pattern": a playlist whose recent additions
// read differently from the identity it had before, one ordinary-looking
// track at a time until the whole thing has quietly changed.

const DRIFT_RECENT_FRACTION = 0.25; // "recent" = newest quarter of the playlist
const DRIFT_RECENT_MIN = 8;         // below this, a "recent" centroid is noise
const DRIFT_OLDER_MIN = 8;          // same for the established "older" half
// A first-pass number, not yet checked against a real library the way the
// misfile margin was (see the rejected-rules note in the browser build's
// classify()). Treat it as a starting point to tune once real drift — or
// real false positives — actually show up.
const DRIFT_THRESHOLD = 0.35;

/**
 * Playlists whose most recent additions score low against the centroid of
 * everything added before them. `idf` should be the same table `rank()` and
 * `findMisfiled()` use, so this reads on the same scale as everything else
 * in the app — not a second, differently-calibrated model.
 */
export function findDrift(lib, tags, targets, idf) {
  const centroidOf = list => {
    const vecs = list.map(t => trackVec(t, tags)).filter(v => v.size);
    if (!vecs.length) return null;
    const c = new Map();
    for (const v of vecs) for (const [k, x] of v) c.set(k, (c.get(k) ?? 0) + x / vecs.length);
    return applyIdf(c, idf);
  };

  const drift = [];
  for (const p of lib.playlists) {
    if (!targets.has(p.id)) continue;
    const dated = p.tracks.filter(t => t?.added_at).sort((a, b) => Date.parse(a.added_at) - Date.parse(b.added_at));
    if (dated.length < DRIFT_RECENT_MIN + DRIFT_OLDER_MIN) continue;

    const cut = Math.max(DRIFT_RECENT_MIN, Math.round(dated.length * DRIFT_RECENT_FRACTION));
    const recent = dated.slice(-cut), older = dated.slice(0, -cut);
    if (recent.length < DRIFT_RECENT_MIN || older.length < DRIFT_OLDER_MIN) continue;

    const recentC = centroidOf(recent), olderC = centroidOf(older);
    if (!recentC || !olderC) continue;

    const similarity = cosine(recentC, olderC);
    if (similarity < DRIFT_THRESHOLD) {
      const topOf = c => [...c].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k);
      drift.push({
        playlistId: p.id, playlistName: p.name, similarity,
        recentCount: recent.length, olderCount: older.length,
        recentTags: topOf(recentC), olderTags: topOf(olderC),
      });
    }
  }
  drift.sort((a, b) => a.similarity - b.similarity);
  return drift;
}
