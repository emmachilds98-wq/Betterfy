// First-pass classification of every playlist by axis. Writes playlists.config.json
// for you to hand-correct; everything downstream reads that file, not these rules.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const lib = JSON.parse(readFileSync('library.json', 'utf8'));

const EVENT = /\b(drumsheds|fabric|ministry|bloc party|e1|printworks|warehouse)\b|\d{2}\.\d{2}\s*$/i;
const DJSET = /^(mix|side)(\s*\d+)?$|rekordbox|dj'?ing for|extended .*mix|^our .*mix$/i;
const ERA   = /\b(90s|00s|80s|70s|nostalgia|old but gold|retro)\b|^\d{4}$/i;
const MOOD  = /\b(chill|mellow|wasted|vibin|groove therapy|sleepy|late night|hi energy|headache|early night|graveyard|forbidden|on road|killstreak|danceable)\b/i;

const guess = name => {
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
  const axis = old?.axis ?? guess(p.name);
  cfg.playlists[p.id] = {
    name: p.name,
    axis,
    // Only genre and mood playlists receive automatic filing.
    target: old?.target ?? (axis === 'genre' || axis === 'mood'),
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
