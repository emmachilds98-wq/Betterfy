# Smarter genres, and playlists for the genres you aren't covering — plan

Written 2026-11-13. It follows on from `docs/GENRE-RECOGNITION-PLAN.md`
(which fixed filing into non-genre playlists and added the scene genres) and
`docs/AUDIO-ANALYSIS-PLAN.md`. Nothing here is built yet. Facts marked
*measured* were measured on 2026-11-13 against the 4,866 artists in
`docs/tags.json`. That table was seeded from the owner's library, so it is
the closest thing this repo has to "your Spotify". Facts marked *checked*
come from a live request or a primary document read the same day.

The owner asked for three things:

1. Get genres right, and keep getting them right.
2. Help sort, and **propose new playlists** for genres the library plays but
   doesn't file.
3. Find new, free tech and assistive features for this.

And one constraint: it has to work for **every** account, not just the
owner's.

---

## 0. The short version

- **One new, free signal tested well: similar-artist graphs from Deezer and
  ListenBrainz.** They answer the engine's weakest case, a track by an
  artist you've never filed. They need no key and no install, and they run
  in the browser. *Measured:* Deezer has a related-artist list for **81%**
  of the niche scene artists that Wikidata doesn't know at all (§2).
- **Most of "propose new playlists" is already written and never shipped.**
  `underservedGenres()`, `buildPlaylist()`, mixed-playlist detection and
  the unnamed-cluster report all exist in `core/`. Most run only from the
  command line, and none of them can create a playlist. The work is to put
  them on the blended engine and on one screen (§5).
- **"Accurate" gets a number you can check.** The plan calibrates the
  engine on your own filing, so "confident" means "right at least 9 times in
  10 on tracks you've already filed". Anything less sure is offered as a
  choice or held back (§4.2).
- **A rule nobody had written down changes two earlier ideas.** Spotify's
  Developer Terms (v10, May 2025) forbid putting Spotify content into an
  AI/ML model, and forbid pooling it into databases. That rules out a
  runtime chatbot reading your playlists, and it changes the "shared filing
  across users" idea (§3).

**What you need to do** is in §8. It's four answers and one re-run.

---

## 1. Where things stand

