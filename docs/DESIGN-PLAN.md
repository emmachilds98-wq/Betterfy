# Design and layout plan (2026-11-18, after review 2)

The owner (emma) asked how the app's design and layout could be improved, and
for a plan to build it. This document is that plan. It is written for a Claude
project in the same way as [`BUILD-7-PLAN.md`](BUILD-7-PLAN.md): one
coordinator and one thread per package. The paste-ready thread briefs are in
§6. The standing rules in BUILD-7-PLAN §1 and the thread workflow in §2.4 apply
unchanged. Nothing here changes the engine, and nothing writes to Spotify
without a tap.

Evidence: `npm run shots` on the synthetic library, at 1280 px desktop and
390 px phone, in light and dark. The before shots are in the project files
under `audio-upgrade/shots/review-2/before/`. Every package below re-shoots its
screens and compares them with those.

Contents:

1. What review 2 already shipped
2. Principles
3. What is wrong today, screen by screen
4. The packages
5. Waves, file ownership, gate
6. Thread briefs
7. UI inventory (L8 step 1) and the provisional merges and cuts

---

## 1. What review 2 already shipped

- **#167:** tags and genres are gathered at every start (Wikidata, then
  Last.fm, then Discogs with a token), and the Settings buttons for them are
  gone. Tidy › Repeats no longer shows an empty sub-list. The Engine's "would
  do differently" list is folded after 8 rows (the phone page was over
  10,000 px tall). Shuffle and Library copy is plainer.
- **#168:**
  - **Release Radar starts by itself.** It starts about 90 s after
    the page opens, after the tag lookups and the Engine's map. It doesn't run
    on Data Saver, or once Stop has been pressed on this device (`bf_radar`).
    The first read is the account check: "Check it works on this account" only
    appears after a read fails, with the table of what Spotify refused. The
    cold card has one button, "Start now".
  - **Engine is a section of the Settings sheet** again (as in UI-D).
    Library keeps one line with the score and an "Engine" button.
    `#/engine` and `go('engine')` open that section.
  - **Tidy's comparison table** is fixed on desktop. Its headings sat beside
    the values because `table.cmp` picked up the `.cmp` tiles' flex row.

## 2. Principles

These are the rules each package is measured against.

1. **One filled button per view.** The filled (`.b.p`) button is the thing
   to do next. Anything else on the view is outlined or small.
2. **Nothing to press for data.** Sources, listening, the radar and Score
   run by themselves. A button that gathers data is at most a small "Ask
   again now".
3. **Empty says one short thing.** An empty list gets a single compact line,
   never a dashed box the size of a card. A sub-list with nothing in it is
   left out.
4. **Phone first, desktop uses its width.** Phone layouts are already good.
   Desktop currently centres one ~880 px column and leaves half the screen
   empty. At 1100 px and above, use two columns where the content has two
   parts.
5. **Quiet when healthy.** A number that is fine everywhere (eight playlists
   all at "100 Healthy") is noise. Show it only where it asks for a look.
6. **Styles in partials.** No inline `style="…"` in screen modules. The
   Engine module has 61 of them and File's has 21. Tokens come from
   `00-tokens.css`.

## 3. What is wrong today, screen by screen

| Screen | Finding | Package |
|---|---|---|
| All, desktop | One narrow column, wide empty margins. Up next, Library rows, Discover picks and the radar feed all stack where they could sit side by side | L1 |
| Library | Every healthy row repeats "100 Healthy"; the footer has three loose lines (score, tag coverage, two buttons) | L2 |
| Library | "N to file" chips don't go anywhere; tapping one should open File on that playlist's suggestions | L2 |
| Discover | Radar sits first, so "Find new music" (the thing most people came for) is below the fold on a phone. Two primaries | L3 |
| Discover | The empty "Nothing found yet" is a large dashed card, and the phone tab bar covers part of it | L3 |
| Tidy, phone | The four-way switch wraps every label onto two lines ("Wrong / place", "Cross- / filed") | L4 |
| Tidy | Sections with 0 look the same as ones with work | L4 |
| Settings | "What's helping your picks" is 12 rows long before any section, so Sources, Engine and History are a long scroll away. The radar isn't listed | L5 |
| Settings › Engine | It was laid out for a full screen: the rung tag wraps ("a few / buckets"), and facts rows are tight at 390 px. 61 inline styles | L5 |
| New playlists | A large dashed empty box with three bold run-in paragraphs | L3 |
| Everywhere | Heading sizes and spacing set inline in places (`font-size:19px`), so the h2 scale differs between screens | L5 |

## 4. The packages

### L0: Fix the second ear looking stuck at "listening 1/1" (bug, do first)

- **What emma sees:** after a listening run, the pill and status say
  "Listening 1/1" (or "N/N") for a long time, and "Listen with the second
  ear now" seems to do nothing.
