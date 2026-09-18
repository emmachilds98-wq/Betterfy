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
| 6 — playlist intelligence | done: fingerprints, clustering, name semantics, multi-dimensional type |
| 7 — playlist relationships | done: duplicate / view / event-copy / subset / variant / related, and §19 collections |
| 8 — personal layer | done: append-only correction log, v1 feedback import, listening relevance, §35 review queue |
| 9 — AI reconciliation | constraint layer done; no vendor wired, `ask` is injected |
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

After phases 0-4: 509 tests. After phases 6-7: 545. After phase 8 and the
review queue: 569. After the diagnostics CLI and weight sweep: 578. After
phase 9's constraint layer: **601 tests, 601 pass**. The 431 originals are
unmodified throughout.

Measured engine baseline, on the benchmark fixtures in
`core/benchmark/fixtures.mjs` (`npm run benchmark:compare`):

| | v1 (tag vector) | v3 (evidence engine) |
|---|---|---|
| cases with a knowable answer (n=7) | 0.429 | **1.000** |
| cases that should be declined (n=5) | 1.000 | 1.000 |
| overall (n=12) | 0.667 | **1.000** |

And at the playlist level (`npm run benchmark:playlists`), 12/12 cases:
playlist-type accuracy 1.000, relationship accuracy 1.000. There is no v1
column for that table because v1 has no notion of a playlist relationship at
all — it would model the event playlist in the worked example as a filing
destination and flag most of it as misfiled out of the playlist it is a
deliberate copy of.

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
| `axes.mjs` | playlist axis guessing, incl. the one-library OVERRIDE table | `playlists/{name,classify,fingerprint}.mjs` — done, and with no per-playlist overrides |
| `misfile.mjs` | misfile + backlog + clusters | Music DNA placement analysis (Phase 10); `playlists/clustering.mjs` already replaces its cluster pass |
| `listening.mjs` | top artists, recently played | `personal/relevance.mjs` — done. Priority only; nothing in `analysis/` imports it |
| browser `FB` feedback store | skips and per-track rejections | `personal/corrections.mjs`, via `fromV1Feedback()` — imported, not discarded |
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
  playlists/fingerprint.mjs   distributions, concentration, added shape, coherence
  playlists/clustering.mjs    musical regions inside one playlist
  playlists/name.mjs          name semantics via the ontology + structure
  playlists/classify.mjs      playlist type, multi-dimensional
  playlists/relationships.mjs overlap, derivation, §19 collections
  personal/corrections.mjs    append-only log, v1 import, global vs personal
  personal/relevance.mjs      listening as priority; never reaches the classifier
  review/queue.mjs            §35's prioritised queue, collapsed by question
  ai/reconcile.mjs            §24's constraint layer; no vendor, `ask` injected
  benchmark/{fixtures,run,compare,playlists}.mjs
  benchmark/fit.mjs           §9: sweep each declared prior against the benchmark
analyse-v3.mjs                run the whole engine over a real library.json
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

### Playlist type is how it is organised, not what it is made of

The single most important rule in `playlists/classify.mjs`. Every playlist is
made of *some* genre and *some* mood — those claims are present for all of
them and so discriminate between none. So evidence is ranked in two tiers:
anything the name or the structure claimed (a title, a date, a burst of
additions, one artist dominating) says how the listener organised it; anything
only the tracks claimed says what went in. A content claim decides the type
only when nothing organisational speaks at all.

That last case — a silent name — is precisely what `axes.mjs` needs a
hand-written `OVERRIDE` entry per playlist for. "Lyricism" is a judgement
about wordplay, not a sound; v1 needs to be told, v3 falls through to the
content and files it correctly with no table.

The musical identity is reported separately and always, which is §34: the
playlists worth looking at are exactly the ones where the name and the music
disagree, and `nameVsMusic()` lists them.

### No venue list, anywhere

v1's `EVENT` regex names Drumsheds, Fabric, Printworks and E1. That is an
excellent classifier for one library and worth nothing for the next account.
v3 recognises an event by *shape* — a date, plus at least one word that
resolves to nothing the ontology knows — because the unknown word is exactly
the venue that cannot be enumerated. It gets "Fabric September 2026" and
"Warehouse 12.04" right, and would get a club in Seoul right too. A test
greps the module (comments stripped) to keep it that way.

The second event signal needs no words at all: built in one sitting and never
touched again. That is carried over from the browser build unchanged, because
it is the one content rule there that holds up.

