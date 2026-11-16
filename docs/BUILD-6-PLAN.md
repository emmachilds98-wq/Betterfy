# Build 6 — where build 5 left things, and the plan for the next upgrade (2026-11-16)

**Start here for build 6.** It follows `docs/BUILD-5-PLAN.md` (whose waves 0–4
are done, see `docs/BUILD-5-PROGRESS.md`) and supersedes that file's §8 wave
table. `docs/HANDOFF.md` is still the file-by-file reference for the sound
features. It was written from `main` at `bbaacc2` (PRs #102–#126), the build 5
plan and progress log, CLAUDE.md, README "Design decisions worth knowing",
V2-PLAN §3, SMARTER-GENRES-PLAN (§3, §5, §7), AUDIO-ANALYSIS-PLAN §0,
RELEASE-RADAR-PLAN and THINKING-ENGINE-PLAN, and greps and small runs in the
code for every claim marked *verified*. Nothing in the app was changed to
write it.

The binding rules have not changed and every item below was tested against
them (CLAUDE.md; SMARTER-GENRES-PLAN §3 R1–R3):

- It works for **every account from its own Spotify library**: no export, no
  desktop app, no key anyone has to go and get. Anything that needs one is a
  bonus, silently absent otherwise.
- **R1** no Spotify content into an ML model (the page's learner is prototypes
  only; BUILD-5 §2.3 decided (b)). **R2** nothing pooled across accounts.
  **R3** counts and nearest-neighbour lookups over your own library, shown back
  to you, are the allowed use.
- Spotify's audio-feature and recommendation endpoints are dead. No tempo,
  energy or valence from Spotify, for anyone.
- Byte-identical when a feature has no data; `mel.mjs`/`record.mjs` frozen;
  generated `docs/*` rebuilt, never hand-merged.
- **No feature without a number that shows it works.** Every package below
  names its number and the bar. A feature that cannot show one ships behind a
  flag, off.

---

## 1. Where build 5 left things

### 1.1 What shipped (verified in `git log` and the tree)

| Area | State on `main` |
|---|---|
| Structure (A1–A8) | Template is markup only; script is `web/app/*.js` (40 files) and `web/screens/*.mjs` (every screen a module); store, keyed patcher, router, build conventions, shared classifier |
| UI (B / UI-A…G) | Four tabs (File, Tidy, Discover, Library) + Settings; motion tokens and View Transitions; optimistic filing with swipe velocity and shared-element art; Library tab with playlist detail sheet and health score; copy pass with ⓘ sheets; skeletons and FLIP |
| Smarter functions (§5.1–5.6) | Accepts/moves/keeps written to feedback; File queue by listening × uncertainty (`core/review/filequeue.mjs`); "File the N sure ones" as one History group; Tidy sound-wins and leave-one-out; Discover memory and "why"; calibrated words |
| Knowledge | Default Last.fm key path (`LASTFM_PUBLIC_KEY`, baked at build) with one-tap "Analyse my library"; keyless Discogs, ListenBrainz, Deezer, Wikidata bridges |
| Audio | EffNet, CLAP encoder, MAEST option; tempo 86% within ±1 BPM at confidence ≥ 0.3 on the Beatport set; key v2 at 47.2% exact (hidden) |
| Spotify fixes | B12 (`items` body, chunked, `actionlog.js:128`), B14 (`/me/library` for playlist removal, `actions.mjs:105`), B13 comments in place; B1, B2, B4–B11 are closed per the progress log and the merged PR list but were **not re-audited for this plan** (wave 0, package Q1, re-checks each with a test) |
| Measurement | `core/measure/history.mjs` computes queue, batch, Tidy-tier and Discover numbers from History and the Score summary prints them |

### 1.2 Dormant or unverified: only ever checked by tests or screenshots

Build 5's gate for every UI package was `npm run shots` plus string tests. No
real pointer, real browser or real Spotify account has exercised these:

| Thing | Why it is unverified |
|---|---|
| Swipe flick (velocity commit under the 76 px threshold, `web/app/gestures.js:53`), fly-out and promote animation | Tests check the markup and the log; nothing drives a touch in a browser |
| ⋯ menu, Library detail sheet, ⓘ sheets, Settings sheet | Screenshots only; focus order, Escape and back-button behaviour untested in a browser |
| View Transitions between tabs and the shared-element art | Feature-detected; the fallback path is the only one tests can see |
| Optimistic filing's failure path (card returns with a toast) | Fault injection exists for the sure batch's rollback only (`inbox.mjs`, the catch in `fileSureOnes`); the single-card path is not driven against a failing write |
| History-based measures (`core/measure/history.mjs`) | See D1, D2 below: two of the four measures cannot report what they say |
| `sureOnes`/"File the N sure ones" | Never run against a real library; its "sure" band is calibrated on held-out folds but its real-world reversal rate is unmeasured, and cannot be (D1) |
| Page load | `test/pageload.test.mjs` is the only thing that catches load-order crashes, and **CI never runs it** (D3) |

### 1.3 Owner-gated or in progress

| Item | State | Who |
|---|---|---|
| **Score run on the real library** (HANDOFF §2.1) | Still the highest-value ten minutes in the project. Everything in §3 below hangs off it | Owner |
| `LASTFM_PUBLIC_KEY` set in the repo secret/variable the build reads | Not set; until it is, "Analyse my library" runs the keyless path only | Owner |
| Key step 2 (S-KEY ONNX) and Beat This | **Done.** Key above 0.65 confidence is shown and joins `mixesWith` and DJ order (no S-KEY needed); Beat This is an opt-in under Deep listen; S-KEY itself is held back on a VQT port and a weights licence (BUILD-5-PROGRESS.md) | Shipped / owner decision |
| Mood/voice/energy labels | Hidden until the owner's label review passes 70% (BUILD-5 §1.1) | Owner |
| MAEST export (#90), Rekordbox tempo/key check | Machine-bound; unchanged since HANDOFF §2 | Owner |
| Shared tag table re-keying (SMARTER-GENRES §3, §8.3) | Unanswered. Touches multi-account hygiene (§4, H1) | Owner |
| Release Radar open questions (RELEASE-RADAR §10) | Unanswered; §4 below proposes defaults so the work can start | Owner |

### 1.4 Defects found by reading and running the current code

Each is *verified* by a grep, a read, or a run (stated).

| # | Defect | Where | Effect |
|---|---|---|---|
| D1 | **The sure-batch measure never counts batch filings.** `isFiling` requires `reason` to match `/^filed (from inbox\|with the rest of)/` **and** `!e.group`. `fileSureOnes` logs `reason:'filed the sure ones'` with a `group` (`web/screens/inbox.mjs:128-129`). *Run:* a log with one such entry gives `batch.n = 0`, `queue.n = 0`. So "Batch filing: N% of sure-band filings later moved or undone" only sees single-card filings the user made on a sure card, never the batch the feature is for | `core/measure/history.mjs:27,54`; `inbox.mjs:128` | The auto-file gate (§4, F1) and the batch threshold cannot be tuned until fixed |
| D2 | **The queue-order measure is near-tautological.** `queuePos` is the deck index at filing time (`inbox.mjs:310`, `at = inboxIndex(ctx)`), and the user files the card in front of them. "Share of filings from the first 20 cards" is ~100% by construction whatever the order is. It does not test whether the order put the right tracks first | `history.mjs:20,53`; `inbox.mjs:310` | The Score line cannot fail. Replace with a measure that can (§5, M2) |
| D3 | **CI does not run the page-load test.** `.github/workflows/ci.yml` is checkout, Node 22 and `node --test` only (no install step); `package.json` has no `playwright`; `test/pageload.test.mjs:10-12` skips when it is missing. Build 5's own notes say that test is what catches load-order crashes | `ci.yml`, `package.json`, `pageload.test.mjs` | A load-order crash can reach `main` green. Everything in §1.2 is untestable in CI for the same reason |
| D4 | **`buildReports` runs on the main thread** (`web/app/boot.js:106`) while the engine, audio and misfit jobs run in workers (`engine.js:44`, `screenjobs.js:57`). The 5k-library budget in BUILD-5 §7 (no long task > 50 ms) was never measured | `boot.js:106` | Probable long task at every sync and every reject; unmeasured, so a number comes first (§4, P1) |
| D5 | **No service worker.** `docs/` has a `manifest.webmanifest` (linked at `app.template.html:27`) and icons, but no `sw.js`; nothing in `web/app` registers one. So the page installs to a home screen but does nothing offline, and a refresh offline is a blank browser error | `docs/` listing; `grep serviceWorker web` empty | PWA and offline are green-field |
| D6 | **Liked songs have no incremental read.** Playlists skip unchanged ones by `snapshot_id` (`feedback.js:184-185`), but liked songs are paged fifty at a time from the start every non-resumed sync (`feedback.js:211-221`, its own comment says so). Liked is where most backlog lives | `feedback.js:208-221` | A sync on a 5k-liked account costs ~100 requests whether or not anything changed; request counts unmeasured (§4, P2) |
| D7 | **No keyboard path off the File screen.** File has 1/2/3, Enter, P, S, U and ←/→ for tabs (`web/screens/inbox-actions.js:15-30`). Tidy, Library and Discover have none, and the swipe has no non-pointer equivalent beyond those File keys | `inbox-actions.js`; grep of `keydown` | WCAG 2.1.1 gaps outside File; fails "full keyboard" for the Tidy rows that are decided one at a time |
| D8 | **The batch "sure" threshold is a stand-in.** `sureOnes` takes whatever the Engine's `decide()` calls `confident` (a calibrated "right ≥ 9 in 10"). It is not tied to the account's own measured reversal rate, so an account whose calibration is optimistic still gets a one-tap batch | `core/review/filequeue.mjs:74-85` | Needs the §3.2 threshold and D1's fix |
| D9 | **Release-radar and listening-weighted enrichment are still unbuilt.** `analysisPriority` (CLAUDE.md's own example) is referenced only under `core/personal/relevance.mjs`; nothing under `web/` uses it. `grep -i radar web` is empty | repo-wide grep | Two items CLAUDE.md or the plans call the cheapest next steps are not in the app |
| D10 | **Player endpoints other than `/me/player/play` are unused** (`player.js:33-107`: state, pause, seek, play on a device). No queue call exists, so any "send to my queue" feature is new, and it is Premium-only for every account that uses it | `player.js` | Shapes the Spotify Connect verdict in §4 |

Not defects, but facts the plan relies on: `core/audio/queue.mjs` already
orders what gets *heard* by listening (so "weight by listening" is shipped for
audio, for File and for Discover seeds); the `sp()` wrapper already retries a
429 quietly and surfaces a quota-exceeded reason (`auth.js:300-320`); the
Playlist health score and twins data already exist for the Library sheet
(`lists.mjs:48 twinsOf`).

---

## 2. Decisions for the owner

1. **Do the Score run** (§3.3, now about ten minutes and one copy-paste). Nothing
   in wave 5 can start without it.
2. **Auto-file** (§4, F1): approve the *principle* that an opt-in setting may
   write to Spotify without a tap, as long as every write is one grouped,
   undoable History entry plus a digest. This reverses the "nothing is written
   until you tap" line (BUILD-5 §4.1) for opted-in accounts only. Default stays
   off.
3. **Release Radar defaults** (RELEASE-RADAR §10): put Radar on the Discover tab
   as its first section, not a fifth tab; two years back by default, older on
   demand; explicit "Start" for the cold sync. No new OAuth scope: library
   artists only.
4. **Shared tag table**: re-key by MusicBrainz/Deezer id, or leave it and add
   the quorum rule in §4 H1 (the plan assumes *leave it + quorum* until told).
5. **Key/tempo verdict: in (2026-11-16, BUILD-5-PROGRESS.md).** Key is shown and
   used for mixing only at confidence >= 0.65 (held-out 62.4% exact / 72.0% MIREX
   on 53% of tracks). Beat This is an opt-in under Deep listen (flagged-only,
   82.7% vs 80.9%, inside the CI). S-KEY is not shipped: blended with the DSP it
   adds 1-2 points overall; where the two agree it is 66.8 / 74.6 on 63% of
   tracks, but it needs a VQT port and its weights are non-commercial. **Owner
   decision:** whether to clear S-KEY's weight licence with Deezer.
6. **Backup file** (§4, F8): confirm that a user-initiated download of their own
   playlist structure (names, track ids, ISRCs, from what the page already
   holds) is fine. It never leaves the device unless the user moves the file.
   Default: yes.

---

## 3. Wave 5 tuning, made concrete

Build 5 left five groups of constants as priors, waiting on real numbers. This
section says which number tunes which constant, the one-change-at-a-time
rule, and a flow that fits in ten minutes.

### 3.1 The constants and the measurement that moves each

| Constant | File | Tuned by (line in Score/Tidy) | Move it if | Bar to keep a change |
|---|---|---|---|---|
| `SOUND_FIRST_WEIGHTS` (`audio` 1.5, `learned` 2.0, `graph` 0.5, `bridge` 0.4, `bpm` 0.4, …) | `core/intrinsic/space.mjs:84` | `With sound (sound-first…): top-1/top-3` and `Never-filed artists with sound` | `With sound` top-1 is below `This engine` top-1, or never-filed top-1 gains < 5 points | Top-1 up ≥ 1 point on the same folds **and** never-filed not down |
| Identify: `SOURCES` (model 1.0, library 1.6, tags 0.5), `SPECIFIC` 0.5, `MIN_GENRE` 0.25 | `core/audio/identify.mjs:39-47` | `Naming genres by sound: genre X%, sub-genre Y%`; `model alone` is the baseline; `By genre:` lists the weak genres | Genre < 70% or sub-genre < 50%, or one genre's `right/n` is far below the rest | Genre +2 points without sub-genre down; each change re-run on the same `identifyAccuracy` sample |
| Tempo ranges per genre (`TEMPO`) and half-time set | `core/ontology/tempo.mjs` | `tempo fits P% of N` (judged) | Fit < 80%, or a genre in `By genre:` with many tempo misses | Fit up; no genre's range widened past its neighbours' (tests in `soundid.test.mjs` pin that) |
| Tidy-by-sound `MISFIT` (`k`12, `minHeard`5, `curMax`0.15, `likely`0.5, `sure`0.7) | `core/audio/misfit.mjs:37` | Tidy › By sound's caught/false-alarm line, **and** History's `Tidy sure/likely/unsure: N% of M moves kept` once there are ≥ 5 per tier | Sure-tier kept < 85%, or false-alarm > 10% of held-out; or caught < 50% | `sure` tier false-alarm ≤ 5% with caught not down > 5 points |
| Split constants (`SPLIT_MIN_PAIR` 0.7, `SPLIT_MIN_SEP` 0.04, `SPLIT_MIN_CLEAN` 0.75, `NEAR_GAP` 0.1) | `core/audio/plprofile.mjs:33-50` | Count of "two genres by sound" offers accepted vs dismissed in History (needs F4's logging) and the owner's eye on the first ten | More than 1 in 3 offers dismissed | Dismiss rate ≤ 25% over ≥ 10 offers |
| Batch "sure" threshold | `filequeue.mjs` + `decide()` calibration | `Batch filing: N% of M sure-band filings later moved or undone` (after D1 is fixed) | Reversal > 3% over ≥ 30 batch filings | Reversal ≤ 3% (this is also F1's opt-in gate) |
| Queue weights: windows `3/2/1.5`, recent track `0.6`, `UNCERTAINTY` (0.05/0.45/0.9/1.0) | `discover-engine.js:51,60`, `filequeue.mjs:34-38`, `relevance.mjs:31` | The new queue-order measure (M2): skip rate and time-to-file of top-listened artists' tracks in the first 20 cards vs the rest | Skip rate in the head not lower than the tail | Head skip rate ≥ 10 points below the tail, or leave the weights |
| Discover blend 60/40 sound/artist | `core/audio/discover.mjs` | `Discover: N% of M added tracks kept` and its held-out fit line | Keep rate < 60% | Keep rate up with the weights moved one step each way |
| Bridge/blend weight per account | already fitted per account in the Score run (`weightsLines`) | Nothing global to tune; verify the fitted weights are not at the sweep's edge | A fitted weight at the grid edge | Widen the grid once, re-run |

Rules for tuning: **one constant group per change**, each change is its own
commit with before/after numbers in the message, and the golden tests do not
move (tuning changes constants, never markup). A constant is never tuned on
the data it is scored on: use the folds the Score run already holds out. A
tune that helps only the owner's library is checked against the synthetic
non-owner fixtures (§5, M5) before it lands, so the owner's taste does not
become the default for everyone (CLAUDE.md).

### 3.2 What to change in the code first

1. **Fix D1 and D2** (`core/measure/history.mjs`, one small package, Q2): count
   batch filings through their `group` entry; log the queue head's listening
   weight and the engine's band with each filing; replace "share of filings
   from the first 20 cards" with "skip rate of the first 20 cards vs the rest".
   Existing `measure.test.mjs` pins the old shape and is updated in the same PR.
2. **A Tune sweep on the Engine screen** (package T1). The Score run today
   reports numbers but cannot say what moving a constant would do. Add
   **Engine › Tune** that, in the existing worker, re-scores the same held-out
   folds over a small grid for each row of §3.1 (3–5 values each, one group at
   a time) and prints one line per group: the current value, the best value,
   and the delta. It reuses `placementAccuracy` (`core/validate/loo.mjs`),
   `identifyAccuracy`, `misfitAccuracy` (`misfit.mjs:142`) and
   `plprofile`'s own split check; it adds no new learning (R1/R3: counts and
   lookups, the sweep is a per-device parameter sweep, never shared). It
   prints a recommended diff; it never changes a constant.
3. **A copy line per row**, so the owner pastes one block, not seven.

### 3.3 The ten-minute flow for the owner

| Min | Step | Result |
|---|---|---|
| 0–1 | Open the app, Settings › Listening: on. Wi-Fi. Leave the default scope | Listening runs in the background |
| 1–6 | Keep the tab open and use File normally (file 15–20 cards; try "File the N sure ones" once; Undo it once; open Tidy › By sound and keep or move five rows). This is what fills the History-based lines | History has ≥ 5 per Tidy tier, ≥ 10 queue filings |
| 6–7 | Settings › Engine › Learn my library › Score both engines | The Score card |
| 7–8 | Engine › Tune (T1) | One line per group in §3.1 |
| 8–9 | **Copy results** for both cards; paste into one issue titled "Score + Tune YYYY-MM-DD" | One paste |
| 9–10 | Optional: the five questions in §2.1–§2.2 answered in the same issue | |

An agent then applies §3.1 row by row: each row is one PR whose description
quotes the before/after lines from the paste. Lines that read "not enough data
yet" mean the row is skipped, not guessed.

Expected honest outcome: some rows will show *no* change worth making. That
is a result; leave the constant and record it in `TUNING.md`.

---

## 4. The next features

Ranked by **value for every account** per unit of effort. "Number" is the
thing that must be measured, and the bar, before the feature turns on by
default. Effort: S ≤ 1 agent-day, M ≈ 2–4, L ≈ a week. Value: how many
accounts feel it (High = every account, on first use; Med = most accounts with
a real library; Low = a subset).

### 4.1 Ranked list

| Rank | ID | Feature | Value | Effort | Number and bar |
|---|---|---|---|---|---|
| 1 | Q1 | **Browser tests in CI**: add `playwright` as a devDependency, install Chromium in `ci.yml`, run `pageload.test.mjs` for real; then a fake-Spotify fixture server and e2e specs for swipe, fly-out, ⋯ menu, sheets, back button, offline | High (guards every account) | M | Page-load test runs and **fails** CI on a deliberately broken load order (a canary test commits it once). ≥ 12 e2e specs; flake rate < 1% over 50 runs |
| 2 | A1 | **Accessibility to WCAG 2.2 AA**: keyboard paths for Tidy, Library and Discover and for swipe actions (D7); roles/labels for chips and bands; focus return from sheets; reduced-motion audit; contrast | High | M | axe-core: 0 critical/serious on every screen in `npm run shots`; every action reachable by keyboard (e2e spec per screen); contrast ≥ 4.5:1 text, 3:1 UI (BUILD-5's B11 chips re-checked) |
| 3 | O1 | **Onboarding for a new account**: connect → analyse → first five filings, with the empty-library, no-genre-playlists and huge-library (5k+) paths; cold-start playlists proposed by sound/graph | High | M | A scripted run on three fixtures (empty, 12 liked/0 genre playlists, 5k liked/40 playlists): time from first load to first filing and to five filings, and that each path ends in a usable File card. Bar: first filing < 90 s on the middle fixture with no key; zero dead ends |
| 4 | P1 | **Performance budgets on a 5k library**: `buildReports` to a worker (D4); long-task monitor; first render, screen change, background-job budgets from BUILD-5 §7 | High (big libraries are where it breaks) | M | Measured on the 5k fixture in Chromium with CPU 4× throttling: first render < 1 s, no long task > 50 ms from background jobs while File is open, screen change < 100 ms to first frame. Numbers printed by `npm run perf` and gated in CI |
| 5 | E1 | **Error resilience**: 429 backoff shown as a state, token expiry mid-batch resumes, partial-write reconciliation (re-read the playlist, compare with the log) | High | M | Fault-injection suite (fake server): 429 mid-sure-batch, 401 then refresh, a write that succeeds but whose response is lost. Bar: unreconciled writes = 0, duplicates = 0, History matches Spotify's playlist after each |
| 6 | M1 | **Fix D1/D2, then the measurement summary on one card** (§5) | High (it makes every smart feature honest) | S | `measure.test.mjs` cases for batch, group, undo; D1 case returns `batch.n = 1` |
| 7 | T1 | **Engine › Tune sweep and wave 5 tuning** (§3) | High (tunes everyone's defaults, checked on non-owner fixtures) | M | The §3.1 bars, per row |
| 8 | F2 | **Smart "fill this playlist"** (see 4.2) | High | M | Held-out recall@10 on the account's own playlists ≥ 40% |
| 9 | F5 | **Weekly digest on File** (see 4.2) | Med–High | S–M | Counts equal History's; no new data source |
| 10 | RR | **Release Radar** for artists in your library (see 4.2) | High for active listeners | L | §4.2 RR numbers |
| 11 | F1 | **Auto-file on open** (opt-in) | Med–High | M | Reversal ≤ 3% over ≥ 30 batch filings before the setting appears at all |
| 12 | P2 | **Incremental liked sync** (D6) | High on big libraries | M | Requests per no-change sync on a 5k-liked account < 5 (today ~100) and a weekly full reconcile catches unlikes |
| 13 | F6 | **PWA: install, cached shell, offline decision queue, replay on open** | Med | M | Airplane-mode e2e: 10 decisions offline, reload online, applied once each |
| 14 | F4 | **Merge/split playlist wizard** | Med | M | Dismiss rate ≤ 25% over ≥ 10 offers; one undo restores both playlists exactly (e2e) |
| 15 | F7 | **Privacy and data page** | Med | S | Wipe leaves zero IndexedDB keys; a test lists every key written and its reason |
| 16 | F8 | **Backup/export and restore of your own playlists** | Med | S | Round trip on the fixture server: exported then restored set equals the original, ISRC-matched |
| 17 | H1 | **Shared tag table hygiene** (quorum + per-account coverage card) | Med (matters with more accounts) | S–M | Injection test: a false tag from one writer is rejected 100%; non-owner fixtures' coverage reported per account |
| 18 | F3 | **DJ set builder** (energy curve, BPM/key transitions) | Low–Med (DJs) | M | Transition fit vs random order; key only if it clears its bar |
| 19 | F9 | **Library cleanup sprint** (batch Tidy, keyboard) | Med | S–M | Decisions per minute vs the same rows by pointer, on the fixture; kept rate stays ≥ today's |
| 20 | SG | **Remaining SMARTER-GENRES**: teach queue, twins/nameless clusters into Gaps, vocabulary pass (see 4.3) | Med | M | Score after 20 teach answers beats before |

Items 1–7 are the build-6 core: they make the build trustworthy and tuned.
Items 8–12 are the features that earn the most; 13–20 follow in build 6's
last wave or move to §5.

### 4.2 Every candidate the owner named: keep, reshape or reject

Each is tested against CLAUDE.md and SMARTER-GENRES §3. **Rule check** says
which rule matters.

| Candidate | Verdict | Rule check | Size | Value, every account | Number that proves it |
|---|---|---|---|---|---|
| **Auto-file on sync (opt-in)** (F1) | **Reshape.** "On sync" is not available (no server, no background execution: a static page cannot run while closed, and Background Sync is not on Safari/Firefox). So: **on open, after sync, while the page is open**, if the setting is on, file the tracks the engine calls sure, as **one History group per day** with a digest on File ("Filed 14 for you · Undo all"). Hidden until the account has ≥ 30 batch filings with reversal ≤ 3% (D1 fixed). Never files a track with a skip, a reject for that playlist or a "keep here". Off by default; opt-in text says plainly it writes without a tap | R3 fine (own library). Departs from "written only on a tap" by consent only | M | Med–High | Reversal rate of auto-filed groups ≤ 3% (same measure as the batch); if it rises above 6% over a week the setting turns itself off and says why |
| **Release radar for artists in your playlists** (RR) | **Keep, reshape.** Library artists only, no `user-follow-read`, no new scope (RELEASE-RADAR §1). Cold sync behind an explicit Start. New releases show with the engine's placement ("sounds like your Garage playlist") and a File/dismiss action. Lives in Discover. **Phase 0 re-verifies `GET /artists/{id}/albums` and `/albums?ids=` against a fresh Development Mode app, because the plan's checks date from September and the February–May 2026 changes moved other endpoints** | Library-derived requests per artist id: fine (R2: nothing sent but artist ids to Spotify itself). The pre-file suggestion is a count over the account's space (R3) | L | High for listeners who follow releases | (a) Phase 0: measured requests and minutes for the first sync of 1,000 artists, against RELEASE-RADAR §3's budget. (b) Fixture accuracy for the seven accuracy problems (§4.1–4.7 of that plan). (c) Real: share of radar rows the user files or likes within 14 days ≥ 15% |
| **DJ set builder** (F3) | **Reshape to what exists plus an honest cap.** `core/audio/order.mjs` already orders by tempo and sound with an optional energy arc. Build on that: choose start/end track, BPM ramp, harmonic neighbours **for tracks whose key is sure (confidence >= 0.65), already wired into DJ order**. Energy: Spotify's is dead; the sound model's energy head is hidden until the owner's label review passes 70%. So energy curve **waits on that review**; BPM and genre-continuity ramps do not | No Spotify audio features; sound from Deezer previews (R1 fine) | M | Low–Med | Share of adjacent pairs within ±4 BPM (or a half/double relation) vs the same tracks shuffled; owner rates 10 sets 1–5 |
| **Merge/split wizard** (F4) | **Keep.** Split offers exist (S2 `plprofile`, Gaps first half); "twins" data exists (`lists.mjs:48 twinsOf`); a wizard puts both behind one preview, creates new private playlists, never edits the original, one undo group | Fine; writes only on tap | M | Med | Dismiss rate ≤ 25% over ≥ 10 offers; undo restores byte-for-byte (e2e) |
| **Weekly digest on File** (F5) | **Keep, as "since you last opened".** Filed N, undone M; misfits found; new genres forming (`screenjobs.js` newGenre clusters); listening shift = overlap of `short_term` vs `long_term` top artists. Also folds in RELEASE-RADAR §9.5 "what changed" (snapshot diff). Dismissible, never a notification | Own history and Spotify's top windows only | S–M | Med–High | Every figure equals its source: tested to match History/log counts. User measure: digest dismissed vs expanded rate (local, not sent) |
| **Library-wide health report & cleanup sprint** (F9) | **Keep, small.** The health score already ships on Library rows (418a24f). Add a one-screen report (worst five playlists, why, one tap into Tidy at that playlist) and a keyboard "sprint" through Tidy (←/→ keep/move, U undo), which is also D7's fix | Own library | S–M | Med | Sprint: decisions per minute vs pointer; kept rate ≥ today's Tidy tier rates |
| **Smart "fill this playlist"** (F2) | **Keep, top feature.** For a playlist, rank unfiled liked tracks and Discover candidates by fit to its sound prototype, tags and graph; add in one undo group. Reuses `discover.mjs` fit and the File engine; no new data source | R3 | M | High | **Held out:** hide 20% of a playlist's tracks, mix them with decoys from the library; recall@10 ≥ 40% (random is ~2%). Report it on the Score card as a new line |
| **Playlist backup/export + restore** (F8) | **Keep, scoped.** Download a JSON/CSV of the user's own playlists (names, track ids, ISRCs, added dates) from what the page already holds; restore recreates private playlists and adds tracks by id, falling back to ISRC. Account-only: the file goes to the user's disk, not a server. CLAUDE.md's "no export" rule is about *inputs*; an output the user asks for is fine. Not offered as a way to share data between accounts (R2) | R2 (no upload), IV.3.1.1 (nothing stored beyond the device) | S | Med | Round-trip test; restored counts equal exported counts on a real 200-track playlist |
| **PWA install, offline queue, background sync** (F6) | **Reshape.** Keep install (manifest exists, D5) and a cached shell with a version-aware update check. Keep an **offline decision queue replayed when the page is next open and online** (the one thing that matters: do not lose decisions on a train). **Reject Background Sync**: not available on iOS Safari or Firefox, so it cannot be promised to every account (RELEASE-RADAR §8 reached the same conclusion for push). The service worker must not break `web/app/version.js`'s update check or the build-stamp match across page and workers | No data leaves the device | M | Med | Airplane-mode e2e; the build-stamp test still passes with the SW registered |
| **Spotify Connect: queue from DJ order / rediscover** (F10) | **Defer to build 7, bonus only.** `/me/player/queue` needs an active device and Premium, so it is not available to every account; and the app already writes a `🎧` DJ-order playlist, which every account can play (D10) | Fails "every account" as a core feature | S–M | Low–Med | Success rate on a Premium account; free accounts see a disabled button with the reason |
| **Accessibility** (A1) | **Keep, rank 2.** | | M | High | axe 0 critical/serious per screen; keyboard e2e per screen; reduced-motion test disables every transition |
| **Performance: worker for `buildReports`, incremental sync, first-render budget** (P1/P2) | **Keep.** Worker moves D4 off the main thread. Incremental: playlists already diff by `snapshot_id`; add a **liked "head sync"** that reads newest pages until it meets a known track (liked is newest-first), plus a weekly full read to catch unlikes. Do not claim `snapshot_id` diffing for liked (it has none) | | M | High | §4.1 rows 4 and 12 |
| **Onboarding** (O1) | **Keep, rank 3.** | | M | High | §4.1 row 3 |
| **Privacy/data page** (F7) | **Keep.** One page listing every IndexedDB/localStorage/Firestore key and what it is for, generated from a registry the code must write to (a test fails when a key is written that is not registered); one-tap wipe; the export from F8 | R2 stated plainly to users | S | Med | Registry test; wipe leaves zero keys but the theme |
| **Multi-account hygiene** (H1) | **Keep, S–M.** README says shared writes are shape-checked, not truth-checked. Add a **quorum rule** to `merge-tags.mjs`: a tag for an artist enters `docs/tags.json` only when ≥ 2 independent contributor ids agree; add the SMARTER-GENRES §6 per-account coverage card ("Deezer knows N%, Wikidata M%, shared table K% of your artists"). App Check rollout status is reported on Settings › About. The re-keying decision (§2.4) stays the owner's | R2 | S–M | Med | Injection test: one writer's false tag is rejected; coverage on three non-owner taste fixtures reported (so "table fits the owner's taste" is visible, THINKING-ENGINE §1) |
| **i18n readiness** | **Reject for now.** The copy is deliberately terse English with goldens pinning markup; moving strings now would conflict with every package. Revisit when a second language is asked for. Cheap hygiene instead: `lang` attribute and no concatenated sentences in new code | | S if ever | Low | None |
| **Error resilience** (E1) | **Keep, rank 5.** `sp()` already backs off on 429 (`auth.js:300-320`); what is missing is the UI state, mid-batch token recovery and reconciliation | | M | High | §4.1 row 5 |
| **Test infra: Playwright e2e + visual regression** (Q1) | **Keep, rank 1.** Visual regression on `npm run shots` with a pixel threshold, desktop and phone, both themes; failing diffs upload as CI artifacts | | M | High (indirect) | §4.1 row 1 |

### 4.3 Remaining planned work folded in from the older plans

| Source | What is still unbuilt | Verdict |
|---|---|---|
| SMARTER-GENRES phase 4 | **Teach queue** ("waits on phase 1", which is now built). BUILD-5 §5.2's queue-by-value covers ordering; what is left is showing the checked short list as one-tap choices where an answer teaches most | **Keep (SG)**, gate: Score after 20 teach answers beats before, as the plan says |
| SMARTER-GENRES phase 3 | Twins and nameless clusters on the Gaps screen ("Twins still live on the Engine screen") | Folded into F4 (twins) and F5 (new genres forming) |
| SMARTER-GENRES phase 6 | Vocabulary pass for unplaced tags (emo, industrial, EBM…), offline and human-reviewed | **Keep, S**, ontology tests; lowest priority |
| SMARTER-GENRES §6 | Per-account coverage card, request budget, one Settings switch for the bridges | Folded into H1 (coverage card); budgets in P2 |
| SMARTER-GENRES §3 R2 | Shared filing across users is dropped; the tag-table re-key decision is open | §2.4 |
| RELEASE-RADAR phases 0–6 | Entire feature unbuilt (`grep radar web` is empty) | RR above |
| RELEASE-RADAR §9 | (2) Radar × engine = RR's pre-file; (3) listening-weighted enrichment: `analysisPriority` is not read under `web/` (D9) → **small package, S**: order tag-gap and bridge fetches by it, number = share of the top-100 listened artists with tags after the first 5 minutes; (5) "what changed" → F5 | Keep each as stated |
| THINKING-ENGINE phase 6 (cutover and misfile, "not started") | The per-account blended-engine verdict on the Score card is the cutover gate in practice (SMARTER-GENRES "Phase 1 as built"). Misfile is shipped as Tidy tiers | **Close it.** After wave 5's numbers, set the status to `abandoned: superseded by blend + Tidy tiers` and link here, so the log stops saying "not started" |
| BUILD-5 §6.5 | Discogs keyless first-class: a live check from a browser (the repo still assumes a token) | **Keep, S**: one browser check, then flip `discogs.mjs` if it holds; number: tag coverage on never-tagged artists |
| BUILD-5 §6.3/6.4 | MAEST re-base (#90), WebGPU measure for MAEST/CLAP | Owner-gated; stays parked |

---

## 5. Measurement and guardrails

The rule from BUILD-5 §7 stands: a smart feature reports its own held-out or
History-based number on **this account**, and one with no number stays behind
a flag. Build 6 tightens it, because two of build 5's four measures turned out
unable to fail (D1, D2).

### 5.1 Measures, and what each must be able to catch

| ID | Measure | Fix or add | Can fail because |
|---|---|---|---|
| M1 | Batch precision | Count `group` entries; use the group's undo (D1) | A batch with later removals shows < 100% |
| M2 | Queue order | Skip rate and time-to-file of tracks in the first 20 cards vs the rest; log the card's listening weight (D2) | A bad order shows head skip rate ≥ tail |
| M3 | Auto-file reversal (F1) | Same as M1, per daily group | > 3% takes the setting away |
| M4 | Fill-this-playlist recall | Hide 20%, mix with decoys, recall@10 | Random-level recall means do not ship |
| M5 | **Non-owner fixtures** | Three committed synthetic libraries from different tastes (e.g. a pop/rock account, a classical/jazz account, a hip-hop account, built from `docs/tags.json` artists for coverage and labelled "synthetic") with held-out filing | A tuning that helps the owner and hurts these is rejected |
| M6 | Perf budget | `npm run perf`: first render, long tasks, screen change, on a 5k fixture, 4× CPU throttle | A regression above budget fails CI |
| M7 | Accessibility | axe on every shot + keyboard e2e | Any critical/serious fails CI |
| M8 | Request cost | Requests and minutes per sync, per radar cold sync, per no-change sync | A regression above the printed budget fails CI |

Scores print on one Settings › "How it's doing" card, with the "not enough
data yet (N of M)" wording build 5 introduced. The card is local only.

### 5.2 Guardrails (all in CI after Q1)

1. `npm test` (unit tests and the Chromium page-load check) and `npm run e2e`
   (the browser specs under `test/e2e`), as two CI steps; CI installs
   Chromium; a canary test proves the page-load test can fail.
2. `npm run build:web` then `git diff --exit-code docs/` so a stale generated
   page, engine, workers or build stamp fails the build (the stamp must match
   across page and workers; progress-log note).
3. Goldens unchanged unless the PR says why.
4. Perf and axe budgets (M6, M7).
5. A **no-network test**: with `fetch` stubbed to reject everything but
   Spotify, a fresh account still gets filing suggestions (CLAUDE.md's "no key,
   no export, nothing to install"), and no request goes to any host not on the
   Sources list.
6. An **R1/R2 grep test**: no code path posts Spotify-derived data to any host
   except Spotify and the user's own Firestore sync; no import of an ML
   training library in `web/`.

### 5.3 Rules every agent follows (baked into every brief)

- **Worktrees can start from a stale base.** First command in any task:
  `git fetch origin main && git checkout -B <your-branch> origin/main`, then
  `git log -1` must show the tip named in the brief. Do not start from the
  worktree's initial checkout.
- **Generated files are rebuilt after every merge**, never hand-merged:
  `npm run build:web`, commit `docs/index.html`, `docs/engine.js`,
  `docs/engine-worker.js`, `docs/audio.js` and the workers together. The build
  stamp must match across page and workers.
- **Run `test/pageload.test.mjs` after any change under `web/app`,
  `web/screens`, `web/manifest.mjs` or `build-web.mjs`**; it catches load-order
  crashes nothing else sees. After Q1, CI does it for you.
- Touch only your package's files. If you need a contract change, stop and say
  so. `mel.mjs` and `record.mjs` are frozen.
- Quote the number and the bar in the PR description. No number, no default-on.

---

## 6. Order of work, and how to split it across agents

Packages carry **file ownership**. Two agents in one wave never own the same
file. Shared files (`web/manifest.mjs`, `build-web.mjs`, `ci.yml`,
`package.json`, `docs/BUILD-6-PROGRESS.md`) are owned by one named package per
wave; others ask the owner package or add their line in their own PR's last
commit and let the merger rebase.

### 6.1 Waves

| Wave | Packages (parallel inside a wave) | Owner of shared files | Gate |
|---|---|---|---|
| **0** (owner, one day) | Score run (§3.3); set `LASTFM_PUBLIC_KEY`; answer §2.2–2.4, 2.6 | — | A pasted Score + a decision list |
| **1** (serial, short) | **Q1a**: add Playwright to devDependencies, install Chromium in `ci.yml`, make `pageload.test.mjs` run in CI and add a canary; **Q2**: fix D1/D2 in `core/measure/history.mjs` | Q1a owns `ci.yml`, `package.json` | CI fails when load order is broken (canary); `measure.test.mjs` covers batch and group |
| **2** | **Q1b** fake-Spotify fixture server + e2e specs (swipe, fly-out, ⋯, sheets, back, optimistic failure); **Q1c** visual-regression harness on `npm run shots`; **A1** accessibility (touches `web/screens/*.mjs`, `web/styles/*`); **E1** error resilience (`web/app/auth.js`, `actionlog.js`, `inbox.mjs`'s write path); **P1** perf (`buildReports` worker; `boot.js`, `reports.js`, `engine-worker` ops); **M5** non-owner fixtures (`test/fixtures/`) | Q1b owns `test/e2e/*`; Q1c owns `scripts/ui-shots/*` | e2e green; axe 0; budgets printed; fixtures committed |
| **3** | **T1** Engine › Tune sweep (`web/screens/engine.mjs`, `core/validate/*`, worker ops); apply §3.1 rows from the owner's paste, one PR per row; **O1** onboarding (`web/screens/home.mjs`, `inbox.mjs`'s empty/cold paths, `coldstart`); **P2** liked head-sync (`web/app/feedback.js`); **H1** hygiene (`merge-tags.mjs`, `tagshare.js`, Sources card); **F7** privacy page (`web/screens/sources.mjs`, new registry) | T1 owns `engine.mjs` | Each tuning row meets §3.1's bar on the owner's data **and** M5 |
| **4** | **F2** fill-this-playlist (`core/audio/discover.mjs` reuse, `web/screens/lists.mjs`); **F5** digest (`web/screens/inbox.mjs` header slot, `core/measure`); **RR** phases 0–3 (`core/release/*` new, `radar.mjs` CLI), then 4–5 (`web/screens/discover.mjs`); **F8** backup/restore (`web/screens/sources.mjs` settings, new `web/app/backup.js`); **Key/Beat This**: consume the other agent's verdict (`core/audio/dsp`, `order.mjs`) | RR owns `core/release/*`; F2 owns `lists.mjs` | Each package's §4.1 number |
| **5** | **F1** auto-file (only if M3's gate is reachable: ≥ 30 batch filings at ≤ 3% reversal exist); **F4** merge/split wizard; **F6** PWA offline queue (`docs/sw.js`, `web/app/offline.js`); **F9** sprint mode; **SG** teach queue and vocabulary pass | F6 owns the service worker | Numbers as §4.1; F1's setting is hidden until its gate |
| **6** | Re-tune from a second Score run with wave 4–5 features on; build 7 horizon (§7) | — | Score + Tune delta pasted |

Why this order: build 5 shipped a lot that a real browser has never seen, so
tests and measures come first (waves 1–2); then tuning, because everything
smart sits on those constants (wave 3); then the features whose number can
now be measured (wave 4); then the features that write on the user's behalf
(wave 5), which need the batch measure to be real before they are safe.

### 6.2 What each agent's brief contains

1. CLAUDE.md, HANDOFF §4, this file's top rules list and §5.3, and
   SMARTER-GENRES-PLAN §3 for anything that touches data, ML or sharing.
2. Its package row (files owned, number and bar).
3. The first command: `git fetch origin main && git checkout -B <branch>
   origin/main`, and the tip it must see.
4. "Rebuild and commit `docs/` after merging; run the page-load test."
5. "Touch only your files; stop and say so if you need a contract change."
6. The deliverable: the PR with the number from the bar quoted, `npm test`
   result, and `npm run shots` desktop and phone, both themes, for any UI
   package.

---

## 7. Further improvements: build 7 and after

Ideas that are real but depend on build 6's numbers, or fail "every account"
today. Each says what would promote it.

| Idea | Why not now | Promoted by |
|---|---|---|
| **Spotify Connect queue from DJ order / rediscover** | Needs Premium and an active device (D10); the DJ playlist covers every account | A measured request from Premium users, or Spotify opening the queue to free accounts |
| **Energy curve for DJ sets** | Energy head hidden until label review ≥ 70% | The owner's label review |
| **Key for the unsure 47% of tracks** | Only S-KEY agreement would add coverage; needs a VQT port and a weights licence. Key in `mixesWith` and DJ order is already live for sure keys | Owner clears S-KEY weights; ≥ 60% exact and ≥ 70% MIREX on the added tracks |
| **Beat-aware cuts/downbeats for set transitions** | Beat This ships opt-in (tempo only); downbeats unused | Its measured octave-error rate (31/203 today) |
| **Collaborative and followed playlists** (V2-PLAN §3 "Owned playlists only") | `snapshot.mjs:27` filters to owned; reading others needs `playlist-read-collaborative` (already requested) but writing needs owner consent | A design for non-owned playlists that never writes |
| **Followed artists you own nothing by** | Needs `user-follow-read`, a re-auth of every account (RELEASE-RADAR §1) | An explicit opt-in re-auth flow, never silent |
| **Radar × feed of label/series** | Discogs is a bonus source (CLAUDE.md) | Keyless Discogs confirmed |
| **MAEST second ear, WebGPU for MAEST/CLAP** | Machine-bound export; 92 MB | Owner's MAEST-vs-effnet Score bar |
| **Threads for the audio runtime** | GitHub Pages cannot send COOP/COEP (BUILD-5 §6.4) | Hosting that can, or an isolated listening page |
| **i18n** | See §4.2: churn without demand | A second language requested |
| **Chromebook/desktop keyboard-first mode** | Follows A1 and F9 | Sprint mode's decisions-per-minute |
| **Local, on-device "what should I make next" report** | Must not be an LLM over Spotify data (R1) | Stays a count report built from Gaps and digest, no model |
| **Share a playlist recipe (not tracks) between friends** | R2: derived data cannot pass to third parties | Not promotable under R2; listed so nobody re-proposes it |

---

## 8. The top ten, re-ranked

1. **Q1 Browser tests in CI** (page-load, e2e with a fake Spotify, visual regression). Nothing in build 5's UI has run in a real browser, and CI never ran the page-load test.
2. **A1 Accessibility to WCAG 2.2 AA**, with a keyboard path for every swipe and Tidy row.
3. **O1 Onboarding for a new account**, including empty, no-genre-playlist and 5k paths.
4. **P1 Performance budgets** with `buildReports` in a worker, measured on a 5k library.
5. **E1 Error resilience**: 429 states, token expiry mid-batch, write reconciliation.
6. **M1/M2 Honest measures** (D1/D2 fixed) and **T1 the Tune sweep**, then wave 5 tuning from the Score run.
7. **F2 Smart "fill this playlist"**, with held-out recall as the proof.
8. **RR Release Radar** for library artists, behind phase 0's request-cost measurement.
9. **P2 Incremental liked sync** and **F5 "since you last opened" digest**.
10. **F1 Auto-file on open (opt-in)**, last, because it is only safe once the batch measure is real.
