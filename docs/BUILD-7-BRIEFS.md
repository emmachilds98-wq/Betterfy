# Build 7 thread briefs (paste-ready)

For the coordinator of a Claude project running
[`BUILD-7-PLAN.md`](BUILD-7-PLAN.md). Each brief below starts one package
thread. Paste **the common header plus one package block**, verbatim, then
add: the owner's approving message (attached by id), the current `main` SHA,
and anything learned since (a Score paste, a Radar answer, an Owner decision).

**Handoff 2026-11-18:** start from BUILD-7-PLAN §0. The design and
layout packages (L0 bug, L1 to L5, L7, L8) use the common header below plus
`docs/DESIGN-PLAN.md` §6.

Start at most three threads at a time, only from the same wave, and only
packages the plan's §6 lists as parallel. Lane E packages run one at a time.

---

## Common header (paste first, every time)

```
You are building one package of Betterfy's build 7 plan, in the repo
emmachilds98-wq/Betterfy. Read first, in this order: CLAUDE.md,
docs/BUILD-7-PLAN.md §1 (standing rules), §2.4 (how every thread works),
§8 (file ownership) and your package in §6. The plan is the source of truth;
if code disagrees with it, trust the code and say so in your report.

Standing rules, in short:
- Works for every Spotify account from its own library alone. Nothing pooled
  across accounts; no Spotify content into AI/ML models (SMARTER-GENRES §3).
- Anything that helps is on by default and shown as on in Settings ▸
  "What's helping your picks".
- Every check runs in the hosted page. Never ask the owner (emma) to run a
  script, export a file or open a terminal.
- Filing stays tap-only. Nothing writes to Spotify without a tap.
- No engine change without with/without numbers on the same tracks and a bar
  set before the run. Missing the bar means it ships switched off and the PR
  says so.
- Never commit or log the Last.fm shared secret; don't weaken
  test/buildguard.test.mjs.

How to work:
- Branch from the latest main. One draft PR for this package. Title:
  "Build 7 <id>: <what changed for a listener>".
- npm test and npm run e2e at the start and before marking ready; while
  fixing, re-run only what failed.
- Edit only the files your package owns (plan §8). Add-only for the shared
  files listed there. If you need anything else, report it as a finding.
- New storage key: register it in web/app/datakeys.js. New core module the
  page uses: add it to FILE_MODULES in build-web.mjs. New page script: add it
  to web/manifest.mjs. CSS only in web/styles/ partials.
- Rebuild the generated docs/ bundles last, after merging the latest main:
  node build-web.mjs (it keeps the built-in Last.fm key already in
  docs/index.html). On a conflict in a generated file, take main's and
  rebuild. Revert generated files a `npm run shots` run changed.
- Standing approval: when both CI steps are green on GitHub, mark ready and
  squash-merge to main yourself, then delete the branch.

Report to the coordinator when merged (or blocked), in exactly this shape:
  <id> merged as #NNN (sha). For a listener: <one sentence>.
  Numbers: <with/without on the same tracks, the bar, pass/fail>.
  Switched on: <what> / off until: <what and why>.
  Owner needed: <none | the exact in-page clicks>.
Save anything a later thread would otherwise have to rediscover to project
memory, one file per subject.
```

---

## Wave 1 (start M1, Q1 and R1 together; U1 when one finishes)

### M1: Score history and "Send to the team"

```
Package M1 (lane M), docs/BUILD-7-PLAN.md §6 "M1".
Goal: keep every Score run on the device with its build id, show the trend
and the change from the last run on the Engine screen, and make handing the
summary to the team one tap.
Owns: core/review/autoscore.mjs, web/app/autoscore.js,
web/screens/engine.mjs, the Engine parts of web/app/screens.js,
test/autoscore.test.mjs, test/e2e/autoscore.test.mjs. Add-only:
web/app/datakeys.js (bf_score_history), one row in web/screens/helpers.mjs.
Owner decision D1: <paste her answer, or "unanswered">. If unanswered or no,
ship Copy results only; if yes, add the pre-filled GitHub issue button
(she presses Submit on GitHub; nothing is ever sent by itself).
Done when: unit tests for scoreHistory/scoreDiff; e2e shows a history row
after an automatic run; Copy results still works; CI green; merged.
Parallel with Q1, R1, U1. Depends on nothing.
```

### Q1: second-account check

