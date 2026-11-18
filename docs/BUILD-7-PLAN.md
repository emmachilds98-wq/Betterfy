# Build 7 plan: keep improving after the audio upgrade (2026-11-17, after #157)

**Start here.** This replaces `docs/archive/NEXT-WORKPLAN.md` §4 to §6 for what to
build next. Every package in NEXT-WORKPLAN is built or measured and closed, and
the audio upgrade (`docs/AUDIO-BUILD-PLAN.md`) is complete. This plan covers
what is on `main`, the leftovers and what to do with each, and the next
packages, ranked, with goal, files, acceptance checks, dependencies and which
can run side by side.

It is written to be **run by a Claude project**: one coordinator in the
project chat, one thread per work package, several agents in parallel. §2 is
the coordinator's runbook. The paste-ready thread briefs are in
[`BUILD-7-BRIEFS.md`](BUILD-7-BRIEFS.md), one per package.

Contents:

0. Handoff, 2026-11-18 (read this first)
1. Standing rules (the owner's, unchanged)
2. How a Claude project runs this plan (coordinator runbook)
3. State of `main` after #157
4. Leftovers: open PRs, old PRs, hidden features, and a verdict for each
5. What waits on the owner (in-page clicks only)
6. The work packages, in waves
7. Not worth doing yet
8. File ownership map (who may touch what in a wave)
9. Progress table (the coordinator keeps this current)

---

## 0. Handoff, 2026-11-18 (read this first)

This project is being handed to a new Claude project. As of `main` after
#168 (`77d89e9`), there are **no open PRs**. What changed since this plan was
written (#158), what is still open, and where to start:

**Merged on 2026-11-17/18, #158 to #168:**

| PR | What a listener gets |
|---|---|
| #158 | This plan and `BUILD-7-BRIEFS.md` |
| #159 | Engine › Past runs: every Score, Listening and Deep listen report kept (`bf_run_history`), each with Copy |
| #160 | The Discover player follows the card after Next; duplicate phone titles and dead styles removed |
| #161 | Discover's File pick agrees with its fit line; the playlist menu lists every playlist you own |
| #162 | Docs: Every Noise at Once is rejected as a source |
| #163 | Tidy › Hard to find: songs Spotify's search shows as another version, found and swapped in place |
| #164, #165 | **Liked Songs is the inbox:** every liked song waits in File until filed there, even if a playlist already holds it |
| #166 | File: a liked song already in a playlist offers Keep it there or Remove from Liked, and links to suggested new playlists |
| #167 | Tags and genres (Wikidata, Last.fm, Discogs with a token) gathered by themselves at every start, with no buttons for them. Plus trims on Tidy, Engine, Shuffle and Library |
| #168 | **Release Radar starts by itself** (`radarAuto`, `bf_radar`). **Engine is back in the Settings sheet**, with one score line on Library. Tidy's table is fixed on desktop. Adds `docs/DESIGN-PLAN.md` |

**Owner decisions from tonight** (also in project memory):

- Every liked song needs filing.
- All data is gathered at startup, never behind a button.
- The radar runs by itself.
- The Engine lives in Settings.
- **No** "Fill this playlist" inside the automatic Score.
- **No** simpler Shuffle screen.
- Every Noise at Once is rejected.

**Where to start:**

1. `docs/DESIGN-PLAN.md` **L0**: the second ear looks stuck at "listening
   1/1". It is a bug emma hit, and the cause is traced in the brief.
2. `docs/DESIGN-PLAN.md` **L8**: full UI optimisation and a home page (emma's
   ask), starting with its inventory. L1 to L5 and L7 are its parts.
3. This plan's waves 1 to 4, as written below, with these changes:
   - **R1** is half done: the radar starts by itself (#168), and a failed
     first read shows the account check. Still open: keep the answer per
     account, the "isn't sharing new releases" line on a refused route, and
     the Settings row.
   - **U2** is replaced by DESIGN-PLAN L1.

Usage is low (emma, 2026-11-15): run few threads at once, and start no new
wave without asking her.

**Update, 2026-11-18 afternoon.** DESIGN-PLAN L0 to L8 and its §7.7 calls
are all merged (#170 to #184), and AUDIO-BUILD-PLAN is complete apart from the
owner's in-page Score run for the gates. M1 was mostly shipped by #159 (run
history, `scoreDiff`, Engine › Past runs); "Send to the team" stays copy-only
while D1 is unanswered. Wave 1 is now running:

- **R1 done** (#185): the account check runs by itself once per account
  per build (IndexedDB `radar:probe`), on the first Discover visit or just
  before the automatic start; a refused or reshaped artist-albums route holds
  the sync and shows one line with Check again; Settings' row is "New releases
  (Radar)" with the check's date and result. It also fixes a false refusal:
  an artist with no singles had no album to read, which counted as refused.
  Live confirmation still comes from the first real account that loads it:
  the owner glances at that Settings row once.
- **M1 done**: its last piece, the Settings row naming the last run's build
  and top-1, merged after R1 (#185).
- **Q1 and U1** touch disjoint files and can run as parallel threads.
- **Q1 merged #187, U1 merged #188, P1 merged #189** (first card 41 s → 16 s on `large`).
- **E1 done** (wave 2): a "not that playlist", a pick of the second choice,
  a move away and an undo change the next card at once
  (`space.mjs` `learnRejected`, `learnUndone`, `rejectPenalty`; page hooks in
  `soundfirst.js` and `feedback.js`). Score gets a "Learning from each tap"
  line (`core/validate/online.mjs`). Measured on synthetic libraries: online
  top-1 is never below static (shaped seeds 32.9→35.0, 36.1→36.4, 35.8→36.4;
  large 10.9→11.7). The teach gate still opens on 1 of 3 shaped seeds, so teach
  questions stay behind their per-account gate; favouring close calls cost
  tracks and ships off.
- **E2 measured, shipped display-only:** a weight per source in each situation
  (artist already filed / never filed) for the engine (`weights.mjs`
  `fitSituations`) and the tags blend (`blend.mjs` `bySituation`), nested
  like the one fit. Shaped seeds 52.7→51.1, 57.5→57.0, 58.2→58.6; large
  13.0→12.8, with never-filed lower on two. That misses the +2 bar, so the
  Score run reports it ("Weights per situation") and nothing applies it; her
  own run decides. Heard/unheard is not a third situation yet (part rows carry
  no sound). Next in lane E: E3, which uses the multiplicative fallback.
- **New package P1, from Q1:** see wave 1 below ("P1. First card fast on a
  large library").

## 1. Standing rules

These come from emma (the owner) in this project's threads and from
`CLAUDE.md`. Every package and every brief keeps to them. Copy this list into
any new brief.

- **Build for every account.** The hosted page is used by several Spotify
  accounts, each with only its own library, playlists, liked songs and
  listening history. A feature counts only if it works from that alone: no
  export, no desktop app, nothing to install. Per-account data only. Nothing
  pooled across accounts, and no Spotify content into AI/ML models
  (`docs/SMARTER-GENRES-PLAN.md` §3, rules R1 to R3).
- **On by default, and shown as on.** Anything that helps every account runs
  with no switch, no key to paste and no setup step. Settings ▸ "What's
  helping your picks" (`web/screens/helpers.mjs`) lists each source as on,
  with a live check. A new source or gate gets a row there.
- **Hosted only.** Every check runs in the page on GitHub Pages, on whichever
  account is signed in. Never ask the owner to run `node …`, export a file or
  open a terminal. A measurement that needs her library is a button or an
  automatic run in the page. Node scripts are fine for developers and for
  public test sets (Beatport, GiantSteps), never a step for her.
- **Filing stays tap-only.** Auto-file was rejected (2026-11-16). Nothing
  writes to Spotify without a tap. "Sure" changes how a card looks and what
  the sure batch offers, never what gets written without a tap.
- **No feature without a number.** Every engine change is one PR with its
  with/without numbers in the description, measured on the same tracks with a
  bar set before the run. A package that misses its bar ships switched off
  (display-only) and says so in the PR.
- **Merge when green.** Standing approval (2026-11-14): open each PR as a
  draft, mark it ready when `npm test` and `npm run e2e` pass on GitHub, then
  squash-merge to `main`. She checks `main` herself. No per-merge question.
- **Low usage.** Few threads at once (at most three, §2.2), no new wave
  without asking her, lower-priority work paused as a draft PR.
- **Secrets.** The built-in Last.fm key is the app's read-only API key,
  baked in by `node build-web.mjs --lastfm-key=…` (`DEFAULT_LFM_KEY`; rebuilds
  keep it). The Last.fm shared secret is never used, committed, logged or
  stored. `test/buildguard.test.mjs` is the last line of defence; never weaken
  it.
- **Spotify's audio features are dead.** `/audio-features` and
  `/recommendations` answer 403/404. Don't look for a Spotify tempo, energy or
  valence signal.
- **She barely uses Rekordbox.** No `rekordbox.json` or `collection.xml`
  exists on her computer. Ground truth for tempo and key comes from public
  sets (Beatport EDM Key, Zenodo 1101082; GiantSteps), never her files.

---

## 2. How a Claude project runs this plan

### 2.1 Roles

| Role | Who | Does | Never does |
| --- | --- | --- | --- |
| Owner | emma | Says go for a wave; does the in-page clicks in §5; picks options on decision cards | Runs scripts, reviews diffs (optional), merges |
| Coordinator | the project chat's Claude | Starts one thread per package with its brief from `BUILD-7-BRIEFS.md`; keeps §9 current; relays only results, blockers and decisions to the owner; starts the next wave when one finishes and she agrees | Writes package code; merges another thread's PR; starts a wave she hasn't approved |
| Package thread | one Claude per package | Builds its package on its own branch, opens a draft PR, waits for green CI, squash-merges, reports to the coordinator | Touches files another thread in the same wave owns (§8); runs a second package |

### 2.2 How many at once

Usage is low, so **at most three package threads run at the same time**, and
only packages listed as parallel in §6. Engine packages that edit
`core/intrinsic/*`, `core/validate/*` or the mirrored `classify()`/
`buildReports()` run **one at a time** (lane E in §8), because they move the
same Score golden and the same gates.

### 2.3 Starting a thread

1. Copy the package's brief from `BUILD-7-BRIEFS.md` verbatim. It already
   contains the standing rules, the files it owns, what it must not touch,
   the acceptance checks and how to report.
2. Attach the owner's approving message by id, so the thread has her go.
3. Add the current `main` SHA and anything learned since this plan (a Score
   paste, a Radar answer).

### 2.4 How every thread works

- **Branch** from the latest `main`, one PR per package, created as a draft.
  Title: `Build 7 <id>: <what changed for a listener>`. The PR description
  starts with the attribution lines the session gives, then: what changed,
  the numbers (with/without, same tracks, the bar), what is switched on or
  off, and what still waits on the owner.
- **Tests before and after.** `npm test` (~2.5 min) and `npm run e2e`. Run the
  whole suite once at the start and once before marking ready; while fixing,
  re-run only what failed.
- **Generated files.** `docs/index.html`, `docs/sw.js`, `docs/engine.js`,
  `docs/engine-worker.js` and the other built bundles conflict on every merge.
  Never hand-edit them. Rebuild them **last**, after merging the latest
  `main` into the branch: `node build-web.mjs --lastfm-key=<the app's API key>`
  (the key is already baked into the current `docs/index.html`; read
  `build-web.mjs` for where it comes from on rebuild). On a conflict in a
  generated file, take `main`'s and rebuild. `npm run shots` rebuilds them
  with `--allow-missing-id`: revert those before committing.
- **New localStorage or IndexedDB key?** Register it in `web/app/datakeys.js`
  or `test/datakeys.test.mjs` fails.
- **New page module in `core/`?** Add it to `FILE_MODULES` in `build-web.mjs`
  so its exports are page globals. New page script? Add it to
  `web/manifest.mjs` in the right order (`web/README.md`). CSS goes in a
  `web/styles/` partial, never in `docs/app.template.html`.
- **Merge.** When both CI steps are green: mark ready, squash-merge, delete the
  branch. If `main` moved and the generated files conflict, merge `main`,
  rebuild, push, wait for green again.
- **Report** to the coordinator in this shape (it is what the coordinator
  copies into §9 and the project chat):

  ```
  <id> merged as #NNN (sha). For a listener: <one sentence>.
  Numbers: <with/without on the same tracks, the bar, pass/fail>.
  Switched on: <what> / off until: <what and why>.
  Owner needed: <none | the exact in-page clicks>.
  ```

### 2.5 What the coordinator tracks and tells the owner

- Keep §9 of this file current through a **small docs-only PR at the end of
  each wave** (not per package, so parallel PRs don't conflict on it), and
  keep the project memory's state file in step.
- Tell the owner, per merge, one or two sentences: what changed for a
  listener and whether anything needs her. Nothing else between merges.
- Ask her only for: a wave's go, the clicks in §5, and the decisions marked
  **Owner decision** below. Each as a decision card with a recommendation.
- When a thread is blocked for more than one turn on something only she can
  give, the coordinator pauses it (draft PR, reminder) rather than letting it
  spin.

### 2.6 Merge order inside a wave

Packages in the same wave own disjoint files (§8), so they can merge in any
order. The only shared files are the generated bundles: **whoever merges
second merges `main`, rebuilds and re-runs CI.** Lane E packages merge in the
order listed, one at a time.

---

## 3. State of `main` after #157 (`febf0b8`)

### 3.1 What a listener gets today, with no setup

| Area | What happens | Built in |
| --- | --- | --- |
| First run | Connect Spotify, then the first analysis starts by itself: Wikidata genres, listening, Last.fm tags, the Engine's map. File opens on a progress strip | #155 |
| Listening | Deezer previews looked up by ISRC, EffNet on every device; MAEST and CLAP ("Deep listen") on laptops on Wi-Fi; a computer hears the whole library by default, phones hear what's played and unfiled | #109, #144, #153 |
| Tempo | DSP tempo with a gated octave fold, 84% within ±1 BPM on Beatport half B; Beat This settles flagged half/double readings under Deep listen | #136, #151 |
| Key | Key v4 (CNN + 0.5 × v3), shown and used for mixing only when sure: 62.5% exact / 71.3% MIREX on 85% of tracks | #157 |
| Knowledge | Last.fm artist tags (built-in key, every load), Wikidata genres, shared tag table with quorum; Deezer/ListenBrainz similar artists gathered in the background, unfiled first | #139, #144, #154 |
| Filing | One card at a time, tap-only, undo everywhere; family first ("Drum & bass: Rollers or Jungle?") at ≥ 85% family top-1; pair checks order the top two inside a family; green "Sure" only when sound or history backs it and sources agree | #144, #145, #152 |
| Learning | Each accepted filing joins the playlist's members at once (`learnFiled`); rejects teach the tag engine; the learner refits in the background | #110, #145 |
| Score + Tune | Runs by itself (first ~60 s after load with ≥ 60 filed, then after listening finishes, 200+ more heard, or weekly), applies Tune rows that pass on both halves | #153 |
| Weakest playlists | Measured as File places, each with its reason (`view`, `few`, `twin`, `unheard`, `partner`, `scattered`, `working`) and the fix; listening hears those playlists next | #156 |
| Mood | "Also fits" chips per mood playlist at ≥ 80% held-out precision with ≥ 12 heard members | #147 |
| Tidy, Library, Discover | Tidy health and sprint; Library rows with health and sound; merge/split wizard with one undo; Discover playable rows; Release Radar as Discover's first section with "Check it works on this account" | #138, #141, #146, #148 |
| Safety | Offline shell and decision queue; Your data (registry, wipe, playlist backup/restore); build guard against shipped secrets | #133, #137 |

### 3.2 The owner's numbers

The last pasted Score is build 2026-11-16-1633 (80 playlists, 1,311 liked):
today's engine 54% top-1 / 77% top-3; blended 67% / 88%; with sound 61% /
82%; Sure on 0%. **None of #151 to #157 has been scored on her library yet.**
Score now runs by itself, so the numbers exist on her device; they reach the
team only when she presses Copy results (§5, and package M1 makes that one
tap).

### 3.3 Gates and where each stands

Every gate below switches itself on per account when that account's own Score
run clears it. "Not yet known" means no Score paste since it was built.

| Gate | Code | Bar | Her state |
| --- | --- | --- | --- |
| Sound in the blend | `core/validate/gate.mjs` `audioGate` | +5 top-1 on never-filed artists, no overall loss | Not yet known |
| Deep ear choice | `gate.mjs` `earChoice` (`EAR_GATE`) | +2 over the first ear | Not yet known |
| Nearest members | `gate.mjs` `nearChoice` (`NEAR_GATE`) | +2 overall, no loss on never-filed | Not yet known |
| Family first | `core/intrinsic/family.mjs` | family top-1 ≥ 85% | Not yet known |
| Sure on agreement | `core/intrinsic/agree.mjs`, `calibrate.mjs` `AGREE_GATE` | ≥ 95% held out on ≥ 20 cards | Not yet known |
| Pair checks | `core/intrinsic/pairs.mjs` `PAIR_GATE` | 70% two-way on ≥ 20 heard, top-1 not lower | Not yet known |
| Similar artists in File | `bf_bridge_gate`, `bridgeVerdict` | never-filed +5, no overall loss | Passed before (11% → 49%) |
| Mood chips | `core/intrinsic/mood.mjs` | ≥ 80% precision per playlist | Not yet known |
| Teach questions | `core/validate/teach.mjs` `teachGate` | beats the no-teach baseline | Failed (23% → 23%) |
| Fill this playlist | recall@10 per account | as built in #132 | Not yet known |
| Key on a card | `KEY_MIN_CONF` 0.65 | ≥ 60% exact and ≥ 70% MIREX at that confidence | Passes on Beatport B (sure keys only) |
| Mood/voice/energy labels | label review on Sources | ≥ 70% over ≥ 20 reviewed tracks | Waiting on her review |

---

## 4. Leftovers, with a verdict for each

### 4.1 Pull requests

**No pull requests are open** (checked 2026-11-17 23:20 UTC). The ones the
last handoffs named are all settled:

| PR | What | State | Verdict |
| --- | --- | --- | --- |
| #77 | WP-D4 BPM, key, loudness per window, behind a flag | Merged 2026-11-14 | Done. BPM shown by default since #86; key since #151/#157 when sure |
| #83 | Mood, voice and energy shown once checked on real previews | Merged 2026-11-14 | Done, but its gate (owner's label review) has never been met. See 4.3 |
| #135 | Release Radar UI (old branch) | Closed 2026-11-16 | Superseded by #148, which merged the same UI with an in-page check. No action |
| #115 | Beat This WIP | Closed 2026-11-16 | Superseded by #151 (Beat This on under Deep listen, flagged tracks only). No action |
| #41 | MusicBrainz genres and iTunes as tag sources (September) | Closed 2026-11-16 | Song-level MusicBrainz measured at 11% genre coverage (NEXT-WORKPLAN package 3). Keep closed |
| #89, #90, #92–#96 | Paused or duplicate build 5 work | Closed | Folded into #97, #105 and later. No action |

**Stale branches.** Merged and closed PRs may have left branches on GitHub.
Package H3 lists them and deletes only branches whose PR is merged or closed
and that hold no commit missing from `main`; anything else goes to the owner
as a list.

### 4.2 Measured and stopped (don't repeat without a new signal)

| Item | Result | Where |
| --- | --- | --- |
| Song-level tags (Last.fm `track.getTopTags`, MusicBrainz by ISRC) | 14% coverage on 200 real tracks, 0% on scene genres, under the 40% bar | NEXT-WORKPLAN package 3 |
| Three windows per track | +0.3 points, under the +1 bar | `scripts/audio-near/README.md` |
| Key tuning (v3 refits, chroma variants, mode classifier, blend weights, S-KEY) | Saturated at 55–57% exact overall | BUILD-5-PROGRESS "Key v4"; memory `audio-key-v3` |
| Offering a weak playlist second on a pair check | Fired on 0–3 cards, never right | NEXT-WORKPLAN package 7 |
| Auto-file | Rejected by the owner | HANDOFF-2026-11-16 |

### 4.3 Built but hidden, and what unlocks each

| Hidden | Why | Unlock | Package |
| --- | --- | --- | --- |
| Teach questions | Single answers barely count; gate 23% → 23% | Online learning from every tap, then re-run the gate | E1 |
| Mood/voice/energy model labels | Owner's review never done | Her 20 reviews on Sources ▸ Check sound labels (§5), or make the review part of the File card so it happens in use | U3 |
| Key on every card | 57.3% / 66.5% overall, under 60/70 | A new signal (more audio per song), not tuning | E4 (research, optional) |
| CLAP "sounds like" search and new-genre naming | Inert until CLAP records exist | Already on under Deep listen; check it shows once records exist | U2 covers the check |

### 4.4 Release Radar

Built (#134, #148) for the API as it is since Spotify's February 2026 changes,
with "Check it works on this account" in Discover. **It has never been
confirmed against a live account.** That is package R1: make the check run by
itself once per account, record the answer, and show it in Settings, so no
one has to press anything.

---

## 5. What waits on the owner

Only in-page clicks. The coordinator asks for these once, together, at the
start of build 7, and never as a blocker for wave 1.

1. **Score results.** Library ▸ "How well it knows you" ▸ Copy results, then
   paste into the project chat. It has already run by itself; this only
   carries the numbers to the team. Package M1 turns it into one "Send to the
   team" tap.
2. **Release Radar check.** Discover ▸ Release Radar ▸ "Check it works on this
   account", paste what it says. Package R1 makes this automatic.
3. **Sound labels review** (optional). Library ▸ Sources ▸ Check sound labels,
   about 20 tracks, a tap each. Unlocks the mood/voice/energy labels if 70%
   are right. Package U3 moves this into normal use instead.

**Owner decisions in this plan** (each goes on a decision card with the
recommendation shown):

- **D1 (package M1):** whether "Send to the team" may open a pre-filled
  GitHub issue in her repo (she presses Submit on GitHub), or stays copy and
  paste. Recommended: the issue, because the numbers then live beside the code.
  The summary holds playlist names and percentages from her own library, no
  tracks, and only leaves the device when she taps.
- **D2 (package H2):** whether GitHub Pages builds `docs/` in Actions instead
  of committing generated files. Recommended: yes, because it ends the
  rebuild-on-every-merge conflicts that slow every parallel wave. Needs her to
  switch Pages' source to "GitHub Actions" (one setting) and add the app's
  Last.fm API key as a repository secret. Not started without her yes.
- **D3 (package E4):** whether a key research thread is worth its usage.
  Recommended: no for now; only if she says key matters for her DJ sets.

---

## 6. The work packages

Each package is one thread and one PR. Size: S ≈ a few hours of agent work,
M ≈ a day, L ≈ more. "Lane" refers to §8. Ids are stable; briefs use them.

### Wave 1: measure honestly, and prove it works for other accounts

All four can start together (cap of three running: start M1, Q1 and R1; then
U1 when the first finishes). They touch disjoint files.

#### M1. Score history and "Send to the team" (lane M, S–M)

**Goal.** Every automatic Score run is kept on the device with its build id,
the Engine screen shows the trend, and one tap hands the latest summary to
the team, so no package waits on the owner remembering to copy and paste.

**Why.** Every gate in §3.3 and every number in this plan depends on her
Score, and the last paste predates seven merges. Score already runs by
itself; the results just don't travel.

**What.**

- `core/review/autoscore.mjs`: add `scoreHistory(prev, run, { keep = 12 })`
  (pure) that appends `{ at, build, why, top1, top3, sure, neverFiled,
  gates: { audio, ear, near, family, agree, pairs, bridge, mood, teach } }`
  and drops the oldest; and `scoreDiff(a, b)` that returns the lines that
  changed between two runs ("Top-1 61% → 66% (+5)", "Family first: switched
  on").
- `web/app/autoscore.js`: after each run (automatic or by hand) store the
  history in localStorage `bf_score_history`; **register it in
  `web/app/datakeys.js`** (group "Engine").
- `web/screens/engine.mjs` and `web/app/screens.js`: under the Score card, a
  small list of the last runs (date, build, top-1, top-3, Sure share) and the
  diff from the previous run in words.
- "Send to the team": keeps **Copy results**, and (only if D1 is yes) adds a
  button that opens `https://github.com/emmachilds98-wq/Betterfy/issues/new`
  with the summary as the body (URL-encoded, trimmed under GitHub's URL
  limit, with a "too long, copied instead" fallback). It never sends anything
  by itself. If D1 is no or unanswered, ship copy only.
- Settings ▸ "What's helping your picks": the "Checks itself weekly" row shows
  the last run's build and top-1.

**Acceptance.**

- Unit tests (`test/autoscore.test.mjs`): history keeps 12, newest first,
  survives a corrupt entry; `scoreDiff` names a gate that switched on/off and
  any top-1 change of ≥ 1 point.
- e2e (`test/e2e/`): on the fake account, an automatic run adds a history
  row; the Engine screen shows it; Copy results still works.
- `test/datakeys.test.mjs` green with the new key.

**Depends on.** Nothing. **Parallel with.** Q1, R1, U1.

#### Q1. Second-account check: three shaped libraries end to end (lane Q, M)

**Goal.** Prove the app works and stays honest for accounts that are not the
owner's: a tiny library, a mood-only library, and a large mixed one. Fix any
dead end found.

**Why.** All tuning happened on one library. CLAUDE.md's first rule is that
the app is used by several accounts. Gates, empty states, the first analysis
and auto Score must behave on libraries with no genre playlists, very few
filed tracks, or 5,000+ liked songs.

**What.**

- Fixtures already exist: `test/fixtures/accounts.mjs` `makeAccount('empty' |
  'small' | 'typical' | 'large')` (BUILD-6 M5), and
  `test/e2e/accounts.test.mjs` covers only `empty` and `small` loading File.
  Add a `moodOnly` kind (600 liked, 12 playlists, none named after a genre,
  several named after moods) and keep the others byte-for-byte (other tests
  rely on them).
- Extend `test/e2e/accounts.test.mjs` so each of `small`, `moodOnly`,
  `typical` and `large`, against `test/fixtures/fake-spotify.mjs`: the first
  analysis reaches File without a button press (#155); auto Score either runs
  or says in words why it waits (fewer than 60 filed); no Settings row or gate
  claims "on" without its numbers; File, Tidy, Discover, Library, Settings
  and the Engine screen open with no console errors and a button in every
  empty state; mood chips appear only for mood playlists that pass their
  gate; nothing writes to Spotify without a tap (`app.fake.writes()` empty
  before a simulated tap).
- `large`: time to first card and main-thread long tasks during the first
  analysis (use `scripts/perf.mjs` as the model). Record the numbers in the
  PR; set a budget only if one is clearly bad.
- Fix what breaks, in the screen or module that owns it. If a fix would touch
  lane E files (`core/intrinsic/*`, `core/validate/*`), stop and report it to
  the coordinator as a finding for E1/E2 instead.

**Acceptance.** The new spec passes in CI for all three profiles; every fix
has a test; the PR lists what was wrong per profile.

**Depends on.** Nothing. **Parallel with.** M1, R1, U1 (U1 owns File's screen
files; if Q1 finds a File bug, it reports it to U1's thread or waits for U1
to merge).

#### R1. Release Radar confirms itself on every account (lane R, S–M)

**Goal.** Radar never needs someone to press "Check it works": the check runs
by itself once per account, its answer is kept and shown in Settings, and
Radar adapts when a route is refused.

**Why.** Radar was built against Spotify's February 2026 API from the
changelog and a fake; it has never been confirmed live, and the owner's rule
is that checks run in the page by themselves.

**What.**

- `web/app/radar.js`: on the first Discover visit (or 2 minutes after load if
  Discover is never opened), run the existing probe (`core/release/probe.mjs`
  via the "Check it works" code path) once per account per build, paced, only
  while the page is visible, skipped under Data Saver. Keep the answer in
  IndexedDB `radar:probe` (**register in `web/app/datakeys.js`**).
- When the probe says a route is refused or shaped differently (403/404 on
  `/artists/{id}/albums`, missing fields), Radar shows one plain line in its
  section ("Spotify isn't sharing new releases for this account right now")
  instead of an empty feed, and the sync does not start.
- Settings ▸ "What's helping your picks" (`web/screens/helpers.mjs`,
  `web/app/helpers.js`): a "New releases (Radar)" row: on, with the probe's
  date and result.
- `test/fixtures/fake-spotify.mjs`: add switches for a refused artist-albums
  route and a page with missing fields (additive; don't change defaults that
  other specs rely on).

**Acceptance.** Unit tests for the "once per account per build" rule; e2e:
probe runs by itself on the fake account, the Settings row shows it, a
refused route shows the plain line and starts no sync, quota stop still
resumes (existing spec). The PR says plainly that live confirmation still
comes from the first real account that loads it, and the coordinator asks
the owner to glance at the Settings row once.

**Depends on.** Nothing. **Parallel with.** M1, Q1, U1.

#### U1. File you can trust at a glance (lane U, M)

**Goal.** The File card says how sure it is in words, shows why, and shows the
honest scoreboard; after a correction the next card visibly changes.

**Why.** USER-REVIEW items 4 to 6 and its "always right" section 1, 2, 4:
three card states, an evidence line, and a 30-day kept-rate line. Family
first and pair checks (#145, #152) already decide *when* a card is two-way;
the card doesn't yet show the three states consistently.

**What.** Read `web/screens/inbox.mjs`, `web/screens/inbox-actions.js`,
`core/review/filequeue.mjs` and `web/ui/sound.mjs` first; some of this may
exist in part (the family "two-way" wording is in `inbox.mjs`).

- Three states, one place: `core/review/filequeue.mjs` gets
  `cardState(pick, { backed, agree, family, pair })` → `'sure' | 'twoWay' |
  'yourCall'` (pure). Sure: one filled button. Two-way: two equal buttons.
  Your call: top three as equals, nothing pre-highlighted. Uses the existing
  `pickBacked` and agreement output; changes no engine number.
- Evidence line under the top pick, from the parts the placement already
  carries: e.g. "3 of your Rollers tracks are by this artist · sounds like
  your Rollers · tags say liquid DnB". Use the badges in `web/ui/sound.mjs`;
  words, not percentages.
- Kept-rate line on File: "Last 30 days: 94% of the picks you filed stayed",
  from `core/measure/history.mjs` (it already counts kept filings), shown
  only at ≥ 20 filings in the window.
- "It learned": after a Skip, a pick of #2, or an undo, the next card by the
  same artist (if any) shows a one-line note ("Learned: you file X in
  Rollers"). Uses `learnFiled` (already called on accept in
  `web/app/soundfirst.js`); no new learning code here (that is E1).
- Styles in `web/styles/60-file.css` (don't add to `50-components.css` unless
  the component is shared).

**Acceptance.** Unit tests for `cardState` on every branch; e2e on the fake
account: a tags-only pick is never in the Sure state; a backed agreeing pick
is; the evidence line renders; the kept-rate line appears at 20 filings and
not before. `npm run shots` desktop and phone, dark and light, attached to the
PR (revert the generated files the shots run rebuilds).

**Depends on.** Nothing. **Parallel with.** M1, Q1, R1.

#### P1. First card fast on a large library (lane P, M; found by Q1)

**Goal.** On a large account the first File card shows within ~10 s of load,
not ~42 s.

**Why.** Q1 measured a `large` account (5,000 liked, 60 playlists): every
Spotify call is paced at 250 ms (`web/app/auth.js` `MIN_GAP`), and File waits
for the whole library read (~168 calls) with `#app` hidden.

**What.** Draw the first card from the first pages of liked songs while the
rest of the read carries on: `web/app/boot.js` shows the app once Liked Songs'
first pages and the playlist list are in, with File's status line saying the
read is still going; `syncLibrary` (`web/app/feedback.js`) reports a usable
partial `LIB`, and every screen that counts (Tidy, Library, the home header's
badges) treats it as partial and repaints when the read finishes. Don't lower
`MIN_GAP` (the quota rules hold). Nothing writes to Spotify from a partial
read without a tap, and Tidy's checks wait for the full read.

**Acceptance.** e2e on `makeAccount('large')`: time to first card under a
budget set from the measured before number, no console errors, counts correct
after the read ends; existing boot/resume specs pass.

**Owns.** `web/app/boot.js`, `web/app/feedback.js` (library read only),
`web/app/auth.js` (read only, unless pacing needs a hook). Must not touch
U1's File files (`inbox.mjs`, `inbox-actions.js`): a status-line word for
"still reading" goes through U1's thread or waits for U1 to merge. Disjoint
from R1 (`radar.js`, `helpers.*`, `radar.mjs`). Can run as its own thread now.

### Wave 2: decide better and learn live (lane E, one at a time)

Start only when the owner says go and, ideally, after one fresh Score paste
(M1 makes that easy). Each package re-runs the Score harness on the shaped
fixtures (`test/fixtures/shaped-library.mjs`, three seeds) and, when the
owner's numbers arrive, her paste is the deciding run. Order: E1, E2, E3.

#### E1. Learn from every tap, now (lane E, M)

**Goal.** A reject, a move-away, picking #2 over #1, and an undo change the
next card at once, not after a refit; then re-run the teach gate.

**Why.** ENGINE-REVIEW weakness 6 and layer 5. Accepts already update the
space at once (`core/intrinsic/space.mjs` `learnFiled`, #145). Rejects reach
the tag engine (#110) and the sound learner only at refit (`audio-learn.mjs`
`negWeight`). The teach queue failed because single answers barely count.

**What.**

- `core/intrinsic/space.mjs`: `learnRejected(space, track, playlistId)`
  marking the (artist, playlist) pair negative for this session and lowering
  that playlist's score for the artist's other tracks (bounded, decays as
  more evidence arrives); `learnUndone` reverses the last learn.
- `web/app/soundfirst.js`: call them where accepts already call
  `learnFiled`; rebuild only the affected rows.
- Teach queue (`core/review/teach.mjs`): pick tracks whose top two are close
  **and** whose artist has many unfiled tracks (ENGINE-REVIEW layer 5).
- Re-run `core/validate/teach.mjs teachGate` with the online updates in the
  loop. If it now passes on the shaped fixtures, the per-account gate decides
  for real accounts; teach stays hidden where it fails.
- Score arm in `core/validate/loo.mjs`: "with online learning" replaying the
  held-out fold's taps in order.

**Gate.** Teach gate passes on ≥ 2 of 3 shaped seeds; online arm top-1 not
lower overall; no change to Sure precision (≥ 95%). Otherwise ship the
online updates (they help in use) and keep teach hidden, and say so.

**Touches mirrored code?** No, unless the tag engine path is changed; if it
is, CLAUDE.md requires `npm test` and `npm run e2e` before and after.

#### E2. Weigh each source by what's been right for this account (lane E, M–L)

**Goal.** One weight per source (artist tags, filing history, similar
artists, sound, tempo) fitted per situation (artist already filed;
never-filed but heard; never-filed and unheard), replacing the single
tags-vs-native blend weight.

**Why.** ENGINE-REVIEW layer 4, first half (the agreement half shipped in
#152). Estimated +2 to +5 top-1.

**What.**

- `core/intrinsic/blend.mjs` / `fit.mjs`: fit a handful of weights per
  situation by the same nested, artist-held-out grid search `blend.mjs` uses
  (no trained model: a few numbers per account, rule R1). Keep the existing
  blend as the fallback when a situation has fewer than 30 rows.
- `core/validate/loo.mjs`: a `perSource` arm; Score card line "Weights per
  situation: top-1 X% (blend Y%)"; Tune applies it only when it clears its
  bar on both halves.
- Re-check `calibrate.mjs` agreement fitting on the new scores.

**Gate.** +2 top-1 overall on the shaped seeds with no loss on never-filed;
for her account, the per-account Tune row decides. Sure precision unchanged
or better.

**Depends on.** E1 merged (same files: `loo.mjs`, Score golden).

#### E3. Tempo range per playlist as evidence (lane E, S–M)

**Goal.** Each genre playlist learns its BPM range from its heard members, and
a track far outside it scores lower there (128 house, 140 garage, 174 DnB).

**Why.** ENGINE-REVIEW layer 1, last bullet. Tempo is now 84% within ±1 BPM
with octave folding; Library already shows each playlist's BPM range (#146).

**What.** `core/intrinsic/audio.mjs` (or a new `core/intrinsic/tempo.mjs`,
added to `FILE_MODULES`): a soft range per playlist from heard members'
`bpm` with `bpmConf ≥ 0.3`, octave-aware (87/174 count as the same), as one
more source part (`parts.tempo`) with its own weight in E2's fit, or a
multiplicative penalty if E2 hasn't merged. Only playlists with ≥ 12 heard
members and a tight range (IQR ≤ 10 BPM) use it.

**Gate.** +1 top-1 overall, or +3 on the weakest five playlists, no family
loss. Otherwise display-only ("most of this playlist is 170–176 BPM").

**Depends on.** E2 preferred (to fit its weight); can run after E1 if E2
stalls.

### Wave 3: polish and housekeeping (parallel with wave 2)

These don't touch lane E files, so one of them may run beside the current
lane E package (still within three threads).

#### U2. Desktop width and a calmer File (lane U, M)

**Goal.** USER-REVIEW design suggestions: on desktop, the card on the left
and a right rail with the evidence, Up next and "recently filed · Undo"; one
filled button per screen; mono for numbers only; one slim setup strip that
disappears when done; gestures shown once.

**Files.** `web/styles/80-responsive.css`, the File partial, `web/screens/
inbox.mjs`, `web/screens/home.mjs` (if Home still shows File's strip). Also
check CLAP "sounds like" search and new-genre naming show once CLAP records
exist (4.3).

**Acceptance.** `npm run shots` before/after in the PR; e2e green; no screen
loses its tabs with the model blocked (the old P0).

**Depends on.** U1 merged (same files).

#### U3. Sound labels reviewed in use, not on a separate screen (lane U, S)

**Goal.** Instead of asking the owner to review 20 tracks on Sources, the
File card occasionally asks one small question ("Does this sound
*energetic*? Yes / No") on a track that's playing or just filed, at most once
per session, and those answers feed the existing label gate (≥ 70% over
≥ 20).

**Files.** `web/audio/labels-view.mjs` and the review code in
`web/app/audio.js` (reuse them; this is where "Check sound labels" lives),
`web/screens/inbox.mjs` (one slot), `web/styles/92-labels.css`.

**Acceptance.** Unit test that answers from File and Sources count once each;
e2e that the question shows at most once per session and never on a Sure
card's main action.

**Depends on.** U1 merged (same File files). **Owner decision:** none; the
question is optional to answer.

#### H1. Docs: one front door (lane H, S)

**Goal.** A newcomer finds the current state in one file. Move superseded
plans to `docs/archive/` with a one-line header saying what replaced each,
and trim `README.md` to what's wired today plus "Design decisions" and "Data
sources" (keep those sections whole).

**Files.** `docs/*.md` (not this file or `BUILD-7-BRIEFS.md`),
`docs/review/*`, `README.md`, `CLAUDE.md` "Where the fuller context lives"
(update links), `V2-PLAN.md`. Superseded: `UPGRADE-PLAN.md`, `HANDOFF.md`,
`SOUND-EVERYWHERE-PLAN.md`, `UI-BUILD-PLAN.md`, `BUILD-5-PLAN.md`,
`BUILD-6-PLAN.md`, `NEXT-WORKPLAN.md`, `review/HANDOFF-2026-11-16.md`. Keep in
place (still referenced by code comments or still the reference):
`AUDIO-ANALYSIS-PLAN.md`, `AUDIO-BUILD-PLAN.md` (frozen contracts),
`BUILD-5-PROGRESS.md` (measurements), `SMARTER-GENRES-PLAN.md` (§3 rules),
`RELEASE-RADAR-PLAN.md`, `ENGINE-V3-ARCHITECTURE.md`, `TUNING.md`,
`review/ENGINE-REVIEW.md`, `review/USER-REVIEW.md`.

**Careful.** `docs/` is the GitHub Pages root: moving `.md` files is safe, but
never move or rename anything the page loads (`index.html`, `*.js`,
`models/`, `tags.json`, icons, `manifest.webmanifest`). Before moving a doc,
`grep -rn "<FILE>.md"` across the repo and update every reference (code
comments included), and keep `test/` green.

**Acceptance.** No broken relative links (a small link check over `*.md` in
the PR, run in CI if cheap); `npm test` green.

**Depends on.** Nothing; best run when no other docs PR is open.

#### H2. Generated files built by CI, not committed (lane H, M; Owner decision D2)

**Goal.** End the rebuild-and-conflict step on every merge. A GitHub Actions
workflow builds `docs/` from source on every push to `main` and deploys
Pages; the generated bundles leave git.

**What.** `.github/workflows/pages.yml` (`actions/upload-pages-artifact`,
`actions/deploy-pages`); the Last.fm API key from a repository secret passed
to `build-web.mjs --lastfm-key`; the build guard runs in that job before
upload; `.gitignore` the generated files; `README.md` and `web/README.md`
updated. The CI test job builds to a temp folder so the page-load test still
runs.

**Only with the owner's yes (D2)**, because she must switch Settings ▸ Pages ▸
Source to "GitHub Actions" and add the secret, and a mistake takes the page
down. The PR description lists those two clicks and a rollback (switch the
source back; the last committed `docs/` still works until the files are
removed in a follow-up PR).

**Acceptance.** A dry-run deploy on the branch (workflow_dispatch to a
preview environment, or the build step alone) produces a page that loads in
the page-load test; the guard fails the job when a fake secret is planted.

**Depends on.** D2. Run when no other PR is open (it touches every generated
file).

#### H3. Branch and dead-code sweep (lane H, S)

**Goal.** List branches whose PR is merged or closed and that hold no commit
missing from `main`; delete those. Mark `legacy/` and the Node CLIs as
developer-only in `README.md`; remove `legacy/` files that nothing imports or
tests (check `package.json` scripts and `test/` first; anything still
referenced stays).

**Acceptance.** The PR lists every branch deleted and every branch kept with
its reason; `npm test` and `npm run e2e` green. Branches with unmerged work
go to the owner as a list, not deleted.

### Wave 4: research (only on the owner's say)

#### E4. Key from more audio (lane E-research, M; Owner decision D3)

**Goal.** Get key over 60% exact / 70% MIREX on all tracks, not only sure ones.

**Why.** Every tuning route is exhausted (§4.2). The two 10 s windows are the
measured limit. The one untried input is the **whole 30 s preview** (three
contiguous windows, or the full clip into keynet with longer crops).

**What.** On Beatport half A only: retrain keynet with 30 s crops;
`scripts/audio-dsp/keynet-eval.mjs` on half B through the page's code. If it
clears the bar, ship by fetching the third window only for tracks whose key is
unsure (cost: one more window, ~0.1 s, on those tracks only).

**Gate.** ≥ 60% exact and ≥ 70% MIREX on all of half B; otherwise record the
numbers in BUILD-5-PROGRESS and stop. Don't touch DJ order unless it passes.

---

## 7. Not worth doing yet

| Idea | Why not | What would change it |
| --- | --- | --- |
| Song-level tags | 14% coverage, 0% on scene genres (§4.2) | Her library turning out mostly indie/rock |
| Discogs release styles | Needs a personal token per listener | Stays an optional bonus, never core |
| MusicBrainz release-group genres by ISRC | 11% genre coverage, two requests per song at 1/s | A source with scene-genre coverage |
| An LLM guessing genres from Spotify data | Rule R1 | Nothing |
| Pooling filing across accounts | Rule R2 | Nothing |
| Auto-file | Rejected | The owner changing her mind |
| Three windows for genre | +0.3, under +1 | E4's results, if it fetches a third window anyway |
| S-KEY in the page | Research/non-commercial weights; needs an nnAudio VQT port | Deezer clearing redistribution |
| Spotify audio features | Dead endpoints | — |

---

## 8. File ownership map

A thread may edit only its lane's files during a wave. Anything else it needs
goes to the coordinator as a finding.

| Lane | Packages | Owns |
| --- | --- | --- |
| M (measure) | M1 | `core/review/autoscore.mjs`, `web/app/autoscore.js`, `web/screens/engine.mjs`, the Engine bits of `web/app/screens.js`, `test/autoscore.test.mjs` |
| Q (accounts) | Q1 | `test/fixtures/accounts.mjs` (add a kind; existing kinds unchanged), `test/e2e/accounts.test.mjs`, and the module of any bug it fixes outside lanes E/U |
| R (radar) | R1 | `web/app/radar.js`, `web/screens/radar.mjs`, `web/styles/78-radar.css`, `core/release/*`, the Radar routes in `test/fixtures/fake-spotify.mjs` (additive) |
| U (File UI) | U1 → U2 → U3 | `web/screens/inbox.mjs`, `web/screens/inbox-actions.js`, `core/review/filequeue.mjs`, `web/ui/sound.mjs`, `web/styles/60-file.css`, `web/styles/80-responsive.css` (U2), `web/audio/labels-view.mjs` and `web/styles/92-labels.css` (U3) |
| E (engine) | E1 → E2 → E3 (→ E4) | `core/intrinsic/*`, `core/validate/*`, `core/review/teach.mjs`, `web/app/soundfirst.js`, `web/app/engine.js`, the Score golden; the mirrored `web/app/classify.js`/`reports.js` only with tests before and after |
| H (housekeeping) | H1, H2, H3 | Docs, `README.md`, `CLAUDE.md`, `.github/workflows/*` (H2), `legacy/` (H3) |

**Shared, with a rule:**

- `web/app/datakeys.js`: any lane may **add** a key; never reorder or remove.
- `web/screens/helpers.mjs`, `web/app/helpers.js` ("What's helping your
  picks"): any lane may **add** one row; M1 and R1 both do, so the second to
  merge rebases its row.
- `build-web.mjs` `FILE_MODULES` and `web/manifest.mjs`: add-only.
- `test/fixtures/fake-spotify.mjs`: add-only switches; defaults unchanged.
- Generated `docs/` bundles: rebuilt last, by whoever merges (§2.4).

---

## 9. Progress table

The coordinator updates this at the end of each wave (one docs-only PR) and
keeps project memory in step.

| Id | Package | Wave | Lane | State | PR | Numbers / notes |
| --- | --- | --- | --- | --- | --- | --- |
| M1 | Score history, Send to the team | 1 | M | Done | #159, M1 row PR | D1 pending: copy only |
| Q1 | Second-account check | 1 | Q | Done | #187 | found P1 |
| R1 | Radar confirms itself | 1 | R | Done | #168, R1 PR | check once per account per build, refused route holds the sync, Settings row; live check on the first real account |
| U1 | File you can trust at a glance | 1 | U | Done | #188 | |
| P1 | First card fast on a large library | 1 | P | Done | #189 | 41 s → 16 s on `large` |
| E1 | Learn from every tap | 2 | E | Done | E1 PR | online ≥ static on all seeds; teach gate 1 of 3, stays per-account |
| E2 | Weights per source and situation | 2 | E | Display-only | E2 PR | −1.5 to +0.4 on the seeds; bar +2 missed; reported in Score |
| E3 | Tempo range per playlist | 2 | E | Not started | | after E2 |
| U2 | Desktop width, calmer File | 3 | U | Replaced | | by DESIGN-PLAN L1 |
| U3 | Sound labels in use | 3 | U | Not started | | after U1 |
| H1 | Docs front door | 3 | H | Not started | | |
| H2 | CI-built Pages | 3 | H | Not started | | D2 pending |
| H3 | Branch and dead-code sweep | 3 | H | Not started | | |
| E4 | Key from more audio | 4 | E | Not started | | D3, optional |

| L0 | Second ear stuck at 1/1 (DESIGN-PLAN) | first | audio | Done | #171 | owner to watch one real Deep listen run |
| L8 | Full UI optimisation + home page (DESIGN-PLAN) | after L0 | U | Done | #170, #172 to #184 | every §7.7 call merged |

**Suggested calendar at low usage:** wave 1 in one sitting (three threads,
then U1); a Score paste; wave 2 one package at a time with H1/H3 beside it;
U2/U3 after U1; H2 and E4 only on her yes.
