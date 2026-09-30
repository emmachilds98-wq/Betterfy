import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprint, entropy, artistConcentration, addedShape, consensusGenre, centroidOf } from '../core/playlists/fingerprint.mjs';
import { clusterTracks, clusterVerdict, describeCluster } from '../core/playlists/clustering.mjs';
import { readName, conceptsIn, datesIn, splitQualifier, unaccountedWords } from '../core/playlists/name.mjs';
import { classifyPlaylist, libraryBaseline } from '../core/playlists/classify.mjs';
import { overlap, viewOf, relate, findRelationships, collections } from '../core/playlists/relationships.mjs';
import { run as runPlaylistBenchmark, buildFixtureLibrary, NOW } from '../core/benchmark/playlists.mjs';
import { indexCaches, buildRegistry, profileLibrary, analysePlaylists, nameVsMusic } from '../core/engine.mjs';

/* ---------- names: the part that has to generalise ---------- */

/*
 * v1 reads playlist names through a regex naming Drumsheds, Fabric,
 * Printworks and E1, plus an OVERRIDE table of one person's exact playlist
 * titles. It is an excellent classifier for one library and worth nothing for
 * the next account. These tests exist to keep the replacement honest.
 */

test('no venue, festival or playlist name appears in the name rules', async () => {
  const src = await import('node:fs').then(fs => fs.readFileSync('core/playlists/name.mjs', 'utf8'));
  // Comments stripped first: the module explains what v1 gets wrong by naming
  // the venues v1 hard-codes, and banning the explanation would be silly. It
  // is a venue in the CODE that would make this module one library's.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const banned of ['fabric', 'drumsheds', 'printworks', 'glastonbury', 'coachella',
                        'tomorrowland', 'creamfields', 'boiler room', 'ministry'])
    assert.ok(!code.toLowerCase().includes(banned),
      `"${banned}" is in the name rules — that is one library's vocabulary, not a general one`);
});

test('an event is recognised by shape, not by knowing the venue', () => {
  // The universal form: a date, plus a word nothing else can account for.
  for (const name of ['Fabric September 2026', 'Warehouse 12.04', 'Some Club Night 04/25']) {
    const dims = readName(name).dimensions.map(d => d.kind);
    assert.ok(dims.includes('event'), `${name} should read as an event`);
  }
  // A date with nothing unaccounted for is an era or a context, not an event.
  assert.ok(!readName('Summer 2026').dimensions.some(d => d.kind === 'event'));
  assert.ok(!readName('1994').dimensions.some(d => d.kind === 'event'));
});

test('the ontology reads the name, so the vocabulary is global', () => {
  assert.equal(readName('Tech House').dimensions[0].value, 'tech-house');
  assert.equal(readName('Drum & Bass').dimensions[0].value, 'drum-and-bass');
  assert.deepEqual(readName('Summer 2026').dimensions.map(d => d.kind).sort(), ['context', 'era']);
  // Multi-dimensional, per §15 — neither answer alone is right.
  assert.deepEqual(readName('Nostalgia Rock').dimensions.map(d => `${d.kind}:${d.value}`).sort(),
    ['era:retro', 'genre:rock']);
});

test('a suffix inference does not swallow the words in front of it', () => {
  // "dark techno" as a provider tag means techno; as a playlist NAME it is a
  // techno playlist with a mood qualifier, and both halves are wanted.
  assert.deepEqual(readName('Dark Techno').dimensions.map(d => `${d.kind}:${d.value}`).sort(),
    ['genre:techno', 'mood:dark']);
});

test('a name that says nothing says so, rather than defaulting to genre', () => {
  const r = readName('Lyricism');
  assert.equal(r.silent, true, 'v1 needs a hand-written OVERRIDE entry for exactly this');
  assert.deepEqual(r.unaccounted, ['lyricism']);
  assert.equal(readName('Tech House').silent, false);
});

test('longest phrase wins, so a subgenre is not read as its parent', () => {
  const c = conceptsIn('Deep House Classics');
  assert.equal(c.find(x => x.facet === 'genre').concept, 'deep-house');
  assert.ok(!c.some(x => x.concept === 'house'), 'the parent must not also be claimed');
});

