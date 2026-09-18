// The non-genre dimensions: mood, context, era.
//
// §4.3 of the v3 plan: "summer" must not be treated like "House". v1 already
// makes that split — tagFacet() in profile.mjs sorts a Last.fm cloud into
// genre / mood / occasion / era / descriptor — and this module deliberately
// *reuses* that classifier rather than restating its vocabulary, so the two
// engines cannot drift into different opinions about what kind of thing
// "chill" is. profile.mjs stays import-free (it is bundled verbatim into the
// browser build); the dependency only ever points this way.
//
// What v3 adds on top is the second half of the question. v1 answers "which
// facet is this tag?"; a profile also needs "which *concept* in that facet?",
// so that `melancholy`, `sad` and `wistful` collapse to one mood the way
// `dnb` and `drum & bass` collapse to one genre. Hence a concept table per
// facet, same shape as GENRES but flat — moods and contexts have no useful
// hierarchy, and inventing one would only add places to disagree.
import { tagFacet } from '../../profile.mjs';

export const FACET_ONTOLOGY_VERSION = '3.0.0';

/** The facets a concept can belong to. 'genre' lives in genres.mjs. */
export const FACETS = ['genre', 'mood', 'context', 'era', 'descriptor'];

/* ---------- mood ----------
 * The ten from §10, plus the few extra poles a real tag cloud keeps
 * producing. Moods are not mutually exclusive: a track can be dark AND
 * hypnotic, and nothing here says otherwise. */
export const MOODS = {
  'energetic':   { aliases: ['energetic', 'high energy', 'hi energy', 'hype', 'hyped', 'intense', 'upbeat', 'banger', 'powerful', 'motivational', 'empowering'] },
  'aggressive':  { aliases: ['aggressive', 'angry', 'heavy', 'brutal', 'menacing'] },
  'euphoric':    { aliases: ['euphoric', 'euphoria', 'blissful', 'anthemic', 'epic'] },
  'uplifting':   { aliases: ['uplifting', 'hopeful', 'happy', 'happiness', 'joyful', 'feel good', 'feelgood', 'sunny', 'fun', 'playful', 'confident'] },
  'melancholic': { aliases: ['melancholic', 'melancholy', 'sad', 'sadness', 'bittersweet', 'wistful', 'longing', 'lonely', 'depressing', 'emotional', 'emotive', 'cathartic'] },
  'dark':        { aliases: ['dark', 'darkness', 'moody', 'gloomy', 'haunting', 'eerie', 'sombre', 'somber', 'sinister'] },
  'relaxed':     { aliases: ['relaxed', 'relaxing', 'relax', 'chill', 'chilled', 'chillout', 'chill out', 'mellow', 'laid back', 'laidback', 'calm', 'calming', 'soothing', 'peaceful', 'serene', 'soft', 'gentle', 'smooth', 'sleepy', 'cosy', 'cozy'] },
  'dreamy':      { aliases: ['dreamy', 'ethereal', 'atmospheric', 'meditative', 'floaty', 'spacey'] },
  // 'driving' is a DJ's word for a mood and profile.mjs's word for a car
  // journey. v1 owns it (context); one word, one meaning, decided once.
  'hypnotic':    { aliases: ['hypnotic', 'trippy', 'rolling', 'groovy', 'repetitive'] },
  // 'nostalgia' is an era word in v1's lexicon, so it stays one.
  'nostalgic':   { aliases: ['nostalgic'] },
  'romantic':    { aliases: ['romantic', 'sexy', 'sensual', 'seductive', 'warm'] },
  'dramatic':    { aliases: ['dramatic', 'cinematic', 'tense'] },
};

/* ---------- context ----------
 * When you would play it. §10 calls this "context" and reserves "occasion"
 * for the same idea; v1's tagFacet() calls the facet 'occasion' and axes.mjs
 * calls the playlist axis 'context'. One name from here on — context — with
 * OCCASION_FACET below as the bridge to v1's word for it. */
export const CONTEXTS = {
  'club':       { aliases: ['club', 'clubbing', 'night out', 'nightlife', 'dancefloor', 'rave'] },
  'festival':   { aliases: ['festival', 'festivals', 'carnival', 'boiler room'] },
  'party':      { aliases: ['party', 'partying', 'house party', 'pregame', 'pre drinks', 'afters', 'after party'] },
  'late-night': { aliases: ['late night', 'after hours', 'afterhours', '3am'] },
  'driving':    { aliases: ['driving', 'road trip', 'roadtrip', 'commute', 'travel'] },
  'workout':    { aliases: ['workout', 'work out', 'gym', 'running', 'jogging', 'exercise', 'fitness', 'yoga', 'training'] },
  'study':      { aliases: ['study', 'studying', 'focus', 'concentration', 'revision', 'work'] },
  'background': { aliases: ['background', 'background music', 'ambient listening', 'dinner', 'cooking'] },
  // Named 'downtime' rather than 'chill': profile.mjs reads the bare word
  // "chill" as a mood, and two tables cannot both own it.
  'downtime':   { aliases: ['chilling', 'lounging', 'sunday morning', 'hangover'] },
  'sleep':      { aliases: ['sleep', 'sleeping', 'bedtime', 'insomnia'] },
  'summer':     { aliases: ['summer', 'beach', 'poolside', 'bbq', 'barbecue', 'holiday', 'holidays', 'ibiza'] },
  'winter':     { aliases: ['winter', 'rainy day', 'christmas', 'xmas', 'halloween'] },
  'celebration':{ aliases: ['wedding', 'birthday', 'new year', 'nye', 'graduation'] },
  'gaming':     { aliases: ['gaming', 'video games'] },
};

/* ---------- era ----------
 * Two ways in: a bare decade tag ("90s", "1994") and the words people use
 * instead ("old school", "throwback"). Only the first is precise enough to
 * become an era concept on its own; the rest resolve to 'retro', which says
 * "older than now" and nothing more — which is all they actually mean. */
export const ERAS = {
  '1960s': { aliases: ['60s', '1960s'], from: 1960, to: 1969 },
  '1970s': { aliases: ['70s', '1970s'], from: 1970, to: 1979 },
  '1980s': { aliases: ['80s', '1980s'], from: 1980, to: 1989 },
  '1990s': { aliases: ['90s', '1990s'], from: 1990, to: 1999 },
  '2000s': { aliases: ['00s', '2000s', 'noughties'], from: 2000, to: 2009 },
  '2010s': { aliases: ['10s', '2010s'], from: 2010, to: 2019 },
  '2020s': { aliases: ['20s', '2020s'], from: 2020, to: 2029 },
  'retro': { aliases: ['retro', 'old school', 'oldschool', 'oldies', 'throwback', 'vintage', 'nostalgia', 'classic', 'classics', 'old'] },
};

/** The era a four-digit release year falls in, or null outside the table. */
export function eraOfYear(year) {
  const y = Number(year);
  if (!Number.isFinite(y)) return null;
  for (const [id, e] of Object.entries(ERAS))
    if (e.from != null && y >= e.from && y <= e.to) return id;
  return null;
}

// v1's tagFacet() says 'occasion' where v3 says 'context'. One translation,
// in one place, rather than either engine changing its vocabulary.
const V1_FACET = { occasion: 'context' };

/**
 * Which facet a raw tag belongs to, in v3's vocabulary. Delegates to v1's
 * tagFacet() so there is exactly one lexicon to maintain — a tag demoted from
 * genre there is demoted here, automatically and in the same release.
 */
export const facetOf = tag => V1_FACET[tagFacet(tag)] ?? tagFacet(tag);
