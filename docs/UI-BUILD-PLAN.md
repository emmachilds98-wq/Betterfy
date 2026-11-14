# UI refresh — review and build plan for parallel agents

The audio build (`docs/AUDIO-BUILD-PLAN.md`) is about to give every track
things the app has never been able to show: how it *sounds* (style labels,
mood, voice/instrumental, danceability), what changes inside it (sections),
BPM and key with a confidence, a per-playlist sound fingerprint, hybrid and
"new genre?" proposals, and a with/without-audio score. It also adds a
long-running background job (listening to previews) that needs a home, a
progress state and an honest "couldn't hear N tracks" list.

This file reviews where the UI is today, sets the direction, and breaks the
work into packages that separate agents can build at the same time without
colliding with each other **or with the audio packages**.

Read before starting any package: `CLAUDE.md`, §0 of this file, and the
audio plan's §0 ground rules (they apply here too: optional all the way down,
nothing stored that shouldn't be, tests green).

---

## 1. Review: where the UI is today

Rendered with a synthetic 230-track library behind a fake Spotify
(`scripts/ui-shots/`, added by UI-0), desktop and phone, both themes.

**What is already good and stays.** This is a refresh, not a replacement.
- A real design system: warm Nightshift/Daylight grounds, named radii, one
  accent that turns, eight spun hues, and the five-colour mark that never
  turns. Each screen owns a hue, and the tab, the Home card and the screen
  agree on it.
- The File card is the best screen in the app: one decision, big artwork,
  ranked picks with the go-ahead colour only on the best one, keyboard and
  swipe parity, "nothing is written until you tap".
- Copy that tells the truth about where data comes from.
- Phone chrome done properly: safe areas, tab bar, More sheet, reduced motion.

**What is wrong or will not survive the audio features.**

| # | Finding | Where | Severity |
|---|---|---|---|
| R1 | The wordmark renders as "Better  fy": `.brand` is a flex row with `gap:11px`, so the text node and the `<span>` become separate flex items with a gap between them. Same on the landing logo. | chrome, landing | bug, visible on every screen |
| R2 | "Next up to file" cards: title and artist run together on one line and the suggestion line is clipped against the card's bottom edge. | Home | bug |
| R3 | **Playlists is two screens in one**: three paragraphs of explanation, then *data-source setup* (Last.fm key, Wikidata, Discogs token) as a wall of prose and buttons, then the per-playlist axes list. The audio plan puts its settings panel ("Listen to my music", Wi-Fi only, scope, progress, couldn't-hear list) **here too**. A fourth source on this page makes it unusable. | Playlists | blocks audio |
| R4 | Suggestions show *a* percentage but not *what it is made of*. Today the only provenance is "via history" vs tags. Audio adds a third and fourth source (sound, learned). Without a shared evidence vocabulary each screen will invent its own. | File, Discover, Tidy | blocks audio |
| R5 | No visual vocabulary for **confidence**. `calibrate.mjs` already produces HIGH / LIKELY / AMBIGUOUS bands and the learner will feed the same bands, but the UI shows raw percentages and Tidy shows "high/medium/low" filter pills with different words. | File, Tidy, Engine | blocks audio |
| R6 | Nowhere for a **background job** to live. Wikidata fill runs quietly; audio analysis runs for minutes to hours. Needs a persistent, glanceable status (listening / paused on mobile data / done) that is not a toast. | chrome | blocks audio |
| R7 | Native controls unstyled: OS-blue checkboxes, default selects on Playlists clash with the warm palette; a disabled primary ("Fetch missing tags (0)") still reads as the main action. | components | polish |
| R8 | Empty states are a grey box with one sentence (Tidy, New playlists ×3, Engine). New playlists is three empty boxes in a row for most libraries. | Tidy, New, Engine | polish |
| R9 | Ledes run to 3–6 lines of prose above every screen. Useful once, noise every visit. | all screens | polish |
| R10 | The whole stylesheet (≈820 lines) and every view live in one 6,500-line `docs/app.template.html`, which `AUDIO-BUILD-PLAN.md` gives exclusively to WP-B2. Any UI work and B2 would collide on the same file. | structure | blocks parallel work |

## 2. Direction

**Keep the system, add a sound layer.** The mark is already five level bars.
Make that literal: it becomes the app's *sound motif*.

1. **Sound chip** — one compact row per track: `174 BPM · 8A · energy ▮▮▮▯▯ ·
   vocal`, with "half/double-time unsure" shown as `87/174`. Absent when there
   is no audio record (never a placeholder, never "—").
2. **Section strip** — a thin horizontal bar under the artwork, split into the
   clip's sections, each coloured by its top style (mark colours, mapped by
   style family). A hybrid track *looks* hybrid at a glance.
