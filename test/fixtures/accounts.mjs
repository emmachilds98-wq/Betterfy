// Synthetic non-owner Spotify libraries (BUILD-6 M5). Nothing here is a real
// listener's data: every name is invented from syllables, every track id,
// playlist id and ISRC is fabricated, and the only real things are the artist
// ids borrowed from docs/tags.json so that genre suggestions behave as they
// would for a real account (the same trick scripts/ui-shots/shots.cjs plays).
//
// Deterministic: the same seed gives the same library, byte for byte.
//
//   makeAccount('empty' | 'small' | 'typical' | 'large') ->
//     { me, playlists: [{ id, name, owner, snapshot_id, tracks }], liked: [track] }
//
//   empty    nothing at all (a brand-new account)
//   small    3 playlists with NO genre in their names, ~40 liked songs
//   typical  ~700 tracks over 14 genre-named playlists, ~175 liked
//   large    5,000+ liked songs, 60 playlists
import { readFileSync } from 'node:fs';

const TAGS = JSON.parse(readFileSync(new URL('../../docs/tags.json', import.meta.url), 'utf8'));
const GENRES = ['drum and bass', 'jungle', 'house', 'techno', 'ambient', 'hip hop', 'uk garage', 'indie',
  'rock', 'jazz', 'classical', 'pop', 'folk', 'metal', 'reggae', 'soul'];

function rng(seed) { let s = seed; return () => (s = (s * 16807) % 2147483647) / 2147483647; }
const SYL = ['ka', 'ro', 'mi', 'dex', 'vel', 'an', 'tor', 'lu', 'sen', 'ray', 'fo', 'zi', 'nor', 'bel', 'quin'];
const cap = s => s[0].toUpperCase() + s.slice(1);

export const ACCOUNT_KINDS = ['empty', 'small', 'typical', 'large'];

export function makeAccount(kind, seed = 11) {
  const rnd = rng(seed);
  const word = n => Array.from({ length: n }, () => SYL[Math.floor(rnd() * SYL.length)]).join('');
  const byGenre = {};
  for (const id of Object.keys(TAGS)) (byGenre[TAGS[id]?.[0]?.[0]] ??= []).push(id);
  const anyIds = Object.keys(TAGS);
  const artists = {};
  const artist = id => artists[id] ??= { id, name: cap(word(2)) };
  let n = 0, p = 0;
  const track = aid => {
    n++;
    return { id: 'fx' + String(n).padStart(20, '0'), name: cap(word(2)), popularity: 40,
      duration_ms: 180000 + Math.floor(rnd() * 120000), explicit: false,
      external_ids: { isrc: 'XX' + String(n).padStart(10, '0') }, track_number: 1,
      album: { id: 'al' + n, name: cap(word(2)), release_date: String(2000 + Math.floor(rnd() * 24)), album_type: 'album', images: [] },
      artists: [artist(aid)] };
  };
  const pool = g => byGenre[g]?.length ? byGenre[g] : anyIds;
  const me = { id: 'fixture-user', display_name: 'Fixture listener' };
  const pl = (name, tracks) => ({ id: 'plfx' + String(++p).padStart(6, '0'), name, owner: { id: me.id }, snapshot_id: 's1', tracks });
  const out = { me, playlists: [], liked: [] };
  if (kind === 'empty') return out;

  if (kind === 'small') {
    // Playlists named for moods, not genres: filing has to go on artists alone.
    const moods = [['Late Night', 'ambient'], ['Gym', 'techno'], ['Sunday', 'indie']];
    for (const [name, g] of moods) out.playlists.push(pl(name, pool(g).slice(0, 8).map(track)));
    for (const [, g] of moods) for (const id of pool(g).slice(20, 33)) out.liked.push(track(id));
    out.liked.push(...out.playlists.flatMap(x => x.tracks.slice(0, 1)));
    return out;
  }
  if (kind !== 'typical' && kind !== 'large') throw new Error('unknown account kind ' + kind);
  const typical = kind === 'typical';
  const nPl = typical ? 14 : 60, per = typical ? 50 : 40;
  for (let i = 0; i < nPl; i++) {
    const g = GENRES[i % GENRES.length], ids = pool(g);
    const tr = Array.from({ length: per }, (_, k) => track(ids[(i * 7 + k) % ids.length]));
    out.playlists.push(pl(i < GENRES.length ? cap(g) : `${cap(g)} ${i}`, tr));
  }
  const likedN = typical ? 150 : 5000;
  for (let k = 0; k < likedN; k++) {
    const g = GENRES[k % GENRES.length], ids = pool(g);
    out.liked.push(track(ids[(k * 3 + 50) % ids.length]));
  }
  // A real library's liked songs also include things already filed.
  for (const x of out.playlists.slice(0, 5)) out.liked.push(...x.tracks.slice(0, 5));
  return out;
}
