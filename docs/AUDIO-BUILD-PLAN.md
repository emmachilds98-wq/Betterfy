# Audio — build plan for parallel agents (Option B, then C)

The owner chose **Option B, "learn from your playlists"**, followed by **Option
C, the laptop-only "deep listen"** (`docs/AUDIO-ANALYSIS-PLAN.md` §0). This file
breaks that into **work packages** that separate agents can build at the same
time without colliding. Each package has an owner file set, a contract it
builds against, tests that prove it, and the packages it waits for.

Read before starting any package: `CLAUDE.md`,
`docs/AUDIO-ANALYSIS-PLAN.md` (§0 for the measured facts, §2 and §7 for the
rules), and the handoff, issue #53.

---

## 0. Ground rules every package follows

1. **Contracts first, frozen.** `core/audio/mel.mjs` and
   `core/audio/record.mjs` are done and tested. Build against them; don't
   edit them inside another package. A contract change is its own PR: bump
   the version constant and add a line to §7 of this file.
2. **Own your files.** Touch only the files your package lists. Shared files
   (`docs/app.template.html`, `build-web.mjs`, `core/intrinsic/space.mjs`)
   each have exactly one owning package. Anyone else asks that package's
   agent, or waits for its PR to merge.
3. **Optional all the way down.** With no audio records, every existing
   output is **byte-identical**. Each package touching the engine writes that
   test first.
4. **Never store audio. Never cache a preview URL** (signed, ~15 min). **ISRC
   or nothing**: phase 0 saw a name match pick the wrong track 1 time in 19.
5. **No paid services, no AGPL in the page, no server.** Models are
   self-hosted under `docs/models/` with their CC BY-NC-SA licence file. The
   owner confirmed a free, non-commercial build.
6. **No Spotify content into a model.** Only Deezer audio goes in. Spotify
   supplies the ISRC and the owner's own playlist structure, which is what
   the learner learns from, not audio.
7. **Measured or it doesn't ship.** Anything that changes a suggestion passes
   the gate in WP-E2 on the owner's real library first.
8. **Tests:** `npm test` green before and after. After editing
   `docs/app.template.html`, run `node build-web.mjs` before testing.
   Engine changes also run `npm run validate:placement` where it applies.
9. **Branches and PRs:** one branch per package, `claude/audio-<wp-id>`, and
   one draft PR to `main` per package, squash-merged. Rebase-free: merge
   `main` in when needed.

---

## 1. Dependency map

```
DONE: WP-0a mel.mjs        WP-0b record.mjs        WP-0c phase-0 scripts
        │                        │
Wave 1 (parallel, no shared files):
  WP-A1 fetch.mjs   WP-A2 decode     WP-A3 infer.mjs   WP-A4 queue.mjs
  WP-D1 dsp/tempo   WP-D2 dsp/key    WP-D3 dsp/loudness
  WP-F1 heads (mood/voice/dance)     WP-V1 audio-vocab.mjs
        │
Wave 2:
  WP-B1 worker.js (A1+A2+A3 → record)       WP-E1 intrinsic/audio.mjs (record → scores)
  WP-L1 learn.mjs (per-playlist classifier)  WP-H1 sections.mjs (hybrids)
        │
Wave 3 (each owns one shared file):
  WP-B2 page wiring + store + settings UI   [owns docs/app.template.html, build-web.mjs]
  WP-E2 space wiring + with/without score   [owns core/intrinsic/space.mjs, core/validate/*]
        │
Wave 4:
  WP-H2 hybrid & cluster proposals on New playlists   WP-S1 v3 provider (audio.mjs)
  WP-D4 DSP into records + UI               WP-L2 learning from accept/reject feedback
        │
Option C (after B ships and is measured):
  WP-C1 MAEST laptop path   WP-C2 CLAP build-time text table   WP-C3 cluster naming + text search
```

A package can start as soon as everything above it in its own chain is
merged. Wave 1 is **nine packages with no shared files**, the main place
where several agents pay off.

---

## 2. Work packages

Each entry gives: **files** it owns · **contract** · **done when** ·
**waits for**. Sizes are rough: S under half a day, M about a day, L 2–3 days.