3. **Evidence badges** — every suggestion says what it is made of with the same
   four small badges everywhere: `tags`, `history`, `sound`, `learned`.
   Hover/tap lists the contribution. One vocabulary for File, Discover, Tidy
   and Engine.
4. **Confidence band** — one chip, three states (Sure / Likely / Unsure) in
   ok / accent / idle tones, replacing raw percentages as the headline. The
   percentage stays, smaller, for whoever wants it.
5. **Listening indicator** — in the top bar (desktop) and above the tab bar
   (phone): the mark's five bars animate as a level meter while analysis runs,
   with a count (`Listening · 412 / 1,980`). Tap opens Sources → Listening.
   Paused on mobile data shows the bars still, with the reason. Respects
   reduced motion.
6. **Sources screen** — data sources move out of Playlists into their own
   screen (behind More): Last.fm, Wikidata, Discogs, and **Listening**, each a
   card with status, one line of explanation and its controls. Playlists
   becomes the axes table only, with styled controls.
7. **Playlist sound profile** — on each playlist row (expandable): its typical
   BPM range, energy spread, top styles and how many members have been heard.
   Built from the playlist centroid WP-E1 produces.
8. **Proposal cards** — New playlists gets one card shape for "pick one of
   these two", "hybrid playlist" (two style colours blending) and "new genre?"
   (unnamed until C3), each with sample tracks and a Create button.
9. **Score card with/without** — Engine shows two bars per metric, without and
   with audio, and the gate (+5 on never-filed artists) as a visible line.
10. **Calmer copy** — ledes cut to one sentence; the long explanations move
    behind a "How this works" disclosure on each screen.

Nothing in 1–9 renders anything when there is no audio data, so the app looks
exactly like today's (plus the fixes) for anyone who never turns listening on.

## 3. Ground rules every package follows

1. **Own your files.** Each package lists them. The view functions in
   `docs/app.template.html` are owned *per function*; the stylesheet is split
   into per-package partials by UI-0 so nobody edits a shared CSS block.
2. **Never touch `core/audio/`**, `core/intrinsic/audio*`, or any file the
   audio plan gives a WP. Sound components take a plain **view model** (§5),
   not an `AudioRecord`, so the UI never imports the audio contract and the
   audio side writes one adapter.
3. **Absent means absent.** With no audio data every screen's HTML is
   byte-identical to the same screen built without the sound layer. Each
   package that adds a sound slot writes that test first.
4. **Tests:** `npm test` green before and after. After editing
   `docs/app.template.html` or any `web/styles/*.css`, run
   `node build-web.mjs` before testing. Each package adds or updates its
   screenshots with `npm run shots` and attaches them to its PR.
5. **No new dependencies, no build step, no framework.** It stays one static
   page. Fonts stay as they are.
6. **One branch and one draft PR per package**, `claude/ui-<id>`, merged into
   `main`. Merge `main` in when needed; don't rebase shared branches.

## 4. Coordination with the audio build

`AUDIO-BUILD-PLAN.md` gives `docs/app.template.html` and `build-web.mjs` to
**WP-B2** (wave 3, not started). The UI packages edit both, so:

- **UI-0 lands first** and moves the stylesheet into `web/styles/` partials
  and adds `web/ui/*.mjs` to the bundle. That is the only change UI makes to
  `build-web.mjs`.
- **UI wave 1 must merge before WP-B2 starts.** B2 then mounts its settings
  into the **Listening card slot** UI-3 builds and uses the UI-2 components
  instead of drawing its own. D4, H2 and E2 likewise render through UI-2's
  sound chip, UI-6's proposal card and UI-6's score card.
- If B2 has to start earlier, it owns the template from then on and the
  remaining UI packages hand their view changes to it as patches.

