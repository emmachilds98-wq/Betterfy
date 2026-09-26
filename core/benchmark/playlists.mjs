// Playlist-level benchmark — §26's "playlist-type accuracy" and §37.
//
// Same shape and same reasoning as the track benchmark: cases are synthetic
// reconstructions of failure modes that are real, each one naming what it
// stands for, run through the real pipeline rather than against hand-built
// fingerprints.
//
// The cases that matter most are the ones where the NAME and the MUSIC
// disagree, because that is the whole difference between v1's approach and
// this one — and the ones where the right answer is "this is several things",
// because forcing a single label is the playlist-level version of forcing a
// genre onto a track with divided evidence.
import { indexCaches, buildRegistry, profileLibrary, analysePlaylists } from '../engine.mjs';

const DAY = 86400000;
export const NOW = Date.UTC(2026, 0, 1);

let seq = 0;
const track = (artistKey, artistName, title, addedDaysAgo, released) => ({
  id: `bt${++seq}`, name: title, released,
  artists: [{ id: artistKey, name: artistName }],
  added_at: new Date(NOW - addedDaysAgo * DAY).toISOString(),
});

/** n tracks by a rotating cast, so artist concentration stays low by default. */
const pool = (n, artistKey, artistName, prefix, { addedDaysAgo = 500, released = '2021-01-01', casts = 5 } = {}) =>
  Array.from({ length: n }, (_, i) =>
    track(`${artistKey}${i % casts}`, `${artistName} ${i % casts}`, `${prefix} ${i}`, addedDaysAgo + i, released));

/** The artist tag clouds behind those pools — one cache, as v1 already keeps. */
export function buildFixtureLibrary() {
  const techHouse = pool(40, 'th', 'TH Artist', 'TH');
  const deepHouse = pool(20, 'dh', 'DH Artist', 'DH');
  const jungle    = pool(20, 'ju', 'Jungle Artist', 'JU', { released: '1996-01-01' });
  const sad       = pool(15, 'sad', 'Sad Artist', 'SAD');
  const oneArtist = pool(15, 'solo', 'Single Producer', 'SP', { casts: 1 });

  const tags = {};
  const put = (list, cloud) => { for (const t of list) tags[t.artists[0].id] = { tags: cloud, checkedAt: NOW }; };
  put(techHouse, [['tech house', 100], ['house', 60]]);
  put(deepHouse, [['deep house', 100], ['house', 70], ['chill', 80]]);
  put(jungle,    [['jungle', 100], ['drum and bass', 80]]);
  put(sad,       [['deep house', 100], ['melancholic', 95], ['sad', 90]]);
  put(oneArtist, [['tech house', 100], ['techno', 50]]);

  // Built over one weekend and never touched again — the vocabulary-free
  // event signal, on a playlist whose name gives nothing away.
  const weekender = techHouse.slice(20, 32).map((t, i) => ({
    ...t, added_at: new Date(NOW - 200 * DAY + i * 3600000).toISOString(),
  }));
  const event = [...techHouse.slice(0, 18), ...deepHouse.slice(0, 2)]
    .map(t => ({ ...t, added_at: new Date(NOW - 200 * DAY).toISOString() }));

  const lib = { playlists: [
    { id: 'p-th',      name: 'Tech House',              tracks: techHouse },
    { id: 'p-thfav',   name: 'Tech House — Favourites', tracks: techHouse.slice(0, 14) },
    { id: 'p-dh',      name: 'Deep House',              tracks: deepHouse },
    { id: 'p-ju',      name: 'Jungle',                  tracks: jungle },
    { id: 'p-judup',   name: 'Jungle Backup',           tracks: jungle },
    { id: 'p-event',   name: 'Fabric September 2025',   tracks: event },
    { id: 'p-weekend', name: 'Bangers',                 tracks: weekender },
    { id: 'p-mood',    name: 'Late Night',              tracks: sad },
    { id: 'p-artist',  name: 'Single Producer Sessions',tracks: oneArtist },
    // A real mix of two families, not one cloud naming two genres: the point
    // of the case is tracks that classify DIFFERENTLY, not tracks that are
    // each individually torn.
    { id: 'p-mixed',   name: 'Misc',                    tracks: [...techHouse.slice(32, 40), ...jungle.slice(8, 20)] },
    { id: 'p-lyric',   name: 'Lyricism',                tracks: deepHouse.slice(0, 14) },
    { id: 'p-inbox',   name: 'Discover Weekly',         tracks: jungle.slice(0, 12) },
  ], liked: [] };
  return { lib, tags };
}

