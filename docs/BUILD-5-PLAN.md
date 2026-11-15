# Build 5 — review of where Betterfy stands, and the plan for the next big upgrade (2026-11-14)

**Start here for build 5.** `docs/HANDOFF.md` is still accurate for the sound
features file by file; this file supersedes its §6 ("next work, ranked") and
`docs/UI-BUILD-PLAN.md` §2/§6 (the UI direction). It was written from a full
read of `main` at `48c8b77`, a fresh `npm test`, a trial merge of every open
PR, screenshots of every screen (`npm run shots`), and four parallel audits
(architecture, function-by-function intelligence, UI and motion, audio and
knowledge sources).

The owner's brief for this build: help people file their music with **real
audio analysis and knowledge**; make **every function as smart as it can be**;
**restructure the UI** freely — easy to use, little on screen at once, smooth
modern transitions — and keep it functional.

The binding rules have not changed (CLAUDE.md, HANDOFF §4): works for every
account from its Spotify library alone; no Spotify content into an ML model;
nothing pooled across accounts; byte-identical when a feature has no data;
`mel.mjs`/`record.mjs` frozen; generated files are rebuilt, never hand-merged.

---

## 1. Where the build is today

### 1.1 What works

| Area | State |
|---|---|
| Library read, sync, PKCE, own-app setup, Firestore tag share and feedback sync | Shipped, stable |
| v1 tag engine (`profile.mjs`, Last.fm/Wikidata/Discogs tags, axes) | Live: drives File, Tidy, Discover, New through `R` |
| Account-native engine (`core/intrinsic/`, artist graph, bridge, calibration) | Live on the Engine screen; feeds sound-first File picks |
| Listening (Deezer preview by ISRC → 16 kHz decode → Discogs-EffNet in the browser) | Shipped behind "Listen to my music" |
| Sound-first filing, sound ID (genre › sub-genre › BPM), "mixes with" | Merged in #88 |
| Tempo | 86% within ±1 BPM at confidence ≥ 0.3 (Beatport set); shown |
| Key | 30% exact; hidden |
| Mood / voice / energy heads | Stored, hidden until the owner's label review passes 70% |
| v3 evidence engine (`core/engine.mjs`, `core/analysis`, `core/evidence`, `core/ai`, `core/review`) | **Not in the page.** Reached only by Node scripts, benchmarks and tests |

`npm test` on `main`: **1,296 tests, 1,295 pass, 0 fail, 1 skip** (182 s).

### 1.2 Open pull requests

| PR | What | State | Verdict |
|---|---|---|---|
| **#92** | S1 Tidy by sound + one shared sound space + mid-run refresh | Clean. **Already contains #93, #94 and #95** (their heads are ancestors of #92's head) | **Merge.** Main + #92 rebuilt and tested here: 1,356 tests, 1,355 pass, 0 fail, 1 skip |
| #93 | S2 playlist sound profiles and two-genre splits | Contained in #92 | Close as merged-by-#92 |
| #94 | S3 DJ order for Shuffle | Contained in #92 | Close as merged-by-#92 |
| #95 | S4 Discover by sound + keyless candidates | Contained in #92 | Close as merged-by-#92 |
| #90 | WP-C1 MAEST second ear | Conflicts. Its diff against `main` would delete #88's tests and CLAP table. The model file isn't in it | Rebase onto `main` after #92, or park until a machine can fetch the model |
| #89 | UI-6 refresh (paused) | Targets a dead branch, conflicts with UI-1..6 already on `main` | **Close.** Its remaining ideas are folded into §4 below |
| #41 | MusicBrainz/iTunes tag sources (September) | Stale | Close or re-scope under §6.5 |

Note: #92's `docs/SOUND-EVERYWHERE-PLAN.md` says "S1–S4 are merged". That is
only true once #92 is merged; until then `main` has none of them.

### 1.3 Bugs found in the review (verified in code)