test('dates are read structurally', () => {
  assert.equal(datesIn('Fabric September 2026').year, 2026);
  assert.equal(datesIn('Fabric September 2026').specific, true);
  assert.equal(datesIn('Summer 2026').specific, false, 'a bare year is an era, not an occasion');
  assert.equal(datesIn('Warehouse 12.04').numeric, '12.04');
  assert.equal(datesIn('Tech House').any, false);
});

test('a qualifier is split off structurally, whatever the words are', () => {
  assert.deepEqual(splitQualifier('Tech House — Favourites'), { base: 'Tech House', qualifier: 'Favourites' });
  assert.deepEqual(splitQualifier('Jungle (old)'), { base: 'Jungle', qualifier: 'old' });
  assert.deepEqual(splitQualifier('Tech House'), { base: 'Tech House', qualifier: null });
});

test('a known artist is not counted as an unaccounted word', () => {
  const known = new Set(['burial']);
  assert.deepEqual(unaccountedWords('Burial 2026', { concepts: [], knownArtists: known }), []);
  assert.deepEqual(unaccountedWords('Warehouse 2026', { concepts: [], knownArtists: known }), ['warehouse']);
});

/* ---------- fingerprints ---------- */

test('a playlist is named from what its tracks were classified as, not from their ancestry', () => {
  // Forty identical Tech House tracks each contribute to tech-house, house
  // AND electronic. Summed, the parent outweighs the answer — which is how a
  // pure Tech House bucket used to report itself as "house".
  const dnas = Array.from({ length: 10 }, () => ({
    primaryGenre: 'tech-house', genreConfidence: 'LIKELY',
    genre: { 'tech-house': 0.51, house: 0.31, electronic: 0.18 }, mood: {}, context: {},
  }));
  const profiles = new Map(dnas.map((dna, i) => [`t${i}`, { dna, profile: {} }]));
  const fp = fingerprint({ id: 'p', name: 'Tech House', tracks: dnas.map((_, i) => ({ id: `t${i}`, artists: [{ name: `A${i}` }] })) }, profiles);
  assert.equal(fp.primaryGenre, 'tech-house');
  assert.equal(fp.genreEntropy, 0, 'a uniform playlist has no spread');
  assert.ok(fp.genre.house > 0, 'the lineage distribution is still kept, for comparing playlists');
});

test('a playlist split between families backs off to what they have in common', () => {
  assert.equal(consensusGenre({ 'tech-house': 0.6, 'deep-house': 0.4 }), 'tech-house', 'a majority is enough');
  assert.equal(consensusGenre({ 'tech-house': 0.34, 'deep-house': 0.33, 'disco-house': 0.33 }), 'house');
  assert.equal(consensusGenre({ 'tech-house': 0.5, jungle: 0.5 }), 'tech-house');
  assert.equal(consensusGenre({}), null);
});

test('entropy measures spread and is 0 for one thing', () => {
  assert.equal(entropy([1]), 0);
  assert.equal(entropy([0.5, 0.5]), 1);
  assert.ok(entropy([0.9, 0.1]) < 0.5);
  assert.equal(entropy([]), 0);
});

test('artist concentration separates an artist playlist from a genre one', () => {
  const one = artistConcentration(Array.from({ length: 10 }, () => ({ artists: [{ name: 'Solo' }] })));
  const many = artistConcentration(Array.from({ length: 10 }, (_, i) => ({ artists: [{ name: `A${i}` }] })));
  assert.equal(one.concentration, 1);
  assert.equal(one.distinct, 1);
  assert.ok(many.concentration < 0.2);
  assert.deepEqual(artistConcentration([]).top, []);
});

test('the added-date shape needs no vocabulary at all', () => {
  const day = 86400000, now = Date.UTC(2026, 0, 1);
  const burst = Array.from({ length: 12 }, (_, i) => ({ added_at: new Date(now - 200 * day + i * 3600000).toISOString() }));
  const shape = addedShape(burst, now);
  assert.ok(shape.spanDays < 1);
  assert.ok(shape.sinceDays > 190);
  assert.equal(addedShape([{ added_at: '2020-01-01' }], now), null, 'too few dates to say anything');
  assert.equal(addedShape([], now), null);
});

