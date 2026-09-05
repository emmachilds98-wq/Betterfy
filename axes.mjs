// First-pass classification of every playlist by axis. Writes playlists.config.json
// for you to hand-correct; everything downstream reads that file, not these rules.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const lib = JSON.parse(readFileSync('library.json', 'utf8'));

const EVENT = /\b(drumsheds|fabric|ministry|bloc party|e1|printworks|warehouse)\b|\d{2}\.\d{2}\s*$/i;
const DJSET = /^(mix|side)(\s*\d+)?$|rekordbox|dj'?ing for|extended .*mix|^our .*mix$/i;
const ERA   = /\b(90s|00s|80s|70s|nostalgia|old but gold|retro)\b|^\d{4}$/i;
const MOOD  = /\b(chill|mellow|wasted|vibin|groove therapy|sleepy|late night|hi energy|headache|early night|graveyard|forbidden|on road|killstreak|danceable)\b/i;

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

const guess = name => {
  if (OVERRIDE[name])   return OVERRIDE[name];
  if (EVENT.test(name)) return 'event';
  if (DJSET.test(name)) return 'djset';
  if (ERA.test(name))   return 'era';
  if (MOOD.test(name))  return 'mood';
  return 'genre';
};

// Preserve any manual edits already made.
const prev = existsSync('playlists.config.json')
  ? JSON.parse(readFileSync('playlists.config.json', 'utf8')) : { playlists: {} };

const cfg = { playlists: {} };
for (const p of lib.playlists) {
  const old = prev.playlists?.[p.id];
  // An explicit override always wins; otherwise a previous hand-edit is kept.
  const forced = OVERRIDE[p.name];
  const axis = forced ?? old?.axis ?? guess(p.name);
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
for (const axis of ['genre', 'mood', 'era', 'event', 'djset']) {
  const rows = (by[axis] ?? []).sort((a, b) => b.tracks - a.tracks);
  const targets = rows.filter(r => r.target).length;
  console.log(`\n${axis.toUpperCase()} — ${rows.length} playlists, ${targets} accept auto-filing`);
  console.log('  ' + rows.map(r => `${r.name}(${r.tracks})`).join(', '));
}
console.log(`\nwrote playlists.config.json`);
