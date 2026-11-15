/* ---------- axis classification (mirrors axes.mjs) ---------- */

/* Spotify's own generated playlists and the obvious hand-made staging posts.
 * These are an *inflow*, not a destination: everyone's account has Discover
 * Weekly and Release Radar under exactly those names, so unlike a club night
 * or a genre word this needs no vocabulary of the listener's at all. Left as
 * genre they are filing targets, which means Tidy offers to move your music
 * into a playlist Spotify overwrites every Monday. */
const INBOX = /\bshazam\b|^discover weekly|^release radar|^on repeat$|^repeat rewind$|^daily mix|^your top songs|^liked (songs )?from radio|^new music friday|^you may have missed|^time capsule|^inbox$|^to (sort|file|listen)\b/i;
const EVENT = /\b(drumsheds|fabric|ministry|printworks|warehouse|festival|boiler room|glastonbury|coachella|tomorrowland|creamfields|carnival|after ?party|afters)\b|\d{2}[./]\d{2}\s*$/i;
const DJSET = /^(mix|side|set)(\s*\d+)?$|rekordbox|dj'?ing for|extended .*mix/i;
const ERA   = /\b((19|20)?\d0s|nostalgia|old ?school|old but gold|retro|throwback|oldies)\b|^\d{4}$/i;
/* A situation rather than a sound: the gym, the drive, the wedding. Filed as
 * context, which takes no suggestions — a workout playlist has no genre for
 * Tidy to compare anything against, and left as one it attracts whatever
 * happens to be loud. */