| Piece | State |
|---|---|
| Filing only into genre playlists, spellings merged, scene genres in the vocabulary | Merged (#46) |
| Account-native engine (your own filing as the training set) | Merged (#43). Shadow mode on the Engine screen |
| Score both engines on your own library | Built. **The post-#46 number hasn't been reported here yet** |
| `underservedGenres()`: genres you play but haven't filed | Written (`core/recommend/suggest.mjs:199`). CLI only. Runs on Last.fm-based v3 profiles |
| `buildPlaylist()`: propose a playlist for a genre | Written (`suggest.mjs:245`). CLI only |
| Mixed-playlist detection (`clusterVerdict` → MIXED) | Written (`core/playlists/clustering.mjs`). Not on any screen |
| "These two playlists are the same thing" (`bucketPairs()`) and "these tracks hang together but have no playlist" (`unnamedClusters()`) | Written (`core/intrinsic/reports.mjs`). Pairs show only on the Engine screen. Unnamed clusters show nowhere |
| Audio analysis | Plan only (`AUDIO-ANALYSIS-PLAN.md`) |
| MusicBrainz + iTunes tags | PR #41, open, waiting on a yes/no |

The engine's known weak spot comes from #43's own reports. A track by an
artist you have never filed can only be placed on "shape": length, single
or album, era. Shape can't tell bassline from UKG.

---

## 2. What the research found

### 2.1 Free data sources, tested live

| Source | Key? | Works from the page? | What it gives | On your library (*measured*) |
|---|---|---|---|---|
| **Deezer related artists** (`/artist/{id}/related`) | none | JSONP only: no CORS header (*checked*), same as the audio plan's lookup | ~20 "fans also like" artists | Of 70 scene-genre artists **missing from Wikidata**, 68 found on Deezer, **57 (81%) have a related list**. The lists are scene-coherent: Coco Bryce → Tim Reaper, LTJ Bukem, Source Direct. KLOFAMA → SLVL, Toxic Machinery. Denon Reed → TS7, Chad Harrison. The Blackout Crew → Ultrabeat, Big Ang, N-Force |
| **Deezer track by ISRC** | none | JSONP | The exact Deezer artist id from the ISRC Spotify already gives (*checked*: ISRC → `artist.id` + `contributors`). No name matching | Same call the audio plan needs for previews, so one request feeds both |
| **ListenBrainz similar artists** (`labs.api.listenbrainz.org/similar-artists`) | none | yes, `access-control-allow-origin: *` (*checked*) | Up to 100 similar artists with scores, from real listening sessions | Of 157 scene artists with an MBID, **142 (90%)** had at least one neighbour in the library. A neighbour vote agreed with the artist's Last.fm genre **56%** of the time: dnb 88%, grime 59%, dubstep 30%, UKG 21%. Non-scene genres: 53% |
| **Wikidata** (SPARQL) | none | yes, CORS open (*checked*) | Spotify artist id → MusicBrainz id + genres. 300 artists per request | 71,020 artists worldwide carry a Spotify id. Your library: **1,992 of 4,866 (41%)** found, 1,631 with a genre, 1,950 with an MBID. **Weak on scene genres:** jungle 5 of 78, UKG 26 of 132, bassline 1 of 20, hard house 0 of 7, donk 0 of 3 |
| MusicBrainz | none | CORS open, but returned `503 busy` today and allows 1 request/second | Genres and tags (PR #41) | Not re-measured |

**How to read the 56%.** It is agreement with Last.fm's top tag, which is
itself coarse ("hardcore" covers both punk and rave). It is not agreement
with *your* filing. The test that matters is the held-out score on your own
playlists, and phase 0 runs exactly that (§7). The coverage figures don't
have that caveat: the neighbours exist, and they cover the artists the
other sources miss.

**Why this signal fits the engine.** It never has to name a genre. "Artists
like this one that you've already filed went into *your* Jungle playlist"
is a vote in your own buckets, so it is account-native. It reaches past your
library to artists you have never filed.

### 2.2 Audio models that run in the browser

| Model | Size | Licence | Strength |
|---|---|---|---|
| Discogs-EffNet (already in the audio plan) | 18 MB | CC BY-NC-SA (non-commercial) | 400 Discogs styles that include **Donk, Bassline, Speed Garage, Hard House, Makina, Jungle**. Supervised on exactly these labels |
| LAION CLAP (`larger_clap_music`) | 78 MB audio encoder, quantised ONNX (*checked*) | **Apache-2.0** (*checked*) | Open vocabulary. Genre names are embedded as text once, at build time, and shipped as a small table, so the page never downloads the text model. Weaker on scene genres it rarely heard in training (*not measured*) |
| Runtimes | — | `onnxruntime-web` 1.31.1 (MIT), Transformers.js 4.3.2 (Apache-2.0) | WebGPU where available, WASM otherwise |

The recommendation stands: **EffNet first**. CLAP is the fallback if you
say no to a non-commercial licence. Either one also gives each playlist an
"audio fingerprint": the average sound of its members. That makes audio
account-native in the same way the artist graph is.

### 2.3 Spotify, as of now (*checked* against Spotify's Feb 2026 migration guide)

- Development-mode apps: 5 users per app, and the owner needs Premium. The
  page already handles this with "use your own Spotify app".
- Gone for new apps: batch `GET /artists`, `/browse/*`, artist top tracks,
  and **track `popularity`**. The engine's popularity component simply drops
  out for those accounts (`combine()` renormalises), so no change is needed.
  Nothing in this plan needs any of these endpoints.
- The repo is already on `/playlists/{id}/items` and `/me/library`.
- Still no genres, audio features or recommendations from Spotify. Unchanged
  from `CLAUDE.md`.

### 2.4 On-device LLMs

Chrome's built-in Gemini Nano (Prompt API) and WebLLM are free and run on
the device. Reports conflict on whether the Prompt API is stable for
ordinary web pages yet. That point doesn't matter, though, because of §3.

---

## 3. The rule this plan adds: what Spotify's terms allow

Spotify's Developer Terms **v10 (effective 15 May 2025)**, *checked*:

- **IV.2.1(a)** forbids "using the Spotify Platform or any Spotify Content to
  train a machine learning or AI model" or "otherwise ingesting Spotify
  Content into a machine learning or AI model".
- **IV.3.1.1** says "you may not store, aggregate or create compilations or
  databases of Spotify Content" beyond what the app strictly needs.
- **IV.2.5** forbids transferring data received from Spotify to third
  parties, "including aggregate, anonymous or derivative data".

No doc in this repo mentions these yet. This is a reading, not legal advice.
The conservative design that follows is:

| Rule | Consequence |
|---|---|
| **R1. No Spotify content goes into an AI/ML model.** | No runtime LLM or chatbot reads your track, artist or playlist names. That includes Gemini Nano. Pretrained audio models are fine: they hear *Deezer's* preview, fetched by ISRC, and were never trained on Spotify data. The offline vocabulary pass (signal E in the genre plan) is fine too, because its input is Last.fm's tag strings, not Spotify's |
| **R2. Data derived from your Spotify account stays with your account.** | Your own devices and your own sync only. **The "shared filing across users" idea (signal C in the genre plan) is dropped.** Pooling which artists users put in "Donk" playlists is a compilation of Spotify-derived data passed to other users |
| **R3. Statistics on your own library, shown back to you, are the allowed use.** | The account-native engine, the similar-artist vote and per-playlist audio fingerprints are all nearest-neighbour lookups and counts. Nothing is trained or shipped, and they work like the engine already live. Weight fitting stays a small per-device parameter sweep that is never shared |

**One existing thing for you to look at:** the shared tag table
(`docs/tags.json`, plus the Firestore collection that feeds it) is keyed by
**Spotify artist ids**. Its *values* are Last.fm's tags, not Spotify's. Its
*keys* came from Spotify. Re-keying it by MusicBrainz id (1,950 of 4,866
artists already have one via Wikidata, *measured*) or by Deezer id would
take it out of the question. That's a decision for you (§8). I haven't
changed anything.

---

## 4. The design

### 4.1 Evidence: what the engine gets to look at

All of it is keyless, runs in the browser, and is silently absent when a
source fails or doesn't know the artist.

| # | Signal | Answers | New? |
|---|---|---|---|
| a | **Your own filing**: artist graph, label family from ISRC, shape, era | "Where do *you* put music like this?" | exists (#43) |
| b | **Neighbour bridge**: Deezer related + ListenBrainz similar → neighbours you've filed → votes into your playlists | "Where did you put this artist's *neighbours*?" (fixes never-filed artists) | **new** |
| c | **Genre names**: Last.fm (with a key) + shared table + **Wikidata** + MusicBrainz/iTunes (#41) → one vocabulary | "What is this called?" (needed to *name* a new playlist) | Wikidata is new |
| d | **Audio**: EffNet styles + per-playlist audio fingerprint | "What does this recording sound like?" (fixes untagged scene genres) | planned |
| e | **Your corrections** | "You told me." Always wins | exists, local only |

**What gets fetched first is set by your listening.** `/me/top/artists`
over three windows plus recently-played, as `CLAUDE.md` asks. The tracks
you're playing get fixed first. Everything is cached per artist under the
existing "a thin answer isn't permanent" rule.

**Identity is exact, never by name.** ISRC → Deezer track → Deezer artist id.
Spotify artist id → Wikidata → MBID → ListenBrainz. A same-named artist can't
slip in, which is the lesson from `README.md` on Last.fm's autocorrect.

### 4.2 Blend, calibrate, and admit when it doesn't know

1. **Blend** the components into one score per (track, playlist). The weights
   are fitted on *your* held-out filing by the harness that already exists
   (`core/validate/loo.mjs`). Any component can be missing, and the rest
   renormalise.
2. **Calibrate.** Map the blended score to "how often a score this high was
   right" on your own held-out tracks (isotonic regression: one pass, a few
   dozen lines).
3. **Prediction sets (split conformal).** For each unfiled track, return
   the smallest set of your playlists that contains the right one at least
   90% of the time on your held-out tracks. The guarantee comes from the
   method, so it doesn't rest on anyone's guess at thresholds:
   - **One playlist in the set:** "Confident". This is the only band that
     could ever file in bulk.
   - **Two or three:** "Pick one", as one tap between the candidates.
   - **Empty, or most of your playlists:** "Not sure". If several of those
     tracks cluster together, they become a *new-genre* candidate (§5).
4. **The Engine screen shows the number:** "Confident suggestions were right
   93% of the time on 1,200 tracks you'd already filed." That replaces a
   bare percentage nobody can check.

### 4.3 Assistive features (free, and they make it smarter as you use it)

- **Teach queue (active learning).** Ten tracks at a time, picked where an
  answer helps most: tracks the engine is unsure about, weighted by how much
  you play the artist. Each answer becomes a correction, re-scores
  everything at once, and tightens that playlist's definition.
- **Artist roll-forward.** Confirm one track, and it offers "file the other
  7 by this artist here too?" with the list shown and nothing ticked
  silently.
- **Reasons in your own terms**, extending `core/intrinsic/explain.mjs`:
  "sits with Tim Reaper and Source Direct, both in your Jungle". Neighbour
  evidence is far easier to trust than a percentage.
- **Corrections sync across devices.** This is UPGRADE-PLAN §4's open item.
  Teach-queue answers are worth too much to live on one phone.
- **Accessibility on every new screen:** labelled controls, one-tap actions,
  confidence shown in words as well as colour, and everything reachable by
  keyboard.

---

## 5. Gaps: proposing new playlists, and fixing the ones you have

A new **Gaps** screen (under Playlists) shows a coverage map and up to four
kinds of proposal. Nothing is created or moved without a tap. New
playlists are private.

| Gap | Detected by | Proposal |
|---|---|---|
| **Uncovered genre.** You play it but have no genre playlist for it | Consensus genre of liked + recently played tracks, rolled up the ontology (`lineageOf`) to the level people name playlists at, compared against your genre playlists | "You've played 38 bassline tracks this month and none are in a bassline playlist. **Make 'Bassline'** with these 52?" Preview, untick, create. `POST /me/playlists` + `/items` are already used by the page |
| **Catch-all playlist.** One playlist holding two genres | `clusterVerdict()` → MIXED, run on the blended space, with names from 4.1c/d | "Your 'Bass' playlist splits into **UKG (61)** and **Bassline (44)**. Split it?" Moves are previewed, and the original stays until you confirm |
| **Twins.** Two playlists the engine can't tell apart | `bucketPairs()` in `reports.mjs`, plus how often held-out tracks from one land in the other | "'DnB Rollers' and 'Liquid' sit almost on top of each other. Merge them, or keep both and teach the difference?" The second option feeds the teach queue |
| **Nameless cluster.** Tracks that hang together but match no vocabulary entry | `unnamedClusters()` in `reports.mjs`, run on the "Not sure" pile from 4.2 | "These 25 hang together: Blackout Crew, Big Ang, N-Force. **What do you call them?**" Your name becomes a genre playlist, and an alias for *your* account only |

**Ranked by listening:** the gap you're playing most comes first.

**Naming rule:** the most specific genre that most members agree on (reuse
`underservedGenres()`'s roll-up). Audio styles and Wikidata break ties. If
nothing reaches a majority, it's a nameless cluster and you name it.

This rebuilds `underservedGenres()`, `buildPlaylist()`, `bucketPairs()` and
`unnamedClusters()` into one screen on the blended engine, not on Last.fm-only v3 profiles. That keeps them working with no
key, as `CLAUDE.md` requires.

---

## 6. Every account, not just the owner's

- **Works per account, from Spotify alone.** No key, no export, no install.
  Bridges, Wikidata and audio are keyless. Last.fm and Rekordbox remain
  optional bonuses.
- **Rungs decide what leads.** No genre playlists yet: the Gaps screen
  proposes starter playlists from liked songs, named by 4.1c. A few
  playlists: the bridges carry most of the weight. A big, well-filed
  library: your own filing leads. The existing rung card says which one
  applies.
- **A Sources card shows coverage per account**, for example "Deezer knows N%
  of your artists, Wikidata M%", worked out on that account. A source that is
  thin for someone's taste then shows up as thin.
- **Request budget, so a big library doesn't stall.** At 2 Deezer calls per
  artist and Deezer's limit of about 50 per 5 s, 5,000 artists take about
  17 minutes. Wikidata needs about 17 batched queries. So: run in the
  background (the Worker exists), resume across visits, top-listened artists
  first, and never block the page.
- **Privacy:** these sources see artist ids and ISRCs from the listener's own
  browser, as Last.fm already does. No Spotify-derived data leaves the
  account (R2). There is one switch in Settings to turn the bridges off.

---

## 7. Order of work, with gates

Each step has to beat the step before it **on your held-out filing**, with
the owner's library as the real test and a small synthetic library as the
"doesn't break new accounts" test. A source that doesn't help ships switched
off.

| Phase | What | Gate |
|---|---|---|
| **0** *(built 2026-11-14; waiting on the owner's run)* | Measurement only. Add the bridge (Deezer + ListenBrainz via Wikidata) as an optional component in `validate-placement` and the Engine screen's **Score**, reporting coverage and accuracy with and without it, overall and on **never-filed artists** | Top-1 placement on never-filed artists up by ≥5 points, overall not down. If it fails, stop and report |
| **1** | Ship the bridge: `core/sources/deezer.mjs`, `listenbrainz.mjs`, `wikidata.mjs` (pure parse functions + thin fetch, fixture-tested like `discogs.mjs`); `core/intrinsic/bridge.mjs` as one more `combine()` component; per-artist cache; listening-ordered background fetch | Test proving that with no bridge cache the output is byte-identical to today |
| **2** *(built 2026-11-14)* | Calibration + prediction sets (`core/intrinsic/calibrate.mjs`); show "right N% of the time" on the Engine screen | The stated rate holds on a second held-out fold within ±3 points |
| **3** *(first half built 2026-11-14)* | **Gaps** screen: uncovered genre → create, split, twins, nameless cluster | Each proposal type has a fixture test. Nothing is written to Spotify without a tap (`verify-untouched.mjs` pattern) |
| **4** | Teach queue, artist roll-forward, corrections + axis-override sync | Score after 20 teach answers beats the score before them |
| **5** | Audio (`AUDIO-ANALYSIS-PLAN.md`, its own phase 0 first), now feeding the blend, the Gaps naming and per-playlist audio fingerprints | That plan's gates |
| **6** | Vocabulary pass for the still-unplaced tags (emo, industrial, EBM…). Offline, human-reviewed PR | Ontology tests |

**Phase 0 as built (2026-11-14).** `core/sources/{deezer,listenbrainz,wikidata}.mjs`
(pure parsers), `core/intrinsic/bridge.mjs` (the component) and
`bridge-fetch.mjs` (paced, cached, injected transports) are in. **Score both
engines** now gathers similar artists for the tracks it is about to score,
then scores each one with and without them on the same folds. It reports the
never-filed subset and the verdict against the gate above, and Copy results
carries all of it. Found and fixed on the way:

- **A bundler bug.** `import { a as b }` was emitted as `const { b } = …`, so
  any aliased import was silently `undefined` in the phone build. It showed up
  as Wikidata never being asked in Chromium. It's fixed and tested, and an
  aliased local export now fails the build instead.
- **Wikidata needs a User-Agent.** It returns 403 to Node's default. The
  browser sends its own, and the CLI sends the project's.
- **ListenBrainz sometimes errors without a CORS header** under a burst. The
  same request a moment later is fine, so it now gets one retry and a slower
  pace.
- **Deezer by JSONP runs in a sandboxed frame** (`allow-scripts` only). A
  script tag would otherwise run Deezer's response with the page's authority,
  Spotify sign-in included. Checked in Chromium: the frame gets a
  SecurityError reading storage, and lookups work.

**Indicative number, from a simulation and not the gate.** This test library
was built from 228 real artists in `docs/tags.json`, with real ISRCs,
durations and release dates from Deezer, across eight scene genres (444
tracks). Each artist was filed by its Last.fm genre, plus three crossover
playlists. Scored with only the genre playlists as destinations, as the phone
does:

| | without | with similar artists |
|---|---|---|
| top-1, all 444 tracks | 39.4% | **59.5%** |
| top-1, 26 tracks by never-filed artists | 23.1% | **57.7%** |

Deezer answered for 202 of the 228 artists and ListenBrainz for 45. 138 had
neighbours in the library, and the bridge had a say on 272 tracks. The lift
barely moves between weights 0.25 and 2. The caveat is a big one: the
playlists were filed *by Last.fm genre*, and crowd genre correlates with
"fans also like", so this flatters the bridge compared with a real person's
filing. Only the owner's run answers the gate.

The bridge is not on the File screen and changes no suggestion. Phase 1 waits
on the gate.

**Phase 2 as built (2026-11-14).** `core/intrinsic/calibrate.mjs`, fed by
`placementAccuracy(…, { collect: true })`. Three changes from §4.2's sketch,
each found by running it:

- **Temperature scaling first.** Normalising scores as score/sum left the
  leader at about 0.2 for most tracks on the simulated library, so every short
  list was too long to be a choice. A single temperature, fitted on held-out
  tracks, sharpens the scores without changing their order. With similar
  artists, average list length fell from about 2.5 to 1.5.
- **Isotonic regression for "confident"**, not "the lowest threshold that
  still averages 90%". The averaging version let easy tracks carry a band of
  coin-flips just over the line, which were then called confident at 50%.
  Probabilities are binned to 0.05 first, because without it noise in the
  third decimal split a coin-flip pile into a "right" tail that qualified.
- **Cross-fitted check.** Thresholds are fitted on half the tracks and checked
  on the other half, then the halves swap, and the two checks are pooled. The
  screen only shows a "confident" accuracy when the thresholds actually in use
  (fitted on everything) allow confident calls at all.

On the simulated library it earns **no "confident" calls**, which is correct
for an engine that is right about 60% of the time. It gives a short list for
62% of tracks (about 1.5 playlists, holding the right one 87% of the time
with similar artists) and says "not sure" for the rest. The Engine screen's
comparison now shows "confident", "probably", "pick one" or "not sure" per
track once a score run has calibrated it. The calibration is kept per
library fingerprint and set of genre playlists. Phase 2's gate (±3 points)
needs confident calls to exist, so on the simulation it is honestly
undecided. The owner's run will say.

**Phase 3, first half, as built (2026-11-14).** This is
`core/recommend/gaps.mjs` on the existing **New playlists** screen, which had
only backlog clusters before. There's no separate Gaps screen.

- **Uncovered genres.** These are counted over tracks that are in none of the
  genre playlists, so a track that already has a home is never proposed twice.
  Genres are rolled up most specific first. They're ranked by what Spotify says
  you're playing, then genres nothing covers, then size.
- **One change from §5.** A genre that only sits *under* a broader playlist's
  genre (hard techno under a "Techno" playlist, donk under "House") is still
  proposed when there's enough of it, marked as such. The first version counted
  it as covered, which is exactly the lumping this work started from.
- **Splits** include the nested case: bassline out of UK garage gives
  "Bassline" and "the rest of UK Garage". A rule that only compared sibling
  genres could never see that one, and it's the owner's most likely case.
- **Creating copies.** Creating makes a private playlist with a copy of the
  tracks. A playlist being split is never edited.
- **Not built yet.** "Twins" still live on the Engine screen. Naming an
  untagged cluster from the engine's "not sure" pile is waiting on phase 1:
  until similar artists are in placement, that pile is mostly what tags already
  can't name.

**Dropped or downgraded by this plan:** shared filing across users (R2), any
runtime LLM over Spotify data (R1), Chrome's Prompt API (R1, and not
reliably available), and Spotify genres/audio features (still dead).

`docs/UPGRADE-PLAN.md`'s other items (Release Radar, PR #41, collaborative
playlists) are independent of this and keep their place.

---

## 8. What you need to do

| # | You | Why |
|---|---|---|
| 1 | Re-run **More → Engine → Learn my library → Score both engines → Copy results** and paste it to me (if you already ran it after #46, just paste that) | It's the baseline every phase above has to beat |
| 2 | Say whether you agree with §3's reading of Spotify's terms | It decides that shared filing is dropped and no chatbot reads your library |
| 3 | Decide on the shared tag table's keys: **re-key by MusicBrainz/Deezer id**, or leave it | It's the one existing piece §3 touches |
| 4 | Audio model: **EffNet** (18 MB, non-commercial licence, best on donk/bassline) or **CLAP** (78 MB, Apache-2.0, open vocabulary) | Only needed by phase 5 |
| 5 | ~~OK for the page to call **Deezer, ListenBrainz and Wikidata**~~ | **Answered yes** (2026-11-14). The switch is on the score card |

Phases 0–3 need only answers 1, 2 and 5. Everything else is mine.

---

## Appendix: how the numbers in §2 were measured

All on 2026-11-13, from this container, against `docs/tags.json` (4,866
Spotify artist ids with Last.fm tags). Not committed. They're one-off
probes, and phase 0 rebuilds them properly inside the harness.

- **Wikidata:** batched SPARQL over `wdt:P1902` (Spotify artist id) → `P434`
  (MBID) and `P136` (genre) labels, 300 ids per query.
- **ListenBrainz:** for each scene-genre artist with an MBID,
  `similar-artists/json` (`session_based_days_7500…limit_100…` algorithm).
  Neighbours were mapped back to library artists through the same Wikidata
  MBIDs. The vote was weighted by score. "Genre" means the first of an
  artist's top six Last.fm tags that `resolveConcept()` reads as a genre.
- **Deezer:** 70 scene-genre artists absent from Wikidata, named via
  Spotify's public oEmbed (test only; the page already has names). Matched
  on exact normalised name (test only; the page would use the ISRC route),
  then `/artist/{id}/related?limit=20`.
