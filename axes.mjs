// First-pass classification of every playlist by axis. Writes playlists.config.json
// for you to hand-correct; everything downstream reads that file, not these rules.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { facetMix } from './profile.mjs';
const lib = JSON.parse(readFileSync('library.json', 'utf8'));

/* The name rules, kept in step with classify() in docs/app.template.html —
 * the browser build is the one most people actually use, so treat that copy as
 * the reference and mirror changes here. */
const INBOX = /\bshazam\b|^discover weekly|^release radar|^on repeat$|^repeat rewind$|^daily mix|^your top songs|^liked (songs )?from radio|^new music friday|^you may have missed|^time capsule|^inbox$|^to (sort|file|listen)\b/i;
const EVENT = /\b(drumsheds|fabric|ministry|bloc party|e1|printworks|warehouse|festival|boiler room|glastonbury|coachella|tomorrowland|creamfields|carnival|after ?party|afters)\b|\d{2}[./]\d{2}\s*$/i;
const DJSET = /^(mix|side|set)(\s*\d+)?$|rekordbox|dj'?ing for|extended .*mix|^our .*mix$/i;
const ERA   = /\b((19|20)?\d0s|nostalgia|old ?school|old but gold|retro|throwback|oldies)\b|^\d{4}$/i;
const OCCASION = /\b(part(y|ies)|pre ?drinks|pregame|workout|gym|running|yoga|study(ing)?|revision|focus|sleep(ing)?|bedtime|driving|road ?trip|commute|wedding|birthday|b'?day|christmas|xmas|halloween|new year|nye|holiday|beach|bbq|barbecue|dinner|cooking|gaming)\b/i;
const MOOD  = /\b(chill|chilled|mellow|wasted|vibin|vibes|groove|sleepy|late night|hi energy|high energy|early night|relax(ing|ed)?|calm|hype|sad|happy|angry|moody|dreamy|melanchol(y|ic)|euphoric|uplifting|upbeat|feel ?good|emotional|romantic|sexy|co[sz]y|soft|energetic|headache|graveyard|forbidden|on road|killstreak|danceable)\b/i;

/* The content fallback, same numbers and same reasoning as the browser build:
 * with nothing in the name, ask which *kind* of tag holds the playlist
 * together, read against this library's own baseline rather than a fixed
 * share. Silently skipped when no tags have been fetched yet — `npm run axes`
 * has always worked before `npm run enrich`, and still does. */
const FACET_LIFT = 1.8, FACET_MIN_SHARE = 0.10, FACET_MIN_TRACKS = 10;
const FACET_AXIS = { mood: 'mood', era: 'era', occasion: 'context' };

let TAGS = null;
try {
  const { loadTags } = await import('./tagstore.mjs');
  TAGS = loadTags();
} catch { /* no tags yet — name rules only, exactly as before */ }
// The All Songs mirror holds a copy of every track by construction, so
// reading it into the baseline counts the whole library twice.
const isMirror = p => p.name === 'All Songs — Betterfy';
const BASE = TAGS
  ? facetMix(lib.playlists.filter(p => !isMirror(p)).flatMap(p => p.tracks ?? []), TAGS)
  : null;

/** The axis a playlist's tags argue for, or null when they argue for nothing. */
function facetAxis(p) {
  if (!TAGS || !BASE) return null;
  const mix = facetMix(p.tracks, TAGS);
  if (mix.tracks < FACET_MIN_TRACKS) return null;
  let best = null;
  for (const [facet, axis] of Object.entries(FACET_AXIS)) {
    const share = mix[facet], baseShare = BASE[facet];
    if (!(share >= FACET_MIN_SHARE) || !baseShare) continue;
    const lift = share / baseShare;
    if (lift >= FACET_LIFT && (!best || lift > best.lift)) best = { axis, lift };
  }
  return best?.axis ?? null;
}

// Playlists whose name misleads the rules above. A name can look like a genre
// while the playlist is really organised on something tags cannot see —
// "Lyricism" is a judgement about wordplay, not a sound, so left as a genre
// target it silently becomes "the rap playlist" and attracts every rap track.
const OVERRIDE = {
  'Lyricism Emma':          'context',   // lyrical quality, not a genre
  'COD Killstreak Emma':    'context',   // an activity
  'Graveyard Emma':         'context',
  'Misc EDM':               'context',   // a leftovers bin
  'My Shazam Tracks':       'inbox',     // an inflow, not a destination
  'You may have missed 25': 'inbox',     // Spotify-generated
  'Demma Exports Inc':      'context',
  "Adam's BDay":            'context',
  'Saudade Vem Correndo':   'context',
  'Old Soul Sound Emma':    'context',
  'Long Tracks Emma':       'context',   // a duration rule
  'VibinWEmma':             'mood',      // MOOD regex misses it — no word break
  'Unique Happier Relaxing Sleep Music': 'mood',
};

// Only genre and mood playlists are filing destinations.
const TARGET_AXES = new Set(['genre', 'mood']);

// A centroid built from a handful of tracks is noise, and a tiny playlist will
// happily "match" anything. Below this it is still filable by hand, just never
// suggested.
const MIN_FOR_TARGET = 12;

const guess = p => {
  const name = p.name;
  if (OVERRIDE[name])      return OVERRIDE[name];
  if (INBOX.test(name))    return 'inbox';
  if (EVENT.test(name))    return 'event';
  if (DJSET.test(name))    return 'djset';
  if (ERA.test(name))      return 'era';
  if (OCCASION.test(name)) return 'context';
  if (MOOD.test(name))     return 'mood';
  // Nothing in the name: ask the tags before defaulting to genre, which is
  // the silent guess that later shows up as a wrong filing suggestion.
  return facetAxis(p) ?? 'genre';
};

// Preserve any manual edits already made.
const prev = existsSync('playlists.config.json')
  ? JSON.parse(readFileSync('playlists.config.json', 'utf8')) : { playlists: {} };

const cfg = { playlists: {} };
for (const p of lib.playlists) {
  const old = prev.playlists?.[p.id];
  // An explicit override always wins; otherwise a previous hand-edit is kept.
  const forced = OVERRIDE[p.name];
  const axis = forced ?? old?.axis ?? guess(p);
  cfg.playlists[p.id] = {
    name: p.name,
    axis,
    // The size gate is unconditional: a centroid built from a handful of
    // tracks matches almost anything, so such a playlist is never *suggested*.
    // Hand-editing the axis is respected; hand-raising a tiny playlist to a
    // suggestion target is not, because the model cannot support it.
    target: TARGET_AXES.has(axis)
      && p.tracks.length >= MIN_FOR_TARGET
      && (forced !== undefined ? true : (old?.target ?? true)),
    tracks: p.tracks.length,
  };
}
writeFileSync('playlists.config.json', JSON.stringify(cfg, null, 2));

const by = {};
for (const v of Object.values(cfg.playlists)) (by[v.axis] ??= []).push(v);
for (const axis of ['genre', 'mood', 'era', 'event', 'djset', 'context', 'inbox']) {
  const rows = (by[axis] ?? []).sort((a, b) => b.tracks - a.tracks);
  const targets = rows.filter(r => r.target).length;
  console.log(`\n${axis.toUpperCase()} — ${rows.length} playlists, ${targets} accept auto-filing`);
  console.log('  ' + rows.map(r => `${r.name}(${r.tracks})`).join(', '));
}
console.log(`\nwrote playlists.config.json`);
