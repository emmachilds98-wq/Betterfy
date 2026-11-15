# Handoff — where the audio and genre work stands (2026-11-14)

**Build 5 starts from `docs/BUILD-5-PLAN.md`**, which supersedes §6 below.
The rest of this file is still the reference for the sound features.

This is the current state of the work, written for whoever
picks it up next (updated 2026-11-14, end of the sound-everywhere round). It
supersedes the "order of work" in `docs/UPGRADE-PLAN.md`. The other plan docs
are still accurate for their own areas; "Read next" (§8) says which covers what.

---

## 1. State of the repo

**`main`** has all of audio plan B, #88 (sound-first filing, sound ID and
matching, CLAP text table) and the four merged pieces of
`docs/SOUND-EVERYWHERE-PLAN.md`:

| Piece | PR | What it added |
|---|---|---|
| Sound ID and matching | `e626b69` | Genre › sub-genre › BPM for heard tracks; sound-alikes and "mixes with"; tempo used in filing |
| Sound-first filing | `9f0637e` | Heard tracks are filed by sound; the artist graph learns from genre playlists only |
| CLAP text table (WP-C2 part 1) | `84d5c08`, `69c75d3` | The build-time text table, and the CLAP model id moves to `larger_clap_music_and_speech` (since replaced by WP-C2 part 2: LAION's original music checkpoint, which places music better) |
| S1 Tidy by sound + plumbing | #92 | `core/audio/misfit.mjs`; Tidy › By sound (move/undo, "Keep here", held-out caught/false-alarm line); File screen reuses the Engine's space (`soundShareable`/`soundAdopt`); records refresh mid-run (`audioMidRun`) |
| S2 Playlist sound profiles | #93 | `core/audio/plprofile.mjs`; genre mix and BPM range per playlist; "two genres by sound" with a Make-playlist split |
| S3 DJ order | #94 | `core/audio/order.mjs`; Shuffle's tempo- and sound-aware order with an optional energy arc, written to a `🎧` playlist |
| S4 Discover by sound | #95 | `core/audio/discover.mjs`; picks are heard and re-ranked by fit to the seed; sound-led playlist picks; a **keyless** candidate path (Deezer + ListenBrainz neighbours), so Discover no longer needs Last.fm |

At the end of the round `npm test` gave **1355 pass, 0 fail, 1 skip** with
all four merged, and CI was green on main.

**Still open on GitHub:**

| PR / branch | State | What it needs |
|---|---|---|
| S5 key detection v2 (`core/audio/dsp/key.mjs`) | **merged as #106** (`KEY_VERSION` 2.0.0, so records' dsp is re-measured) | EDM-fitted profiles and calibrated confidence: held-out Beatport half 47.2% exact (was 24.8%), MIREX 58.3%, 69.4% exact at confidence ≥0.6 (`scripts/audio-dsp/key-fit.mjs` reproduces it). Still below BUILD-5-PLAN §6.1's bar (≥60% exact and ≥70% MIREX), so key stays hidden and out of `mixesWith`. Next: a separate major/minor decision (tonic is right on ~67%), a non-EDM re-measure, or §6.1 step 2 (S-KEY) |
| #90 MAEST (WP-C1) | draft | The model file is not committed: run `scripts/audio-maest/export.py` on a machine that can reach essentia.upf.edu, add the file, then the owner's MAEST-vs-effnet Score run |
| WP-C2 part 2, CLAP audio encoder | merged (#104) | `core/audio/clap.mjs`: 48 kHz front end (matches `ClapFeatureExtractor` to 1e-4 dB), 77 MB int8 encoder from LAION's original CC0 music checkpoint (the HF `larger_clap_music` upload has an untrained text half; `music_and_speech` places music worse), behind #84's "Search by description". Rebuilding needs `scripts/audio-clap/` and the 2.4 GB checkpoint |
| #41 MusicBrainz/iTunes tag sources | draft, old (2026-09) | Owner's decision (keyless tag sources) |
| #89 UI-6 (paused) | closed: superseded by #81, which merged UI-6 | nothing |
| branch `claude/project-thread-zoqwss` (UI-2) | stale, no PR: superseded by #80 | can be deleted |

Other `claude/*` branches whose PRs are merged are history only.

## 2. Waiting on the owner (needs their machine or library)

1. **Engine Score run on the real library.** Every number so far comes from
   the simulated library or synthetic fixtures. Turn on **Listen to my music**,
   let it hear the default scope, then **Engine → Learn my library → Score both
   engines → Copy results** and paste the text into an issue. It reports
   filing accuracy with sound, genre/sub-genre naming accuracy, tempo fit and
   results by genre. Then also open **Tidy › By sound**: its line gives the
   real caught and false-alarm rates.
2. **Rekordbox tempo/key check.** `scripts/audio-dsp/tempo-vs-rekordbox.mjs`
   and `key-vs-rekordbox.mjs` against the owner's Rekordbox export (needs
   the export file, which lives only on their machine).
3. **MAEST export** for #90 (above).
4. Older open questions, still unanswered:
   - re-keying the shared tag table off Spotify ids (`SMARTER-GENRES-PLAN.md` §3 and §8);
   - PR #41, keyless tag sources;
   - the Release Radar questions (`UPGRADE-PLAN.md` §5).

## 3. What the sound features are, file by file

| File | Does |
|---|---|
| `core/intrinsic/space.mjs` | Builds the engine. Pieces added in #88 are listed below |
| `core/intrinsic/cooccurrence.mjs` | `only`: build the artist graph from chosen playlists only |
| `core/validate/loo.mjs` | `placementAccuracy` with `genreGraph` and `soundWeights`. The sound variant reports `soundFirst: true` |
| `core/ontology/tempo.mjs` | A working BPM range per ontology genre, a half-time set, `tempoFit`, `resolveOctave` |
| `core/audio/match.mjs` | `nearest`, `playlistConcepts` (playlist name → genres), `genreMembership`, `filedNeighbours`, `tempoOf`, `tempoRelation`, `mixesWith` |
| `core/audio/identify.mjs` | `identify(record, { neighbours, tags })` → genre, path, sub-genre, BPM, blend, support, why. Also `identifyAccuracy` and `identifyAccuracyFor` |
| `build-web.mjs` | Bundles `match`/`identify` into `engine.js` as `BetterfyMatch` and `BetterfyIdentify`, and keeps them out of `audio.js` (since A7 by their own `// @bundle engine` line, see `web/bundles.mjs`; it was the `ENGINE_SIDE` list). The worker's build and validate ops pass `genreGraph`/`soundFirst` and return `identify` |
| `docs/app.template.html` | The engine section and the File card. Details below |
| `web/styles/68-soundid.css` | Styles for the File card's "Sounds like" box |

**`core/intrinsic/space.mjs` pieces added in #88:**
- `SOUND_FIRST_WEIGHTS`;
- `placements(…, { soundFirst })`;
- `buildSpace(…, { genreGraph })`;
- `hearMore(space, records)`, which adds rows to the index in place; the learner shares that index;
- the sound-path tempo part: `parts.bpm` is the share of a playlist's heard tracks this one could be beatmatched with.

**`docs/app.template.html`, the `SOUND` section in the engine part:**
- `soundWarm` and `soundBuild` build the sound space when the File screen opens with listening on. The build runs in the worker and is cached under `SPACE_KEY` `engine-space-g`.
- `soundPicks` makes the sound-first picks.
- `soundIdOf` makes the ID, sound-alikes and mixes.

**`docs/app.template.html`, File card (inside the `artHTML`…`vTidy` slice that the tests run):**
- `filePicks`: two sound picks, then the tag engine's best;
- `soundNote`: why the picks are tags, plus the listening prompt;
- `soundIdHTML`: the "Sounds like" box.

**`docs/app.template.html`, Engine screen:**
- the comparison is sound-first, with a sound calibration for heard tracks;
- `calStamp` ends in `/sf`;
- the Score card has `identifyHTML`, and `audioLines` carries the copy lines.

**Tests:**
- `test/soundfirst.test.mjs`: engine-level sound-first behaviour.
- `test/soundid.test.mjs`: tempo, matching, identify, and tempo in filing.
- `test/websoundfirst.test.mjs`: the real built page plus `engine.js` in a `vm` sandbox.

## 4. Rules that bind this work

- **`CLAUDE.md`.** A feature must work for every account from its Spotify library alone: no keys, no exports, no installs.
- **Spotify terms (`SMARTER-GENRES-PLAN.md` §3).**
  - **R1:** no Spotify content into an ML model.
  - **R2:** nothing pooled across accounts.
  - **R3:** lookups and counts on your own library, shown back to you, are fine.

  The sound ID and matching work is nearest-neighbour lookups and counts only. Keep it that way.
  The sound learner in the page and its worker is prototypes only (`model: 'prototype'`, set in
  `engineAudioIn` and the worker's `prototypesOnly`; BUILD-5-PLAN §2 item 3, option b): each playlist's
  sound is the average of the account's own heard tracks in it, moved by accepts and rejects. No
  regression is fitted to playlist membership in the hosted app. Logistic regression stays in
  `audio-learn.mjs` (default `model: 'auto'`) for offline scripts and tests only.
- **Byte-identical when absent.** A card with no sound data must render exactly as before; the UI-4 goldens in `test/webinbox-sound.test.mjs` check this. The goldens compare through `test/golden.mjs` (`assertSameHTML`), which ignores line-broken formatting whitespace next to tags (BUILD-5-PLAN A8), so a new slot no longer has to sit on the same line as the existing one. Words, tags, attributes and single spaces between inline tags still have to match.
- **Frozen contracts.** `core/audio/mel.mjs` and `record.mjs` are frozen. A change goes in its own PR, with a line in `docs/AUDIO-BUILD-PLAN.md` §7.
- **Generated files.** `docs/index.html`, `docs/engine.js`, `docs/engine-worker.js` and `docs/audio.js` come from `node build-web.mjs`. On a merge conflict, rebuild them; never hand-merge.
- **Gate overridden.** Sound now leads filing ahead of the WP-E2 gate, by the owner's decision (AUDIO-BUILD-PLAN §5, 2026-11-14). The gate is still measured and shown.

## 5. How to work on it

| Task | Command or note |
|---|---|
| Build | `node build-web.mjs` |
| All tests | `npm test`, about 5 minutes. To get a list of failures: `node --test --test-reporter=tap > out.txt` |
| Screenshot every screen offline | `npm run shots`. It rebuilds with `--allow-missing-id`, so run `node build-web.mjs` again afterwards |
| Page tests | They slice the built `docs/index.html` and run the slice in `vm` with stubs |

When writing page tests, the sandbox needs:
- `atob`/`btoa`, or records can't be unpacked;
- `isMirrorPlaylist`;
- `TAGS`.

## 6. Next work, ranked

1. **Tune from the owner's Score run** (§2.1). Change one thing, re-score, compare:
   - `SOUND_FIRST_WEIGHTS` (space.mjs); identify's `SOURCES`, `SPECIFIC`, `MIN_GENRE`; the `TEMPO` ranges;
   - Tidy by sound's `MISFIT` thresholds (misfit.mjs), against its caught/false-alarm line;
   - playlist splits' `SPLIT_*`/`NEAR_GAP` (plprofile.mjs); Discover's 60/40 sound/artist blend (discover.mjs).
2. **Key detection (S5)**, see §1. Then key in `mixesWith` and the DJ order.
3. ~~**WP-C2 part 2: the CLAP audio encoder in the page.**~~ Done (#104): `core/audio/clap.mjs` behind #84's "Search by description" switch, table and encoder from LAION's original music checkpoint (AUDIO-BUILD-PLAN §4, §7). WP-C3 naming and search draw on it once emma ticks it.
4. **WP-C1: MAEST** (#90), after the export.
5. **Show the held-out measures together.** Tidy by sound, splits and Discover's fit each measure themselves on the account's own tracks; the Engine Score card could list them beside filing and naming accuracy.
6. Built in this round (for reference): Tidy by sound, playlist profiles, DJ order, Discover by sound and keyless Discover, a shared sound space, mid-run record refresh.

## 7. Known limits

- **Library votes need genre names.** They only come from genre playlists whose names resolve to a genre (`playlistConcepts`). "Bangers" says nothing, so a scene with no named playlist falls back to the model's broader label.
- **The sound model is weak on scene genres** (29% top-1 in phase 0). That is why it never names a genre alone.
- **Tempo** is 86% within ±1 BPM at confidence ≥ 0.3 on the Beatport set. Half/double-time readings are settled by genre, and wrong when the genre is wrong.
- **What has been measured, and on what:**
  - the genre-only artist graph: top-1 39.4% → 67.1% on the simulated library;
  - everything else: synthetic fixtures only.

## 8. Read next

| Doc | Covers |
|---|---|
| `docs/SOUND-EVERYWHERE-PLAN.md` | The S1–S5 round: what each piece owns and does |
| `docs/AUDIO-BUILD-PLAN.md` | Packages, §4 status, §5 owner decisions, §7 contract log |
| `docs/AUDIO-ANALYSIS-PLAN.md` | Phase 0 measurements (§0) and external facts (§2) |
| `docs/SMARTER-GENRES-PLAN.md` | The rules (§3), the bridge, calibration, gaps |
| `docs/UI-BUILD-PLAN.md` | Who owns which stylesheet partial; the sound view models |
| `README.md` | "Sound first, once a track has been heard", and "What a heard track is" |