### Wave 1

**WP-A1 Deezer fetch, `core/audio/fetch.mjs` (M)**
- Contract:
  - `lookup(isrc, { jsonp })` returns `{ deezerId, previewUrl, durationMs, readable }`, or a `MISS` reason. `jsonp` is injected; the page passes its existing `deezerJsonp` (`docs/app.template.html`), and tests pass a fake.
  - `identityOk(deezerDurationMs, spotifyDurationMs)` allows up to ±3 s.
  - `windows(byteLength)` returns two ranges of 165,000 bytes: one at the start and one centred.
  - `fetchWindows(url, ranges, { fetch })` returns `ArrayBuffer[]`.
  - Expects `206`; on a `200` it slices the body itself and records that it did.
- Done when there are tests for a hit, `{error}`, `readable:false`, no preview, a duration mismatch, a 200 instead of 206, and a network failure (`FAILED`, never cached). There's no network in tests.
- Waits for: nothing.

**WP-A2 Decode to 16 kHz mono, `core/audio/decode.mjs` (M, judgement-heavy)**
- Contract: `decodeTo16k(arrayBuffer, { audioContextCtor })` returns a 16 kHz mono `Float32Array`, using `decodeAudioData` and an `OfflineAudioContext` resample.
- **Risk:** this is the one step phase 0 didn't prove. A partial byte range must decode; MP3 frames resync after a cut, but check it.
- Done when a Playwright test in Chromium decodes a committed **synthetic** MP3 (generate it with ffmpeg from the `synth()` signal, a few KB) and the mel of the result matches Essentia's MonoLoader path within a stated tolerance. Then feed both through the model, or the recorded fixture, and show the top-5 styles agree. Record the numbers in `AUDIO-ANALYSIS-PLAN.md` §0.
- Waits for: nothing.

**WP-A3 Inference, `core/audio/infer.mjs` (S)**
- Contract: `createEar({ ort, modelUrl })` returns `{ run(patchData, patches) → { activations, embeddings } }`. `ort` is injected (onnxruntime-web in the page, onnxruntime-node in scripts and tests). It batches at most 16 patches per run to cap memory on phones.
- Done when a test with a **fake** `ort` session checks the shapes and batching. An optional Node test skips unless `BETTERFY_MODEL_DIR` is set and checks the real model on the synthetic signal. CI stays model-free.
- Waits for: nothing.

**WP-A4 Priority queue, `core/audio/queue.mjs` (M)**
- Contract: `audioQueue(lib, { listening, filedIds, untaggedArtistIds, store, budget, exemplarsPerPlaylist = 20 })` returns ordered Spotify ids. The order is:
  1. Tracks being played: top artists and recently-played, weighted by `byListening`.
  2. Unfiled liked songs.
  3. Tracks by untagged artists.
  4. Up to 20 exemplars per **genre** playlist, so every playlist gets a sound fingerprint early.
  5. Everything else.
  It skips ids whose stored record `isCurrent()`. It's pure: it takes data, not fetches.
- Done when there are tests for ordering, dedupe, skipping current records, re-queueing stale ones, and budget truncation.
- Waits for: nothing.

**WP-D1 Tempo, `core/audio/dsp/tempo.mjs` (L, judgement-heavy)**
- Our own BPM estimator: onset strength (spectral flux, from `mel.mjs` frames or its own STFT), then autocorrelation or comb filter, then a tempo with a confidence. **Report octave ambiguity** (85/170, 87/174) instead of averaging it away; `music-dna.mjs`'s `measured()` already treats half/double-time as the failure that matters.
- Done when synthetic click tracks at known BPMs come out right within ±1 BPM. A script compares against `rekordbox.json` where the owner has it and records the accuracy in §0. It ships only with a measured number.
- Waits for: nothing (uses `mel.mjs` constants).

**WP-D2 Key, `core/audio/dsp/key.mjs` (L, judgement-heavy)**
- Chroma from STFT, Krumhansl or Temperley profiles, key plus confidence plus Camelot. Same evidence bar as D1, checked against Rekordbox.
- Waits for: nothing.