- **Cause, read from the code** (not yet reproduced live; reproduce it first):
  1. `web/audio/controller.mjs` `start()`. After the queue reaches done =
     total, the run stays `state: 'running'` while it does four top-ups with
     no progress of their own: `topUpDsp`, `topUpClap`, `topUpBeats` and
     `topUpKeyNet`.
     - Each one re-downloads previews.
     - CLAP (about 77 MB), Beat This and the key net can each load a model
       first.
     - Only "loading the … model" sets a `reason`. The work itself sets none.

     So the vm reads `done 1, total 1, running` for minutes. `listenPill()`
     and File's status line (`app/shell.js` `listenStatus()`) both print
     that as "listening 1/1".
  2. `web/app/audio-panel.js` `maestStart()` returns silently while
     `AUDIO.ctrl.running` ("one writer at a time"). The second-ear button
     calls it, so a tap during the top-ups does nothing visible. MAEST only
     starts when `audioStart()` reaches its trailing `maestStart`.
  3. None of the top-ups, model loads or `fillMaest` steps has a timeout. One
     preview fetch or model load that never settles would leave it truly
     stuck, not just slow.
- **Fix:**
  - The controller sets a reason and a count for each top-up ("tidying up:
    tempo 3 of 12", "describing 2 of 20", "keys 5 of 40"). The pill and
    status show that, not "1/1".
  - The second-ear button, while the first ear is busy, says "Waits for
    listening to finish" and queues the start, rather than returning silently.
  - Each per-track step and each model load gets a timeout (for example 60 s
    per track, 5 min per model). It is counted as a failed track, retried on a
    later run, and the run carries on.
  - The maest runner gets the same per-track timeout.
- **Files:** `web/audio/controller.mjs`, `web/audio/maest-run.mjs`,
  `web/app/audio-panel.js`, `web/app/listening.js` and `web/ui/sound.mjs`
  (the pill text only), and their tests (`test/audio*.test.mjs` and the
  controller tests).
- **Accept:**
  - A unit test: a controller with stub top-ups emits a reason with counts
    during each one, and ends `done`.
  - A stub fetch that never resolves times out, and the run still ends.
  - A second-ear start during a run is queued and then runs.
  - Then ask emma to watch one real run with Deep listen on, in the page
    only.

### L1: Desktop uses its width (≥1100 px)

- **Goal:** a desktop screen shows two things side by side wherever it has
  two.
  - **File:** card on the left, Up next as a right rail. Coordinate with
    whoever owns File: it changes `40-home.css` and `60-file.css` only.
  - **Library:** rows in two columns.
  - **Discover:** the current card with All picks beside it, and the radar
    feed in two columns of months.
  - **Tidy:** rows in two columns.
- **Files:** `web/styles/80-responsive.css` (a new `@media (min-width:1100px)`
  block), and the screen partials for each grid. Markup changes only where a
  wrapper is needed.
- **Accept:** shots at 1280 and 1440 show no column wider than 760 px of text
  and no empty half. Phone shots are pixel-identical to before. `npm run a11y`
  is unchanged.

### L2: Library rows and footer

- **Goal:** rows say only what asks for a look.
  - Hide the score when it is 90 or more; show it when it is lower.
  - Make "N to file" a button that opens File on the songs it suggests for
    that playlist. File has no playlist filter today, so this needs a small
    `S.inboxFor` filter, agreed with whoever owns File.
  - Turn the footer into one line: score sentence · tag coverage · Genre
    sources · Shuffle everything · Engine.
- **Files:** `web/screens/lists.mjs`, `web/styles/61-library.css`,
  `62-lists.css`, `test/weblists.test.mjs`.
- **Accept:** the synthetic library's Library screen loses eight "100 Healthy"
  labels. File opens on that playlist's songs (unit test on the action).

### L3: Discover order, and compact empty states everywhere

- **Goal:** Discover leads with what you came for.
  - Put a two-way switch at the top: **Find new music | New releases**.
    Remember the last choice in the existing remembered filters.
  - The radar keeps running in the background whichever way the switch is
    set. Show a count of new releases on the New releases side.
  - Keep one filled button per side.
  - Make `emptyState()`'s big variant compact on phone for Discover and New
    playlists.
  - Rewrite New playlists' empty text as one sentence.
- **Files:** `web/screens/discover.mjs`, `web/screens/radar.mjs` (layout
  only), `web/screens/new.mjs` (copy), `web/styles/71-discrows.css`,
  `78-radar.css`, `50-components.css` (the empty-state rule, add-only),
  `test/webdiscover.test.mjs`, `test/e2e/radar.test.mjs` (selector updates
  only).
- **Accept:** on a phone at 390 × 844 the Find button is above the fold. The
  radar e2e passes. No screen shows a dashed empty box taller than 160 px.

### L4: Tidy's switch on phone

- **Goal:** the four-way switch fits on one line at 390 px.
  - Use short labels on phone ("Misfiled", "Repeats", "In two", "Hidden").
    Keep the full labels on desktop and in the ⓘ text.
  - Dim sections whose count is 0. They stay tappable.
- **Files:** `web/screens/tidy.mjs`, `web/styles/64-tidy.css`,
  `test/webtidy*.test.mjs`.
- **Accept:** a phone shot with no wrapped label. Counts are unchanged.

### L5: The Settings sheet

- **Goal:** sections are reachable without a long scroll, and the Engine fits
  the sheet.
  - Fold "What's helping your picks" to its header ("12 of 12 on") plus any
    row that is not OK. The full list opens on tap.
  - Add a **Release radar** row (on; reading N of M; off since Stop), keeping
    the rule that every source is shown as on.
  - Move the Engine's 61 inline styles into `66-engine.css`.
  - Let the rung tag sit on its own line under the heading on narrow widths.
- **Files:** `web/screens/helpers.mjs`, `web/app/helpers.js` (the radar
  row's state), `web/screens/engine.mjs` (markup classes only),
  `web/styles/66-engine.css`, `70-overlays.css`, tests for helpers and the
  engine.
- **Accept:** in the phone Settings shot the first section heading is visible
  without scrolling. `grep -c 'style="' web/screens/engine.mjs` is 0. The
  engine tests are unchanged apart from class names.

### L7: Inline styles and type scale (housekeeping)

- **Goal:** move the remaining inline styles (File's 21, Discover's 9,
  Tidy's 8, Shuffle's 6) into partials, and use `--fs-*` tokens for every h2.
  No visual change is intended.
- **Files:** those modules (class names only) and their partials. File's
  part waits until the File thread is idle.
- **Accept:** the shots match the before shots to the eye. The unit tests
  pass, with only fixture updates.

### L8: Full UI optimisation and a home page (owner's ask, 2026-11-18)

emma: "full ui optimisation to make all new functions fit better, more usable
easily with no bloat and a nice homepage". This package is the umbrella that
L1 to L5 and L7 are parts of. It starts with an inventory and ends with a home
page.

1. **Inventory (a short doc, first PR).** List every function the app has
   today: each screen, sheet, section, button and automatic job. For each,
   record where it is reached from, how many taps it takes, and whether it is
   automatic now (tonight made tags, genres, Score, the radar and listening
   automatic). Mark each one:
   - **keep**;
   - **merge** (two ways to the same thing; for example "Genre sources" on
     Library and Settings › Sources, or Shuffle on Library and in the playlist
     sheet);
   - **automate** (a button that gathers data);
   - **cut** (no one needs to see it).

   Put the table in this file as §7 and agree the cuts with emma in the thread
   before building. Cuts are her call.
2. **Home page.** File stays the first tab, and the top of it becomes a calm
   "today" header:
   - One line of greeting and status, for example "72 songs to file · 3 new
     releases · 1 thing to tidy · listening 412/1,280".
   - Each part is a tap to where it lives.
   - Under it, the File card as today.
   - Setup strips (first five, analysis progress) fold into that one line and
     disappear when done.
   - No new data. Everything comes from what the page already holds (`R`,
     `RADAR`, `LISTEN`, the File queue).
   - Coordinate with whoever owns File, or own File for the length of this
     package.
3. **Fit the new functions.**
   - Remove-from-likes and Keep (#166), Hard to find (#163), Past runs
     (#159), the radar, the Engine section and Fill this playlist each get
     one obvious home and one way in.
   - Duplicate entry points go.
   - Labels use the listener's words (see BUILD-7-PLAN §1).
4. **Then L1 to L5 and L7** as already written, with the inventory deciding
   any detail that overlaps.

- **Files:** the inventory doc, then `web/screens/home.mjs`, the
  `40-home.css` partial, and whatever the agreed merges and cuts touch, one PR
  each.
- **Accept:**
  - The inventory is agreed with emma.
  - Home shots on phone and desktop, light and dark.
  - No feature is lost unless she agreed to cut it.
  - Tap counts to each function are equal or lower than in the inventory.
  - e2e passes.

## 5. Waves, file ownership, gate

- **First:** L0 (bug). It touches only the audio files, so it can run beside
  anything.
- **Then L8's inventory** (docs only). L8's home page and merges come next,
  using L1 to L5 and L7 as their parts, in this order:
  - **Wave A** (parallel, at most three): L2, L4, L5. They touch different
    partials and modules.
  - **Wave B:** L3, then L1. L1 goes last because it lays out what L2 and L3
    leave. L1 replaces BUILD-7's U2 (desktop width), so don't run both.
  - **Wave C:** L7, once File is quiet.

Not planned: a simpler Shuffle screen. It was described to the owner on
2026-11-18, and she decided not to build it.

Owned files per package are listed under each package above. Shared files
are add-only: `50-components.css`, `80-responsive.css` (L1 owns the
`min-width:1100px` block) and `web/app/datakeys.js`.

Gate for every package:

- `npm test` and `npm run e2e` pass.
- `npm run shots` before and after. Save the after shots in
  `/mnt/project-files/audio-upgrade/shots/<package id>/`.
- `npm run a11y` is not worse.
- Merge on green under the standing approval.

## 6. Thread briefs

Paste the **common header from `BUILD-7-BRIEFS.md`**, then this line, then one
package block from §4 verbatim:

```
Your package is in docs/DESIGN-PLAN.md §4. Read §2 (principles) and §5 (gate)
first. This is a layout and design package: no engine change, no new data
source, no write to Spotify. Title the PR "Design <id>: <what changed for a
listener>". Before and after screenshots go in
/mnt/project-files/audio-upgrade/shots/<id>/.
```

Report in the BUILD-7-BRIEFS shape, with "Numbers" replaced by
"Shots: <before/after paths>".

## 7. UI inventory (L8 step 1) and the provisional merges and cuts

Read from `main` at `a48e494` (2026-11-18), code only. Nothing was run, so
"rarely shown" means "the code only draws it when …", not a measured rate.

**Status: provisional.** emma asked (2026-11-18) for the work to keep running
while she is away, with temporary calls she can change later. Every
**merge**, **cut** and **automate** below is a provisional call. Each one ships
as its own small PR (§7.6), so any one can be reverted on its own. Nothing is
deleted from the code that she can't get back with a revert. Where a call is
close, the safer one was taken: "fold" or "move" rather than "cut".

How to read the tables:

- **Taps** count from opening the app, which lands on File (0 taps). A sheet
  opened from a screen adds 1. "⚙" is the Settings sheet; "⚙ › Sources" means
  the sheet's "Listening and genre sources" section (3 taps: ⚙, the section,
  then the control).
- **Auto** is *yes* (runs by itself), *button* (needs a press) or *–* (display).
- **Mark** is keep, **merge** (two ways to the same thing), **automate** (a
  button that gathers data), **cut** (no one needs to see it), or **words**
  (keep, but say it in the listener's words, BUILD-7-PLAN §1).

### 7.1 Shell and navigation

| Function | Where | Taps | Auto | Mark |
|---|---|---|---|---|
| Tabs: File, Tidy, Discover, Library, with badges | `app.template.html:166-170`, `render.js:44` | 1 | – | keep. Library's badge counts *suggested new playlists*, not playlists, and Tidy's badge (`within + misfiled`) disagrees with the Tidy switch's counts (`tidy.mjs:207`). **words**: one count rule for both (home page PR) |
| Swipe / arrow keys between tabs | `gestures.js:119`, `inbox-actions.js:12` | 1 | – | keep, but stop at Library: `VORDER` includes `new` and `shuffle`, so a swipe from Library lands on screens with no tab |
| Header title | `#mtitle`, `render.js:38` | 0 | yes | keep. The template's placeholder says "Overview" before the first paint |
| Listening pill | `listening.js:16-46` → ⚙ › Sources | 1 | yes | keep (the one way in to listening status) |
| Update banner | `app.template.html:190` | 1 | yes | keep |
| Undo toast, with History | `ui.js:58` | 1 | yes | keep |
| ⓘ "how this works" sheet | `ui.js` `infoBtn`, `sheet.js` | 1 | – | keep |
| Routes `#/inbox`, `#/tidy`, `#/discover`, `#/lists`, `#/new`, `#/shuffle`, `#/<v>/settings`, `#/<v>/pl:<id>` | `router.js` | – | – | keep. `#/home`, `#/engine`, `#/sources`, `#/history` stay as redirects (`LEGACY_VIEWS`) |

### 7.2 File (home)

| Function | Where | Taps | Auto | Mark |
|---|---|---|---|---|
| Status line: "N to file" | `home.mjs:16` | 0 | yes | **merge** into the home header (L8 step 2) |
| Status line: "N to tidy" | `home.mjs:20` | 1 | – | **merge** into the home header |
| Status line: "listening 37/412" | `home.mjs:23` → ⚙ › Sources | 1 | yes | **merge** into the home header (L0's new counts feed it) |
| Getting-started strip "Connected · Analyse · File your first five" | `analyse.js:185` | 0 | yes | **merge** into the home header; it already goes after five filings |
| Analysis progress strip | `analyse.js:155` | 0 | yes | **merge** into the home header while it runs |
| "Analyse my library" button | `analyse.js:159` | 1 | button | **cut** (provisional). Boot runs the first analysis by itself (`boot.js:294-311`) and sets `bf_analysed`, so the button only shows if that never ran. Keep the code path; drop the button |
| "Start these playlists" (no genre playlist yet) | `home.mjs:78` | 1 | button | keep here. **cut** the copy on Library (`lists.mjs:635`): File is where a new account lands |
| Liked line "N liked · N filed here · N to file" | `inbox.mjs:284` | 1 | – | **merge** its count into the home header; keep its link to New playlists only (see 7.4) |
| "Since you last opened" digest | `inbox.mjs:136` | 0 | yes | keep, under the header. **cut** its `bf_digest_measure` count from anything a listener sees |
| "N are sure. File the N sure ones" | `inbox.mjs:189` | 1 | button | keep. **words**: drop "The engine's checked answer…" |
| "Retry the rest" (after a failed batch) | `inbox.mjs:194`, toast `:264` | 1 | button | keep the toast, **cut** the card copy |
| Teach card | `teach.js:114` | 1-2 | button | keep, hidden as today (gated on a Score pass, BUILD-6 SG). **words**: "Help it learn" for "Teach the engine" |
| Roll-forward "N more by Artist… put them in X too?" | `inbox.mjs:45` | 2 | yes (offered) | keep |
| Counter "i of N · liked <date>" | `inbox.mjs:372` | 0 | yes | keep the date; **cut** "of N" (the header has it) |
| The File card: art, play, meta, sound chip and strip, "Sounds like…" | `inbox.mjs:386-395`, `soundslots.js:86` | 0-1 | yes | keep. **words**: "half/double time", "Two genres in one clip" |
| Picks 1-3, ✕ never suggest, "Also fits" chips | `inbox.mjs:396-412` | 1 | button | keep. **words**: "<axis> playlist" |
| File in X / Skip (tap, swipe, keys) | `inbox.mjs:419-420` | 1 | button | keep |
| "Already in X: Keep it there / Remove from Liked" (#166) | `inbox.mjs:298` | 1-2 | button | keep. This is the one home for removing a like |
| ⋯ › Unlike | `inbox.mjs:424` | 2 | button | **merge** into "Remove from Liked": same action (`inboxAct('unlike')`), but this one has no confirm. Keep the U key, with the same confirm |
| ⋯ › "Suggest a new playlist" | `inbox.mjs:425` | 2 | – | **cut** (provisional). It only opens New playlists, and its label reads as if it makes one. The liked line and Library already go there |
| ⋯ › "Add another playlist…" | `inbox.mjs:426` | 2 | button | keep |
| Sound nudge "Listen to my music / Not now" | `soundslots.js:114` | 1 | button | **automate** (provisional). Listening is on unless someone switched it off (`audio.js:45`); where it is off, the nudge becomes one line in the home header that opens ⚙ › Sources |
| "That's the lot" and "Where your library sits" | `inbox.mjs:325`, `home.mjs:28` | 0 | yes | keep. **words**: "Cross-filed" → "In two playlists" |
| Up next (8 covers) | `home.mjs:55` | 1 | – | keep (L1 makes it a right rail on desktop) |
| Background: sound space, file order, learn from each filing, first-run analysis | `soundfirst.js:30,128`, `inbox.mjs:360`, `boot.js:294` | – | yes | keep |

### 7.3 Tidy

| Function | Where | Taps | Auto | Mark |
|---|---|---|---|---|
| Section switch: Wrong place · Repeats · Cross-filed · [By sound] · [Health] · Hard to find | `tidy.mjs:203` | 1-2 | opens on the first with rows | keep. L4 shortens the labels on phone and dims zeros. Up to six parts, not four |
| Wrong place: Move / second choice / Keep here / Play, Sure·Likely·Unsure filter | `tidy.mjs:148-193` | 2 | button | keep |
| "Wrong tags? <artist>" tag editor | `tidy.mjs:191`, `tagfix.js:114` | 2 | button | keep. **words**: "Reset to shipped" → "Reset to the default tags" |
| Sprint (keyboard, one at a time) | `tidy.mjs:510` | 2 | button | keep, desktop only. **words**: drop decisions-per-minute |
| Repeats: Keep <length> | `tidy.mjs:22` | 2 | button | keep. **words**: "ISRC" → "the same recording" |
| Cross-filed: remove from one, Keep only in X | `tidy.mjs:52-65` | 2 | button | keep |
| Cross-filed 2+ … 6+ threshold row | `tidy.mjs:57` | 3 | – | **cut** (provisional): fix it at 2+. Five buttons, one filled, for a section whose own lede says "usually deliberate" |
| By sound: Move / Keep here / Play | `tidy.mjs:109` | 2 | yes (worker) | **merge** into Wrong place as a "by sound" badge on the row (provisional). The rows use the same buttons and the same Move/undo, and the page already drops the tag row when they disagree (`tidy.mjs:87`). Saves a switch part on phone |
| Health: worst playlists, "Tidy N" / "Open in Library" | `tidy.mjs:447` | 2 | – | **cut** from Tidy (provisional). Library's rows and sheet carry the same score (`lists.mjs:71`); L2 makes Library show it only where it is low. "Tidy N" goes on the Library row instead |
| "Only <playlist> · Show every playlist" chip | `tidy.mjs:467` | – | – | keep (Library's "Tidy N" sets it) |
| Hard to find: find box, "Compare with Spotify search" | `hidden.mjs:109,193` | 2+ | button | keep |
| Hard to find: "Check my oldest N / Check N more" | `hidden.mjs:40,162` | 3 | button | **automate**: check a batch in the background after the radar's first read, and keep "Check N more" as a small "Ask again now". The section reads 0 until it has run |
| Hard to find: Use this version → Swap / Cancel | `hidden.mjs:136,204` | 4 | button | keep (confirm-first stays) |

### 7.4 Library, the playlist sheet, Shuffle, New playlists

| Function | Where | Taps | Auto | Mark |
|---|---|---|---|---|
| Library rows: art, count, facts, sound strip, health | `lists.mjs:210` | 1 | – | keep. L2: hide the score at 90 and over |
| "N to file" chip | `lists.mjs:156` | 1 | – | keep; L2 makes it open File on that playlist |
| "These look like genre playlists" with ticks | `lists.mjs:625` | 1-2 | button | keep (first-run only); same job as the sheet's "It groups by" |
| "Start these playlists" | `lists.mjs:635` | 2 | button | **cut** here; File keeps it (7.2) |
| "Possible new genres" | `lists.mjs:643` | 2 | button | **merge** into New playlists › By sound "New genre?" (`new.mjs:102`) |
| "Playlists that sound the same: Merge… / Not now" | `lists.mjs:656` | 2 | button | keep here; **cut** the sheet's Twins copy (below) |
| Merge/split "Not now" rate line | `lists.mjs:664` | 1 | – | **cut**: an internal measure |
| "Playlists it gets wrong most" | `lists.mjs:308` | 1 | – | keep |
| "Suggested playlists" (3 rows + See all) | `lists.mjs:665` | 1-2 | – | keep as the one way in to New playlists (all four targets already go there). Becomes one row "N suggested playlists ›" |
| "How well it knows you" + "Engine" | `lists.mjs:674` | 1-2 | – | keep (#168 just put it here). **words**: "Engine" → "How it picks" |
| Tag coverage line | `lists.mjs:681` | 1 | – | **cut** here; it lives in ⚙ › Sources (`sources.mjs:80`) and in "What's helping your picks" |
| "Genre sources" button | `lists.mjs:682` | 2 | – | **cut** (provisional): ⚙ is one tap from everywhere |
| "Shuffle everything" button | `lists.mjs:683` | 2 | – | keep, and fix it: it reopens whatever playlist a sheet last picked (`S.shufPl` isn't reset) |
| Sheet: header, tag mix "64% genre · 19% mood" | `lists.mjs:224,248` | 2 | – | keep. **words**: drop the facet percentages |
| Sheet › Health | `lists.mjs:249` | 2 | – | keep (becomes the one home for health) |
| Sheet › "It groups by" | `lists.mjs:252` | 2 | button | keep. **words**: "an inbox to sort later" |
| Sheet › "Suggest new tracks for it" | `lists.mjs:256` | 2 | button | keep |
| Sheet › Sound profile | `lists.mjs:258` | 2 | – | keep |
| Sheet › "Two genres?" by sound and by tags | `lists.mjs:259-266` | 3 | button | **merge** into one "Two genres?" section with the better of the two (same title, same wizard) |
| Sheet › Twins "Merge into a new playlist…" | `lists.mjs:267` | 3 | button | **cut** (provisional): Library's "sound the same" and the weak-playlist hint already offer it |
| Sheet › "Help it learn this one" | `lists.mjs:296` | 2 | – | keep. **words**: "Score" |
| Sheet › Fill this playlist: ranked rows, Add, Add all | `lists.mjs:356-389` | 2-3 | yes (ranks on open) | keep |
| Sheet › Fill: "Check it on my library" | `lists.mjs:368` | 3 | button | **automate**: run the recall check in the background after the weekly Score (`autoscore.js`), not on a press |
| Sheet › Fill: "Off for your library: it found X%…" | `lists.mjs:370` | 2 | – | **cut** to one line, "Not enough to go on for this playlist yet" |
| Sheet › Shuffle / DJ order | `lists.mjs:273` | 3 | – | keep: it is the "shuffle this playlist" way in; "Shuffle everything" is the other |
| Merge/split wizard | `lists.mjs:522` | 3+ | button | keep |
| Shuffle screen: All Songs mirror, picker, order, options, preview | `shuffle.mjs` | 2-3 | button | keep (owner: no simpler Shuffle screen) |
| Shuffle "Rediscover…" | `shuffle.mjs:93` | 3 | button | keep (a choice about the order, not a data button) |
| New playlists: gaps job, "Genres with no playlist" | `new.mjs:29-47` | 2-3 | yes / button | keep |
| New: "Playlists that are two genres" — Split… and per-part "Make 'X'" | `new.mjs:48-53` | 3 | button | **cut** the per-part "Make 'X'" (provisional): it skips the wizard and its undo. Split… stays |
| New: untagged note | `new.mjs:54` | 2 | – | **cut**: diagnostic |
| New › By sound: hybrid, "New genre?", "A or B?" | `new.mjs:84-126` | 3 | button | keep (takes Library's "Possible new genres") |
| New: "Groups in your backlog" Create | `new.mjs:136,217` | 3 | button | keep, but route it through `gapsCreate` so it gets History and undo like the rest |

### 7.5 Discover

| Function | Where | Taps | Auto | Mark |
|---|---|---|---|---|
| Release radar: cold card "Start now" | `radar.mjs:201` | 1 | yes (`radarAuto`, 90 s) | keep. **words**: "(N requests)" |
| Radar status, Stop / Start again | `radar.mjs:216` | 1 | button | keep |
| Radar account check and its status table, Copy | `radar.mjs:176-186` | 1 | after a failed read | **fold** (provisional): one line "Spotify isn't sharing new releases with this account" plus a "Details" fold holding the table (finishes BUILD-7 R1) |
| Radar filter chips (7) | `radar.mjs:22,225` | 2 | – | keep, but **cut** the "Features and remixes" fold (`radar.mjs:256`): the Features chip shows the same |
| Radar: find an artist, Read older releases | `radar.mjs:231` | 2-3 | button | keep |
| Radar feed: open, File → playlist, dismiss ×, Show more | `radar.mjs:150-167` | 2 | – | keep |
| "Find new music" source menu and button | `discover.mjs:91-97` | 1 | button | **automate** (provisional): run once a day from top artists and recent plays after the radar's first read, so Discover opens on picks. The button stays as "Find more" |
| Empty state's second filled "Find new music from what I play" | `discover.mjs:104` | 1 | button | **cut**: one filled button per view |
| Keyless note and "Connect Last.fm" | `discover.mjs:85` | 1 | – | **cut** from Discover: the hosted build always has the built-in key (`storage.js:55`), so it never shows there. ⚙ › Sources keeps the key box |
| "Find tracks that sound like…" | `clap.js:81` | 1 | button | **move** (provisional) to Library: it searches your own library, not new music. Its "Search" stops being a filled button |
| Pick card: art, via, why, tags, fit line | `discover.mjs:109-139` | 1 | – | keep. **words**: "via deezer, listenbrainz", "<axis> playlist" |
| Card player, art play, row ▶ preview | `discover.mjs:34,109,127` | 1-2 | – | keep the card player and row ▶; **cut** play-on-art |
| Add: fit line, "Add to X", picks 2-3, row "+ X", "Add to another playlist…" | `discover.mjs:40,137-158` | 2 | button | **merge** the fit line and "Add to X" (same `data-dfile`) into one button |
| Next / Back, Not for me, Open in Spotify | `discover.mjs:192-207` | 2 | button | keep |
| Like on the card and on each row | `discover.mjs:39,156` | 2 | button | keep both (the row is a different pick) |
| "All N picks" rows | `discover.mjs:26` | 1 | – | keep (L1 puts them beside the card) |

### 7.6 Settings sheet (⚙)

| Function | Where | Taps | Auto | Mark |
|---|---|---|---|---|
| "What's helping your picks" (12 rows) | `helpers.mjs:24-72` | 1 | yes | keep; L5 folds it to "12 of 12 on" plus any row not OK, and adds the radar row |
| › Sources: "Your artists" coverage | `sources.mjs:52` | 2 | yes | keep. **words**: "shared table" |
| › Sources: Last.fm card, own key, "Ask again now" | `sources.mjs:86-90` | 3 | yes + button | keep (small "Ask again now" is allowed by §2.2) |
| › Sources: Wikidata card | `sources.mjs:92` | 2 | yes | keep |
| › Sources: Discogs token | `sources.mjs:95` | 3 | button | keep (optional bonus, CLAUDE.md) |
| › Sources: Listening panel: on/off, Wi-Fi only, scope, Listen now, Stop; Deep listen: second ear, CLAP, Beat This, memory | `audio-panel.js` | 2-3 | yes + button | keep. L0 owns its wording now |
| › Sources: label check | `sources.mjs:103` | 2 | – | keep |
| › Sources: Your data: back up, restore (preview, tick, undo), what is kept, who hears, wipe | `sources.mjs:133-165` | 3+ | button | keep. **words**: show plain names, not raw `bf_*` keys, in "What is kept" |
| › Engine: how much it has to go on, would do differently, Is it any better (Score, Score + Tune, Copy), can't tell apart, Forget and learn again, Tune (use / copy / reset), Past runs (Copy) | `engine.mjs` | 2-3 | yes (weekly, `autoscore.js`) + button | keep. Score and Score + Tune run by themselves now, so their buttons become one small "Run again now" (**automate**, provisional) |
| › History: log, Undo | `history.mjs` | 2-3 | – | keep |
| Appearance, accent colour (12 + custom), apply-to ticks | `app.template.html:215-245` | 2 | button | keep |
| App icon preview | `app.template.html:246` | 1 | – | **cut** (provisional): a picture of the icon, no control |
| Behaviour: compact rows, remember Tidy filters | `app.template.html:254` | 2 | button | keep |
| Your library: Re-sync from Spotify | `app.template.html:266` | 2 | button | keep (on purpose a manual, costly read) |
| Sync across devices | `app.template.html:277` | 2 | button | keep (hidden unless configured) |
| About: build, credits, licences, Check for updates, Disconnect | `app.template.html:293` | 2 | button | keep |
| Reset to defaults | `app.template.html:310` | 2 | button | keep; **words**: "Reset look to defaults" (it resets the theme only) |

Automatic jobs at start (`boot.js:290-345`), all kept and all to be named by
the home header while they run: library read, cross-device sync, Wikidata then
Last.fm tags, first-run analysis, the Engine's map (`engineAutoLearn`), the
radar (90 s), similar artists (`bridgeWarm`), listening (3 s, when on), Score +
Tune (a minute in, then weekly), update check.

### 7.7 The provisional calls, as one list

Each line is one PR unless it says which package carries it. **R** = can be
reverted on its own.

Merges:

- **M1** File's status line, getting-started strip, analysis strip, liked
  count and the sound nudge become the home header's one line (L8 step 2). R.
- **M2** ⋯ › Unlike goes; "Remove from Liked" (with its confirm) is the one
  way, and the U key gets the same confirm. R.
- **M3** Tidy › By sound joins Wrong place as a "by sound" badge on the row. R.
- **M4** Health lives in Library only (row and sheet); Tidy's Health part
  goes, and the Library row gets "Tidy N". With L2. R.
- **M5** Library's "Possible new genres" joins New › By sound. R.
- **M6** The sheet's two "Two genres?" sections become one. R.
- **M7** Discover's fit line and "Add to X" become one button. With L3. R.

Cuts:

- **C1** File: "Analyse my library" button, ⋯ › "Suggest a new playlist",
  the card's "Retry the rest" (the toast keeps it), the counter's "of N". R.
- **C2** Library: "Start these playlists" (File keeps it), tag coverage line,
  "Genre sources" button, merge/split rate line. With L2. R.
- **C3** Sheet: Twins section; Fill's "Off for your library" paragraph
  becomes one line. R.
- **C4** Tidy: Cross-filed's 2+…6+ row (fixed at 2+). With L4. R.
- **C5** Discover: second filled button in the empty state, keyless note and
  "Connect Last.fm", play-on-art, the radar's "Features and remixes" fold.
  With L3. R.
- **C6** New: per-part "Make 'X'" (Split… stays), untagged note. R.
- **C7** Settings: App icon preview. With L5. R.

Automate:

- **A1** Discover finds new music once a day by itself (the button stays as
  "Find more"). With L3.
- **A2** Hard to find checks a batch in the background (small "Check more"
  stays).
- **A3** Fill's "Check it on my library" runs after the weekly Score.
- **A4** Engine's Score / Score + Tune buttons become one small "Run again
  now".
- **A5** The sound nudge goes into the home header (with M1).

Moves and fixes found on the way (not cuts):

- **F1** "Find tracks that sound like…" moves from Discover to Library.
- **F2** "Shuffle everything" resets to All Songs.
- **F3** New's "Groups in your backlog" Create goes through `gapsCreate`,
  so it gets History and undo.
- **F4** Swipes stop at Library; tab badges use the same counts as the
  screens they open.
- **F5** The radar's account check folds into one plain line plus Details
  (BUILD-7 R1).
- **Words** (one PR, L7 wave): the **words** marks above.

Tap counts: no call above makes a function further away. M4 makes playlist
health one tap closer from File (Library row, not Tidy › Health), F1 makes
"sound like" search 1 tap from Library as from Discover, and every cut
function either has another way in at equal or fewer taps or is shown in the
home header at 0.

### 7.8 How the calls are split into threads

Owned files decide what can run together (§5). The home page goes first,
after L0 merges, because M1, A5 and F4 sit in `home.mjs`, `inbox.mjs`,
`shell.js` and `render.js`.

- **Home page** (L8 step 2): M1, A5, C1, M2, F4. Owns `home.mjs`,
  `inbox.mjs`, `analyse.js`, `soundslots.js` (nudge only), `40-home.css`,
  `60-file.css`, `render.js` (counts only).
- **Wave A**, in parallel:
  - **L2** + M4 (Library side), M5, C2, C3, M6, F2, F3: `lists.mjs`,
    `new.mjs`, `shuffle.mjs` (F2 only), `61-library.css`, `62-lists.css`.
  - **L4** + M3, M4 (Tidy side), C4, A2: `tidy.mjs`, `hidden.mjs`,
    `64-tidy.css`, `63-hidden.css`. L2 and L4 share M4: L4 removes Tidy's
    Health part only after L2's "Tidy N" link is on `main`.
  - **L5** + C7, A4: `helpers.mjs`, `engine.mjs`, `66-engine.css`,
    `70-overlays.css`, the template's Settings markup.
- **Wave B:** **L3** + M7, C5, A1, F1, F5 (`discover.mjs`, `radar.mjs`,
  `clap.js`, `discover-engine.js`, and `lists.mjs` for F1's new home, after
  L2 merges); then **L1**.
- **Wave C:** **L7** + the words PR. A3 (Fill after Score) goes here too,
  because it touches `autoscore.js`, which no other package owns.
