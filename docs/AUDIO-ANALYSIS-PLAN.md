# Audio analysis — plan for v3 phase 5

Status: **plan only, nothing built.** Every external fact below was checked
from a live request on 2026-10-31 unless it says otherwise. Where a number is
a guess, it says that too.

---

## 1. What this adds, and why it is worth adding

Almost everything the v3 engine knows about a track today is about its
**artist**. Last.fm and Discogs both answer per artist, and the engine is
careful to weight that as contextual rather than canonical
(`SPECIFICITY['artist']` in `core/evidence/weights.mjs`). The only track-level
genre signal is the optional `enrich-lastfm-tracks.mjs` cache, which is
sparse. So the engine is weakest exactly where filing is hardest: an artist
who makes both house and techno, a compilation, a one-off remix.

Audio analysis is the one source that answers **per recording, from the
recording itself**. That makes it the single biggest gap in the provider
table (`docs/ENGINE-V3-ARCHITECTURE.md` §1 lists phase 5 as *not started —
the provider interface exists, no provider does*).

### How it sits under CLAUDE.md's rule

It passes the universality test. It needs **no export, no desktop app, no API
key and no token**. The audio comes from a public 30-second preview, looked
up by the ISRC Spotify already gives every track (§2). The model runs in the
listener's own browser.

It is still scoped as an **opt-in enrichment, not infrastructure**, because
it costs the listener real bandwidth and CPU (§6) and depends on a third
party's preview catalogue. Concretely:

- With no audio cache, every output of the engine is byte-identical to today.
  The test for that is written first (§8, phase 1).
- It fills and sharpens. It never gates. No filing, tagging or misfile
  decision may require an audio record to exist.
- It starts when the listener presses a button. It is never a background
  download on page load.

Spotify itself has nothing to offer here. `/audio-features` is `403`, and
Spotify's own `preview_url` is null for apps registered after Nov 2024,
which includes every "use your own Spotify app" registration the hosted page
steers people to. So the audio does not come from Spotify.

---

## 2. Verified facts this plan rests on

| Fact | How checked | Consequence |
|---|---|---|
| `GET api.deezer.com/2.0/track/isrc:{ISRC}` returns the track with a `preview` MP3 URL, no key | live request | ISRC → audio with **exact identity** (`LINK_CONFIDENCE['isrc']` = 0.98) |
| That API sends **no** `access-control-allow-origin` | response headers with an `Origin` | a browser `fetch` is blocked. Use `?output=jsonp&callback=…` instead, which works (200, `text/javascript`). The hosted page has no CSP, so a `<script>` tag is allowed |
| The preview MP3 (`cdnt-preview.dzcdn.net`) sends `access-control-allow-origin: *` | response headers | the browser can `fetch` it and `decodeAudioData` it |
| Preview URLs are signed (`hdnea=exp=…`) and expire **~15 minutes** after lookup | decoded the `exp` against the lookup time | never cache the URL. Look up and download in the same pass |
| One preview is ~480 KB (479,827 bytes measured) | download | §6 bandwidth estimate |
| iTunes Search (`itunes.apple.com/search`) and its previews both send `access-control-allow-origin: *`; `lookup?isrc=` returned nothing | live request | a possible fallback, but by **name match only** (`name-fuzzy`). Not in phase 1 |
| `discogs-effnet-bsdynamic-1.onnx` (18.0 MB) takes `[n,128,96]` mel patches at 16 kHz and outputs **both** 400 Discogs-style sigmoids **and** a 1280-d embedding | model metadata JSON | one model gives genre *and* a similarity vector. No separate genre head is needed |
| The separate `genre_discogs400-discogs-effnet-1` head is `.pb` only | model index | irrelevant, because the backbone above already includes those 400 outputs |
| ONNX heads on the effnet embedding: `mtg_jamendo_moodtheme` (56 classes, 2.7 MB), `voice_instrumental`, `danceability`, `tonal_atonal`, `mtg_jamendo_instrument`, `mtg_jamendo_genre`, `approachability`, `engagement` | model index | mood and voice come from small heads on the same embedding, without running the backbone twice |
| Arousal/valence heads (`deam`, `emomusic`, `muse`) exist **only** for musicnn/vggish backbones, not effnet | model index | `energy`/`valence` would need a second backbone. Deferred (§9) |
| `essentia.upf.edu` sends **no** CORS header on model files | `HEAD` with `Origin` | models must be self-hosted (§5.4) |
| Essentia models are **CC BY-NC-SA 4.0** | models page | redistributing them needs attribution and non-commercial share-alike (§7) |
| `essentia.js` is **AGPL-3.0**, last published 2022 (0.1.3) | npm | do not ship it in an MIT project's page. Write the mel front-end in plain JS (§5.2) |
| `onnxruntime-web` is MIT, currently 1.31.1 | npm | the inference runtime |
| **198 of the 400** style labels already resolve to a genre concept through `resolveConcept()`; 69/106 of the Electronic ones | ran the ontology over the label list | half the vocabulary is free. The rest needs a curated table (§4.2) |
| **29 of the 56** mood/theme labels resolve, some wrongly (`holiday`→`summer`, `christmas`→`winter`) | same | mood mapping must be a reviewed static table, not `resolveConcept()` at runtime |