**WP-D3 Loudness and energy, `core/audio/dsp/loudness.mjs` (S)**
- RMS and short-term loudness (an EBU-style approximation), spectral centroid and onset density, combined into an `energy` 0–1. Described honestly as a heuristic.
- Waits for: nothing.

**WP-F1 Extra heads (M)**
- These run on the effnet embedding:
  - `mtg_jamendo_moodtheme`: 56 classes, 2.7 MB.
  - `voice_instrumental`: 0.5 MB.
  - `danceability`: 0.5 MB.
  - `approachability`, `engagement`: optional.
- Files: `core/audio/heads.mjs`, plus a contract `HEADS = { name: { file, classes, outKey } }`.
- Done when a fake-session test checks shapes, and the mood labels have a **reviewed static mapping** to the ontology. `resolveConcept()` mis-maps them (`holiday`→`summer`), per §2 of the analysis plan.
- Waits for: WP-A3's interface (not its merge; the interface is fixed above).

**WP-V1 Style vocabulary, `core/sources/audio-vocab.mjs` (M)**
- A reviewed static table from all 400 `Genre---Style` labels to ontology concepts. 198 resolve today; review the rest by hand. The labels are **hints and names**, not verdicts: phase 0 measured them at 29% top-1 on scene genres.
- Done when there's a test that every label maps to a concept or an explicit `null`, and the scene styles (Donk, Bassline, Speed Garage, UK Garage, Jungle, Grime, Hard House, Juke) map to the scene concepts from #46.
- Waits for: nothing.

### Wave 2

**WP-B1 Worker, `core/audio/worker.js` (M)**
- Glue: queue id → `lookup` → `fetchWindows` → `decodeTo16k` → `melFrames` → `melPatches` → `ear.run` → heads → `makeRecord` (or `makeMiss`) → `postMessage`. It runs one track at a time and stops cleanly. It owns no storage; the page owns IndexedDB.
- Done when the worker logic is factored into a pure `analyseOne(deps, track)` with a test where every dependency is faked, including each `MISS` path, and audio buffers are dropped after use.
- Waits for: A1, A2, A3 (F1 optional).

**WP-E1 Audio component, `core/intrinsic/audio.mjs` (M, judgement-heavy)**
- Mirrors `bonus-rekordbox.mjs`:
  - `audioIndex(records)`
  - `audioProfileOf(playlistTrackIds, index)`, a centroid of unpacked embeddings with a member count
  - `audioScores(track, space)`, cosine to each destination's centroid, or `null` when the track or destination has no audio
  A destination with fewer than `MIN_DEFINITION_TRACKS` analysed members scores `null`, never 0.
- Done when the unit tests pass and the **byte-identical test** passes: `buildSpace`/`placements` with `audio: null` produce identical JSON to `main`.
- Waits for: record.mjs (done). It does **not** edit `space.mjs`; WP-E2 wires it in.

**WP-L1 Learner, `core/intrinsic/audio-learn.mjs` (L, judgement-heavy)**
- The part that makes it "learn". It takes the account's own genre playlists' analysed members and trains, in the browser, in milliseconds:
  1. prototypes (centroids) as the baseline phase 0 measured: 58% top-1, 76% top-2 from 9 examples
  2. a small multinomial logistic regression on the embeddings, with L2 regularisation, a class-balanced loss and early stopping on a held-out fold.
- Both must be beaten honestly. `learnedScores(track)` returns per-playlist probabilities that `calibrate.mjs` can turn into the HIGH/LIKELY/AMBIGUOUS bands.
- Done when a test on a synthetic separable/non-separable embedding set passes, and the cross-validated accuracy on the phase 0 fixture is reported. The scripts can export embeddings, never audio. It must report learning curves at 5, 10, 20 and 40 examples per playlist.
- Waits for: E1's `audioIndex`.

**WP-H1 Sections, `core/audio/sections.mjs` (S)**
- `sectionsOf(record)` returns runs of consistent top styles over time. `isHybrid(record)` holds when two styles each lead at least 30% of sections, or the overall top two are within a margin. Phase 0 saw section agreement from 17% to 100%.
- Waits for: record.mjs (done).

### Wave 3 (each owns one shared file; run these two in parallel)

