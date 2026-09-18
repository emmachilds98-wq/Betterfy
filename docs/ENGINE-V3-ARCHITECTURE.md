# Betterfy Engine v3 — architecture and data flow

The state of the v3 engine as built, what each existing module maps to, the
baseline it has to beat, and what is deliberately not done yet.

This is a working document for the engine, not a restatement of the plan.
Where the plan and the code disagree, the code and this document are the
record of *why*.

---

## 1. Where things stand

| Phase | Status |
|---|---|
| 0 — baseline | done (below) |
| 1 — identity engine | done for the Spotify/ISRC/version chain; MusicBrainz recording lookup written, unverified against a live response |
| 2 — evidence engine | done |
| 3 — ontology | done, versioned and validated |
| 4 — track classification | done |
| 5 — audio analysis | **not started** — the provider interface exists, no provider does |
| 6-7 — playlist intelligence and relationships | **not started**, deliberately (§32: only once the track engine is stable) |
| 8 — personal layer | **not started**; v1's feedback store is still the only one |
| 9 — AI reconciliation | **not started** |
| 10-11 — recommendations, UI | **not started**; v1 still answers every question the app asks |

Nothing in `core/` is wired into the shipping app. v1 is untouched and still
produces every suggestion, every misfile flag and every playlist axis. That
is the point: v3 is built beside it and measured against it, and only
replaces it a layer at a time once it is measurably better at that layer.

---

## 2. Baseline (Phase 0)

Captured on the commit this work branched from, before any change:

```
node --test    431 tests, 431 pass, 0 fail
```

After this change: **509 tests, 509 pass**. The 431 originals are unmodified.

Measured engine baseline, on the benchmark fixtures in
`core/benchmark/fixtures.mjs` (`npm run benchmark:compare`):

| | v1 (tag vector) | v3 (evidence engine) |
|---|---|---|
| cases with a knowable answer (n=7) | 0.429 | **1.000** |
| cases that should be declined (n=5) | 1.000 | 1.000 |
| overall (n=12) | 0.667 | **1.000** |

Read that second row carefully before treating it as a tie. v1 scores 1.000
there because on these cases its answer happened to be nothing at all — it
has no mechanism to *decide* that the evidence is insufficient, so it cannot
distinguish "nothing to say" from "two sources flatly disagree". v3 reports
`AMBIGUOUS` for the latter. The row measures the same outcome reached for
different reasons, and only one of them generalises.

The known failure modes v1 exhibits on the known-good half, all three of which
are the reason v3 exists:

- **`good-track-beats-diverse-artist`** — v1 answers `drum-and-bass` for an
  ambient record, because that is what the artist is tagged with. It has no
  track-level concept at all.
- **`good-siblings-resolve-to-parent`** — evidence split evenly over Tech
  House, Deep House and Progressive House. v1 answers `tech-house` because it
  polled five points higher. The true answer is House.
- **`good-release-style-outranks-thin-artist`** and
  **`good-compound-tag-resolves-to-parent`** — v1 answers nothing, because the
  library-wide tag gate drops a tag seen on one artist, and because
  "dark techno" is not a string it knows.

### Known-wrong classifications carried forward

Two things v1 gets wrong that v3 does *not* yet fix, recorded so they are not
mistaken for solved:

- `axes.mjs`'s `OVERRIDE` table is one person's playlist names. It generalises
  to nobody and is still the only thing stopping "Lyricism" being read as a
  rap playlist. Playlist intelligence (Phase 6) is where that gets fixed.
- `DRIFT_THRESHOLD` in `profile.mjs` is a first-pass number never validated
  against a real library, as its own comment says.

---

## 3. Data flow