### A playlist is named from its tracks' answers, not their ancestry

Every Tech House track contributes weight to tech-house, house *and*
electronic. Summed over forty identical tracks the parent outweighs the
answer, and a pure Tech House bucket reported itself as "house" — with a
genre entropy of 0.98, because a three-deep ancestry always looks evenly
spread. So the fingerprint keeps two distributions: the lineage-weighted one
for comparing playlists, and the tracks' actual answers for naming one and
measuring its spread. When no single answer holds a majority the playlist
backs off to what its leading answers have in common — the same reconciliation
the track classifier does, one level up.

### Containment, not Jaccard

A 74-track playlist can be almost entirely inside a 600-track one while their
Jaccard similarity is 0.11. Jaccard calls that unrelated, which is exactly
backwards, so every structural relationship is measured by containment from
the smaller side.

An event copy and a plain subset are structurally *identical*; only the
smaller playlist's own type separates them. That is why relationships are
computed after classification rather than beside it.

### A correction never touches evidence, and evidence never touches a correction

The two directions matter for different reasons. Provider evidence stays
untouched so that reclassifying after an ontology change cannot silently
discard a year of somebody's corrections. Corrections stay out of the global
model because a personal taxonomy is true of one library and not of the world
— if you file all your minimal techno under "Techno" because that is how your
brain works, the engine should do that for you and not learn it as a fact.

So `personalView()` returns both answers and says which applies. The log is
append-only: "I moved this in March and back in June" is a different fact from
"this is Tech House", and the second is recoverable from the first while the
reverse is not. Append-only also makes cross-device merge safe — there is no
field to pick a winner for, so no device can lose what another recorded, and
syncing twice is a no-op.

v1's `{skips, lastSkip, rejected[]}` store is imported rather than dropped.
Somebody sat and told that app "no, not there" one track at a time; discarding
it because the new schema is nicer would be the worst possible upgrade.

### The ontology grows from real libraries, through the queue

`conceptQueue()` surfaces the tags nothing could place, ranked by how many
tracks are waiting on each. A person answers one — "schranz is a kind of hard
techno" — and it resolves for every track carrying that tag, in their runs
only. It is applied at normalisation time and never written into the ontology,
and it is consulted only for strings the ontology itself declined, so a
correction can fill a gap and never overrule a known concept.

This is also how the benchmark §26 asks for becomes reachable. A queue that
asks the right two hundred questions turns a real library into reviewed data;
asking in playlist order would just exhaust the person.

### One question, asked once

A review queue that asks the same thing repeatedly loses the person it is for.
Eight tracks by one artist, with no track-level evidence between them, rest on
the same tag cloud and produce the same answer — they are one question with
eight tracks riding on it. Rows are collapsed on (credited artists, answer,
confidence, unmapped tags), so a track the engine reached a *different*
conclusion about stays its own question. On the playlist fixture this takes
110 rows to 12.

The counterpart is knowing what NOT to ask. `THIN_IDENTITY` fires only below
the confidence a bare Spotify id already gives, because most tracks in most
libraries have no ISRC and no MusicBrainz match — flagging that would put the
whole library in the queue and say nothing.

### Listening is priority, never genre

§22, enforced structurally: nothing in `core/analysis/` imports
`personal/relevance.mjs`, and a test greps for it. "What is this track" and
"is it worth my attention" are different questions, and the second is where
listening belongs — ranking the queue, and ordering which tracks
`enrich-lastfm-tracks.mjs` spends requests on.

### Which numbers are actually validated, and which are not

`npm run benchmark:fit` sweeps every threshold and specificity through a
plausible range and re-runs the benchmark. As of this writing:

- **No parameter is set to a value the benchmark scores worse at.** A test
  asserts this, so mistuning one fails the build.
- **4 of 15 are FLAT** — the benchmark never distinguished *any* value in the
  swept range. `HIGH_LEADER_SHARE`, `HIGH_MARGIN_RATIO`,
  `EVENT_SETTLED_DAYS` and `CONTENT_LIFT` are uncontradicted, not validated,
  and those are different claims.
- Most of the rest sit on wide plateaus. `SPECIFICITY.artist` — the number
  §4.1's entire fix rests on — passes anywhere in [0.15 .. 0.85] against 0.35.