```
Package Q1 (lane Q), docs/BUILD-7-PLAN.md §6 "Q1".
Goal: prove the page works and stays honest for accounts that are not the
owner's, and fix any dead end found.
Start from test/fixtures/accounts.mjs (makeAccount: empty, small, typical,
large) and test/e2e/accounts.test.mjs (covers empty and small only). Add a
moodOnly kind without changing the existing kinds. Extend the spec over
small, moodOnly, typical and large: first analysis reaches File by itself;
auto Score runs or says why it waits; no gate or Settings row claims "on"
without numbers; every screen opens with no console errors and a button in
every empty state; nothing written to Spotify before a tap. On large, record
time to first card and long tasks during the first analysis in the PR.
Owns: those two test files plus the module of any bug you fix, except lane E
(core/intrinsic, core/validate) and lane U (web/screens/inbox*.mjs,
core/review/filequeue.mjs) files: report those as findings instead.
Done when: the spec passes in CI for every kind; each fix has a test; the PR
lists what was wrong per kind; merged.
Parallel with M1, R1, U1. Depends on nothing.
```

### R1: Release Radar confirms itself

```
Package R1 (lane R), docs/BUILD-7-PLAN.md §6 "R1".
Goal: Radar's "Check it works on this account" runs by itself once per
account per build, its answer is kept (IndexedDB radar:probe, registered in
web/app/datakeys.js) and shown as a Settings row, and a refused or reshaped
Spotify route gives one plain line instead of an empty feed, with no sync.
Read first: docs/RELEASE-RADAR-PLAN.md §0, core/release/probe.mjs,
web/app/radar.js, web/screens/radar.mjs.
Owns: web/app/radar.js, web/screens/radar.mjs, web/styles/78-radar.css,
core/release/*, test/radar*.test.mjs, test/e2e/radar.test.mjs. Add-only:
Radar switches in test/fixtures/fake-spotify.mjs (defaults unchanged), one
row in web/screens/helpers.mjs and web/app/helpers.js.
Done when: unit test for once-per-account-per-build; e2e: the probe runs by
itself, the Settings row shows it, a refused route shows the plain line and
starts no sync, quota stop still resumes; CI green; merged. Say in the report
that live confirmation comes from the first real account that loads it.
Parallel with M1, Q1, U1. Depends on nothing.
```

### U1: File you can trust at a glance

```
Package U1 (lane U), docs/BUILD-7-PLAN.md §6 "U1".
Goal: every File card is in one of three states (Sure / two-way / your
call), shows an evidence line in words under the top pick, File shows a
30-day kept-rate line at 20+ filings, and after a correction the next card
by the same artist says what it learned.
Read first: docs/review/USER-REVIEW.md ("Making the engine feel always
right", items 4-6), web/screens/inbox.mjs, web/screens/inbox-actions.js,
core/review/filequeue.mjs (pickBacked), web/ui/sound.mjs (badges),
core/measure/history.mjs. Some of this exists in part: extend, don't
duplicate.
Owns: web/screens/inbox.mjs, web/screens/inbox-actions.js,
core/review/filequeue.mjs, web/ui/sound.mjs, web/styles/60-file.css, their
tests. No engine numbers change in this package.
Done when: unit tests for cardState on every branch; e2e: a tags-only pick
is never Sure, a backed agreeing pick is, the evidence line renders, the
kept-rate line appears at 20 filings and not before; npm run shots desktop
and phone, dark and light, attached to the PR; CI green; merged.
Parallel with M1, Q1, R1. Depends on nothing.
```

---

## Wave 2 (lane E, one at a time, in this order; only after the owner's go)

### E1: learn from every tap, now

```
Package E1 (lane E), docs/BUILD-7-PLAN.md §6 "E1".
Goal: a reject, move-away, pick of #2 over #1, or undo changes the next card
at once (accepts already do via core/intrinsic/space.mjs learnFiled); rework
the teach queue's choice of question; re-run the teach gate.
Read first: docs/review/ENGINE-REVIEW.md weakness 6 and layer 5,
core/intrinsic/space.mjs, web/app/soundfirst.js, core/review/teach.mjs,
core/validate/teach.mjs, core/validate/loo.mjs.
Owns: lane E (plan §8). Before and after: npm test and npm run e2e (CLAUDE.md
requires it if you touch profile.mjs, axes.mjs or the mirrored
classify()/buildReports()).
Bar (set before running): teach gate passes on >= 2 of 3 shaped seeds
(test/fixtures/shaped-library.mjs); online arm top-1 not lower overall; Sure
precision still >= 95%. Missing it: ship the online updates, keep teach
hidden, say so.
Latest owner Score paste: <paste, or "none since build 2026-11-16-1633">.
Depends on wave 1 merged (for M1's history). Next: E2.
```

### E2: weights per source and situation

```
Package E2 (lane E), docs/BUILD-7-PLAN.md §6 "E2".
Goal: one weight per source (artist tags, filing history, similar artists,
sound, tempo) per situation (artist filed; never-filed heard; never-filed
unheard), fitted by nested artist-held-out grid search like blend.mjs, with
the current blend as fallback under 30 rows. A perSource Score arm and a
Tune row that applies only when it clears its bar on both halves.
Read first: ENGINE-REVIEW layer 4, core/intrinsic/blend.mjs, fit.mjs,
calibrate.mjs, agree.mjs, core/validate/loo.mjs, tune.mjs.
Bar: +2 top-1 overall on the shaped seeds with no loss on never-filed; Sure
precision unchanged or better. Per account, its own Tune row decides.
Depends on E1 merged. Next: E3.
```