**Not yet measured, and the reason phase 0 exists:**

- Deezer's ISRC coverage of a real library. This is the GetSongBPM lesson:
  it looked fine and covered 20% (README, *Data sources*).
- Inference time per preview with `onnxruntime-web` WASM on a mid-range
  phone and a laptop.
- Whether a mel front-end in JS matches Essentia's `TensorflowInputMusiCNN`
  closely enough that the model's outputs don't drift.

---

## 3. Pipeline

```
Spotify track (id, isrc)                        — already in LIB / library.json
  → Deezer JSONP  track/isrc:{isrc}             — identity check (§4.1)
  → fetch preview MP3                           — CORS-open, signed, 15-min URL
  → decodeAudioData → mono → 16 kHz             — OfflineAudioContext resample
  → log-mel [n,128,96]                          — core/audio/mel.mjs (§5.2)
  → discogs-effnet  → styles[400], emb[1280]    — onnxruntime-web, in a Worker
  → heads(emb)      → moodtheme[56], voice[2]   — same session, tiny
  → AudioRecord (compact, §4.3)                 — stored, keyed by Spotify id
  → core/sources/audio.mjs toEvidence()         — pure, fixture-tested
```

The raw audio is discarded as soon as it has been analysed. Only the record
is kept.

---

## 4. v3 integration — the part with the judgement in it

### 4.1 Provider declaration — new `core/sources/audio.mjs`

Same split as `discogs.mjs` and `lastfm.mjs`: a `defineProvider()`
declaration, pure mapping functions, and a separate thin fetch.

```js
export const AUDIO = defineProvider({
  id: 'audio-effnet',
  version: '3.0.0',            // bump on any mapping-table or threshold change
  capabilities: ['genre', 'mood', 'voice', 'similarity'],
  entityTypes: ['track'],
  reliability: 0.6,            // prior only; replaced by the phase-2 benchmark
  independenceGroup: 'audio',
  optional: true,
  requires: 'nothing — runs in your browser on 30-second previews',
});
```

- **Independence.** The model was trained on Discogs editorial labels, so it
  shares Discogs' *vocabulary*. It does not share its *evidence*: it hears
  this recording, while the Discogs provider reads the artist's discography.
  Their errors are different, so it gets its own group. This is the one call
  in this plan most worth re-checking against the benchmark. If audio and
  Discogs agree far more often than chance on tracks where Discogs is
  *wrong*, merge the groups.
- **Identity.** `matchedBy: 'isrc'` only when Deezer's returned `isrc` equals
  the one asked for **and** `|duration − duration_ms/1000| ≤ 3 s`. Otherwise
  discard the record; don't keep it at lower confidence. `readable: false`
  (region-blocked) means no record.