| # | Bug | Where |
|---|---|---|
| B1 | **Move's undo only reverses the remove.** The toast undoes the newest log entry (the remove), so after Undo the track is in *both* playlists | `docs/app.template.html` ~5985–5996 |
| B2 | **History keeps "Undo" on rows already undone**, so a second tap re-adds a duplicate. A move shows as two unrelated rows | `vHistory` ~3258 |
| B3 | **Phone File screen: the File button sits under the tab bar** at 390×844; the main action is hidden until you scroll | `phone-dark-inbox.png`; `60-file.css` / `80-responsive.css` |
| B4 | Liked tracks already filed as another release (same ISRC or same `trackKey`) show in File as unfiled — matching is by Spotify id only | `buildReports` ~1589 |
| B5 | Rejecting a pick re-ranks with bare `rank()`, dropping the `artistHistory` fallback and the `via` label | click handler ~5920 |
| B6 | "Wrong place" (tag tier) has no "Keep here", so dismissed rows return every sync | `secMisfile` |
| B7 | Accepts and moves are never written to feedback, so `audio-feedback.mjs` (which reads `FB.accepted` and move verdicts) learns only from rejects | `fileCurrent` ~6242, move ~5980, `FB` 1147 |
| B8 | Listening pill overlaps the "tracks heard" figure on phone Home; the More pill jumps when it appears on desktop | `phone-dark-home-listening.png` |
| B9 | No URL routing: browser/Android back leaves the app | no `pushState`/`popstate` anywhere |
| B10 | `axes.mjs` claims to mirror the page's `classify()` but has drifted (different EVENT/DJSET/MOOD regexes, no `genreInName`) | `axes.mjs:7` vs template ~1293–1312 |
| B11 | Low contrast (3.0–3.2:1) on the sound chip's `.snd-unit` and `.snd-q` | `90-sound.css` |

### 1.4 Structural findings

- **One 6,785-line template** holds every view, all state, the engine glue and
  ~90 click branches in one delegate. Every parallel PR edits it plus
  `build-web.mjs`'s hand-kept `ENGINE_ENTRIES`/`ENGINE_SIDE` lists, so
  conflicts are structural, not accidental.
- **Every action re-renders the whole screen** (`main.innerHTML = VIEWS[view]()`,
  68 call sites, including background engine progress while you are mid-swipe).
  Nothing can animate *between* states, focus and scroll are lost, and inputs
  have to be re-hydrated from `S`.
- **Tests slice the built page by function name** (~224 cuts across 33 files)
  and compare byte-exact goldens. That is why "put a new slot on the same
  line" is a rule. It protects behaviour but makes restructuring expensive.
- **10 screens** in navigation (5 tabs + More), ~40–140 words of prose each;
  Discover and Sources are the densest. Home buries the actual work (tracks to
  file) three phone-screens down.
- **Good things to keep:** the design tokens and five-bar mark, the File card,
  honest copy, the sound view-model contract (`web/ui/sound.mjs`), the Worker
  split, IndexedDB storage, the evidence/band vocabulary, the test culture.

### 1.5 What has *not* been measured

Everything about sound on a real library. Every sound number so far is from
fixtures, a simulated library or strangers' Deezer playlists. The owner's
Score run (HANDOFF §2) is still the single most valuable 10 minutes in the
project: it tunes `SOUND_FIRST_WEIGHTS`, identify's thresholds, tempo ranges,
and #92's Tidy-by-sound thresholds.

---

## 2. Decisions for the owner

1. **Merge #92** (it brings S1–S4). Close #93/#94/#95/#89; decide #90 and #41.
2. **Do the Score run** with listening on, and paste the results.
3. **The learner and the Spotify terms.** `core/intrinsic/audio-learn.mjs`
   fits a logistic regression whose *labels* are the account's own playlist
   membership; the *features* are Deezer audio embeddings. README and HANDOFF
   say "nothing is trained". SMARTER-GENRES-PLAN §3 R1 reads the terms as "no
   Spotify content into an ML model". The module's own header argues for
   reading (a). Options: (a) keep it, on the reading that a per-account model
   of your own organisation, never shared, is your own data shown back to you
   (R3) — and fix README/HANDOFF to say so; (b) set the page to the learner's
   `model: 'prototype'` option (prototypes only, measured within ~1.5 points
   top-1 of logistic at 20–40 examples) and keep logistic regression for
   offline measurement only. **This plan assumes (b) until the owner decides**,
   and every new feature below is lookups and counts.
   **Decided 2026-11-15 by the owner: (b), prototype only.** Logistic
   regression stays for offline measurement; README/HANDOFF keep saying nothing
   is trained in the page.
