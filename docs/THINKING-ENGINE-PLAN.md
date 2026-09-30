# The thinking engine — build plan

An engine that learns what **this account's** playlists mean from the account
itself, files against those learned meanings, and needs no key, no second
website and no crowd opinion to do it.

This document is the plan, not the implementation.

---

## 1. The problem, stated plainly

`CLAUDE.md` says external enrichment must be "a fully optional bonus, silently
absent and zero-cost for anyone who doesn't have it, never something the core
filing/tagging/misfile model leans on."

The build does not honour that. Both engines lean on it completely:

- v1 builds every track's signal from its artists' **Last.fm** tags. Remove the
  key and `rank()` has nothing to rank with.
- v3 replaces the *reasoning* over those tags with something far better, but the
  tags are still the input. `core/sources/spotify.mjs` declares
  `capabilities: ['identity', 'era']` — the only provider that needs no setup
  asserts nothing about what a record *sounds like*.

### What the shipped tag table does and does not fix

One correction, because the first draft of this argument overstated it.

`docs/tags.json` ships **4,866 artists** baked into the page, and the browser
reads it at runtime with no key and no setup. So a hosted listener is *not*
signal-less without a Last.fm key. They have coverage for those 4,866 artists
for free, and a key only extends it to artists outside the table.

That is a real mitigation, and it moves the problem rather than removing it —
in three ways that all matter more than the one it solves:

1. **The table is one library's taste.** It was built from this account. A
   listener whose taste overlaps gets good coverage; a listener whose does not
   falls off a cliff. Both get the same interface, the same confidence
   language, and no indication which of the two they are. That is the
   "excellent classifier for one library, worth nothing for the next account"
   failure that `axes.mjs` is criticised for, one layer up and much harder to
   see.
2. **It can be false, by documented design.** The shared Firestore path that
   grows the table takes unauthenticated writes and `merge-tags.mjs` checks a
   contribution's *shape* — "a real Spotify artist ID format, sane tag names
   and counts" — not whether it is true. The README says so plainly: somebody
   could submit a plausible but false tag for a real uncovered artist and
   nothing in the pipeline would catch it. A PR gate puts human eyes on the
   diff, which is a good control and not the same as verification.
3. **It is still one flat tag cloud per artist.** Coverage does not fix
   granularity. A diverse artist hands the same answer to every record they
   ever made, whether the cloud arrived from a key, the shipped table or a
   stranger's contribution.

So the accurate statement is not "no key, no signal". It is: *the core model's
quality depends on how much a stranger's library resembles this one, on a
table that is checked for shape rather than truth, at a granularity that cannot
separate one artist's records from each other* — and the app cannot tell the
listener which of those is currently limiting it.

The intrinsic signals in §4 have none of those three properties. Their coverage
is 100% by construction, because they are computed from the listener's own
library; they cannot be poisoned by a third party, because no third party is
involved; and they are per-track, because format, era, session and label are
properties of the record rather than of its artist.

Spotify cannot fill the gap. Verified September 2026, and re-confirmed against
the repo's own measurements:

| Endpoint | Status |
|---|---|
| `GET /audio-features/{id}` | `403` |
| `GET /recommendations` | `404` |
| `GET /artists/{id}` → `genres` | **field absent entirely — 0 tags across 956 artists** |
| `GET /artists/{id}/related-artists` | gone |

There is no genre vocabulary to be had from Spotify, for anyone, ever again.
Any plan that waits for one is not a plan.

---

## 2. The reframe

The engine currently asks **"what genre is this track?"** and then matches that
answer to a playlist. That question *requires* an external vocabulary.

It should ask **"which of this account's playlists does this track belong
with?"** — and that question needs no vocabulary at all, because the account
already contains the answer key.

**A playlist is a labelled training set.** A "Tech House" playlist holding 200
tracks is 200 examples, labelled by hand, of what *this person* means by tech
house. Nobody has to agree with them. The label cannot be "false", because it
is definitionally what they meant.

