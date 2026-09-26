// Turn a real, reviewed library into benchmark cases — §26's missing half.
//
// The harness has always been able to take 500 reviewed tracks; there has
// never been a way to *produce* them. This is it: read the library, the
// provider caches v1 already keeps, and the answers a human gave in the
// review page, and emit cases in exactly the shape core/benchmark/fixtures.mjs
// defines, so `runBenchmark()` takes them without knowing the difference.
//
// Two constraints the fixtures file states and this has to honour.
//
// **Real tags are not committable.** fixtures.mjs is synthetic on purpose:
// committing a real library's Last.fm tags republishes a third party's data
// and goes stale the next time the crowd moves. So imported cases are written
// to `benchmark-cases.json`, which is gitignored, and picked up only if
// present. The committed benchmark stays synthetic and stays honest; yours
// stays yours.
//
// **A human answer is not automatically ground truth.** A person who clicked
// "not sure" told you something real — that the track is genuinely hard — and
// that becomes a known-bad case, not a discarded row. A person who named a
// genre gives a known-good case. Both are needed: §26 is explicit that the
// benchmark must not be optimised for "every track gets a label".
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { CorrectionLog, fromV1Feedback } from '../personal/corrections.mjs';
import { GENRE_INDEX } from '../ontology/index.mjs';

export const IMPORT_VERSION = '3.0.0';
export const CASES_FILE = 'benchmark-cases.json';

const read = f => existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;

/**
 * Build cases from a library, its caches and a correction log.
 *
 * Only tracks with an answer AND evidence become cases. An answered track
 * nothing has ever said anything about would test the harness's ability to
 * return nothing, which the synthetic known-bad cases already do better and
 * without pretending a human verified an absence.
 */
export function importCases({ lib, caches = {}, log, trackTags = null }) {
  const byId = new Map();
  for (const p of lib?.playlists ?? []) for (const t of p.tracks ?? []) if (t?.id && !byId.has(t.id)) byId.set(t.id, t);
  for (const t of lib?.liked ?? []) if (t?.id && !byId.has(t.id)) byId.set(t.id, t);

  const answered = new Map();
  for (const c of log?.entries ?? []) {
    if (c.kind !== 'genre' && c.kind !== 'not-sure') continue;
    if (!c.trackId) continue;
    answered.set(c.trackId, c);            // last statement wins, as genreOf does
  }

  const cases = [], skipped = { noTrack: 0, noEvidence: 0, unknownGenre: 0 };
  for (const [trackId, c] of answered) {
    const track = byId.get(trackId);
    if (!track) { skipped.noTrack++; continue; }
    if (c.kind === 'genre' && !GENRE_INDEX.has(c.value)) { skipped.unknownGenre++; continue; }

    const evidence = [];
    const entry = trackTags?.[trackId];
    if (entry?.tags?.length)
      evidence.push({ provider: 'lastfm', entityType: 'track', entityId: trackId,
        matchedBy: entry.mbid ? 'mbid-recording' : 'name-exact',
        response: { toptags: { tag: entry.tags.map(([name, count]) => ({ name, count })) } } });

    for (const a of track.artists ?? []) {
      if (!a?.id) continue;
      const lf = caches.lastfm?.[a.id];
      if (lf?.tags?.length)
        evidence.push({ provider: 'lastfm', entityType: 'artist', entityId: a.id,
          response: { toptags: { tag: lf.tags.map(([name, count]) => ({ name, count })) } } });
      const dg = caches.discogs?.[a.id];
      if (dg?.tags?.length)
        evidence.push({ provider: 'discogs', entityType: 'artist', entityId: a.id, matchedBy: 'name-exact',
          response: { results: dg.tags.map(([style]) => ({ style: [style] })) } });
    }
    if (!evidence.length) { skipped.noEvidence++; continue; }

    cases.push({
      id: `real-${trackId}`,
      why: c.kind === 'genre'
        ? `reviewed in a real library: answered ${c.value}`
        : 'reviewed in a real library: a person looked at it and could not say',
      // Names are kept — they are what makes a failing case diagnosable, and
      // an artist name is not a secret. Playlist membership is not, because
      // how somebody files their music is nobody else's business and the
      // classifier must never see it anyway (§22).
      track: { id: trackId, name: track.name, released: track.released ?? null,
               artists: (track.artists ?? []).map(a => ({ id: a.id, name: a.name })) },
      evidence,
      expectGenre: c.kind === 'genre' ? c.value : null,
      // A human who could not answer is evidence that the engine should not
      // answer confidently either — not that it must return nothing at all.
      ...(c.kind === 'not-sure' ? { expectConfidence: ['AMBIGUOUS', 'INSUFFICIENT_DATA'] } : {}),
      source: 'imported', importedAt: Date.now(),
    });
  }

  return { cases, skipped, version: IMPORT_VERSION };
}

/** Read everything from the working directory and write CASES_FILE. */
export function importFromDisk({ out = CASES_FILE } = {}) {
  const lib = read('library.json');
  if (!lib) throw new Error('No library.json — run: npm run snapshot');

  const log = existsSync('corrections.json')
    ? CorrectionLog.fromJSON(read('corrections.json'))
    : existsSync('feedback.json') ? fromV1Feedback(read('feedback.json')) : new CorrectionLog();

  const result = importCases({
    lib, log,
    caches: { lastfm: read('tags-lastfm.json'), discogs: read('tags-discogs.json') },
    trackTags: read('tags-lastfm-tracks.json'),
  });

  writeFileSync(out, JSON.stringify({ version: IMPORT_VERSION, generatedAt: new Date().toISOString(),
                                      cases: result.cases }, null, 2));
  return { ...result, out };
}

/** The imported cases, if any have been produced. Used by the benchmark run. */
export function loadImported(file = CASES_FILE) {
  const json = read(file);
  return json?.cases ?? [];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { cases, skipped, out } = importFromDisk();
  const good = cases.filter(c => c.expectGenre !== null).length;
  console.log(`${cases.length} cases -> ${out}  (${good} answered, ${cases.length - good} "not sure")`);
  const total = skipped.noTrack + skipped.noEvidence + skipped.unknownGenre;
  if (total) console.log(`skipped ${total}: ${skipped.noTrack} not in library, `
    + `${skipped.noEvidence} with no provider evidence, ${skipped.unknownGenre} naming an unknown genre`);
  if (cases.length < 500) console.log(`\n§26 asks for ~500. You have ${cases.length}. `
    + `Keep working the queue: npm run analyse:v3 -- --queue && npm run build:review:v3`);
}
