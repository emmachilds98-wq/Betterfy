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

---

## 1. What review 2 already shipped

- **#167:** tags and genres are gathered at every start (Wikidata, then
  Last.fm, then Discogs with a token), and the Settings buttons for them are
  gone. Tidy › Repeats no longer shows an empty sub-list. The Engine's "would
  do differently" list is folded after 8 rows (the phone page was over
  10,000 px tall). Shuffle and Library copy is plainer.
- **The follow-up PR:**
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

## 5. Waves, file ownership, gate

- **Wave A** (parallel, at most three): L2, L4, L5. They touch different
  partials and modules.
- **Wave B:** L3, then L1. L1 goes last because it lays out what L2 and L3
  leave.
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