4. **Approve the restructure** in §3 (it is the precondition for the UI and
   motion work).

---

## 3. Phase A — foundation: restructure without changing behaviour

Goal: make the app modular enough that screens can animate, update in place
and be built by parallel agents without fighting over one file.
No framework, no new dependencies, still one static page built by
`build-web.mjs`.

| Step | What | Gate |
|---|---|---|
| A0 | Drain the PR queue (§2.1). Freeze the template for A1 | `main` green |
| A1 | **Mechanical split.** Cut the inline script into ordered classic files: `web/app/*.js` (theme, auth/`sp`, storage, sync, classify, reports, engine glue, audio glue, events) and `web/screens/<name>.js` (each `v*` and its helpers). `build-web.mjs` concatenates them where the script was | The new `docs/index.html` is **byte-identical** to the old one; every existing test passes unchanged |
| A2 | Move `classify()`/`genreInName`/`addedShape` into one shared module that both the page and `axes.mjs` import (fixes B10) | Existing classify tests + a parity test |
| A3 | **Store.** `store.get/set/on` with slices `lib`, `reports`, `eng`, `sound`, `audio`, `gaps`, `player`, `ui.<screen>`. Background jobs write their slice; only a mounted screen that subscribes repaints | No blind `render()` from background jobs (grep test) |
| A4 | **Screens become ES modules:** `view(ctx)` (pure, returns HTML), `actions` (a `data-act` map), optional `mount/update`. Tests move screen by screen from vm slices to importing the module with a fixture `ctx` | Each migrated screen deletes its slice test in the same PR |
| A5 | **Keyed patcher** `patch(el, html)` (~150 lines): diff children by `data-key`, keep focused inputs and scroll. Full re-render only on screen change and sync | Unit tests: insert, remove, reorder, focus kept |
| A6 | **Router:** `pushState` per screen and per sheet, `popstate` → back (fixes B9) | Back closes a sheet, then returns to the previous screen |
| A7 | **Build conventions:** replace the hand-kept `ENGINE_ENTRIES`/`ENGINE_SIDE` lists with a folder or header convention (`// @bundle engine`); move v3 and the Node-only v1 CLIs (`server.mjs`, `dupes.mjs`, `misfile.mjs`, `review*.html`) to `legacy/` | Build output unchanged; benchmarks still run |
| A8 | Goldens compare on normalised whitespace (or DOM structure), so the "same line" rule goes away | Old goldens still pass |

A1 is one serial PR. A2–A8 can then run in parallel (different files).

---

## 4. Phase B — the new app: navigation, layout and motion

### 4.1 Information architecture: 10 screens → 4 tabs + settings

