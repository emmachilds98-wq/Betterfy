// The genre hierarchy, declared once and indexed at load.
//
// Why a declared tree and not a flat tag list: §4.4 of the v3 plan. A flat
// list cannot answer "is Tech House a kind of House" — which is the question
// every reconciliation step in the classifier actually asks. Without it, a
// track with evidence split three ways between tech-house, deep-house and
// house looks *ambiguous*, when in fact all three agree on House and only
// disagree about which room of it.
//
// The shape is deliberately minimal. Each genre declares its parent and its
// aliases; children, depth, ancestry and the alias index are all derived in
// index.mjs, because a hand-maintained `children` array is a hand-maintained
// chance to disagree with `parent`.
//
//   parent      the one broader genre this sits inside, or null at the root.
//               Single-parent on purpose: a DAG reads better on paper and is
//               far worse to reason about when scoring, and the handful of
//               genuinely two-parented genres (electro, trip hop) are served
//               better by `related`.
//   aliases     what providers actually call it. Last.fm crowd tags and
//               Discogs styles, not what a genre history would call it.
//   related     neighbouring genres — evidence for one is weak evidence for
//               the other. Symmetric by construction (index.mjs closes it).
//   contradicts genres that being this one argues *against*. Rare and
//               deliberate: used only where two genres are routinely confused
//               by tag clouds but never actually co-occur in one record.
//
// Coverage is electronic-heavy because that is where subgenre resolution
// actually matters for filing; the rest of popular music is present at one or
// two levels, which is enough for the hierarchy to do its job. An unmapped
// concept is never discarded (see normalise.mjs) — it is carried as an
// unknown candidate, so a gap here costs recall, never data.

/** Bumped whenever a genre is added, removed, re-parented or re-aliased. */
export const GENRE_ONTOLOGY_VERSION = '3.0.0';

/** @typedef {{parent: string|null, aliases?: string[], related?: string[], contradicts?: string[]}} GenreNode */