**WP-B2 Page wiring, owning `docs/app.template.html` and `build-web.mjs` (L)**
- IndexedDB store `audio_v1` keyed by Spotify id, with `validRecord` on read.
- `onnxruntime-web` pinned (`1.31.1`, from jsDelivr), with the WASM backend only and single-threaded, because GitHub Pages can't set COOP/COEP.
- Models under `docs/models/` plus a `LICENSE` and an attribution line in the UI.
- A settings panel under Playlists → Genre data:
  - "Listen to my music" on/off
  - Wi-Fi only, defaulting to on, using `navigator.connection` where it exists and otherwise asking
  - scope, defaulting to "what I'm playing + unfiled"
  - Stop
  - progress
  - **"N tracks couldn't be heard"**, with reasons grouped by `MISS`
- Adds the `core/audio/*` and `core/intrinsic/audio*.mjs` modules to the bundle list in `build-web.mjs`.
- Done when the `test/web*.test.mjs`-style tests cover store round-trip, the settings default, and a run that stops mid-queue and resumes. A real-browser smoke run (Playwright) analyses 3 tracks end to end from a local preview fixture.
- Waits for: B1, A4.

**WP-E2 Engine wiring and the gate, owning `core/intrinsic/space.mjs`, `core/validate/*` and the Engine screen's Score card text (M)**
- Adds `audio` and `learned` to `WEIGHTS`, passes `audio` through `buildSpace`, and bumps `SPACE_VERSION`.
- `placementAccuracy(lib, { audio })` runs **with and without** audio on the same folds, including the never-filed-artist subset, through `calibrate.mjs`.
- The Score card and Copy results show both.
- **Gate (from the handoff):** at least +5 points top-1 on never-filed artists and no loss overall, on the owner's real library. Until the owner's Score run shows that, audio is computed and shown but **does not change a suggestion**.
- Done when the byte-identical test and the with/without test pass, and the gate logic is unit-tested.
- Waits for: E1, L1.

### Wave 4

