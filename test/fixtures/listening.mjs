// Synthetic listening for the non-owner fixtures (accounts.mjs): what
// fetchListeningRaw() would hold for that account. Invented, deterministic,
// and shaped like real listening rather than like library order:
//
//   short_term   50 artists, mostly from the most recently liked fifth
//   medium_term  50 artists, from the most recently liked half
//   long_term    50 artists, from anywhere, favouring artists you own a lot of
//   recent       50 plays, mostly short-term artists, some repeats
//
// Real listening has the same property this relies on: what you play this
// month is not what sits at the top of your oldest playlist.
function rng(seed) { let s = seed; return () => (s = (s * 16807) % 2147483647) / 2147483647; }

/** @returns {{ topWindows, recentArtists, topTracks: [], recentTracks: [] }} */
export function makeListening(acc, seed = 7) {
  const rnd = rng(seed);
  const liked = acc.liked ?? [];
  const names = list => list.map(t => t.artists?.[0]?.name).filter(Boolean);
  const all = names([...acc.playlists.flatMap(p => p.tracks ?? []), ...liked]);
  if (!all.length) return { topWindows: [], recentArtists: [], topTracks: [], recentTracks: [] };
  const count = new Map();
  for (const n of all) count.set(n, (count.get(n) ?? 0) + 1);
  // Liked songs come newest first from Spotify; the fixture appends, so its tail is "recent".
  const tail = frac => names(liked.slice(Math.floor(liked.length * (1 - frac))));
  const draw = (pool, n, byCount = false) => {
    const out = [], seen = new Set();
    const bag = byCount ? pool.flatMap(x => Array(Math.min(8, count.get(x) ?? 1)).fill(x)) : pool;
    for (let tries = 0; out.length < n && tries < n * 50 && bag.length; tries++) {
      const x = bag[Math.floor(rnd() * bag.length)];
      if (!seen.has(x)) { seen.add(x); out.push(x); }
    }
    return out;
  };
  const short = draw(tail(0.2).length ? tail(0.2) : all, 50);
  const medium = draw(tail(0.5).length ? tail(0.5) : all, 50);
  const long = draw([...count.keys()], 50, true);
  const recentArtists = Array.from({ length: 50 }, () => (rnd() < 0.8 ? short : long)[Math.floor(rnd() * 20)]).filter(Boolean);
  return {
    topWindows: [{ range: 'short_term', weight: 3, items: short },
                 { range: 'medium_term', weight: 2, items: medium },
                 { range: 'long_term', weight: 1.5, items: long }],
    recentArtists, topTracks: [], recentTracks: [],
  };
}

/**
 * The fixture account with every artist's name made unique. accounts.mjs makes
 * names from two of fifteen syllables, so a large account has ~1,300 artists
 * over ~225 names; listening is keyed by name (as Spotify's top-artists answer
 * is read), and on real libraries two artists sharing a name is rare. Copied,
 * never mutated.
 */
export function withUniqueNames(acc) {
  const copy = JSON.parse(JSON.stringify(acc));
  for (const t of [...copy.playlists.flatMap(p => p.tracks ?? []), ...(copy.liked ?? [])])
    for (const a of t.artists ?? []) if (a?.id) a.name = `${a.name} ${a.id}`;
  return copy;
}