## 5. The view-model contract (frozen by UI-0, used by UI-2..6)

`web/ui/sound.mjs` exports pure `(viewModel) → html string` functions. The
view models are plain objects; `null`/`undefined` renders `''`.

```js
// per track
SoundVM = {
  bpm?: number, bpmAlt?: number,      // bpmAlt set ⇒ "87/174", octave unsure
  bpmConf?: number,                   // 0–1
  key?: string, camelot?: string, keyConf?: number,
  energy?: number,                    // 0–1, heuristic (D3)
  voice?: 'vocal'|'instrumental'|null,
  moods?: string[],                   // ontology names, already mapped (F1)
  styles?: [label: string, p: number][],   // top styles, labels already mapped (V1)
  sections?: string[][],              // per section, top style labels in time order
  hybrid?: boolean,
}
// per suggestion
EvidenceVM = { tags?: number, history?: number, sound?: number, learned?: number }  // contributions 0–1
BandVM = 'HIGH'|'LIKELY'|'AMBIGUOUS'|null
// per playlist
ProfileVM = { heard: number, members: number, bpm?: [lo, hi], energy?: [lo, hi], styles?: [label, p][] }
// background job
ListenVM = { state: 'off'|'running'|'paused'|'done', done: number, total: number,
             reason?: string, missed?: { [MISS]: number } }
```

## 6. Work packages

Sizes: S under half a day, M about a day, L 2–3 days.

### Wave 0 (one agent, serial; everything else waits for it)

**UI-0 Foundation (M)** — *done in the first PR.*
- Files: `build-web.mjs` (two blocks), `docs/app.template.html` (the
  `<style>` element only, now `__STYLES__`), new `web/styles/*.css`, new
  `web/ui/sound.mjs` (the §5 contract with `''` renderers),
  `scripts/ui-shots/`, `package.json` (`shots`), `test/uibuild.test.mjs`.
- The stylesheet is split, unchanged, into partials the build inlines in
  file-name order (the number is the cascade position):

  | Partial | Was | Owner |
  |---|---|---|
  | `00-tokens.css` | `:root` tokens, both themes | UI-1 |
  | `10-base.css` | reset, body, reduced motion | UI-1 |
  | `20-landing.css` | landing, wordmark | UI-5 |
  | `30-chrome.css` | top bar, nav pills, mobile header, h1/h2/lede | UI-5 |
  | `40-home.css` | hero, action tiles, split panel, up-next | UI-5 |
  | `50-components.css` | card, art, tags, picks, player, buttons | UI-1 (UI-4 for `.pick`) |
  | `60-file.css` | swipe deck, rows, list covers, end-of-queue | UI-4 (UI-3 for list rows) |
  | `70-overlays.css` | update bar, FABs, toast, settings, sheet | UI-5 |
  | `80-responsive.css` | pager dots and the phone breakpoint | UI-5 |
  | `90-sound.css` | empty; the sound layer | UI-2 |

  A package that needs styles for its own screen adds a **new** partial in a
  free slot before `80` (`62-lists.css`, `64-tidy.css`, `66-engine.css`)
  rather than editing someone else's. Phone overrides for a screen go in that
  screen's partial inside its own `@media`, not in `80-responsive.css`.
- Fixed R1 (the wordmark gap) in `20-landing.css`, `30-chrome.css` and
  `80-responsive.css`.
- Done: the built page's CSS is byte-identical to before the split apart
  from R1, `npm test` passes, and `npm run shots` writes 40 screenshots
  (9 screens + landing × desktop/phone × dark/light) from a synthetic library
  with no network.

### Wave 1 (parallel, no shared files)

**UI-1 Tokens and components (M)** — owns `00-tokens.css`, `10-base.css`,
`50-components.css` (except `.pick`).
- Styled checkbox, select, text input, toggle switch (needed by Listening),
  segmented control; disabled primary that reads as disabled (R7).
- Band chip (Sure/Likely/Unsure) and evidence badge *styles*.
- Empty-state pattern with the mark as illustration (R8).
- A type-scale pass: one lede size, `.how` disclosure style for R9.
- Done when `npm run shots` shows every control in both themes on a
  component gallery section of the shots harness, contrast ≥ 4.5:1 for text.

