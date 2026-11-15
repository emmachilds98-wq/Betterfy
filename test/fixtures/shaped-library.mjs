// A synthetic library shaped like the owner's (docs/SMARTER-GENRES-PLAN.md,
// "why the account-native engine trails tags"): genre playlists of very uneven
// size (7 to 60 tracks), most artists in one playlist only, a few wide
// playlists of one-track artists, and record shape that differs more between
// scene families than within one. Deterministic: same library every run.
//
// Used by test/weightfit.test.mjs to check that fitting the component weights
// on held-out folds finds what the hand experiment found (the graph should
// count for more), and to measure the wide-playlist fix honestly.

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9 >>> 0) / 2 ** 32);
}

/** Family shapes: era, minutes, release type, album size, popularity. */
const FAMILY = [
  { year: 2021, min: 6.0, album: 0.1, pop: 30 },   // club
  { year: 2019, min: 3.4, album: 0.6, pop: 55 },   // rap
  { year: 2015, min: 4.0, album: 0.7, pop: 45 },   // indie
  { year: 2022, min: 3.0, album: 0.3, pop: 60 },   // pop-ish
  { year: 2005, min: 5.0, album: 0.4, pop: 25 },   // older dance
];

/**
 * @param {object} [o]
 * @param {number} [o.seed]
 * @param {number} [o.playlists]  how many genre playlists
 * @returns {{ playlists, liked, targets: string[], bridge: object }}
 */
export function shapedLibrary({ seed = 11, playlists: P = 29 } = {}) {
  const r = rng(seed);
  const pick = a => a[Math.floor(r() * a.length)];
  const lists = [];
  let artistN = 0, trackN = 0;
  const artistsOf = new Map();          // playlist index → [artist]
  const homeOf = new Map();             // artist id → playlist indexes
  for (let p = 0; p < P; p++) {
    const fam = p % FAMILY.length;
    // Uneven sizes: a few wide playlists, many small ones.
    const wide = p % 6 === 0;
    const size = wide ? 40 + Math.floor(r() * 20) : 7 + Math.floor(r() * 18);
    lists.push({ id: `pl-${String(p).padStart(2, '0')}`, name: `Genre ${p}`, fam, wide, size, tracks: [] });
    // Wide playlists are one or two tracks per artist; narrow ones a handful of artists.
    const nArtists = wide ? Math.ceil(size * 0.85) : Math.max(2, Math.ceil(size / 3.5));
    const list = [];
    for (let i = 0; i < nArtists; i++) {
      // Labels are shared across a family's playlists (eight per family), so a
      // registrant hints at the scene, not at the playlist.
      const a = { id: `art${String(artistN++).padStart(4, '0')}`.padEnd(22, 'x'), label: `GB${'QRSTU'[fam]}${'ABCDEFGH'[Math.floor(r() * 8)]}X` };
      a.name = `Artist ${a.id.slice(3, 7)}`;
      list.push(a);
      homeOf.set(a.id, [p]);
    }
    artistsOf.set(p, list);
  }
  // ~15% of artists also live in one sibling playlist of the same family.
  for (let p = 0; p < P; p++) {
    for (const a of artistsOf.get(p)) {
      if (r() < 0.15) {
        const sibs = lists.filter((l, q) => q !== p && l.fam === lists[p].fam);
        if (!sibs.length) continue;
        const q = lists.indexOf(pick(sibs));
        artistsOf.get(q).push(a);
        homeOf.get(a.id).push(q);
      }
    }
  }
  const mkTrack = (a, fam) => {
    const f = FAMILY[fam];
    const album = r() < f.album;
    const year = f.year + Math.round((r() - 0.5) * 14);
    trackN++;
    return {
      id: `trk${String(trackN).padStart(5, '0')}`, name: `Track ${trackN}`,
      artists: [{ id: a.id, name: a.name }],
      albumType: album ? 'album' : 'single', albumTracks: album ? 10 + Math.floor(r() * 6) : 1 + Math.floor(r() * 3),
      trackNo: 1, released: `${year}-0${1 + Math.floor(r() * 9)}-01`,
      duration_ms: Math.round((f.min + (r() - 0.5) * 2.4) * 60000), popularity: Math.max(0, Math.min(100, Math.round(f.pop + (r() - 0.5) * 30))),
      isrc: `${r() < 0.5 ? a.label : 'ZZAGG'}${String(year).slice(2)}${String(10000 + Math.floor(r() * 89999))}`,
      added_at: new Date(Date.UTC(2024, Math.floor(r() * 12), 1 + Math.floor(r() * 27))).toISOString(),
    };
  };
  for (let p = 0; p < P; p++) {
    const l = lists[p], arts = artistsOf.get(p);
    for (let i = 0; i < l.size; i++) l.tracks.push(mkTrack(arts[i % arts.length], l.fam));
  }
  // Liked songs: some by filed artists, some by artists never filed.
  const liked = [];
  for (let i = 0; i < 40; i++) {
    const p = Math.floor(r() * P);
    liked.push(mkTrack(pick(artistsOf.get(p)), lists[p].fam));
  }
  // A similar-artist bridge: each artist's neighbours are mostly from its own
  // playlist, some from the same family, a few noise.
  const neighbours = {};
  const all = [...homeOf.keys()];
  for (const [aid, homes] of homeOf) {
    const own = artistsOf.get(homes[0]).filter(x => x.id !== aid);
    const fam = lists[homes[0]].fam;
    const famArts = lists.filter(l => l.fam === fam).flatMap((l) => artistsOf.get(lists.indexOf(l)));
    const out = new Map();
    for (let k = 0; k < 6; k++) {
      const x = r();
      const n = x < 0.55 && own.length ? pick(own).id : x < 0.85 ? pick(famArts).id : pick(all);
      if (n !== aid) out.set(n, +(1 - k / 6).toFixed(4));
    }
    if (r() < 0.85) neighbours[aid] = [...out];
  }
  const playlists = lists.map(({ id, name, tracks }) => ({ id, name, tracks }));
  return { playlists, liked, targets: playlists.map(p => p.id),
           bridge: { version: '1.0.0', neighbours, coverage: { asked: all.length, deezer: 0, listenbrainz: 0, withNeighbours: Object.keys(neighbours).length } } };
}