- **Entity type** is `track`, keyed by the Spotify track id. This is the
  whole value of the source, so it must not be averaged up to the artist in
  v3.

### 4.2 Mapping — new `core/sources/audio-vocab.mjs`

The model's vocabulary is **fixed**: 400 styles and 56 mood/theme labels,
the same for every listener. So it maps through a static table that is
reviewed once, not through runtime resolution:

- `STYLE_MAP`: `"Electronic---Jungle"` → genre concept. Seed it from
  `resolveConcept()` (198/400 today), then hand-fill the rest. A style with
  no concept falls back to its parent (`Electronic` → `electronic`) at
  `sourceReliability` 0.5, the same discount `discogs.mjs` gives Discogs'
  coarse `genre` field.
- `MOOD_MAP`: the 56 Jamendo labels → `MOODS`/`CONTEXTS` concept or `null`.
  Many are film-library themes (`trailer`, `corporate`, `documentary`,
  `advertising`) and should map to `null` on purpose.
- **Unmapped labels must not reach `unknownConcepts()`.** Otherwise every
  listener's review queue fills with 200 model labels that are the same for
  everyone. Gaps in this table are a code review question, not a personal
  one. A test asserts every label has an explicit entry, including the
  explicit `null`s.

`toEvidence(record)` turns the record into `evidence()` records through
`normaliseValues()`, with the top-k sigmoid as the "count". It keeps only
labels above a threshold (a declared prior, swept in phase 2), at most
`MAX_STYLES` (10), like Discogs. `voice_instrumental` → field `voice`.

### 4.3 The stored record

```js
{ v: 1, model: 'discogs-effnet-bsdynamic-1', heads: {...versions},
  isrc, deezerId, analysedAt,
  styles: [[label, p], ...top 10],   // not all 400
  moods:  [[label, p], ...top 8],
  voice:  p_voice,
  emb:    Int8Array(1280) as base64, // ~1.7 KB, quantised, scale stored
}
```

That is about 2 KB per track, so 2,000 tracks come to about 4 MB in
IndexedDB. Storing raw scores rather than evidence means a mapping-table
change re-maps every track **without re-downloading or re-running
anything**. This is the §29 reclassify-don't-trust property, and
`AUDIO.version` stamps it.

### 4.4 Engine wiring — `core/engine.mjs`

- `buildRegistry({ …, audio = false })` registers `AUDIO` when present.
- `indexCaches({ …, audio = null })` builds a **per-track** map, unlike the
  three per-artist ones. Add `present.audio`.
- `buildEvidence()` adds `audio.get(track.id)` beside the existing
  `trackTags` block. It's track-level evidence, so it already outranks
  artist clouds on specificity, with no special case.
- `musicProfile()` (`core/analysis/music-dna.mjs`) needs no change for
  genre/mood. `voice` is not in `MEASURED_FIELDS` and should stay a concept
  field.

### 4.5 Similarity — `core/recommend/similarity.mjs`

`musicDNA()` gains an optional `audio` field (the embedding). It's absent,
not zeroed, when there is no record, which is the module's own rule.
`compare()` blends `dnaSimilarity()` with the embedding cosine **only when
both sides have one**, and reports `basis: 'audio'` when it did, so the
review UI can say why. This also attacks `SHARED_CLOUD_DISCOUNT`'s problem
directly. Two tracks by one artist stop looking identical, because their
embeddings differ.

The blend weight is an undeclared prior until
`npm run benchmark:playlists` sweeps it (phase 4).

---

## 5. Runtime

### 5.1 Where it runs

The hosted page is what every account uses, so the **browser is the primary
runtime**. A Node runner exists only so `npm run benchmark` can measure it.

- **Browser:** a module Worker (`docs/audio-worker.js`, built alongside
  `docs/index.html` by `build-web.mjs`). It runs `onnxruntime-web` WASM,
  with WebGPU when present. Decoding and resampling run on the main thread
  (`OfflineAudioContext` is not available in workers), and the mel plus
  inference runs in the worker.
