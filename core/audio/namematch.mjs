// F1 (docs/SOUND-ENGINE-PLAN.md): when the ISRC is not on Deezer, look the
// track up there by artist and title instead, and accept only a result that is
// plainly the same recording. Phase 0 saw a loose name match pick the wrong
// track 1 time in 19, so every test here is a way to say no:
//   - the artist is identical after folding case, accents and punctuation (any
//     one of the Spotify track's credited artists; "A & B" is not "A");
//   - the title is identical after dropping only the suffixes that do not
//     change the recording ("(Original Mix)", "(feat. X)", "- Remastered 2011");
//     a remix, live, acoustic, edit or instrumental stays in the title, so it
//     must be on both sides or neither;
//   - the duration is within +/-1 s (Deezer states whole seconds), tighter than
//     the ISRC path's 3 s because there is no ISRC to vouch for it;
//   - more than one *different* recording passing all three is ambiguous, and
//     ambiguous is a no.
// Pure: no network. fetch.mjs lookup() sends the query and calls pickByName().

/** Deezer duration vs Spotify duration when matching by name. */
export const NAME_TOLERANCE_MS = 1000;

/** Words that make a recording another one. Both sides must agree on this set. */
const VERSION_WORDS = /\b(remix|mix|live|acoustic|instrumental|karaoke|cover|tribute|edit|version|demo|vip|bootleg|mashup|rework|dub|sped up|slowed|reverb|session|unplugged|reprise|medley|a cappella|acapella)\b/g;
/** Suffixes that name the same recording and are dropped before comparing. */
const SAME_RECORDING = /\s*[([-]\s*(original mix|original version|album version|full length version|remaster(ed)?( \d{4})?|\d{4} remaster(ed)?( version)?|mono|stereo)\s*[)\]]?\s*$/i;
const FEAT = /\s*[([]\s*(feat\.?|ft\.?|featuring|with)\s[^)\]]*[)\]]|\s+-\s+(feat\.?|ft\.?|featuring)\s.*$/ig;

/** Title with only the harmless decorations removed, original case kept (the query uses it). */
export function cleanTitle(s) {
  let t = String(s ?? '').replace(FEAT, '').trim();
  for (let i = 0; i < 2; i++) t = t.replace(SAME_RECORDING, '').trim();
  return t;
}

/** Fold case, accents, "&", punctuation and spacing. */
export function fold(s) {
  return String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9Ѐ-ӿ぀-ヿ一-鿿]+/g, ' ').replace(/\s+/g, ' ').trim();
}
export const normTitle = s => fold(cleanTitle(s));
export const normArtist = s => fold(s);

const versionTags = s => new Set(String(s).match(VERSION_WORDS) ?? []);
const sameSet = (a, b) => a.size === b.size && [...a].every(x => b.has(x));

/**
 * Is this Deezer search hit the Spotify track? Returns the reason it is not, or null.
 * @param {{ title: string, artists: string[], durationMs?: number }} want
 * @param {object} hit  a Deezer track object from /search
 */
export function rejectReason(want, hit) {
  if (!hit?.id || !hit.title) return 'malformed';
  const names = (want.artists ?? []).map(normArtist).filter(Boolean);
  if (!names.length || !names.includes(normArtist(hit.artist?.name))) return 'artist';
  const full = hit.title_version && !String(hit.title).toLowerCase().includes(String(hit.title_version).toLowerCase())
    ? `${hit.title} ${hit.title_version}` : hit.title;
  const a = normTitle(want.title), b = normTitle(full);
  if (!a || a !== b) return 'title';
  if (!sameSet(versionTags(a), versionTags(b))) return 'version';
  const ms = Number(hit.duration) * 1000;
  if (!Number.isFinite(want.durationMs) || !(ms > 0)) return 'duration';
  if (Math.abs(ms - want.durationMs) > NAME_TOLERANCE_MS) return 'duration';
  return null;
}

/**
 * The one hit that is the same recording, or `{ none: true }`. Hits with no
 * preview are dropped last, so "same track but no clip" is told apart from "not
 * found". Passing hits of different durations are different recordings, so the
 * answer is ambiguous and refused.
 * @returns {{ hit: object, deltaMs: number } | { none: true, ambiguous?: boolean, noPreview?: boolean }}
 */
export function pickByName(want, hits) {
  const ok = (Array.isArray(hits) ? hits : []).filter(h => rejectReason(want, h) === null);
  if (!ok.length) return { none: true };
  const usable = ok.filter(h => h.preview && h.readable !== false);
  if (!usable.length) return { none: true, noPreview: true };
  // Re-issues of one master share a duration to the second; others are other recordings.
  if (new Set(usable.map(h => Number(h.duration))).size > 1) return { none: true, ambiguous: true };
  const hit = usable[0];
  return { hit, deltaMs: Math.abs(Number(hit.duration) * 1000 - want.durationMs) };
}

/** Percent-encode everything, including the characters encodeURIComponent leaves (! ' ( ) * ~ .). */
const enc = s => encodeURIComponent(s).replace(/[!'()*~.]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/** `search?q=artist:"…" track:"…"`, quotes dropped from the values. */
export function searchUrl(artist, title, api = 'https://api.deezer.com') {
  const q = `artist:"${String(artist).replace(/"/g, ' ').trim()}" track:"${cleanTitle(title).replace(/"/g, ' ').trim()}"`;
  return `${api}/search?q=${enc(q)}&limit=15`;
}
