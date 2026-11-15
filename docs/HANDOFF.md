# Handoff — where the audio and genre work stands (2026-11-14)

**Start here.** This is the current state of the work, written for the next
agent. It supersedes the "order of work" in `docs/UPGRADE-PLAN.md`, which
dates from 2026-10-31. The other plan docs are still accurate for their own
areas; the map in "Read next" says which one covers what.

---

## 1. State of the repo

**`main`** has everything up to and including these PRs:
- #82, record v2 with optional MAEST and CLAP ears;
- #84, Deep listen settings;
- #87, the build plan status table.

The audio pipeline (Option B) is merged on `main`:
- listening;
- records;
- the learner;
- the gate;
- the UI layer.

**Open draft PR: [#88](https://github.com/emmachilds98-wq/Betterfy/pull/88)**. Its branch is `claude/gifted-planck-bglamu`. Its body is the full write-up. It holds three things, newest first:

| Part | Commit | What it is |
|---|---|---|
| Sound ID and matching | `e626b69` | Genre › sub-genre › BPM for heard tracks; sound-alikes and "mixes with"; tempo used in filing |
| Sound-first filing | `9f0637e` | Heard tracks are filed by sound; the artist graph learns from genre playlists only |
| CLAP text table (WP-C2 part 1) | `84d5c08`, `69c75d3` | The build-time text table, and the CLAP model id moves to `larger_clap_music_and_speech` |

At handoff, `npm test` gave **1295 pass, 0 fail, 1 skip**. Check #88's CI on its last push before merging.

## 2. Waiting on the owner

1. **Merge #88.** It is a draft; the owner merges, or asks an agent to.
2. **Real numbers.** Every number so far comes from the simulated library or synthetic fixtures. To get real ones:
   - turn on **Listen to my music** and let it hear the default scope;
   - then go to **Engine → Learn my library → Score both engines → Copy results**, and paste the text into an issue or the chat.

   The pasted text includes:
   - "With sound (sound-first…)", which is filing accuracy;
   - "Naming genres by sound", which is genre and sub-genre accuracy, model alone against with the library;
   - tempo fit, and results by genre.
3. Older open questions, still unanswered:
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
| `build-web.mjs` | Bundles `match`/`identify` into `engine.js` as `BetterfyMatch` and `BetterfyIdentify`, and keeps them out of `audio.js` (`ENGINE_SIDE`). The worker's build and validate ops pass `genreGraph`/`soundFirst` and return `identify` |
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
- **Byte-identical when absent.** A card with no sound data must render exactly as before; the UI-4 goldens in `test/webinbox-sound.test.mjs` check this. Put any new slot on the same line as the existing one; a newline breaks the goldens.
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

1. **Tune from the owner's Score run.** Use the numbers from §2 to adjust:
   - `SOUND_FIRST_WEIGHTS` (space.mjs);
   - identify's `SOURCES`, `SPECIFIC` and `MIN_GENRE`;
   - the `TEMPO` ranges.

   "By genre" shows which scenes are weak. Change one thing, re-score, compare.
2. **Tidy by sound.** Flag filed tracks whose sound ID or sound-first placement strongly disagrees with their playlist ("sounds like jungle, sits in House"). `identify` and `placements(…, { soundFirst })` already give everything needed. Done when there is a sound tier on Tidy with the same move and undo flow, it is measured on held-out tracks, and nothing is shown without sound.
3. **Playlist sound profiles.** Show each playlist's genre mix and BPM range on the Playlists screen. `profileRow`/ProfileVM in `web/ui/sound.mjs` already draws heard, BPM, energy and styles. Feed it `identify` results for members, and flag playlists that are two genres by sound.
4. **BPM-aware Shuffle and DJ-set ordering.** Use `tempoRelation`/`mixesWith` to order a playlist so each next track can be beatmatched and sounds close.
5. **WP-C2 part 2: the CLAP audio encoder in the page.** Port `ClapFeatureExtractor` (48 kHz, 64 mel, 10 s) with a parity test. Run `Xenova/larger_clap_music_and_speech` `onnx/audio_model_quantized.onnx` (78 MB) behind #84's opt-in, and store the result with `withEar()`. This switches on WP-C3 naming and search. Details are in AUDIO-BUILD-PLAN §4.
6. **WP-C1: MAEST** as the second ear.
7. **Key detection.** It is 30% exact, so it stays hidden. Improve `core/audio/dsp/key.mjs`, re-measure with `scripts/audio-dsp/beatport-eval.mjs`, and then use key in "mixes with".
8. **Plumbing:**
   - The File screen and the Engine screen each build their own space. Share `SOUND.space` with `ENG.space`.
   - `AUDIO.records` refreshes only at the start and end of a listening run. Refreshing it every so often mid-run would let the File card show newly heard tracks sooner.

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
| `docs/AUDIO-BUILD-PLAN.md` | Packages, §4 status, §5 owner decisions, §7 contract log |
| `docs/AUDIO-ANALYSIS-PLAN.md` | Phase 0 measurements (§0) and external facts (§2) |
| `docs/SMARTER-GENRES-PLAN.md` | The rules (§3), the bridge, calibration, gaps |
| `docs/UI-BUILD-PLAN.md` | Who owns which stylesheet partial; the sound view models |
| `README.md` | "Sound first, once a track has been heard", and "What a heard track is" |