/** @type {{id: string, why: string, expectType: string[], expectMusic?: string, expectTarget?: boolean}[]} */
export const CASES = [
  { id: 'p-th', why: 'A plain genre bucket, coherent throughout. The baseline case everything else is read against.',
    expectType: ['SUBGENRE', 'GENRE'], expectMusic: 'tech-house', expectTarget: true },
  { id: 'p-dh', why: 'A genre bucket whose tracks also carry a strong mood. The mood must not displace the genre.',
    expectType: ['SUBGENRE', 'GENRE'], expectMusic: 'deep-house', expectTarget: true },
  { id: 'p-event', why: 'The plan\'s worked example: an event playlist that is mostly a copy of a genre playlist. '
       + 'It must read as EVENT, not as the genre it is made of — v1 would model it as a filing destination.',
    expectType: ['EVENT'], expectMusic: 'tech-house', expectTarget: false },
  { id: 'p-weekend', why: 'An event playlist whose NAME gives nothing away — built in a weekend, untouched since. '
       + 'This is the one event signal that needs no vocabulary and so works for a library nobody tuned for.',
    expectType: ['EVENT'], expectTarget: false },
  { id: 'p-mood', why: 'Organised on when you play it, made of one genre. Every playlist is made of some genre, so '
       + 'the genre must not outvote the axis it is actually organised on.',
    expectType: ['OCCASION', 'MOOD', 'HYBRID'], expectMusic: 'deep-house', expectTarget: false },
  { id: 'p-artist', why: 'One producer, 100% of it. An artist playlist however its name reads.',
    expectType: ['ARTIST'], expectTarget: false },
  { id: 'p-mixed', why: 'Two comparable musical regions from different families. §17: a mixed playlist must not be '
       + 'forced into a single genre.',
    expectType: ['MIXED'], expectTarget: false },
  { id: 'p-lyric', why: 'A name organised on something tags cannot see. v1 needs a hand-written OVERRIDE entry per '
       + 'playlist for this; v3 must fall through to the content without one.',
    expectType: ['SUBGENRE', 'GENRE'], expectMusic: 'deep-house' },
  { id: 'p-inbox', why: 'A Spotify-generated inflow. Not a destination, whatever is in it this week.',
    expectType: ['INBOX'], expectTarget: false },
];

/** @type {{kind: string, between: [string, string], why: string}[]} */
export const RELATIONSHIP_CASES = [
  { kind: 'duplicate', between: ['p-ju', 'p-judup'],
    why: 'Same tracks in both. The easy case, and the one that must never be reported as anything subtler.' },
  { kind: 'view', between: ['p-th', 'p-thfav'],
    why: '§19: one musical identity seen twice. Detected from the name being the other plus a qualifier, '
       + 'which needs no understanding of what "Favourites" means.' },
  { kind: 'event-copy', between: ['p-th', 'p-event'],
    why: '§18: structurally a subset, and only the smaller one\'s TYPE distinguishes it from a plain subset.' },
];

export function run({ now = NOW } = {}) {
  const { lib, tags } = buildFixtureLibrary();
  const idx = indexCaches({ lastfm: tags, now });
  const profiles = profileLibrary(lib, idx, { registry: buildRegistry(idx.present), now });
  const analysis = analysePlaylists(lib, profiles, { now });

  const results = CASES.map(c => {
    const cls = analysis.classifications.get(c.id);
    const checks = [
      { name: 'type', ok: c.expectType.includes(cls?.type),
        detail: `expected ${c.expectType.join('/')}, got ${cls?.type}` },
    ];
    if (c.expectMusic !== undefined)
      checks.push({ name: 'musical identity', ok: cls?.musicalIdentity.primary === c.expectMusic,
                    detail: `expected ${c.expectMusic}, got ${cls?.musicalIdentity.primary ?? 'nothing'}` });
    if (c.expectTarget !== undefined)
      checks.push({ name: 'filing target', ok: cls?.isTarget === c.expectTarget,
                    detail: `expected ${c.expectTarget}, got ${cls?.isTarget}` });
    return { id: c.id, name: cls?.name ?? c.id, why: c.why, checks, pass: checks.every(k => k.ok) };
  });

  const relResults = RELATIONSHIP_CASES.map(c => {
    const found = analysis.relationships.find(r =>
      [r.a.id, r.b.id].sort().join() === [...c.between].sort().join());
    return { id: c.between.join(' <-> '), why: c.why,
             checks: [{ name: 'relationship', ok: found?.kind === c.kind,
                        detail: `expected ${c.kind}, got ${found?.kind ?? 'nothing'}` }],
             pass: found?.kind === c.kind };
  });

  const all = [...results, ...relResults];
  return {
    analysis, results, relResults,
    cases: all.length,
    passed: all.filter(r => r.pass).length,
    typeAccuracy: +(results.filter(r => r.checks[0].ok).length / results.length).toFixed(3),
    relationshipAccuracy: +(relResults.filter(r => r.pass).length / relResults.length).toFixed(3),
  };
}

function main() {
  const r = run();
  console.log('=== BETTERFY PLAYLIST BENCHMARK ===\n');
  for (const res of [...r.results, ...r.relResults]) {
    console.log(`${res.pass ? 'PASS' : 'FAIL'}  ${res.name ?? res.id}`);
    for (const k of res.checks) if (!k.ok || process.argv.includes('-v')) console.log(`        ${k.ok ? 'ok  ' : 'BAD '} ${k.name}: ${k.detail}`);
  }
  console.log(`\n${r.passed}/${r.cases} cases passed`);
  console.log(`  playlist type accuracy   ${r.typeAccuracy}`);
  console.log(`  relationship accuracy    ${r.relationshipAccuracy}`);
  console.log('\n  collections found (§19):');
  for (const c of r.analysis.collections)
    console.log(`    ${c.parent.name}` + c.views.map(v => `\n       -> ${v.name} (${v.kind})`).join(''));
  if (r.passed < r.cases) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) main();
