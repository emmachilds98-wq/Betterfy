// The fixture library the audio engine tests share (a copy of
// test/audiocomponent.test.mjs's, which is a compact copy of
// test/intrinsic.test.mjs's): four families with a bucket each, plus crossover
// buckets so the artist graph is not empty, and over 50 tracks so the mirror
// predicate is live.
//
// Also used to regenerate test/fixtures/space-v4-golden.json, so it must stay
// deterministic: no clocks, no randomness.
export const FAMILIES = ['tech', 'deep', 'jungle', 'ambient'];

export function fixture() {
  const playlists = [], all = [];
  FAMILIES.forEach((fam, fi) => {
    const core = Array.from({ length: 6 }, (_, i) => ({ id: `${fam}-a${i}`, name: `${fam} artist ${i}` }));
    const letter = String.fromCharCode(65 + fi);
    const tracks = Array.from({ length: 15 }, (_, i) => {
      const orphan = i === 14, guest = i === 12 || i === 13;
      const a1 = orphan ? { id: `${fam}-o${i}a` } : guest ? { id: `${fam}-g${i}` } : core[i % 6];
      const a2 = orphan ? { id: `${fam}-o${i}b` } : core[(i + 2) % 6];
      const reg = orphan || i % 5 === 0 ? 'ZZAGG' : `GB${letter}${letter}${letter}`;
      const t = {
        id: `${fam}-t${i}`, name: `${fam} track ${i}`, artists: [a1, a2],
        albumId: `${fam}-al${i % 5}`, albumType: 'single', albumTracks: 2, trackNo: 1,
        released: '2020-03-01', duration_ms: 6 * 60000 + (i % 5) * 20000, explicit: false,
        isrc: `${reg}${20 + fi}${String(10000 + i).slice(0, 5)}`, popularity: 45 + (i % 5),
        added_at: new Date(Date.UTC(2025, fi, 1 + Math.floor(i / 5), 12, i % 5)).toISOString(),
      };
      all.push(t);
      return t;
    });
    playlists.push({ id: `p-${fam}`, name: fam, tracks });
  });
  const pick = (fam, from, to) => playlists.find(p => p.id === `p-${fam}`).tracks.slice(from, to);
  playlists.push({ id: 'p-favs', name: 'Favourites', tracks: [...pick('tech', 0, 5), ...pick('deep', 0, 5)] });
  playlists.push({ id: 'p-night', name: 'Late Night', tracks: [...pick('deep', 5, 9), ...pick('ambient', 0, 5)] });
  playlists.push({ id: 'p-bang', name: 'Bangers', tracks: [...pick('tech', 5, 9), ...pick('jungle', 0, 5)] });
  return { playlists, all };
}

/**
 * Drop every `version` key, and persist's `stamp` (the versions joined): the
 * golden pins behaviour, and E2 bumps the version on purpose.
 */
export function unversioned(x) {
  return JSON.parse(JSON.stringify(x), (k, v) => (k === 'version' || k === 'stamp' ? undefined : v));
}

/**
 * Everything the engine says about the fixture, for the byte-identical guard:
 * the serialised space (minus its clock), every placement with explanations,
 * the targeted variant, and a 5-fold placementAccuracy with rows.
 */
export async function engineSnapshot(root, lib = fixture()) {
  const { buildSpace, placements } = await import(`${root}/core/intrinsic/space.mjs`);
  const { serialiseSpace } = await import(`${root}/core/intrinsic/persist.mjs`);
  const { placementAccuracy } = await import(`${root}/core/validate/loo.mjs`);
  const targets = FAMILIES.map(f => `p-${f}`);
  const space = buildSpace(lib), targeted = buildSpace(lib, { targets });
  const { builtAt, ...serial } = serialiseSpace(space, lib);
  return unversioned({
    space: serial,
    placements: lib.all.map(t => placements(t, space, { limit: Infinity, why: true })),
    targeted: lib.all.map(t => placements(t, targeted, { limit: Infinity })),
    accuracy: placementAccuracy(lib, { collect: true }),
    accuracyTargeted: placementAccuracy(lib, { targets: new Set(targets), collect: true }),
  });
}