- **Node:** `enrich-audio.mjs` → gitignored `audio-effnet.json`, same shape
  as the browser store. It uses `onnxruntime-node` and a pure-JS/WASM MP3
  decoder (choose one with an MIT/BSD licence; this is not chosen yet). Wire
  it into `analyse-v3.mjs` the way `tags-discogs.json` is.

### 5.2 The mel front-end — new `core/audio/mel.mjs`

Effnet expects Essentia's `TensorflowInputMusiCNN` features: 16 kHz, frame
512, hop 256, 96 mel bands, `log10(1 + 10000·x)`, patches of 128 frames.
That is roughly 150 lines of plain JS (FFT, mel filterbank, compression).
Writing it avoids shipping AGPL `essentia.js`.

It's isomorphic (no DOM, no Node APIs), so the browser and Node share it.

**Parity test:** a committed fixture of a short synthetic signal (a sweep
plus noise, generated in the test, not copied audio), with the reference mel
computed once by Essentia's Python package and committed as JSON. Assert
max abs error under a tolerance. Without this, a quiet drift in the front-end
degrades every prediction and nothing notices.

### 5.3 What gets analysed first

Following CLAUDE.md, listening decides priority, not library order:

1. Tracks whose artists are tag gaps (the same `gap()` test as
   `enrichMissing()` in `docs/app.template.html`), ordered by
   `byListening(…, (await getListening()).weights)`. `byListening` is in
   `profile.mjs` and is inlined into the page by `build-web.mjs`.
2. Tracks the review queue is unsure about (`AMBIGUOUS` /
   `INSUFFICIENT_DATA`).
3. Everything else, in listening order.

Runs are resumable and budgeted, with a default of ~200 tracks a run and a
visible counter and a Stop button. Already-analysed ids are skipped, unless
`model` or `heads` differ from the current versions.

Deezer documents a rate limit of 50 requests per 5 s (from Deezer's docs,
not measured here). Stay well under it, roughly 4 lookups a second.

### 5.4 Hosting the models

`essentia.upf.edu` is not CORS-open, so the files ship from this site:
`docs/models/discogs-effnet-bsdynamic-1.onnx` (18.0 MB) and the heads (each
under 3 MB). That's about 21–24 MB in total, under GitHub Pages' and Git's
per-file limits, but it permanently adds about 22 MB to repo history. The
alternative is a release asset, served by jsDelivr from a tagged GitHub
release. Decide in phase 3. Either way the page caches the files in
`caches.open('betterfy-models-v1')`, so the download happens once per
device, and the version is in the cache name.

---

## 6. Cost to a listener

| | Estimate | Basis |
|---|---|---|
| Model download | ~22 MB once per device | file sizes above |
| Audio per track | ~0.48 MB | measured preview |
| 200-track run | ~96 MB downloaded | arithmetic |
| 2,000-track library | ~1 GB downloaded over many runs | arithmetic |
| Storage | ~2 KB per track | §4.3 |
| Inference time | **unknown** | phase 0 measures it |

1 GB is real money on a phone's data plan. The UI should say so before the
first run and default to Wi-Fi-only (`navigator.connection?.type` where it
exists, otherwise ask).

---

## 7. Licences and terms

- **Models: CC BY-NC-SA 4.0.** Betterfy is free and non-commercial, so this
  is usable. But the model files are *not* MIT. Ship a
  `docs/models/LICENSE.md` naming MTG/UPF, the licence and the paper citation
  from the model JSON. Add a line to README's Licence section saying the
  code is MIT and these model files are not. A commercial fork would have to
  drop them.
- **`essentia.js`: AGPL-3.0**, so it is not used (§5.2).
- **`onnxruntime-web`/`-node`: MIT.**
- **Deezer API terms:** not reviewed in this pass. Read their API terms on
  preview use before phase 3 ships. This is a real open question, not a
  formality.