Three things follow, and they are the whole reason to do this:

1. **Adaptability stops being configuration and becomes structure.** Two
   accounts with a playlist called "House" get different learned definitions,
   because they are learned from different members. That is correct — they
   *do* mean different things.
2. **External data moves from infrastructure to presentation.** Last.fm and
   Discogs stop deciding anything and start supplying human-readable *names*
   for clusters the engine already found. Without a key the app still files;
   it says "belongs with these 200 tracks" instead of naming a genre.
3. **Validation becomes free.** Held-out playlist membership *is* ground truth.
   See §6 — this is the part that changes the project's economics.

---

## 3. What the account gives us, with nothing to configure

Already on disk after `npm run snapshot`, per `snapshot.mjs`'s field mask:

| Per track | Per playlist | Per account |
|---|---|---|
| `id`, `name` | `name`, `description` | liked songs |
| `artists[]` **in billing order** | `public`, `collaborative` | top artists × 3 windows |
| `albumId`, `album`, `albumType`, `albumTracks`, `trackNo` | full membership | top tracks × 3 windows |
| `released` | **`added_at` per track** | recently played |
| `duration_ms`, `explicit`, `popularity` | | following (needs scope) |
| **`isrc`** | | |

Not captured, and worth one batched call later: album `label`, which lives only
on the *full* album object (`GET /albums?ids=`, 20 per call). Unverified against
a live response — one call decides it. Out of the critical path either way,
because §4.2 gets most of the same signal for free.

---

## 4. The six intrinsic signals

None needs a key. None is an opinion. All but §4.7 are already on disk.

### 4.1 Artist co-occurrence — the load-bearing signal

Build the bipartite incidence of playlists × artists over the account's own
playlists, **excluding mirrors** (`core/playlists/mirror.mjs` already detects
a record-of-everything playlist by shape; a playlist holding the whole library
co-occurs everything with everything and would flatten the graph).

Two artists are close if they co-occur more than chance. Raw counts are wrong
for the same reason raw tag counts were wrong — a prolific artist co-occurs
with everybody — so score pairs by **positive pointwise mutual information**:

```
ppmi(a,b) = max(0, log( P(a,b) / (P(a)·P(b)) ))
```

Each artist's PPMI row is its **neighbourhood vector**. A track's vector is the
billing-order-weighted mean of its credited artists' vectors — billing order is
captured, and the first credit carries the record.

This says *"in this person's world, these two sit together"* with zero external
data. Nothing in the repo does it today; `grep` for co-occurrence finds only
unrelated uses in `classify.mjs`, `genres.mjs` and `shuffle.mjs`.

**Bounding it for a phone.** Keep only artists in ≥2 playlists, and cap each
artist's neighbourhood to its top *K* by PPMI (start K=50). A 200-playlist,
5000-artist library then holds ≤250k sparse entries, which is tractable in a
browser — but this must be **measured on a real library, not assumed** (§9).

### 4.2 Label family, from the ISRC registrant — free, already captured, unused

An ISRC is `CC-XXX-YY-NNNNN`. `XXX` is the **registrant**: effectively the label
or its distributor. Tracks sharing a registrant are label-siblings. This is
factual metadata, not crowd opinion, and `isrc` is already in `library.json` —
today it is used only as an identity key in `core/identity/track-identity.mjs`.

**The aggregator problem, and its self-correcting fix.** Plenty of independent
releases carry a distributor's registrant (DistroKid and friends) rather than a
label's, which dilutes the signal. The fix is the one already used for tags:
down-weight registrants by how many distinct playlists they span. A real label
concentrates; an aggregator appears everywhere and weights itself out.

You never need the label's *name* for affinity to work, which is why this needs
no lookup.

### 4.3 Add-session cohesion

`added_at` is captured per playlist entry. Tracks added to one playlist inside
one sitting are one crate — a strong "these go together" signal that is purely
behavioural. Across playlists, same-day adds are a weak session signal.