test('a fingerprint reports how much of the playlist it could actually describe', () => {
  const profiles = new Map([['t1', { dna: { primaryGenre: 'techno', genreConfidence: 'LIKELY', genre: { techno: 1 } }, profile: {} }]]);
  const tracks = Array.from({ length: 10 }, (_, i) => ({ id: `t${i + 1}`, artists: [{ name: 'A' }] }));
  const fp = fingerprint({ id: 'p', name: 'X', tracks }, profiles);
  assert.equal(fp.tracks, 10);
  assert.equal(fp.profiled, 1);
  assert.equal(fp.coverage, 0.1);
  assert.equal(fp.enoughToDescribe, false, 'one track out of ten is not a description of the playlist');
});

test('a playlist of uncertain tracks does not acquire a confident identity', () => {
  const dna = { primaryGenre: 'techno', genreConfidence: 'AMBIGUOUS', genre: { techno: 1 }, mood: {}, context: {} };
  const tracks = Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, artists: [{ name: `A${i}` }] }));
  const fp = fingerprint({ id: 'p', name: 'X', tracks }, new Map(tracks.map(t => [t.id, { dna, profile: {} }])));
  assert.equal(fp.confidentShare, 0, 'ten shrugs are not a confident playlist');
  assert.equal(fp.trackConfidence.AMBIGUOUS, 10);
});

test('centroidOf survives tracks with no genre at all', () => {
  assert.deepEqual(centroidOf([]), {});
  assert.deepEqual(centroidOf([{ genre: {} }, null]), {});
});

/* ---------- clustering ---------- */

const dnaOf = (id, genre) => ({ id, name: id, dna: { primaryGenre: genre, genre: { [genre]: 0.6, ...(genre.includes('house') ? { house: 0.4 } : {}) } } });

test('two musical regions are found rather than averaged into one', () => {
  const members = [...Array.from({ length: 6 }, (_, i) => dnaOf(`th${i}`, 'tech-house')),
                   ...Array.from({ length: 6 }, (_, i) => dnaOf(`ju${i}`, 'jungle'))];
  const clusters = clusterTracks(members);
  assert.equal(clusters.length, 2);
  assert.deepEqual(clusters.map(c => c.genre).sort(), ['jungle', 'tech-house']);
  assert.equal(clusterVerdict(clusters).shape, 'mixed');
});

test('a cluster is described by what its members have in common, not by the modal genre', () => {
  // Three of one and two of another must not be called "the first one".
  const d = describeCluster([dnaOf('a', 'tech-house'), dnaOf('b', 'tech-house'), dnaOf('c', 'deep-house')]);
  assert.equal(d.genre, 'house');
});

test('one family seen widely is broad; two families is mixed', () => {
  const broad = clusterTracks([...Array.from({ length: 6 }, (_, i) => dnaOf(`a${i}`, 'tech-house')),
                               ...Array.from({ length: 5 }, (_, i) => dnaOf(`b${i}`, 'deep-house'))]);
  assert.equal(clusterVerdict(broad).shape, 'broad', 'tech house beside deep house is one family');
  // …but sharing only a ROOT is not a family: that is the whole library.
  const mixed = clusterTracks([...Array.from({ length: 6 }, (_, i) => dnaOf(`a${i}`, 'techno')),
                               ...Array.from({ length: 6 }, (_, i) => dnaOf(`b${i}`, 'jungle'))]);
  assert.equal(clusterVerdict(mixed).shape, 'mixed');
  assert.equal(clusterVerdict([]).shape, 'unknown');
});

test('a long tail is not a second region', () => {
  const members = [...Array.from({ length: 20 }, (_, i) => dnaOf(`a${i}`, 'techno')),
                   ...Array.from({ length: 3 }, (_, i) => dnaOf(`b${i}`, 'jungle'))];
  assert.equal(clusterVerdict(clusterTracks(members)).shape, 'single');
});

test('clustering handles unprofiled input without throwing', () => {
  assert.deepEqual(clusterTracks([]), []);
  assert.deepEqual(clusterTracks(null), []);
  assert.deepEqual(clusterTracks([{ id: 'x' }, { id: 'y', dna: { genre: {} } }]), []);
});

/* ---------- relationships ---------- */

test('containment, not Jaccard, is what sees a small playlist inside a big one', () => {
  const small = new Set(['a', 'b', 'c']), big = new Set(['a', 'b', 'c', ...Array.from({ length: 27 }, (_, i) => `x${i}`)]);
  const ov = overlap(small, big);
  assert.equal(ov.ofA, 1, 'all of the small one is inside');
  assert.ok(ov.jaccard < 0.2, 'and Jaccard would have called that unrelated');
});