---

## 8. Phases and gates

Each phase ends at a gate that can stop the work. This is the same
discipline as the v3 build: measured against the baseline, replaced a layer
at a time.

**Phase 0 — measure (scripts only, no product code).**
- `scripts/audio-probe.mjs`: for a sample of 200 tracks from a real
  `library.json`, report the Deezer ISRC hit rate, `readable` rate and
  duration-check pass rate.
- A throwaway HTML page timing `onnxruntime-web` on one preview, on a phone
  and a laptop.
- **Gate:** coverage ≥ 70% on an electronic-heavy library (the hardest case
  for the README's earlier sources), and under 2 s per track on a phone.
  These thresholds are a judgement call; if either fails, write the number
  into README's *Data sources* table and stop.

**Phase 1 — core, offline.** `core/audio/mel.mjs` + parity test;
`core/sources/audio.mjs` + `audio-vocab.mjs` + tests against a **recorded
model-output fixture** (no network, no model in CI); engine wiring (§4.4).
- **Required test:** profiles for the existing fixtures are byte-identical
  with `audio` absent.
- `npm test` stays green (638 tests at the time of writing).

**Phase 2 — does it help?** `enrich-audio.mjs`, then
`npm run benchmark` and `npm run benchmark:fit` with and without the audio
cache. Sweep the label threshold and reliability prior.
- **Gate:** genre accuracy measurably better on the benchmark, and no worse
  on any benchmark case where the listener has corrected the engine. If not,
  it stays behind a flag and the numbers go in `docs/TUNING.md`.

**Phase 3 — browser.** Worker, IndexedDB store (`audio_v1`), model cache, a
button under Playlists beside the tag-gap fetch, cost warning, progress and
Stop. First consumer in v1 terms: an artist with **no** tags from Last.fm or
Discogs gets a cloud aggregated from its tracks' audio styles, under exactly
the rule Discogs already lives by: *it only ever fills a total gap and
never outranks a real Last.fm tag*.

**Phase 4 — similarity.** The embedding in DNA, the blend in `compare()`,
and a sweep against `npm run benchmark:playlists`.

---

## 9. Deliberately not in this plan

- **BPM and key.** Classic DSP estimates on a 30-second excerpt are prone to
  half/double-time errors, which `measured()` in `music-dna.mjs` already
  calls out as the failure that must not be averaged away. The only clean
  library for it is AGPL. Rekordbox remains the bonus path for DJs. Revisit
  only with a measured accuracy number.
- **Energy and valence.** The heads exist only for musicnn/vggish, which is a
  second backbone and a second download. Do it after phase 2 shows the first
  one earns its keep.
- **MAEST** (transformer, better 400-style scores, much larger). Not until
  effnet's numbers show a ceiling worth paying for.
- **iTunes fallback.** Fuzzy name matching at `name-fuzzy` (0.40) identity is
  a separate decision, after phase 0 shows how many tracks Deezer misses.
- **Any server.** The project's identity is "no server" (FIREBASE.md). All of
  the above runs on the listener's device.

---

## 10. Files this touches

New: `core/audio/mel.mjs`, `core/sources/audio.mjs`,
`core/sources/audio-vocab.mjs`, `enrich-audio.mjs`, `scripts/audio-probe.mjs`,
`docs/audio-worker.js`, `docs/models/` (+ `LICENSE.md`),
`test/audio-*.test.mjs` with fixtures.

Changed: `core/engine.mjs` (`buildRegistry`, `indexCaches`,
`buildEvidence`), `core/analysis/music-dna.mjs` (`musicDNA` gains optional
`audio`), `core/recommend/similarity.mjs` (`compare`), `analyse-v3.mjs`,
`build-web.mjs`, `docs/app.template.html` (phase 3 only), `.gitignore`
(`audio-effnet.json`), `package.json` (`enrich:audio`),
`docs/ENGINE-V3-ARCHITECTURE.md` (phase 5 row), README (*Data sources*,
*Licence*).