`core/playlists/fingerprint.mjs` already computes `addedShape()` and calls it
one of "the two structural signals that need no vocabulary". The instinct is
in the codebase; it is just peripheral while the genre picture hangs off tags.

### 4.4 Format shape

`duration_ms` + `albumType` + `albumTracks` + `trackNo` separates a seven-minute
cut on a two-track single (a club record) from a three-minute cut on a
twelve-track album (a song). That distinction matters enormously in this
library and costs nothing.

Critically, **this is the only signal that works at zero filing** — see §7.

### 4.5 Era

`released` → `eraOfYear()`, which exists. Carries the caveat
`core/sources/spotify.mjs` already documents: a release date is the date of
*that pressing*, so a reissued 1994 record reads 2019.

### 4.6 Popularity

Bucketed. Weak, plausibly correlated with underground-vs-mainstream, and
entirely capable of encoding a bias nobody wanted. It goes in the fit sweep
(§6.3) and earns its weight or gets zeroed.

### 4.7 Tempo and key — the optional bonus layer

`rekordbox.json` already exists as `{ [trackId]: { bpm, key, camelot, … } }`
and nothing reads it. It is genuinely the user's own factual data rather than a
third party's opinion, so it fits the bonus rule — but it must be **absent by
default and structurally incapable of mattering**:

- Missing file, or a track not in it, changes nothing.
- A guard test asserts identical placements and identical confidence bands for
  every track not present in the file, with and without it loaded.

That test is the contract. Without it this becomes exactly the dependency
`CLAUDE.md` forbids.

---

## 5. The learned playlist definition

For each **filing destination** — reuse the existing axis rule, so only genre
and mood playlists qualify, and mirrors never do:

- **Definition** = centroid of its members in the combined intrinsic space,
  plus a spread measure (the intrinsic analogue of the fingerprint's entropy).
- **Distinctiveness** = how separably its members sit from every other
  destination's members. A bucket with low distinctiveness is either broad or a
  duplicate, and saying so is a *finding*, not a failure.

Scoring a track produces a ranked list of destinations with a confidence band
and — the part that matters for trust — **an explanation in the account's own
terms**, carrying no genre word at all:

> sits with Enzo Siragusa and Seb Zito, who are in this playlist 12 times ·
> same label family as 7 tracks here · seven-minute single, like 80% of this
> bucket · 2023, and this bucket is 70% post-2020

Compare with what the current engine can say, which is "tag cosine 0.71".

---

## 6. Validation — the part that changes the project's economics

### 6.1 Leave-one-out placement accuracy

Held-out membership is ground truth. For each track in a destination playlist:
remove it, ask the engine where it goes, compare to where the account actually
put it.

Metrics: top-1 and top-3 accuracy; **per-playlist** accuracy, which finds the
buckets the engine does not understand; abstention quality (when it declines,
would it have been wrong?); and calibration (does HIGH actually mean high?).

The current blocker — ~500 manually reviewed tracks before any weight is
trustworthy — **largely dissolves for placement**. The harness computes its own
answer key, per account, in seconds.

### 6.2 Leakage is the single biggest correctness risk in this build

A held-out track must not feed the centroid it is scored against, nor the
co-occurrence matrix used to score it. Leak either and accuracy jumps toward
1.0 and the whole exercise becomes a lie that looks like a triumph.

Mitigation is a **deliberate leakage canary**: a test that scores with the
track left in, asserts near-perfect accuracy, then scores correctly and asserts
the number drops. If the canary ever stops distinguishing the two, the harness
is broken. This test is not optional and not a nicety.

### 6.3 What it buys the existing fit sweep

`npm run benchmark:fit` currently reports **4 of 15 parameters FLAT** —
`HIGH_LEADER_SHARE`, `HIGH_MARGIN_RATIO`, `EVENT_SETTLED_DAYS`, `CONTENT_LIFT`
are uncontradicted rather than validated, because twelve synthetic cases cannot
distinguish them. Intrinsic weights go into the same sweep, scored against
leave-one-out accuracy on a real library instead. That is a fitness surface
with thousands of rows rather than twelve.

### 6.4 The honest limit

Leave-one-out measures **consistency with the account's habits, not musical
truth.** It cannot detect a systematically misfiled library, and it will
faithfully reproduce existing mistakes. For a filing tool whose job is "put it
where you'd have put it", that is the right target — but it is not a claim
about genre, and nothing in the UI should imply it is.

---

## 7. Cold start — and where the requirement genuinely conflicts

The engine must work on a near-empty account. It must also **say which rung it
is standing on**, because silently degrading is how a tool loses trust.

| Rung | Condition | What it does |
|---|---|---|
| 0 | nothing filed | No placement suggestions — there is nowhere to place. Instead: **cluster and name.** Group liked songs by format shape, era and artist identity, and offer the groups as candidate playlists. This bootstraps the labels the rest of the engine needs. |
| 1 | <10 playlists | PPMI too sparse to mean anything. Direct artist-identity match (this artist is already in this bucket) + format + era. Low confidence, mode stated. |
| 2 | ~10+ playlists | PPMI meaningful. Full intrinsic engine. |
| 3 | established | Everything, with label families and session structure at full weight. |

**The conflict, stated rather than hidden.** "Works from a near-empty account"
and "does not rely on external data" cannot both be fully satisfied at rung 0,
because an account with nothing filed contains no internal structure to learn
from — that is arithmetic, not a design failure.

The resolution: a near-empty account gets **help building its taxonomy**, not
accurate filing into buckets that do not exist yet. Accurate filing there is
not a well-posed problem.

At rungs 0–1 the shipped tag table (§1) and a Last.fm key if present may break
ties, labelled as doing so, and are forbidden from overriding intrinsic
evidence at rungs 2–3. That confines the crutch to the rungs where the gap is
genuinely arithmetic and makes it visible whenever it is load-bearing.

Two things follow that the UI has to carry, or the honesty is decorative:

- **Report the rung**, not just the confidence. "Low confidence" and "not
  enough of your library filed yet to be confident" are different sentences and
  only the second tells the listener what would fix it.
- **Report tag-table coverage as a first-class number.** How many of this
  account's artists the shipped table actually covers is the single best
  predictor of how well the *old* model will do for them, and it is currently
  computed nowhere. `misfile.mjs` does a coverage check for its own report;
  nothing surfaces it to a listener.

---

## 8. Phases

Each phase ends in something measurable. Phase 0 is the one that decides
whether the rest happens.

### Phase 0 — Feasibility, measured. No user-visible change.

New: `core/intrinsic/cooccurrence.mjs` (PPMI graph, bounded per §4.1),
`core/intrinsic/features.mjs` (§4.2–4.6 from fields already captured),
`core/intrinsic/space.mjs` (combined vector, cosine),
`core/validate/loo.mjs` (the harness and its leakage canary).

CLI: `npm run validate:placement` — top-1/top-3 for **intrinsic-only vs v1 vs
v3-with-tags** on the same library.

**Gate:** does intrinsic-only match or beat v1 on your library? If it does not,
stop and re-plan rather than building six phases on a premise that failed. The
cost of finding out is roughly a day.

### Phase 1 — The browser bridge. Prerequisite for anything in-app.

`build-web.mjs` bundles exactly `norm.mjs`, `credits.mjs`, `profile.mjs`, by
regex-stripping imports and concatenating. `core/` is 34 modules with a real
dependency graph, so **no part of v3 can currently reach the phone.** That, not
just the benchmark, is why v3 is unwired.

The graph is a clean DAG, so: extend `build-web.mjs` with a topological-sort
bundler over `core/`. No new dependency — the project's zero-dependency
property is worth keeping.

- Exclude Node-only modules. `core/sources/musicbrainz.mjs` pulls
  `musicbrainz.mjs`, which needs a `User-Agent` a browser `fetch` cannot set.
- Fail loudly on a cycle and on a duplicate top-level name, rather than
  emitting a file that half-works.
- Keep the single-file output and the existing secret guard intact.
- Tests: order validity, cycle detection, collision detection, and a parity
  test proving bundled `core` behaves identically to imported `core`.

This phase is independently valuable: it unblocks *all* of v3, not just this.

### Phase 2 — The engine, and its explanations.

`core/intrinsic/definitions.mjs` (learned definitions + distinctiveness),
`core/intrinsic/place.mjs` (scoring, bands, explanation objects per §5).

Reports that answer "the differences between genres, playlists and more":

- **Distinct vs duplicate buckets** — two destinations whose learned
  definitions are inseparable. Complements the existing §19 containment
  relationships with a *learned* measure rather than an overlap one.
- **Boundary tracks** — tracks sitting between two buckets. Also the best
  review-queue fodder there is.
- **Drift** — a playlist whose recent add-sessions sit away from its own
  centroid. `misfile.mjs` has a tag-based `findDrift`; this is its intrinsic
  twin.
- **Unnamed clusters** — groups that hang together in intrinsic space and
  belong to no playlist: candidate new buckets, learned rather than
  tag-clustered.

Intrinsic weights enter `core/benchmark/fit.mjs`, scored against §6.1.
`analyse-v3.mjs` gains shadow mode: both engines, side by side, same library.

### Phase 3 — The cold-start ladder.

Rung detection, explicit mode reporting, and the rung-0 cluster-and-name flow.
Fixtures per rung, including a three-playlist library and an empty one — the
cases that will otherwise be discovered by a new user rather than by a test.

### Phase 4 — Rekordbox as a bonus layer.

`core/intrinsic/bonus-rekordbox.mjs`, absent by default, plus the guard test
from §4.7 that makes its absence structurally free.

### Phase 5 — In-app: the queue screen, and shadow filing.

Needs Phase 1. The review queue becomes a real screen rather than the
standalone `review-v3.html`: boundary tracks, unmapped concepts, playlist-type
questions. Answers write through the existing `CorrectionLog`, which is
append-only and already separate from provider evidence in both directions.

While shadowing, the File screen can show the disagreement — "v1 says Deep
House, the new engine says Lyricism" — which is both a trust-builder and a
free source of corrections.

### Phase 6 — The cutover gate, and misfile.

Per your choice, filing switches to intrinsic **only when leave-one-out
accuracy beats v1 on your own library**, with the number shown rather than
asserted. v1 stays reachable as a fallback for one release.

Then misfile migrates onto the intrinsic space, so "this is in the wrong place"
arrives with the evidence trail from §5 instead of a bare flag. This is the
first place the engine tells you to move music, so it goes last on purpose.

---

## 9. Risks, and what each one costs

| Risk | Why it bites | Answer |
|---|---|---|
| **Leakage in the harness** | Inflates accuracy toward 1.0 and looks like success | The canary test in §6.2. Non-negotiable. |
| **Circularity** | Learning from membership and then suggesting membership reinforces what is already there and never surprises you | Discovery stays a separate path. The engine is explicitly a *filer*, not a recommender. |
| **Aggregator ISRCs** | Dilutes the label signal | Playlist-span down-weighting (§4.2). Self-correcting. |
| **Popularity bias** | Encodes something nobody asked for | In the fit sweep; earns its weight or is zeroed. |
| **Phone performance** | PPMI over thousands of artists in a browser | Bounded per §4.1, cached per snapshot, and **measured on a real library before Phase 5 rather than assumed**. |
| **Bundle-order fragility** | A silently mis-ordered bundle half-works | Cycle + collision detection that fails the build, plus the parity test. |
| **Cold-start honesty** | A rung-0 account could be shown confident nonsense | Rung is reported, not inferred by the user from vibes. |
| **`docs/index.html` is the shipped page** | Phase 5 touches it | Existing secret guard and build-guard tests stay; the page is rebuilt and diffed, never hand-edited. |

---

## 10. What this does not change

The v3 work stands. Ontology, `TrackIdentity`, the evidence record, the
append-only correction log, the review queue's prioritisation, mirror
detection, the AI constraint layer and the recommendation layer's refusal to
move anything all survive untouched.

What changes is **which layer decides**. And one honest note on shape: the
co-occurrence space is *not* a `defineProvider` adapter. It asserts no concept
from a source; it computes a space. It sits beside `core/analysis/classify.mjs`
rather than inside the provider registry, and pretending otherwise to make the
architecture diagram tidier would be a mistake.

---

## 11. Execution log

This section is the build's memory. It is updated in the same commit as the
work it describes, so the state of the build is readable from the repository
rather than from anybody's recollection.

Status values: `not started` · `in progress` · `done` · `blocked` · `abandoned`.

| Phase | Status | Gate | Evidence |
|---|---|---|---|
| 0 — feasibility & harness | `in progress` — built, **gate unrun** | intrinsic-only ≥ v1 on a real library | 29 tests; 667 suite-wide. Needs `library.json` to answer. |
| 1 — browser bundling bridge | `done` | bundled `core` parity test passes | 16 tests; parity asserted; page rendered in Chromium with 0 errors |
| 2 — engine & explanations | `done` | weights enter the fit sweep | 42 intrinsic tests; sweep + componentValue against real filing |
| 3 — cold-start ladder | `done` | rung fixtures pass, incl. empty library | 50 intrinsic tests; rung 0 and rung 1 both exercised through the CLI |
| 4 — Rekordbox bonus layer | `done` | absence-is-free guard test passes | guard asserts byte-identical output for every unknown track |
| 5 — in-app queue & shadow | `not started` | queue renders on the phone build | — |
| 6 — cutover & misfile | `not started` | leave-one-out beats v1, number shown | — |

### Decisions taken, and by whom

- **Cutover policy:** shadow until it beats v1, then one switch. *(Owner's
  choice, 2026-09-30.)*
- **Cold start:** must work from a near-empty account. *(Owner's choice.)* The
  arithmetic conflict this creates is resolved in §7 rather than hidden.
- **Rekordbox:** in scope as a pure bonus layer, gated by the §4.7 guard test.
  *(Owner's choice.)*
- **Scope:** engine + in-app queue + misfile migration. *(Owner's choice.)*
- **v3 is substrate, not competition.** The owner's instruction was to
  disregard the previous build where that produces a better outcome. The
  judgement taken here: keep what is independently correct and reusable — the
  ontology, `TrackIdentity`, the evidence record, the append-only correction
  log, mirror detection, the queue's prioritisation, the recommendation
  layer's refusal to move anything — and replace only the inference path that
  made external tags load-bearing. Discarding 638 passing tests to prove
  independence would be loyalty to a gesture rather than to the outcome.

### Findings that changed the plan after it was written

- **2026-09-30.** `docs/tags.json` ships 4,866 artists and the page reads it
  with no key, so the original claim "no key, no signal" was wrong and is
  corrected in §1. The argument that replaces it is stronger: coverage is
  biased to one library's taste, the shared write path is shape-checked rather
  than truth-checked, and granularity is still one cloud per artist.

- **Phase 0, three fixture and metric defects, each found by running it rather
  than reading it.** Recorded because the same traps are waiting in Phase 2.

  1. *An empty graph that looked like a working one.* The first fixture gave
     every artist exactly one playlist, so `MIN_ARTIST_PLAYLISTS` dropped all
     of them and the artist graph was **entirely empty** — yet held-out
     accuracy came out at 0.78 on shape features alone. A number that high
     reads as proof the graph works. The general lesson for a real library:
     if most artists sit in exactly one bucket, co-occurrence has nothing to
     say and the engine is quietly running on format and era. The CLI now
     prints that share and warns past 80%.
  2. *A ceiling that blinded the canary.* With each family given its own era,
     album type and popularity, every track was placeable from shape alone and
     both the honest and the leaky path scored exactly 1.000 — so the canary
     could not detect leakage even in principle. A fixture must leave the
     honest path room to be wrong, or the test that guards the harness is
     itself untested.
  3. *A per-bucket metric no view could ever win.* Crediting a bucket only when
     it ranks first gave every crossover playlist exactly 0.0, because a
     "Favourites" view always loses to the tighter bucket its tracks also live
     in — the engine was right and the metric said otherwise. Replaced with
     three numbers: `rank1`, `inTop3` (fair to both kinds, and what the worst-
     bucket table now sorts by) and `exclusive` (rank 1 among tracks whose only
     home is that bucket).

- **The two engines fail on correlated cases, which makes synthetic comparison
  worthless in both directions.** The intrinsic engine is weakest on a record
  whose artists appear nowhere else in the library. Those are obscure artists —
  which is exactly who Last.fm and the shipped tag table have least on. So a
  real comparison could go either way, and a synthetic one tells you only about
  the fixture: giving every artist a family-named tag, as the test fixture
  does, hands v1 a perfect answer key precisely where reality would hand it
  nothing. Two consequences worth carrying into later phases: the Phase 0 gate
  is meaningless until it runs on a real library, and Layer 2 tie-breaking is
  most valuable exactly where intrinsic signal is thinnest, which is an
  independent argument for the §7 ladder rather than a concession.

- **Phase 1 found that two unused lines were keeping v3 off the phone.**
  `core/sources/musicbrainz.mjs` re-exported the root module's `resolveMbid`
  and `extractArtistMbid` as a convenience — and **nothing ever imported them
  from there**; `enrich-lastfm.mjs` and the tests both go to `musicbrainz.mjs`
  directly. Those two lines were the only reason the engine graph reached
  `musicbrainz.mjs` -> `cache.mjs` -> `node:fs`, which is what made the whole
  graph unbundleable for a browser. Deleting them changed no behaviour.

- **The bundler's first design was wrong, and the build said so immediately.**
  It kept flat concatenation and added a name-collision check, on the theory
  that a duplicate should fail the build rather than let the second declaration
  win. Run against the real graph it refused at once: **every provider adapter
  exports `toEvidence`**, which is the provider interface working exactly as
  designed rather than a mess to tidy. Renaming five adapters to suit the
  bundler would have been the tail wagging the dog, so the bundler changed
  instead — each module gets its own scope and returns its exports, which makes
  duplicate names across modules a non-issue rather than something to police.
  `profile.mjs`'s `cosine` and `core/intrinsic/cooccurrence.mjs`'s `cosine` now
  coexist, and a test asserts they are different functions.

- **Four web tests and the build guard were coupled to the old flat layout.**
  They sliced `docs/index.html` between module header comments and ran the
  fragment, which only worked because concatenation put everything at top level.
  They now run the whole generated bundle, which is strictly more faithful —
  they exercise the file a browser actually gets, including the exposure lines,
  rather than a hand-cut fragment of it.

- **Shipping decision: `--with-core` is off by default.** The bundler can now
  put the v3 engine on the phone, and doing so adds ~234 KB to a 323 KB page.
  Until a screen uses it that is a download every listener pays for nothing, so
  the flag exists and stays off until Phase 5 turns it on. Building the bridge
  is not a reason to drive traffic over it.

- **Verified by rendering, not by reading.** The built page was loaded in
  headless Chromium: v1's functions are present as globals, `tagFacet`,
  `norm` and `rank` behave, and there are zero console errors. With
  `--with-core`, `BetterfyIntrinsic.buildSpace` / `placements` and
  `BetterfyValidate.placementAccuracy` all run in the browser, also with zero
  errors. `norm('  Déjà Vu ')` returns the identical string in Node and in
  Chromium.

- **Phase 2 deviated from the planned file split, deliberately.** The plan named
  `definitions.mjs` and `place.mjs`, but `space.mjs` already held learned
  definitions and scoring, so those files would have been a rename with extra
  indirection. What was actually missing was `explain.mjs` and `reports.mjs`.
  The plan is the argument, not a contract to be honoured past the point of
  usefulness.

- **An explanation that is true of every bucket is a horoscope.** The first
  version emitted "a single, and 100% of this bucket is too" — perfectly true,
  and identical under every alternative, so it made the reasoning look thorough
  while helping nobody choose. Format and era clauses are now compared against
  the library-wide base rate and dropped unless they *distinguish* this bucket.
  The same IDF instinct that stopped "electronic" dominating every tag
  comparison, one layer up.

- **"Fits no bucket" cannot be defined by a low score.** A record by artists the
  library has never seen still matches every bucket on format, era and
  popularity, so generic shape clears any absolute threshold and the first
  version of `unnamedClusters()` reported that every stranger was comfortably
  placed. It now asks which *kind* of evidence was available: a placement with
  no artist-graph component at all is the engine guessing from the shape of the
  object, and that is what homeless means.

- **The sweep asks whether a component earns its place before asking how to tune
  it.** `componentValue()` reports what removing each weight entirely would
  cost, because "best at 0.1" invites tuning while "removing it costs nothing"
  invites deleting it — usually the better answer, and never the one a sweep
  volunteers. A test asserts that zeroing the artist graph measurably *hurts*
  accuracy, so if the graph ever stops being load-bearing the suite says so
  rather than the engine quietly running on format.

- **The rung is about evidence, not library size.** A listener with 4,000 tracks
  in two buckets is on a lower rung than one with 400 across twenty, because the
  second has told the engine far more about what they mean. A test asserts
  exactly that, since "big library must mean good signal" is the intuitive and
  wrong reading.

- **Rung 0 has to be a different product, not a degraded one.** With nothing
  filed there is nowhere to place anything, so the engine proposes groups to
  name — by lead artist where somebody has enough records, and by the shape of
  the release otherwise — rather than answering a question that is not
  well-posed. The CLI prints this instead of the accuracy table and says plainly
  that nothing below it will mean much yet.

- **Tag-table coverage is now a first-class number.** It is the best predictor
  of how the *tag* engine treats a given listener and was computed nowhere they
  could see. Under 50% the CLI names it for what it is: what the shipped table
  being one library's taste looks like from the outside.

- **The bonus guard is asserted, not claimed.** For every track the Rekordbox
  file does not cover, the test compares the full placement output — ranking,
  scores and band — with and without the file loaded, and requires them to be
  deep-equal. A second test requires the layer to be *capable* of mattering
  where the file does cover both sides, since a guard is trivially satisfied by
  a feature that never does anything.

- **A finite number is not a usable one.** The first version of `bonusIndex()`
  kept a row whose bpm was `-1` and which had no key, because `-1` is finite —
  an entry that exists and says nothing, which is worse than no entry, since
  `bonusProfileOf` would count it toward the threshold that decides whether a
  bucket has enough tempo data to judge on. Caught by its own test.

- **Half and double time are deliberately not a tempo match.** The arithmetic
  works and the records do not belong together: a 140 bpm track is not at home
  in a 70 bpm bucket.

- **v1 already contains a narrow version of this idea.** `artistHistory()` in
  `profile.mjs` places a track by where its primary artist's other tracks
  already live, and its comment says outright that "the user's own playlists
  are themselves evidence, free of any third party". It fires only as a
  fallback, only on the first-billed artist, and only on a strong majority.
  This build generalises that instinct rather than introducing it.