- **WP-H2 Hybrid and cluster proposals** (in #50's "New playlists" code, which this package owns for its duration):
  - Ambiguous top-2 placements turn into a "pick one of these two" offer.
  - A tight embedding cluster between two playlists becomes a "hybrid playlist" proposal, named from its top two styles (via V1).
  - A tight cluster near no playlist becomes "new genre?", unnamed until C3.
  - Waits for: E2, H1, V1.
- **WP-S1 v3 provider** `core/sources/audio.mjs`, as in `AUDIO-ANALYSIS-PLAN.md` §4.1: track-level evidence, independence group `audio-model`, labels via V1, and the byte-identical-without test. Waits for: V1.
- **WP-D4 DSP into records and the UI:**
  - Add `dsp` to `makeRecord` (the field already exists; fill it).
  - Show BPM and key with confidence, and say "half/double-time unsure" when it is.
  - Waits for: D1–D3 to pass their accuracy bars, plus B2.
- **WP-L2 Learning from feedback:** accepted or rejected suggestions and corrections (#51's synced feedback) become positive or negative examples for L1, so the learner improves with use. Waits for: L1, E2.

### Option C (start only after B has shipped and E2's numbers are in)

- **WP-C1 MAEST, laptop path:**
  - A 345 MB ONNX download, only on an explicit opt-in, on Wi-Fi, on a device with `navigator.deviceMemory ≥ 8` (or the owner overriding).
  - Runs as a second ear: better style labels and a 768-d embedding.
  - Measured with the same with/without harness. It ships only if it beats B's ear on the owner's library.
- **WP-C2 CLAP text table at build time:**
  - `laion/larger_clap_music` (Apache-2.0) runs **only in a build script**, embedding a reviewed list of genre and description prompts into a small JSON table shipped with the page.
  - The page downloads only CLAP's quantised **audio** encoder (~78 MB), on opt-in.
- **WP-C3 Naming and text search:**
  - Unnamed clusters from H2 get CLAP's nearest prompt as a suggested name ("phonk?", "jersey club?"), which the owner confirms.
  - "Find tracks that sound like *dark rolling bassline*" runs as search over the library's CLAP audio embeddings.

---

## 3. How to split this across agents

- **One coordinator agent** (Opus 5.5, high effort):
  - owns this file
  - reviews every package PR against §0 and its "done when"
  - merges `main` into package branches
  - is the only one who edits contracts
- **Wave 1: up to nine worker agents at once.** A1, A2, A3, A4, D1, D2, D3, F1 and V1 share no files.
- **Waves 2–4: three or four agents.** Wave 3's two packages each own a shared file, so B2 and E2 can run together, but not with anything else touching those files.
- Every agent's first message should include the package ID, its §2 entry, §0, and this sentence: *"Touch only your package's files; if you need a contract change, stop and say so."*

### Model effort per package

| Effort | Packages | Why |
|---|---|---|
| **High** | A2 decode parity, D1 tempo, D2 key, E1 audio component, L1 learner, E2 wiring and gate, C1 MAEST | numerical correctness, judgement, or gate logic, where a plausible-looking mistake silently degrades every answer |
| **Medium** | A1 fetch, A3 infer, A4 queue, D3 loudness, F1 heads, V1 vocab table (with high for the final review), B1 worker, H1 sections, B2 page wiring, H2 proposals, S1 provider, D4, L2, C2, C3 | well-specified plumbing against a fixed contract, with tests that catch mistakes |

The coordinator's review is at high effort whatever the package used.

---

## 4. Status

| Package | State |
|---|---|
| WP-0a `core/audio/mel.mjs` | **Done.** Worst error 2.1e-4 vs Essentia, frame rule pinned at 13 lengths, 38 ms per 30 s preview (#54) |
| WP-0b `core/audio/record.mjs` | **Done.** Contract plus 6 tests: int8 embedding cosine > 0.999, ~2.5 KB per record with two windows (~4 KB with a full preview's section timeline) (#54) |
| WP-0c phase 0 scripts | **Done**, `scripts/audio-phase0/` (#54) |
| WP-V1 vocab | Built, #55. Review: OK |
| WP-A1 fetch | Built, #56. Review: OK; preview URL never kept |
| WP-A3 infer | Built, #57. Review: OK (header patch count corrected) |
| WP-H1 sections | Built, #58. Review: OK |
| WP-F1 heads | Built, #59. Open: check each head's class order against its model JSON when the models are hosted (WP-B2) |
| WP-A4 queue | Built, #60. Review: OK; adds optional `targets`, `isMirror`, `now` |
| WP-B1 worker | Built, #61. Note for WP-D4: DSP and mel run on the two windows joined, so run tempo/key per window |
| WP-E1 audio component | Built, #62. Review: OK; byte-identical test passes |
| WP-D3 loudness | Built, #63. Energy weights hand-picked; check on real previews in WP-D4 |
| WP-D2 key | Built, #65. Synthetic only; not into records until the Rekordbox run is in §0 |
| WP-S1 provider | Built, #66 (stacked on #55). Review: OK; engine byte-identical hash pinned |
| WP-A2 decode | Built, #67. Reference is ffmpeg (Essentia not installable); top-5 through the model not run yet |
| WP-D1 tempo | Built, #68. Synthetic only; not into records until the Rekordbox run is in §0 |
| WP-L1, WP-E2, WP-B2 | In progress (2026-11-14), one thread each; B2 builds on UI-0 (#64) |
| Everything else | Not started |

All 13 built branches merged together pass the full suite (1042 pass, 1 skip), 2026-11-14.

## 5. Owner decisions recorded

- 2026-11-14: **Option B, then C.** Free and non-commercial: the CC BY-NC-SA model licence is accepted on that basis. No paid services.
- Default scope (proposed, confirm in WP-B2's PR): Wi-Fi only, "what I'm playing + unfiled", about 330 KB per track.

## 6. Done means

B is done when WP-E2's gate has run on the owner's real library and either:
- passed, so audio changes suggestions; or
- failed, and the numbers are in §0 of the analysis plan with audio left as display-only.

C is done when C1–C3 have each been measured the same way.

## 7. Contract change log

- `mel.mjs` 1.0.0: initial.
- `record.mjs` v1: initial.