test('views of one collection are spotted structurally', () => {
  assert.deepEqual(viewOf('Tech House', 'Tech House — Favourites'), { parent: 'a', view: 'Favourites' });
  assert.deepEqual(viewOf('Tech House — Driving', 'Tech House'), { parent: 'b', view: 'Driving' });
  assert.equal(viewOf('Tech House', 'Deep House'), null);
});

test('an event copy and a plain subset differ only by the smaller one\'s type', () => {
  const shared = Array.from({ length: 18 }, (_, i) => ({ id: `s${i}` }));
  const big = { id: 'big', name: 'Tech House', tracks: [...shared, ...Array.from({ length: 22 }, (_, i) => ({ id: `b${i}` }))] };
  const small = { id: 'small', name: 'A Night Out', tracks: shared };
  const fp = { centroid: { 'tech-house': 1 }, primaryGenre: 'tech-house' };

  const asEvent = relate(big, small, { fpA: fp, fpB: fp, classA: { type: 'GENRE' }, classB: { type: 'EVENT' } });
  assert.equal(asEvent.kind, 'event-copy');
  assert.equal(asEvent.parentId, 'big');
  const asPlain = relate(big, small, { fpA: fp, fpB: fp, classA: { type: 'GENRE' }, classB: { type: 'GENRE' } });
  assert.equal(asPlain.kind, 'subset', 'identical structure, different answer — only the type separates them');
});

test('an artist or event playlist is not a "variant" of the genre it is made of', () => {
  const a = { id: 'a', name: 'Tech House', tracks: Array.from({ length: 20 }, (_, i) => ({ id: `a${i}` })) };
  const b = { id: 'b', name: 'Single Producer', tracks: Array.from({ length: 15 }, (_, i) => ({ id: `b${i}` })) };
  const fp = { centroid: { 'tech-house': 1 }, primaryGenre: 'tech-house' };
  // "related" is a fair thing to say about them — they are both tech house.
  // "variant" is not: it claims one continues the other.
  assert.notEqual(relate(a, b, { fpA: fp, fpB: fp, classA: { type: 'GENRE' }, classB: { type: 'ARTIST' } })?.kind,
    'variant', 'an artist playlist made of tech house is not a continuation of the tech house bucket');
  // Two genre buckets with the same profile and no shared tracks IS one.
  assert.equal(relate(a, b, { fpA: fp, fpB: fp, classA: { type: 'GENRE' }, classB: { type: 'GENRE' } })?.kind, 'variant');
});

test('sharing only a root genre is not a relationship', () => {
  const a = { id: 'a', name: 'A', tracks: Array.from({ length: 20 }, (_, i) => ({ id: `a${i}` })) };
  const b = { id: 'b', name: 'B', tracks: Array.from({ length: 20 }, (_, i) => ({ id: `b${i}` })) };
  const rel = relate(a, b, {
    fpA: { centroid: { techno: 0.6, electronic: 0.4 }, primaryGenre: 'techno' },
    fpB: { centroid: { jungle: 0.6, electronic: 0.4 }, primaryGenre: 'jungle' },
    classA: { type: 'GENRE' }, classB: { type: 'GENRE' },
  });
  assert.ok(rel === null || rel.kind !== 'related',
    'in an electronic library every pair "sits under electronic" — reporting it buries the real findings');
});

test('playlists below the size floor are skipped rather than compared badly', () => {
  const tiny = { id: 't', name: 'Tiny', tracks: [{ id: 'x' }] };
  assert.equal(relate(tiny, tiny, { fpA: {}, fpB: {} }), null);
});

test('collections are not transitive, so an event copy does not become a parent', () => {
  const rels = [
    { kind: 'view', parentId: 'p1', childId: 'p2', confidence: 1, a: { id: 'p1', name: 'Parent' }, b: { id: 'p2', name: 'View' } },
    { kind: 'subset', parentId: 'p2', childId: 'p3', confidence: 1, a: { id: 'p2', name: 'View' }, b: { id: 'p3', name: 'Deeper' } },
  ];
  const cols = collections(rels);
  assert.deepEqual(cols.map(c => c.parent.id), ['p1'], 'p2 is itself a child and cannot head a collection');
});