/** @type {Record<string, GenreNode>} */
export const GENRES = {
  /* ---------- electronic ---------- */
  'electronic': { parent: null, aliases: ['electronica', 'electronic music', 'edm', 'dance', 'dance music', 'electro dance'] },

  'house': { parent: 'electronic', aliases: ['house music', 'classic house'] },
  'deep-house': { parent: 'house', aliases: ['deephouse'] },
  'tech-house': { parent: 'house', aliases: ['techhouse'], related: ['techno', 'minimal-techno'] },
  'progressive-house': { parent: 'house', aliases: ['prog house'], related: ['trance'] },
  'acid-house': { parent: 'house', aliases: ['acid'], related: ['acid-techno'] },
  'disco-house': { parent: 'house', aliases: ['nu disco', 'nu-disco', 'french house', 'filter house'], related: ['disco'] },
  'electro-house': { parent: 'house', aliases: ['big room', 'big room house'] },
  'afro-house': { parent: 'house', aliases: ['afrohouse', 'afro tech'] },
  'melodic-house': { parent: 'house', aliases: ['melodic house and techno', 'melodic house & techno', 'organic house'] },
  'garage-house': { parent: 'house', aliases: ['soulful house', 'vocal house', 'new jersey sound'] },
  'minimal-house': { parent: 'house', aliases: ['micro house', 'microhouse'], related: ['minimal-techno'] },
  'bass-house': { parent: 'house', aliases: ['basshouse'], related: ['uk-bass'] },

  'techno': { parent: 'electronic', aliases: ['techno music'] },
  'minimal-techno': { parent: 'techno', aliases: ['minimal', 'minimal tech'] },
  'acid-techno': { parent: 'techno', aliases: [] },
  'detroit-techno': { parent: 'techno', aliases: ['detroit'] },
  'hard-techno': { parent: 'techno', aliases: ['hardtechno', 'industrial techno'], related: ['hardcore'] },
  'dub-techno': { parent: 'techno', aliases: ['dubtechno'], related: ['dub', 'ambient'] },

  'trance': { parent: 'electronic', aliases: ['trance music'] },
  'progressive-trance': { parent: 'trance', aliases: [], related: ['progressive-house'] },
  'psytrance': { parent: 'trance', aliases: ['psychedelic trance', 'goa', 'goa trance', 'psy trance'] },
  'uplifting-trance': { parent: 'trance', aliases: ['epic trance'] },
  'hard-trance': { parent: 'trance', aliases: [], related: ['hardstyle'] },

  'breakbeat': { parent: 'electronic', aliases: ['breaks', 'break beat'] },
  'big-beat': { parent: 'breakbeat', aliases: ['bigbeat'] },
  'uk-breaks': { parent: 'breakbeat', aliases: ['nu skool breaks', 'nu-skool breaks', 'progressive breaks'] },
  'breakcore': { parent: 'breakbeat', aliases: [], related: ['jungle', 'hardcore'] },

  'drum-and-bass': { parent: 'electronic', aliases: ['drum n bass', 'drum & bass', 'drum and bass', 'dnb', 'd&b', 'dandb', 'drumandbass', 'drum bass'] },
  'jungle': { parent: 'drum-and-bass', aliases: ['ragga jungle', 'jungle techno'] },
  'liquid-dnb': { parent: 'drum-and-bass', aliases: ['liquid', 'liquid funk', 'liquid drum and bass', 'liquid dnb'] },
  'neurofunk': { parent: 'drum-and-bass', aliases: ['neuro', 'techstep'] },
  'jump-up': { parent: 'drum-and-bass', aliases: ['jumpup'] },
  'halftime': { parent: 'drum-and-bass', aliases: [] },

  'uk-garage': { parent: 'electronic', aliases: ['garage', 'ukg', '2 step', '2-step', 'two step', 'speed garage'] },
  'bassline': { parent: 'uk-garage', aliases: ['niche', 'bassline house'] },
  'future-garage': { parent: 'uk-garage', aliases: ['futuregarage'], related: ['dubstep'] },
  'grime': { parent: 'uk-garage', aliases: [], related: ['hip-hop', 'uk-bass'] },

  'dubstep': { parent: 'electronic', aliases: ['dub step'] },
  'brostep': { parent: 'dubstep', aliases: ['riddim'] },
  'uk-bass': { parent: 'electronic', aliases: ['bass music', 'bass', 'future bass', 'wonky'] },

  'hardcore': { parent: 'electronic', aliases: ['hardcore techno', 'happy hardcore', 'rave', 'oldskool', 'old skool rave'] },
  'gabber': { parent: 'hardcore', aliases: ['gabba'] },
  'hardstyle': { parent: 'hardcore', aliases: ['hardjump', 'rawstyle'] },

  'ambient': { parent: 'electronic', aliases: ['ambient music', 'drone', 'dark ambient'] },
  // 'chillout' deliberately absent: profile.mjs reads it as a mood, and it
  // genuinely is one more often than it is this genre. validateOntology()
  // flags any alias the two vocabularies disagree about.
  'downtempo': { parent: 'electronic', aliases: ['trip hop', 'trip-hop', 'triphop', 'lounge'], related: ['ambient', 'hip-hop'] },
  'idm': { parent: 'electronic', aliases: ['intelligent dance music', 'braindance', 'glitch'] },
  'electro': { parent: 'electronic', aliases: ['electro funk', 'electrofunk', 'miami bass'], related: ['hip-hop', 'electro-house'] },
  'synthwave': { parent: 'electronic', aliases: ['retrowave', 'outrun', 'darksynth'] },
  'synth-pop': { parent: 'electronic', aliases: ['synthpop', 'new wave', 'electropop', 'electro pop'], related: ['pop'] },
  'eurodance': { parent: 'electronic', aliases: ['euro dance', 'euro house', 'hands up'] },

  /* ---------- hip hop, r&b, soul ---------- */
  'hip-hop': { parent: null, aliases: ['hip hop', 'hiphop', 'rap', 'rap music', 'old school hip hop', 'old school rap'] },
  'uk-hip-hop': { parent: 'hip-hop', aliases: ['uk rap', 'british hip hop'] },
  'drill': { parent: 'hip-hop', aliases: ['uk drill'] },
  'trap': { parent: 'hip-hop', aliases: ['trap music'] },
  'boom-bap': { parent: 'hip-hop', aliases: ['boombap', 'golden age hip hop', 'east coast hip hop'] },
  'conscious-hip-hop': { parent: 'hip-hop', aliases: ['alternative hip hop', 'underground hip hop', 'jazz rap'] },
  'g-funk': { parent: 'hip-hop', aliases: ['west coast hip hop', 'gangsta rap'] },
  'lo-fi-hip-hop': { parent: 'hip-hop', aliases: ['lofi hip hop', 'lo fi hip hop', 'lofi'], related: ['downtempo'] },

  'rnb': { parent: null, aliases: ['r&b', 'r and b', 'rhythm and blues', 'randb', 'contemporary r&b'] },
  'neo-soul': { parent: 'rnb', aliases: ['neosoul'], related: ['soul'] },
  'soul': { parent: null, aliases: ['soul music', 'northern soul'] },
  'motown': { parent: 'soul', aliases: [] },
  'funk': { parent: null, aliases: ['funk music', 'p funk', 'p-funk'] },
  'disco': { parent: 'funk', aliases: ['italo disco', 'italo-disco', 'boogie'], related: ['disco-house'] },

  /* ---------- rock and its neighbours ---------- */
  'rock': { parent: null, aliases: ['rock music', 'classic rock'] },
  'indie-rock': { parent: 'rock', aliases: ['indie', 'indie music'] },
  'alternative-rock': { parent: 'rock', aliases: ['alternative', 'alt rock', 'alternative music'] },
  'punk': { parent: 'rock', aliases: ['punk rock'] },
  'pop-punk': { parent: 'punk', aliases: ['poppunk'] },
  'hardcore-punk': { parent: 'punk', aliases: ['post hardcore', 'post-hardcore'], contradicts: ['hardcore'] },
  'metal': { parent: 'rock', aliases: ['heavy metal'] },
  'metalcore': { parent: 'metal', aliases: [] },
  'death-metal': { parent: 'metal', aliases: [] },
  'black-metal': { parent: 'metal', aliases: [] },
  'psychedelic-rock': { parent: 'rock', aliases: ['psych rock', 'psychedelic'] },
  'shoegaze': { parent: 'rock', aliases: ['dream pop', 'dreampop'] },
  'post-rock': { parent: 'rock', aliases: ['postrock', 'math rock'] },
  'britpop': { parent: 'rock', aliases: ['brit pop'], related: ['indie-rock'] },
  'grunge': { parent: 'rock', aliases: [] },
  'garage-rock': { parent: 'rock', aliases: ['garage punk'], contradicts: ['uk-garage'] },

  /* ---------- pop and the rest ---------- */
  'pop': { parent: null, aliases: ['pop music', 'mainstream pop'] },
  'dance-pop': { parent: 'pop', aliases: ['dancepop'], related: ['electronic'] },
  'indie-pop': { parent: 'pop', aliases: ['indiepop'], related: ['indie-rock'] },
  'hyperpop': { parent: 'pop', aliases: [], related: ['uk-bass'] },
  'k-pop': { parent: 'pop', aliases: ['kpop'] },

  'jazz': { parent: null, aliases: ['jazz music'] },
  'jazz-funk': { parent: 'jazz', aliases: ['jazz fusion', 'fusion'], related: ['funk'] },
  'nu-jazz': { parent: 'jazz', aliases: ['broken beat', 'acid jazz'], related: ['downtempo'] },

  'reggae': { parent: null, aliases: ['roots reggae'] },
  'dub': { parent: 'reggae', aliases: ['dub music'] },
  'dancehall': { parent: 'reggae', aliases: ['ragga'] },
  'afrobeats': { parent: null, aliases: ['afrobeat', 'afro beats', 'amapiano'] },
  'latin': { parent: null, aliases: ['latin music', 'reggaeton', 'salsa', 'bossa nova'] },

  'folk': { parent: null, aliases: ['folk music', 'singer songwriter', 'singer-songwriter'] },
  'country': { parent: null, aliases: ['country music', 'americana'] },
  'blues': { parent: null, aliases: ['blues music'] },
  'classical': { parent: null, aliases: ['classical music', 'orchestral', 'contemporary classical', 'neoclassical'] },
  'soundtrack': { parent: null, aliases: ['score', 'film score', 'ost', 'video game music'] },
};