```
Spotify library (snapshot.mjs / the browser's own sync)
        │
        ▼
┌─────────────────────────────────────────────────────────┐
│ IDENTITY            core/identity/track-identity.mjs    │
│ spotify id · ISRC · version kind · artists in billing   │
│ order · album/year · resolved MBIDs and Discogs ids     │
│ → every identity carries how well-resolved it is        │
└───────────────────────────┬─────────────────────────────┘
                            ▼
┌─────────────────────────────────────────────────────────┐
│ PROVIDERS           core/sources/*.mjs                  │
│ spotify · lastfm · discogs · musicbrainz · legacy v1    │
│ caches. Each declares: capabilities, reliability,       │
│ independence group, version, what it requires.          │
│ Each is a pure response→evidence mapper plus a thin     │
│ fetch. No provider is named below this line.            │
└───────────────────────────┬─────────────────────────────┘
                            ▼
┌─────────────────────────────────────────────────────────┐
│ EVIDENCE            core/evidence/*.mjs                 │
│ frozen records: source · entityType · field · rawValue  │
│ · concept · sourceConfidence · identityConfidence ·     │
│ retrievedAt · provenance                                │
│ normalise.mjs maps raw→concept, keeps the unmappable    │
│ weights.mjs scores by specificity/identity/recency      │
└───────────────────────────┬─────────────────────────────┘
                            ▼
┌─────────────────────────────────────────────────────────┐
│ ONTOLOGY            core/ontology/*.mjs                 │
│ hierarchical genres + aliases + related + contradicts   │
│ flat mood / context / era concept tables                │
│ versioned, and validated by the test suite              │
└───────────────────────────┬─────────────────────────────┘
                            ▼
┌─────────────────────────────────────────────────────────┐
│ CLASSIFIER          core/analysis/classify.mjs          │
│ accumulate → lineage lift → descent → de-correlated     │
│ agreement → contradictions → rank → reconcile up/down   │
│ the hierarchy → calibrate → explain                     │
└───────────────────────────┬─────────────────────────────┘
                            ▼
┌─────────────────────────────────────────────────────────┐
│ PROFILE / DNA       core/analysis/music-dna.mjs         │
│ MusicProfile: for showing a person (candidates,         │
│   explanation, unknown concepts, versions)              │
│ Music DNA: for comparing two pieces of music            │
└─────────────────────────────────────────────────────────┘
```

`core/engine.mjs` is the front door that points all of it at a real library.

---

## 4. Module inventory (Task 1)

### v1 modules, and what they become

| v1 module | Role now | v3 destination |
|---|---|---|
| `profile.mjs` | tag vectors, centroids, IDF, misfile, drift | splits into Music DNA (`analysis/music-dna.mjs`), similarity, and playlist profiling. **Still the live engine.** Its `tagFacet()` and `usableTag()` are already shared with v3 as the single tag lexicon. |
| `tagstore.mjs` | loads and merges v1 caches | `sources/legacy.mjs` reads the same files as evidence |
| `enrich-lastfm.mjs` | artist tag fetch | `sources/lastfm.mjs` (artist), joined by `enrich-lastfm-tracks.mjs` (track) |
| `enrich-discogs.mjs` | gap-fill only | `sources/discogs.mjs` — a first-class release-level source, no longer a fallback |
| `musicbrainz.mjs` | artist MBID via Spotify URL | `sources/musicbrainz.mjs` wraps it and adds ISRC→recording |
| `merge-tags.mjs` | folds contributions into the shipped table | unchanged; the shipped table becomes the `shared-tags` provider |
| `axes.mjs` | playlist axis guessing | playlist classifier + fingerprint (Phase 6) |
| `misfile.mjs` | misfile + backlog + clusters | Music DNA placement analysis (Phase 7) |
| `listening.mjs` | top artists, recently played | personal behaviour signal (Phase 8); already used by `enrich-lastfm-tracks.mjs` to prioritise |
| `discover.mjs` | recommendation consumer | Phase 10 |
| `analyse.mjs` | diagnostics | joined by `libraryReport()` in `core/engine.mjs` |
| `norm.mjs`, `credits.mjs` | string identity | consumed by `identity/track-identity.mjs` |
| `cache.mjs` | resumable JSON cache + re-ask policy | unchanged, reused by the new enrichment |

### What v3 adds

```
core/
  engine.mjs                  front door: library → profiles → report
  identity/track-identity.mjs canonical identity, link confidence, merge rules
  ontology/genres.mjs         99 genres, parent/alias/related/contradicts
  ontology/facets.mjs         mood/context/era concepts; delegates facet to profile.mjs
  ontology/index.mjs          derived indices, resolveConcept(), validateOntology()
  evidence/evidence.mjs       frozen Evidence records, append-only EvidenceSet
  evidence/normalise.mjs      raw → concept, junk dropped, unknowns kept
  evidence/weights.mjs        specificity/identity/recency/agreement, no provider names
  sources/provider.mjs        capability declaration + registry
  sources/{spotify,lastfm,discogs,musicbrainz,legacy}.mjs
  analysis/classify.mjs       classifyGenre(), classifyFlatFacet(), calibration
  analysis/music-dna.mjs      MusicProfile, Music DNA, DNA similarity
  benchmark/{fixtures,run,compare}.mjs
enrich-lastfm-tracks.mjs      track-level Last.fm, prioritised by use × uncertainty
```

---

## 5. The decisions worth knowing

### Artist evidence is contextual; specificity does the work

There is no rule anywhere that says "prefer track tags to artist tags". There
is one number — `SPECIFICITY` in `evidence/weights.mjs` — and a track-level
statement scores about 2.9× an artist-level one before anything else is
considered. That is the whole of §4.1's fix, and it means a new source slots
in at its own level without the classifier learning about it.

### Lineage lift, and why sibling dominance is needed

