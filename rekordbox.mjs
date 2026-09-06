// Import tempo and musical key from a Rekordbox collection export.
//
//   node rekordbox.mjs "C:\path\to\collection.xml"        # dry run + match report
//   node rekordbox.mjs "C:\path\to\collection.xml" --write # write rekordbox.json
//
// Why this and not an API: Spotify removed audio-features, GetSongBPM covered
// 20% of this library when measured over a 40-track sample, and Deezer's bpm
// field was empty for 4 of 5 tested tracks. Rekordbox has already analysed
// every file in the collection, and its values are the ones actually used to
// mix, so they beat any third-party guess.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { norm, baseTitle, versionOf } from './norm.mjs';

const file = process.argv[2];
const WRITE = process.argv.includes('--write');
if (!file || !existsSync(file)) {
  console.error('Usage: node rekordbox.mjs "<collection.xml>" [--write]');
  process.exit(1);
}

/* ---------- XML ----------
 * Rekordbox writes TRACK as a single self-closing-ish element whose data all
 * lives in attributes, so a full XML parser is not needed — but attribute
 * values are entity-escaped and can contain '>', so scan attributes properly
 * rather than splitting on '>'.
 */
const ENT = { '&amp;':'&', '&lt;':'<', '&gt;':'>', '&quot;':'"', '&apos;':"'", '&#38;':'&' };
const unesc = s => s.replace(/&(amp|lt|gt|quot|apos|#38);/g, m => ENT[m] ?? m);

function trackElements(xml) {
  const out = [];
  const re = /<TRACK\b/g;
  let m;
  while ((m = re.exec(xml))) {
    // Walk to the end of the open tag, respecting quoted attribute values.
    let i = m.index + 6, inQ = false;
    for (; i < xml.length; i++) {
      const c = xml[i];
      if (c === '"') inQ = !inQ;
      else if (c === '>' && !inQ) break;
    }
    out.push(xml.slice(m.index, i));
  }
  return out;
}

const attrs = tag => {
  const o = {};
  for (const m of tag.matchAll(/([A-Za-z_][\w.:-]*)="([^"]*)"/g)) o[m[1]] = unesc(m[2]);
  return o;
};

/* ---------- key notation ----------
 * Rekordbox's Tonality follows whatever key display the user has set: classical
 * ("Am", "F#"), Camelot ("8A"), or Open Key ("1m"). Normalise all three to
 * Camelot, which is what harmonic mixing actually uses.
 */
const CAMELOT = {
  // minor -> A side
  'am':'8A','em':'9A','bm':'10A','f#m':'11A','gbm':'11A','c#m':'12A','dbm':'12A',
  'g#m':'1A','abm':'1A','d#m':'2A','ebm':'2A','a#m':'3A','bbm':'3A','fm':'4A',
  'cm':'5A','gm':'6A','dm':'7A',
  // major -> B side
  'c':'8B','g':'9B','d':'10B','a':'11B','e':'12B','b':'1B','f#':'2B','gb':'2B',
  'db':'3B','c#':'3B','ab':'4B','g#':'4B','eb':'5B','d#':'5B','bb':'6B','a#':'6B','f':'7B',
};

function toCamelot(raw) {
  if (!raw) return null;
  let s = String(raw).trim().replace(/♯/g, '#').replace(/♭/g, 'b');
  if (/^\d{1,2}[AB]$/i.test(s)) return s.toUpperCase();          // already Camelot
  const open = s.match(/^(\d{1,2})([md])$/i);                    // Open Key: 1m / 1d
  if (open) return open[1] + (open[2].toLowerCase() === 'm' ? 'A' : 'B');
  const k = s.toLowerCase().replace(/\s+/g, '').replace(/min$/, 'm').replace(/maj$/, '');
  return CAMELOT[k] ?? null;
}

/* ---------- read the collection ---------- */
const xml = readFileSync(file, 'utf8');
const tags = trackElements(xml);
const rb = [];
for (const t of tags) {
  const a = attrs(t);
  if (!a.Name) continue;
  const bpm = a.AverageBpm ? Math.round(parseFloat(a.AverageBpm) * 100) / 100 : null;
  rb.push({
    name: a.Name, artist: a.Artist ?? '', album: a.Album ?? '',
    bpm: bpm && bpm > 0 ? bpm : null,
    key: a.Tonality || null,
    camelot: toCamelot(a.Tonality),
    seconds: a.TotalTime ? +a.TotalTime : null,
    genre: a.Genre || null,
    rating: a.Rating ? +a.Rating : null,
    playCount: a.PlayCount ? +a.PlayCount : null,
  });
}

const withBpm = rb.filter(r => r.bpm);
const withKey = rb.filter(r => r.camelot);
console.log(`rekordbox collection: ${rb.length} tracks`);
console.log(`  with tempo : ${withBpm.length}`);
console.log(`  with key   : ${withKey.length}${withKey.length ? ` (e.g. ${withKey[0].key} -> ${withKey[0].camelot})` : ''}`);
if (!rb.length) {
  console.error('\nNo TRACK elements found — is this a Rekordbox collection export?');
  process.exit(1);
}

/* ---------- match to the Spotify library ---------- */
if (!existsSync('library.json')) {
  console.log('\nNo library.json yet — run: npm run snapshot');
  process.exit(0);
}
const lib = JSON.parse(readFileSync('library.json', 'utf8'));

const spotify = new Map();
const add = t => { if (t?.id && !spotify.has(t.id)) spotify.set(t.id, t); };
for (const p of lib.playlists) p.tracks.forEach(add);
lib.liked.forEach(add);

// Index rekordbox by two keys: exact (artist + title + version) and a looser
// artist + base-title, so an "(Extended Mix)" on one side still finds its pair
// but only after the exact form has had its chance.
const exact = new Map(), loose = new Map();
for (const r of rb) {
  const a = norm(r.artist.split(/\s*(?:,|&|feat\.?|ft\.?|vs\.?)\s*/i)[0] ?? '');
  const eK = a + '|' + baseTitle(r.name) + '|' + versionOf(r.name);
  const lK = a + '|' + baseTitle(r.name);
  if (!exact.has(eK)) exact.set(eK, r);
  if (!loose.has(lK)) loose.set(lK, r);
}

const matched = {}, unmatchedSpotify = [];
let nExact = 0, nLoose = 0;
for (const [id, t] of spotify) {
  const a = norm(t.artists?.[0]?.name ?? '');
  const eK = a + '|' + baseTitle(t.name) + '|' + versionOf(t.name);
  const lK = a + '|' + baseTitle(t.name);
  let hit = exact.get(eK), how = 'exact';
  if (!hit) { hit = loose.get(lK); how = 'loose'; }
  if (!hit || (!hit.bpm && !hit.camelot)) { unmatchedSpotify.push(t); continue; }
  how === 'exact' ? nExact++ : nLoose++;
  matched[id] = { bpm: hit.bpm, key: hit.key, camelot: hit.camelot, match: how,
                  rbName: hit.name, rbArtist: hit.artist };
}

const n = Object.keys(matched).length;
console.log(`\nmatched to Spotify: ${n} of ${spotify.size} library tracks (${(100*n/spotify.size).toFixed(1)}%)`);
console.log(`  exact title+version : ${nExact}`);
console.log(`  same song, other cut: ${nLoose}`);

console.log('\n--- 12 matches ---');
for (const [id, m] of Object.entries(matched).slice(0, 12)) {
  const t = spotify.get(id);
  console.log(`  ${String(m.bpm ?? '—').padStart(6)} ${String(m.camelot ?? '—').padEnd(4)} ${t.artists?.[0]?.name} — ${t.name}`);
}

if (WRITE) {
  writeFileSync('rekordbox.json', JSON.stringify(matched, null, 2));
  console.log(`\nwrote rekordbox.json — ${n} tracks with tempo/key`);
} else {
  console.log('\nDRY RUN — add --write to save rekordbox.json');
}