That is the honest state of §9, and it is a request for benchmark rows rather
than a reason to trust the numbers. A flat parameter also usually points at a
gap in the fixtures: `EVENT_SETTLED_DAYS` reads flat because every event
playlist in the fixture is 200 days old, so no threshold under 180 could tell
them apart.

### Running it against a real library

`analyse-v3.mjs` reads `library.json` plus whichever of the v1 caches exist
and runs the whole engine — no network, no new configuration, nothing written
back. It prints the confidence bands, the playlist types and relationships,
the playlists whose name disagrees with their music, and the review queue;
`--queue` writes the queue out to work through.

This is the mechanism the two open items above need. Work the queue, and the
answers are both corrections for your own library and benchmark rows.

### AI chooses; it does not propose

§24 is mostly a list of things AI must not be allowed to do, so `core/ai/` is
mostly a constraint layer. Four rules, each enforced structurally rather than
by prompt wording:

- **It never sees a question the evidence answered.** `shouldAsk()` fires only
  on `AMBIGUOUS` with two or more candidates, or on an unmapped tag.
  Re-opening a settled answer with a language model is how a good answer gets
  talked out of.
- **The choice set is closed.** Every candidate in the request was produced by
  the deterministic classifier from real evidence, and a response naming
  anything else is rejected. That makes "inventing a genre from the title"
  impossible rather than discouraged — and note the subtler case is covered
  too: a *real* ontology genre that nothing in this track supports is still
  refused (`NOT_A_CHOICE`), where a naive "is it a valid genre" check would
  pass it.
- **It cannot manufacture certainty.** A reconciled answer is capped at
  `LIKELY` and carries `reconciledBy: 'ai'`. The evidence was divided before
  the model spoke and it is divided still; what changed is which side we act
  on.
- **It never touches the evidence.** Reconciliation reorders a decision among
  existing candidates and adds no records, so the next classification run
  starts from exactly the same inputs.

Unmapped tags are a separate task with a separate rule: a model may *propose*
that "schranz" means hard techno, and the proposal goes to the review queue
for a human. It is never applied.

The tests are an adversary — a model that throws, invents genres, names real
genres nothing supports, claims HIGH confidence, and returns a bare string.
A constraint layer tested against a well-behaved mock proves nothing.

No vendor is named anywhere in the module and it makes no network calls;
`ask` is injected. A test greps for both.

### What is NOT here

- **No audio analysis.** Spotify's `/audio-features` and `/recommendations`
  are dead — 403/404 against a real app registration. There is nothing to
  read. `SPOTIFY.capabilities` is `['identity', 'era']` and says so.
  `MEASURED_FIELDS` in `music-dna.mjs` is the shape a licensed provider would
  fill; nothing fills it.
- **No AI model.** The §24 constraint layer is built and tested; no vendor is
  wired to it, and `ask` is injected. Nothing in the engine calls a model
  today — which also means the accuracy numbers above owe nothing to one.
- **Misfile detection on Music DNA (§21).** The fingerprints and clusters it
  needs now exist; `misfile.mjs` still runs on v1 tag vectors.
- **Recommendations and the UI** (phases 10, 11). The review queue produces
  the rows §33/§34 describe; nothing renders them.

---

## 6. Running it

```sh
npm test                    # 509 tests, including the ontology validator
npm run benchmark           # the §26 metric set, per confidence band
npm run benchmark:compare   # v1 against v3, same fixtures
npm run benchmark:playlists # playlist type + relationship accuracy
npm run benchmark:fit       # which weights the benchmark actually constrains

npm run analyse:v3          # the whole engine over YOUR library.json
npm run analyse:v3 -- --queue

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
2. **Re-fit the weights against it.** `npm run benchmark:fit` now says
   exactly which numbers the benchmark constrains and which it does not — 4
   of 15 are entirely unconstrained. Provider `reliability` values are not
   swept at all yet, because a registry is built per run rather than read
   from a mutable table.
3. **Verify the MusicBrainz recording lookup** against a live response. Like
   the v1 artist lookup it sits beside, it is written from the documented JSON
   shape and degrades to "not found" on anything else.
4. **Migrate misfile detection onto Music DNA** (§21). This is the first
   place the new engine would change what a user sees, and it should not
   happen until the benchmark above is real — a misfile flag is an
   instruction to move somebody's music.

Note that (1) and (2) now have a mechanism: run the engine over a real
library, work the review queue, and the answers are benchmark rows. That is
the intended order — the queue exists so the benchmark can be built without
anybody inspecting thousands of tracks by hand.