| Tab | Holds | Replaces |
|---|---|---|
| **File** (home) | One-line status strip ("42 to file · 1 to tidy · listening 37/412"), the deck, "Up next" as a horizontal strip; a done state with the library bar when the backlog is empty | Home + File |
| **Tidy** | Opens on the first non-empty section: Wrong place · Sounds wrong (by sound) · Repeats · Cross-filed. Every row is one swipe-able decision with undo | Tidy |
| **Discover** | Results first; seeds as a chip row; keyless by default (after #92) | Discover |
| **Library** | Compact playlist rows (name, count, axis chip, sound sparkline); "Suggested playlists" at the top only when there are any; tap a playlist → **detail sheet** with axis, receives-suggestions, sound profile, health score, split offer and **Shuffle / DJ order** | Playlists + New playlists + Shuffle |
| ⚙ **Settings** ("Under the hood") | Listening (first), Last.fm, Wikidata, Discogs as status rows that expand; Engine; History (also reachable from every Undo toast); theme, update check, About/licences, disconnect | Sources, Engine, History, top-bar download icon |

Progressive disclosure everywhere: ledes are one line or none; "How this
works" becomes an ⓘ sheet; on the File card, Unlike and "Add another
playlist" move into a ⋯ menu; the listening prompt is a one-time banner; the
keyboard hint shows on `?`, desktop only; Shuffle's 28-row preview collapses.
"Nothing is written until you tap" is said once, in onboarding, and then by
every Undo toast.

### 4.2 Motion system (platform only)

Tokens in `web/styles/00-tokens.css`:

```css
--dur-1:120ms;  /* press, hover, colour */
--dur-2:200ms;  /* chips, toggles, toast, fades */
--dur-3:300ms;  /* screen change, sheet, row add/remove */
--dur-4:450ms;  /* shared element, deck promote */
--ease-out:cubic-bezier(.2,.7,.3,1);   /* the existing curve, named */
--ease-in:cubic-bezier(.4,0,1,1);      /* exits */
--ease-std:cubic-bezier(.3,0,.2,1);    /* moves on screen */
--ease-spring:linear(0,.106,.325,.556,.748,.886,.972,1.018,1.036,1.038,1.031,1.022,1.014,1.007,1.003,1);
--ease-bounce:linear(0,.166,.493,.802,1.011,1.109,1.124,1.095,1.053,1.016,.994,.985,.985,.989,.995,.999,1);
--slide:24px;
```

Springs are for `transform` only, never opacity. About 30 hard-coded
durations and the repeated `cubic-bezier(.2,.7,.3,1)` move onto the tokens.

| Moment | Technique |
|---|---|
| Tab / screen change | `document.startViewTransition` with forward/back types (feature-detected; fall back to a `data-dir` attribute), top bar and tab bar named so they stay still, the active tab pill named so it glides. Replaces `slideL`/`slideR` |
| Up-next cover → File card | Shared element: `view-transition-name: art-<trackId>` on both, grown on `--dur-4 --ease-spring` |
| Filing a track | **Optimistic:** the card flies out, the peek card springs up from .955 to 1, the Spotify write happens in the background; on failure the card comes back with a toast. Swipe gets velocity: a fast flick commits below the 76 px threshold |
| Sheets, toasts, popovers, new rows, listening pill | `@starting-style` + `transition-behavior: allow-discrete` (replaces `tileIn`/`toastIn`) |
| Rows removed or reordered (Tidy, History, DJ order) | FLIP with `el.animate` on `--ease-spring` |
| Large title → header title on scroll; header hairline; rows fading in | Scroll-driven animations inside `@supports (animation-timeline: scroll())` |
| First sync, Discover search, listening | Skeleton blocks shaped like the card and rows; the mark's five bars as the level meter |
| Expanding cards | `<details>` + `interpolate-size` / `::details-content` where supported; snap open elsewhere |
| Reduced motion | Keep the global kill switch; also disable `::view-transition-*` animations. Swaps become a cut |

Browser support (checked 2026-11-14): same-document View Transitions are
Baseline since Firefox 144 (October 2025); transition *types* need feature
detection; `@starting-style` and `linear()` are in all three engines;
scroll-driven animations only reached Firefox in 159, so they stay inside
`@supports`. Nested and scoped view transitions are Chrome-only — don't use
them.

### 4.3 Work packages

| ID | Package | Depends on |
|---|---|---|
| UI-A | Quick fixes now, before the restructure: B3 (pin File/Skip above the tab bar, hide the key hint on touch), B8, B11, Tidy opens on first non-empty section, one empty-state style | — |
| UI-B | Motion tokens + View Transition navigation + router (A6) | A1 |
| UI-C | Optimistic filing, deck promotion, swipe velocity, shared-element art | A3, A5 |
| UI-D | 4-tab shell + Settings sheet; Sources/Engine/History move in; pager dots and top-bar download icon go | A1 |
| UI-E | Library tab: compact rows, playlist detail sheet (profile, health, split, Shuffle/DJ order), suggested playlists section | A4, #92 |
| UI-F | Copy pass: one-line ledes, ⓘ sheets, licences to About, one Last.fm connect sheet | UI-D |
| UI-G | `@starting-style`, FLIP, skeletons, scroll-driven header | A5 |

Every UI package attaches `npm run shots` output (desktop + phone, both
themes) and keeps the "nothing without data" rule.

---

## 5. Phase C — make every function smarter

All of this is lookups, counts and per-account prototypes over the
account's own library and heard tracks (rule R3). Ranked by value for effort.

### 5.1 Learn from everything the user does (fixes B6, B7)

- Write **accepts, moves and "keep here"** to feedback, not only skips and
  rejects. One event shape: `{ trackId, from?, to, verdict: accept|reject|move|keep, at }`.
- Use it everywhere with prototype updates (no training): an accepted
  filing pulls that playlist's sound prototype toward the track; a reject
  pushes it away for that track's neighbours; "keep here" suppresses the same
  flag in both Tidy tiers.
- Rejects also teach the tag engine (exclude that playlist for the same
  artist's next tracks, decaying).

### 5.2 File

- **Queue order by value:** listening weight (top artists, recently played,
  and `/me/top/tracks`, which the app never calls yet) × uncertainty, so the
  tracks you play most and the engine is least sure about come first.
  `core/personal/relevance.mjs` and `core/review/queue.mjs` already exist but
  aren't bundled.
- **Confident batch:** show the calibrated band from the Engine's `decide()`
  on every card, and offer "File the 18 sure ones" as one History group with
  one undo.
- **Unheard tracks with thin tags** get the account-native engine's
  placements (artist graph, ISRC registrant, bridge), gated per account by
  the Score result. *Built 2026-11-15 as a blend with the tag engine
  (SMARTER-GENRES-PLAN phase 1, "Phase 1 as built").*
- **Already filed elsewhere** (B4): a liked track whose ISRC or `trackKey` is
  already in a playlist counts as filed.
- Roll-forward ("file the rest of this artist") by sound ID and registrant,
  not only by artist.

### 5.3 Tidy

- After #92: when the sound tier and the tag tier disagree about a track,
  sound wins and the tag row is dropped.
- A track is left out of its own home centroid when judged.
- Repeats group by **ISRC first**, then name; optional "probably the same
  master" by audio embedding (cosine ≈ 1, same artist).
- Cross-filed is ranked by suspicion: two genre playlists on the same axis
  first, genre + mood last (deliberate), each with a pre-suggested keeper.

### 5.4 Library (Playlists + New + Shuffle)

- **Playlist health score** on each row: sound coherence, two-genre split
  (#93), twins (`bucketPairs`, today Engine-only), tag drift, misfile and
  repeat counts, staleness.
- **"These look like genre playlists"**: suggest axis ticks from facet mix and
  sound, one tap to confirm, instead of making the user tick them.
- **Cold start:** an account with no genre-named playlists hits a dead end on
  File today. Offer `coldstart.proposeBuckets` / `unnamedClusters` on the
  intrinsic space as "start these playlists", named by sound ID.
- **New-genre detection:** cluster the calibration's "not sure" set, rank by
  listening, name by sound ID (and CLAP when it ships).
- **Shuffle:** soft sound/genre continuity inside the spaced shuffle; a
  "rediscover" option that pushes down artists in `short_term` and recently
  played; key (Camelot) in DJ order once key clears its bar.

### 5.5 Discover

- Remember passed artists on this account; use Like/Add as positive seeds.
- Show "why" with your own neighbours (`explain.sharedArtists`) and the sound
  fit #95 adds.

### 5.6 Home status and copy

- Show calibrated words (Sure / Likely / Unsure), not raw percentages.
- "Genre comes from Last.fm" is no longer true once listening is on.

---

## 6. Phase D — hear better, know more

Research done 2026-11-14 (live requests and published results); sources at
the end of this section. Licences matter: Essentia's models, madmom's and
S-KEY's weights are **non-commercial**. Betterfy is free and personal today,
so they fit, but each one is recorded in `docs/models/LICENSE` and About.

### 6.1 Key: from 30% to usable

- **Why it's weak.** `core/audio/dsp/key.mjs` correlates chroma with the
  Krumhansl–Kessler and Temperley profiles — both derived from classical
  music. EDM's minor-heavy, drone-heavy harmony is exactly where those fail;
  the measured errors are mostly parallel major/minor, which fits.
- **Step 1 (plain JS, small):** EDM-derived profiles in the style of Faraldo's
  `edma`/`bgate` (median Beatport profile), with detuning correction and
  25–3500 Hz whitening. Take the numbers from the published thesis/papers,
  not Essentia's AGPL code. Re-measure with `scripts/audio-dsp/beatport-eval.mjs`.
- **Step 2 (tiny model):** Deezer's S-KEY exported to ONNX is about **325 KB**,
  24-class softmax from 22.05 kHz mono with the transform inside the graph,
  runs on onnxruntime-web WASM. Published MIREX-weighted scores on GiantSteps
  are around 72 (Korzeniowski's CNN: 74.6 weighted, 67.9% exact). Weights are
  research/non-commercial. Needs a 22.05 kHz decode beside the 16 kHz one.
- **Bar to show key:** ≥ 60% exact *and* ≥ 70% MIREX-weighted on the Beatport
  set; then key (Camelot) joins "mixes with" and DJ order.

### 6.2 Tempo and beats

Tempo is already competitive (published GiantSteps Acc1 at ±4%: 86–90 for the
best CNNs; Betterfy's 80% at ±1 BPM is a stricter test). The remaining errors
are octave errors (31/203). Candidate: **Beat This** (MIT code and weights);
its `small0` checkpoint is ~8 MB, but no ready ONNX export exists — export it,
derive tempo from beats, and use downbeats for section boundaries. TempoCNN is
AGPL; skip it.

### 6.3 Better ears

| Model | Size in the browser | Licence | Plan |
|---|---|---|---|
| Discogs-EffNet (today) | 18 MB | CC BY-NC-SA | Stays the default ear |
| **MAEST via Transformers.js** (`Xenova/discogs-maest-30s-pw-73e-ts`) | **92 MB quantised** (vs the 345 MB Essentia ONNX #90 planned) | CC BY-NC-SA | Re-base #90 on this file; it makes the second ear plausible on desktop. Still behind Deep listen + Wi-Fi + 8 GB, and only kept if it beats effnet on the owner's library by the bar #90 set |
| CLAP `larger_clap_music_and_speech` | 78 MB quantised audio encoder | Apache-2.0 | WP-C2 part 2 as planned: names new genre groups and powers "sounds like" text search |
| MERT, OpenL3, MusiCNN, VGGish | no usable ONNX / weaker | mixed | Skip |

### 6.4 Runtime

- **WebGPU** is now on by default in Chrome (desktop, Android 12+), Safari 26
  (macOS and iOS) and Firefox (Windows; Apple Silicon Macs). Use
  `executionProviders: ['webgpu','wasm']` for MAEST and CLAP, where it should
  pay off; for EffNet, measure first — on a small conv net the copy overhead
  may eat the gain unless patches are batched.
- **Threads** need cross-origin isolation, which GitHub Pages can't send. The
  `coi-serviceworker` trick works but costs a reload, and on Safari it falls
  back to `require-corp`, which would block the Deezer JSONP and un-annotated
  album art. Don't isolate the whole app; if threads are ever needed, isolate
  only a separate listening page fed over `BroadcastChannel`.

### 6.5 Knowledge without keys (checked live)

| Source | Keyless + CORS | Use |
|---|---|---|
| **Discogs search** | Answered **without a token** here (HTTP 200), 25 req/min | Release *styles* are the best scene-genre labels anywhere (UK Garage, Dubstep, Bass Music…). The repo assumes a token is required (`discogs.mjs`); if a browser check agrees, make Discogs styles keyless and first-class for tag gaps |
| **ListenBrainz metadata** (`/1/metadata/artist/?artist_mbids=…&inc=tag`) | yes | Batch MusicBrainz genres/tags without MusicBrainz's 1 req/s limit. Needs MBIDs (Wikidata or ISRC → MBID) |
| ListenBrainz similar artists, Wikidata SPARQL | yes | Already used for the bridge (#95) |
| MusicBrainz ws/2 | yes, 1 req/s | Off unless `MUSICBRAINZ_CONTACT` is set — keep it as the slow fallback |
| Deezer API | keyless, JSONP only | Previews and related artists; its genres are too coarse to use |
| Last.fm | needs a key | Stays an optional extra |
| AcousticBrainz, Every Noise | frozen since 2022 / 2023 | No |

Knowledge ladder for a track's genre, in order: your own filing (sound and
graph) → Discogs styles → MusicBrainz/ListenBrainz genres → Wikidata →
Last.fm if a key is saved. Everything is fetched per account and cached on
the device; the shared tag table stays as it is until the owner rules on
re-keying (HANDOFF §2.3).

### 6.6 Spotify API: things that quietly broke (verified in code)

The February 2026 changes (Development Mode, all apps since 9 March) removed
fields and endpoints the code still uses. ISRC (`external_ids`) was removed
and then restored in March, so listening is safe.

| # | What | Where | Fix |
|---|---|---|---|
| B12 | `DELETE /playlists/{id}/items` is sent a `tracks` body; the reference now documents `items: [{ uri }]`, max 100. `delTracks` also doesn't chunk to 100 | `delTracks` ~1770, ~2836; `actions.mjs:50,118` | Send `items`, chunk by 100, keep `tracks` only as a fallback; test live |
| B13 | `linked_from` and `popularity` were removed from tracks: relinked-track matching stopped silently, and repeat cleanup's "keep the most popular" is now arbitrary | `playlistEntries` ~1746; `FIELDS` 1166, 1177, 1541, 1559; `snapshot.mjs` | Match relinks by ISRC; keep the copy that's in more playlists, then the earliest added |
| B14 | Undoing a playlist creation calls `DELETE /playlists/{id}/followers`, which was removed | `actions.mjs:130` and the page equivalent | `DELETE /me/library` with the playlist URI |

### 6.7 Sources

- Key: Korzeniowski & Widmer, all-convolutional key CNN (arXiv 1808.05340); S-KEY (arXiv 2501.12907, github.com/deezer/s-key, huggingface.co/aaatmy/skey-onnx); Essentia Key/KeyExtractor reference (essentia.upf.edu/reference/std_Key.html); GiantSteps+ EDM key dataset (Zenodo 1101082).
- Tempo: tempo_eval GiantSteps report (tempoeval.github.io); github.com/CPJKU/beat_this; huggingface.co/musetric/beat-this-onnx.
- Models: essentia.upf.edu/models.html; huggingface.co/Xenova/discogs-maest-30s-pw-73e-ts; huggingface.co/Xenova/larger_clap_music_and_speech.
- Runtime: web.dev "WebGPU supported in major browsers" (2025-11-25); onnxruntime.ai WebGPU EP tutorial; github.com/gzuidhof/coi-serviceworker; WebKit bug 230550.
- Knowledge: MusicBrainz rate limiting docs; ListenBrainz API; Discogs API (live request 2026-11-14).
- Spotify: developer.spotify.com Web API changelogs for February, March and May 2026, and the February 2026 migration guide.
- Motion: web.dev "Same-document view transitions are Baseline Newly available" (2025-10-16); developer.chrome.com "What's new in view transitions (2025 update)"; MDN `ViewTransition.types`.

---

## 7. Measurement and guardrails

- **Every smart feature reports its own held-out number on the owner's
  library**, the way #92's Tidy by sound does (caught / false alarms). A
  feature with no number stays behind a flag.
- The Score run gains lines for: queue-order value (share of filings in the
  first 20 cards), batch-file precision (share of "sure" filings later moved
  or undone), Tidy acceptance rate per tier, Discover keep rate.
- Accepted/undone rates are computed from History, on this account only.
- Performance budgets: first render < 1 s on a mid phone with a 5k-track
  library; a screen change < 100 ms to first frame; no long task > 50 ms from
  background jobs while the File screen is open (A3 makes this possible).

---

## 8. Order of work, and how to split it across agents

| Wave | Packages (parallel inside a wave) | Notes |
|---|---|---|
| 0 | Merge #92; close #93/#94/#95/#89; one small bug PR for B1, B2, B4, B5, B12–B14; UI-A | Owner: Score run, rules decision |
| 1 | A1 (one agent, serial) | Byte-identical gate |
| 2 | A2, A3, A5, A6, A7, A8; §5.1 feedback events; §6 key and tempo work (pure `core/` files) | No shared files |
| 3 | A4 per screen (one agent per screen); UI-B, UI-D | Each screen module is its own file |
| 4 | UI-C, UI-E, UI-F, UI-G; §5.2–§5.6 per screen | Owners follow the screen modules |
| 5 | Tune everything from the owner's real numbers; UI-7-style review on the real library | |

Every agent's brief includes: CLAUDE.md, HANDOFF §4, this file's §2.3 rules
decision, its package row, and "touch only your package's files; if you need
a contract change, stop and say so".