**UI-2 Sound components (M)** — owns `web/ui/sound.mjs`, `90-sound.css`,
`test/uisound.test.mjs`.
- `soundChip(SoundVM)`, `sectionStrip(SoundVM)`, `evidenceBadges(EvidenceVM)`,
  `bandChip(BandVM)`, `profileRow(ProfileVM)`, `listenPill(ListenVM)`,
  `listenCard(ListenVM)` (body only; B2 supplies controls), `missedList(ListenVM)`.
- Style-family → mark-colour mapping for the section strip, stable per label.
- Done when every renderer returns `''` for null/empty input (tested), each
  has fixture tests for octave-unsure BPM, hybrid, all-miss, and the shots
  harness has a gallery of every component on fixtures.

**UI-3 Playlists and Sources (L)** — owns `vLists` and a new `vSources` in the
template, `lists.css`, `test/weblists*.test.mjs`.
- New Sources screen behind More: Last.fm, Wikidata, Discogs cards with status
  and controls (moved, behaviour unchanged), and a **Listening card slot**
  that renders `listenCard()` and is empty until B2 wires it.
- Playlists becomes the axes table: compact rows, styled controls, an
  expandable row that renders `profileRow()` (empty without audio).
- Ledes to one sentence + "How this works" (R9).
- Done when every existing Playlists test passes unchanged against the new
  location of each control, and the byte-identical-without-audio test holds.

**UI-4 File and Discover cards (M)** — owns `vInbox`, `vDiscover`,
`60-file.css` (except list rows), `.pick` in `50-components.css`,
`test/webinbox*.test.mjs` additions.
- Picks show `bandChip` as the headline and `evidenceBadges`; the % stays,
  smaller. History-based picks keep their "4 of 5" wording.
- Slots under the artwork for `sectionStrip` and next to the meta line for
  `soundChip`.
- Done when existing webinbox/webdiscover tests pass, band and badge fixtures
  render, and output with no audio is byte-identical to the slot-less build.

**UI-5 Home, chrome and landing (M)** — owns `vHome`, the chrome markup
(`aside`, `.mtop`, tab bar), landing markup, `20-landing.css`,
`30-chrome.css`, `40-home.css`, `70-overlays.css`, `80-responsive.css`.
- Fix R2 (up-next cards). Listening indicator slot in the top bar and above
  the phone tab bar rendering `listenPill()`. A fifth Home tile, "Heard",
  shown only when listening has ever run.
- Landing: one line about listening (optional, on-device) in the feature grid
  once B ships — behind a flag until then.
- Done when shots show desktop and phone, both themes, with and without a
  ListenVM fixture.

**UI-6 Tidy, New playlists, Engine (M)** — owns `vTidy`, `vNew`, `vEngine`,
new `64-tidy.css` and `66-engine.css`.
- Tidy's high/medium/low filter renamed to the band words (Sure/Likely/Unsure)
  and uses `bandChip` (R5). Real empty states (R8).
- New playlists: collapse three empty sections into one empty state; proposal
  card shape (pick-one-of-two, hybrid, new genre?) on fixtures for WP-H2.
- Engine: Score card with paired without/with bars and the gate line, on
  fixtures for WP-E2.
- Done when existing webtidymore/webgaps/webengine tests pass and fixtures
  for each new card render in the shots gallery.

### Wave 2 (after audio WP-B2/E2/H2/D4 land)

**UI-7 Wire-up review (S)** — not a build package: a design review pass with
real audio data on the owner's library, filing fixes as small PRs against
whichever package's files they touch.

## 7. How to split this across agents

- UI-0 first, one agent.
- Wave 1: **six agents at once**. Their only shared surface is
  `docs/app.template.html`, where each owns different functions; git merges
  those cleanly. If two packages need the same function, the listed owner
  does it.
- Every agent's first message includes the package ID, its §6 entry, §3, §5,
  and: *"Touch only your package's files; never touch core/audio or anything
  an audio WP owns; if you need a contract change, stop and say so."*

## 8. Status

| Package | State |
|---|---|
| UI-0 | **Done** (first PR) |
| UI-1 … UI-6 | Ready: branch from UI-0's branch until it merges, then merge `main` in |
| UI-7 | Waiting on audio wave 3–4 |