/* ---------- end to end ---------- */

test('the playlist benchmark passes in full', () => {
  const r = runPlaylistBenchmark();
  const failed = [...r.results, ...r.relResults].filter(x => !x.pass);
  assert.deepEqual(failed.map(f => `${f.id}: ${f.checks.filter(k => !k.ok).map(k => k.detail).join('; ')}`), []);
  assert.equal(r.typeAccuracy, 1);
  assert.equal(r.relationshipAccuracy, 1);
});

test('every playlist benchmark case says what failure it stands for', () => {
  const { CASES, RELATIONSHIP_CASES } = { CASES: runPlaylistBenchmark().results, RELATIONSHIP_CASES: runPlaylistBenchmark().relResults };
  for (const c of [...CASES, ...RELATIONSHIP_CASES])
    assert.ok(c.why && c.why.length > 30, `${c.id} does not say what it stands for`);
});

test('how a playlist is organised decides its type; what it is made of is reported separately', () => {
  const r = runPlaylistBenchmark();
  const event = r.analysis.classifications.get('p-event');
  assert.equal(event.type, 'EVENT', 'organised as an event');
  assert.equal(event.musicalIdentity.primary, 'tech-house', 'made of tech house');
  assert.equal(event.isTarget, false, 'and so never a filing destination — the §18 error');

  const mood = r.analysis.classifications.get('p-mood');
  assert.equal(mood.musicalIdentity.primary, 'deep-house');
  assert.notEqual(mood.type, 'GENRE', 'every playlist is made of some genre; that is not what it IS');
});

test('a silent name falls through to the content without a hand-written override', () => {
  const r = runPlaylistBenchmark();
  const lyric = r.analysis.classifications.get('p-lyric');
  assert.equal(lyric.nameSilent, true);
  assert.ok(['GENRE', 'SUBGENRE'].includes(lyric.type));
  assert.ok(lyric.dimensions.every(d => d.from === 'content'));
});

test('a name that disagrees with the music is surfaced, not silently overruled', () => {
  const { lib, tags } = buildFixtureLibrary();
  // Rename the jungle bucket to something it is not.
  const mislabelled = { ...lib, playlists: lib.playlists.map(p => p.id === 'p-ju' ? { ...p, name: 'Tech House Vol 2' } : p) };
  const idx = indexCaches({ lastfm: tags, now: NOW });
  const profiles = profileLibrary(mislabelled, idx, { registry: buildRegistry(idx.present), now: NOW });
  const a = analysePlaylists(mislabelled, profiles, { now: NOW });
  const row = nameVsMusic(a.classifications).find(x => x.id === 'p-ju');
  assert.ok(row, 'the disagreement must be reported');
  assert.equal(row.named, 'tech-house');
  assert.equal(row.actual, 'jungle');
});

test('a mirror playlist is excluded from baselines and relationships', () => {
  const { lib, tags } = buildFixtureLibrary();
  const everything = lib.playlists.flatMap(p => p.tracks);
  const withMirror = { ...lib, playlists: [...lib.playlists, { id: 'p-mirror', name: 'All Songs — Betterfy', tracks: everything }] };
  const idx = indexCaches({ lastfm: tags, now: NOW });
  const profiles = profileLibrary(withMirror, idx, { registry: buildRegistry(idx.present), now: NOW });
  const a = analysePlaylists(withMirror, profiles, { isMirror: p => p.id === 'p-mirror', now: NOW });
  assert.ok(!a.relationships.some(r => r.a.id === 'p-mirror' || r.b.id === 'p-mirror'),
    'left in, it is a superset of everything you own and buries every real finding');
  assert.equal(a.classifications.get('p-mirror').isTarget, false);
});

test('an empty or malformed library does not throw', () => {
  const idx = indexCaches({});
  for (const lib of [{}, { playlists: null }, { playlists: [{ id: 'p', name: 'X', tracks: null }] }]) {
    const profiles = profileLibrary(lib, idx);
    const a = analysePlaylists(lib, profiles);
    assert.ok(a.classifications instanceof Map);
    assert.deepEqual(a.relationships, []);
  }
  assert.deepEqual(libraryBaseline(new Map()).playlists, 0);
  assert.equal(classifyPlaylist(null, {}).type, 'UNKNOWN');
});