const OCCASION = /\b(part(y|ies)|pre ?drinks|pregame|workout|gym|running|yoga|study(ing)?|revision|focus|sleep(ing)?|bedtime|driving|road ?trip|commute|wedding|birthday|b'?day|christmas|xmas|halloween|new year|nye|holiday|beach|bbq|barbecue|dinner|cooking|gaming)\b/i;
// Word-bounded: unbounded "chill" also matches inside "Chillstep" or
// "Chillwave" (genres), "hype" inside "Hyperpop", "groove" inside
// "Groovebox" — real genre names that happen to contain a mood word as a
// substring. This is not one listener's vocabulary problem; it misfires on
// any library that has a mood-adjacent genre bucket.
//
// What is deliberately *not* here is every mood word that also modifies a
// genre: "dark" (Dark Techno), "deep" (Deep House), "heavy" (Heavy Metal),
// "hard" (Hard Trance), "smooth" (Smooth Jazz), "lo-fi". A word boundary
// cannot separate those, so they stay genre and the listener corrects the
// rare miss — which is the cheap direction to be wrong in.
const MOOD  = /\b(chill|chilled|mellow|wasted|vibin|vibes|groove|sleepy|late night|hi energy|high energy|early night|relax(ing|ed)?|calm|hype|sad|happy|angry|moody|dreamy|melanchol(y|ic)|euphoric|uplifting|upbeat|feel ?good|emotional|romantic|sexy|co[sz]y|soft|energetic)\b/i;
const MIN_FOR_TARGET = 12;

/* A genre playlist is one whose name names a genre.
 *
 * Every playlist with nothing else in its name used to be *defaulted* to
 * genre, and every genre playlist took filing suggestions — so "Sunday",
 * "Bangers", "Car" and "Favourites" were all treated as genre buckets, and
 * both engines filed tracks into them. Asking for positive evidence instead
 * means a playlist only receives suggestions when its name says what genre it
 * is, against the same vocabulary the engine reads tags with (baked in at
 * build time from core/ontology). Anything else lands under "Needs your
 * input" on the Playlists screen, where one tap makes it a genre playlist. */
const GENRE_WORDS = new Set('__GENRE_WORDS__');
const NO_SIGNAL = 'no genre in the name — not filed into until you say so';

/** The genre a playlist's name names, longest phrase first, or null. */
function genreInName(name) {
  const words = canonTag(String(name ?? '')).replace(/[^\p{L}\p{N} ]+/gu, ' ').split(' ').filter(Boolean);
  for (let len = Math.min(4, words.length); len >= 1; len--)
    for (let i = 0; i + len <= words.length; i++) {
      const phrase = canonTag(words.slice(i, i + len).join(' '));
      if (GENRE_WORDS.has(phrase)) return phrase;
    }
  return null;
}

/* An event playlist named for the club gives itself away; one named for who
 * you were with that night looks like any other playlist, and falls through to
 * genre — where it competes for suggestions with the real genre buckets and
 * turns up in Misfiles as noise. The filed dates carry what the name does not:
 * a night out lands inside a couple of days and is then finished, while a
 * genre bucket accretes for years and is still growing.
 *
 * Both halves matter. "Added in one go" alone would catch a playlist somebody
 * built last week by dropping fifty tracks in at once, which is exactly what a
 * new listener does — so it must also have been left alone since. */
const EVENT_SPAN_DAYS = 4;      // a night out, and the next morning's additions
const EVENT_SETTLED_DAYS = 45;  // and nothing added since
const EVENT_MIN_TRACKS = 8;     // below this, one sitting means nothing

/** How many days the middle 80% of a playlist's additions span, and how long
 *  ago the last one was. Null when too few tracks carry a date to say. */
function addedShape(p, now = Date.now()) {
  const at = p.tracks.map(t => Date.parse(t?.added_at)).filter(Number.isFinite).sort((a, b) => a - b);
  if (at.length < EVENT_MIN_TRACKS) return null;
  // Percentiles rather than first-to-last, so one track added late does not
  // hide a playlist that was otherwise built in an evening.
  const lo = at[Math.floor(at.length * 0.1)], hi = at[Math.ceil(at.length * 0.9) - 1];
  return { spanDays: (hi - lo) / 86400000, sinceDays: (now - at[at.length - 1]) / 86400000 };
}

/* Two content-based axis rules were tried here and rejected on evidence,
 * measured over a real 83-playlist library. Do not re-add them without
 * new data.
 *
 * Tag coherence (mean pairwise similarity) to tell genre from mood: it
 * does not separate them. Genre playlists ran a median 0.225 (0.096-0.677)
 * and mood 0.246 (0.036-0.751) - mood scored HIGHER, and the ranges
 * overlap almost entirely. A broad genre bucket ("Alt/Indie", 293 tracks)
 * scored 0.110 while a tight mood playlist scored 0.751. The signal
 * measures how broad a playlist is, not which axis it sits on.
 *
 * A release-year window to spot an era: genres cluster in time too.
 * "Pop Punk" (a genre) spans 2002-2016 at coherence 0.385; "Nostalgia
 * Rock" (an era) spans 1994-2011 at 0.370 - indistinguishable on both
 * signals. Worse, the real era playlists in that library span 16-45 years,
 * so any window tight enough to mean anything caught only the false
 * positive.
 *
 * The facet mix below is a third content rule and not a rerun of the first.
 * Coherence asked how tightly a playlist's tags agree with each other, which
 * turned out to measure breadth. This asks which *kind* of tag holds the
 * playlist together — sound, feel, decade or occasion — which is the actual
 * question the axis is asking, and a mood playlist is one whether it is broad
 * or narrow. See tagFacet() in profile.mjs.
 */

/* Read against the library's own baseline rather than an absolute number.
 * Mood tags are a small slice of anybody's tag cloud — "chill" turns up far
 * less often than "electronic" — so "28% mood" means nothing on its own, and
 * whatever number worked for one library would be wrong for the next. What
 * travels is the lift: a playlist carrying twice the mood weight of the rest
 * of your library is a mood playlist in your vocabulary, whatever the raw
 * share happens to be. */
const FACET_LIFT = 1.8;        // times the library's own share of that facet
const FACET_MIN_SHARE = 0.10;  // and still a real share, so a library with
                               // almost no mood tags cannot promote on a trace
const FACET_MIN_TRACKS = 10;   // tagged tracks — below this the mix is noise

// Which axis each facet argues for. 'genre' is the default and argues for
// nothing; 'descriptor' (british, female vocalists) says how a playlist was
// tagged, never how it was organised, so it argues for nothing either.
const FACET_AXIS = { mood: 'mood', era: 'era', occasion: 'context' };

/**
 * The axis a playlist's tags argue for, or null when they argue for nothing.
 * `base` is the same mix taken over the whole library, so this reads as
 * "unusually moody *for you*" rather than against some fixed number.
 */
function facetAxis(p, tags, base) {
  if (!tags || !base) return null;
  const mix = facetMix(p.tracks, tags);
  if (mix.tracks < FACET_MIN_TRACKS) return null;
  let best = null;
  for (const [facet, axis] of Object.entries(FACET_AXIS)) {
    const share = mix[facet], baseShare = base[facet];
    if (!(share >= FACET_MIN_SHARE) || !baseShare) continue;
    const lift = share / baseShare;
    if (lift < FACET_LIFT) continue;
    if (!best || lift > best.lift) best = { axis, facet, share, baseShare, lift };
  }
  if (!best) return null;
  const pct = x => Math.round(x * 100) + '%';
  return { axis: best.axis,
           why: `${pct(best.share)} ${best.facet} tags, against ${pct(best.baseShare)} across your library` };
}

function classify(lib, tags = null, now = Date.now()) {
  const cfg = {};
  // Drop whatever the library-wide tag gate doesn't trust before any of it
  // gets to argue for an axis — see tagGate() in the bundled profile.mjs.
  if (tags) tags = gateTags(tags, tagGate(tags));
  // The baseline every playlist is read against. Taken over the library as one
  // pile, so it is this listener's own tag vocabulary and not an average of
  // somebody else's.
  // The mirror is skipped: it holds a copy of every track by construction, so
  // reading it into the baseline is counting the whole library twice.
  const base = tags
    ? facetMix(lib.playlists.filter(p => !isMirrorPlaylist(p)).flatMap(p => p.tracks ?? []), tags)
    : null;
  for (const p of lib.playlists) {
    const n = p.name;
    // A named genre beats a mood word — "Happy Hardcore", "Dark Techno", "Deep
    // House" are genre playlists — but not an inbox, an event, a set, a decade
    // or an occasion, which say what the playlist is *for*.
    const genre = genreInName(n);
    const named = INBOX.test(n) ? 'inbox' : EVENT.test(n) ? 'event' : DJSET.test(n) ? 'djset'
                : ERA.test(n) ? 'era' : OCCASION.test(n) ? 'context'
                : genre ? null : MOOD.test(n) ? 'mood' : null;
    let axis = named ?? 'genre';
    let why = named ? 'from the name' : genre ? `“${genre}” in the name` : NO_SIGNAL;

    // Built in one sitting and never touched again: a night out, a party, a
    // trip. This is the one content signal that holds up, and it needs no
    // vocabulary — so it works for a library nobody has tuned for. A playlist
    // named for a genre is a genre playlist however quickly it was built.
    const shape = addedShape(p, now);
    if (!genre && !named && shape && shape.spanDays <= EVENT_SPAN_DAYS && shape.sinceDays >= EVENT_SETTLED_DAYS) {
      axis = 'event';
      why = `built in ${shape.spanDays < 1 ? 'a day' : Math.round(shape.spanDays) + ' days'}, nothing added since`;
    }

    // Last resort, and only ever a last resort: with nothing in the name and
    // nothing in the dates, ask what the tracks are actually tagged with. It
    // never overrules a name or a date, so a playlist that was already being
    // read correctly cannot start being read differently.
    if (!named && why === NO_SIGNAL) {
      const guess = facetAxis(p, tags, base);
      if (guess) { axis = guess.axis; why = guess.why; }
    }

    cfg[p.id] = { name:n, axis, why, tracks:p.tracks.length,
                  // The mirror holds a copy of every track by construction, so
                  // left eligible it would always "win" as a target — a
                  // centroid of the whole library, and every artist's own
                  // placement trivially "confirmed" by their own copy sitting
                  // in it. Never a filing destination, same as it's never
                  // read into the tag baseline above.
                  // Only a playlist that names its genre takes suggestions by
                  // default. Mood playlists and unnamed ones can still be
                  // switched on, one tap each, on the Playlists screen.
                  target: axis === 'genre' && !!genre && p.tracks.length >= MIN_FOR_TARGET && !isMirrorPlaylist(p) };
  }
  const saved = JSON.parse(LS.getItem('bf_axes') || '{}');
  // `at` is when it was set, for syncing between devices; not part of the config.
  for (const [id, { at, ...v }] of Object.entries(saved)) if (cfg[id]) Object.assign(cfg[id], v, { why:'set by you' });
  return cfg;
}