Evidence for a child lifts its parents at `LINEAGE_LIFT` (0.6) per level, so
three house subgenres splitting the evidence add up to a confident House.
Reconciliation then promotes back down to a child only when that child is:

1. substantially backed relative to the answer it replaces (`SPECIFIC_ENOUGH`),
2. **asserted more than the parent was in its own right**, and
3. ahead of its strongest sibling by `SIBLING_DOMINANCE` (1.4×).

Test (2) exists because the parent's score is largely lift from that same
child, so comparing child-direct against parent-*score* is circular. Test (3)
exists because without it a three-way even split promotes whichever subgenre
polled one point higher — the exact v1 defect. Both were found by the
benchmark, not by reasoning.

### Share is measured against rivals, not against everything

A track's own lineage is not competing with it. Dividing the leader's score by
the total made a unanimously-sourced track look *less* certain the deeper its
genre sat in the tree. `leaderShare()` divides by the leader plus only those
candidates outside its lineage.

### Agreement is counted over independence groups

Last.fm's artist tags, Last.fm's track tags and the shipped `docs/tags.json`
are one crowd. They share an independence group and cannot corroborate each
other — counting them as two sources is precisely how a confident wrong answer
gets manufactured. Providers declare the group; the classifier never knows
which providers exist.

### One tag lexicon, not two

`core/ontology/facets.mjs` imports `tagFacet()` from `profile.mjs` rather than
restating its vocabulary, and `evidence/normalise.mjs` imports `usableTag()`.
`validateOntology()` fails the build if the two ever disagree about a word —
which it already caught twice during this work (`chillout`, `driving`,
`nostalgia`). The dependency only ever points from `core/` to `profile.mjs`,
because `profile.mjs` is bundled verbatim into the browser build and must stay
import-free.

### Unknown concepts are kept

An unmapped provider string becomes an `unknown` record carrying its raw
value, tallied by `unknownConcepts()` and surfaced by `libraryReport()`. That
is the mechanism by which the ontology is meant to grow — from what real
libraries are actually tagged with, rather than from guesswork. Collection
cruft ("seen live", "albums i own") is the one thing dropped outright: it
names the tagger, not a concept the ontology is missing.

### What is NOT here

- **No audio analysis.** Spotify's `/audio-features` and `/recommendations`
  are dead — 403/404 against a real app registration. There is nothing to
  read. `SPOTIFY.capabilities` is `['identity', 'era']` and says so.
  `MEASURED_FIELDS` in `music-dna.mjs` is the shape a licensed provider would
  fill; nothing fills it.
- **No AI.** §4.5 puts AI reconciliation after deterministic evidence works.
  Deterministic evidence now works; AI is still Phase 9.
- **No playlist work.** §32 Task 12 gates it on the track engine being stable.

---

## 6. Running it

```sh
npm test                    # 509 tests, including the ontology validator
npm run benchmark           # the §26 metric set, per confidence band
npm run benchmark:compare   # v1 against v3, same fixtures

npm run enrich:tracks       # track-level Last.fm, needs only a Last.fm key
npm run enrich:tracks -- --limit=200
```

`enrich-lastfm-tracks.mjs` is the one new thing that costs requests. It is
prioritised per §28 — it runs the engine over the library first, and asks
about the tracks where the engine is least certain *and* the listener plays
most, so an interrupted run has already covered what matters. It is resumable,
and running it is entirely optional: without it, v3 reads the artist caches v1
already keeps and simply reports lower confidence.

---

## 7. What a new provider costs

Per §36, adding one should mean an adapter, a mapper, tests and a capability
declaration — and nothing else. Concretely:

1. `core/sources/yours.mjs` — a `defineProvider({...})` declaration plus a
   pure `toEvidence(response, ctx)`.
2. Register it in `buildRegistry()` behind whatever it requires.
3. Tests, including at least one malformed-response case.

No change to `classify.mjs`, `weights.mjs` or the ontology is needed or
wanted. If one turns out to be, the adapter is leaking provider-specific
behaviour and that is the bug.

---

## 8. Immediate next steps

1. **Grow the benchmark.** Twelve synthetic cases is a harness, not a
   benchmark. §26 asks for ~500 reviewed tracks. The harness takes them as
   data; nothing in `run.mjs` changes.
2. **Re-fit the weights against it.** Every number in `THRESHOLDS`,
   `SPECIFICITY` and each provider's `reliability` is a declared prior chosen
   by reasoning. §9 is explicit that they must be validated against real data,
   and none of them have been.
3. **Verify the MusicBrainz recording lookup** against a live response. Like
   the v1 artist lookup it sits beside, it is written from the documented JSON
   shape and degrades to "not found" on anything else.
4. **Then** playlist intelligence (Phase 6).