### E3: tempo range per playlist

```
Package E3 (lane E), docs/BUILD-7-PLAN.md §6 "E3".
Goal: playlists with >= 12 heard members and a tight BPM range (IQR <= 10,
octave-aware: 87 and 174 are the same) learn that range from heard members
with bpmConf >= 0.3; a track far outside scores lower there, as parts.tempo
weighted by E2's fit (or a bounded penalty if E2 isn't merged).
Bar: +1 top-1 overall or +3 on the weakest five playlists, no family loss;
otherwise display-only ("most of this playlist is 170-176 BPM").
Depends on E2 (preferred) or E1.
```

---

## Wave 3 (one may run beside the current lane E package)

### U2: desktop width and a calmer File

```
Package U2 (lane U), docs/BUILD-7-PLAN.md §6 "U2".
Goal: USER-REVIEW "Design suggestions": desktop card left with a right rail
(evidence, Up next, recently filed · Undo); one filled button per screen;
mono for numbers only; one slim setup strip that goes away when done;
gestures shown once. Check CLAP "sounds like" search and new-genre naming
appear once CLAP records exist.
Owns: web/screens/inbox.mjs, web/screens/home.mjs, web/styles/60-file.css,
web/styles/80-responsive.css.
Done when: npm run shots before/after in the PR; e2e green; no screen loses
its tabs with the model blocked; merged. Depends on U1 merged.
```

### U3: sound labels reviewed in use

```
Package U3 (lane U), docs/BUILD-7-PLAN.md §6 "U3".
Goal: at most once per session, File asks one small label question on a
playing or just-filed track ("Does this sound energetic? Yes / No"); answers
feed the existing label gate (>= 70% over >= 20) from #83, so mood/voice/
energy labels can unlock without a separate review screen.
Read first: web/audio/labels-view.mjs and the review code in
web/app/audio.js ("Check sound labels"), web/styles/92-labels.css.
Done when: unit test that answers from File and Sources each count once;
e2e that the question shows at most once per session and never replaces a
Sure card's main action; merged. Depends on U1 merged.
```

### H1: docs front door

```
Package H1 (lane H), docs/BUILD-7-PLAN.md §6 "H1".
Goal: move the superseded plans listed in the plan to docs/archive/ with a
one-line "superseded by" header, trim README.md to what's wired today (keep
"Design decisions worth knowing" and "Data sources, and what they're worth"
whole), update CLAUDE.md's links.
Careful: docs/ is the GitHub Pages root. Move only .md files; never move
anything the page loads. grep every moved filename across the repo and fix
references, code comments included.
Done when: no broken relative links in *.md (show the check in the PR); npm
test green; merged. Run when no other docs PR is open.
```

### H2: Pages built by CI (only with Owner decision D2 = yes)

```
Package H2 (lane H), docs/BUILD-7-PLAN.md §6 "H2". Owner decision D2: yes
(attached).
Goal: a pages.yml workflow builds docs/ from source on every push to main
(Last.fm API key from a repository secret into build-web.mjs --lastfm-key,
build guard before upload) and deploys Pages; generated bundles leave git in
a follow-up PR once the first Actions deploy is confirmed.
The PR description lists the owner's two clicks (Settings ▸ Pages ▸ Source:
GitHub Actions; add the secret) and the rollback.
Run when no other PR is open.
```

### H3: branch and dead-code sweep

```
Package H3 (lane H), docs/BUILD-7-PLAN.md §6 "H3".
Goal: delete remote branches whose PR is merged or closed and that hold no
commit missing from main; list every branch kept with its reason; mark
legacy/ and the Node CLIs developer-only in README.md; remove legacy/ files
nothing imports, runs (package.json) or tests.
Branches with unmerged work are listed for the owner, never deleted.
Done when: npm test and npm run e2e green; the lists are in the PR; merged.
```

---

## Wave 4 (only on the owner's say)

### E4: key from more audio (Owner decision D3 = yes)

```
Package E4 (lane E, research), docs/BUILD-7-PLAN.md §6 "E4".
Read first: docs/BUILD-5-PROGRESS.md "Key v4" and project memory
audio-key-v3. Don't re-tune what's listed there.
Goal: >= 60% exact and >= 70% MIREX on ALL of Beatport EDM Key half B, by
giving keynet the whole 30 s preview (three windows / longer crops), trained
on half A (+ GiantSteps) only. If it passes, fetch the third window only for
tracks whose key is unsure. If it fails, record the numbers in
BUILD-5-PROGRESS and stop. Don't touch DJ order unless it passes.
```
