# Sound engine plan: listen, analyse, name, place, show tempo (2026-11-18, after `0e47de1`)

**What this is.** A review of the whole sound pipeline, end to end in the code,
with new measurements, and a ranked work plan for making it more accurate and
faster for every account. It answers the owner's ask: *"review the sound engine
and how we analyse, listen, suggest genre and playlists and display bpm of
music. We should be accurately doing this for all music to the best of our
ability."*

It **builds on `docs/BUILD-8-PLAN.md`** and does not repeat it. Where a
build 8 package already covers something (D1 drum & bass naming, S2 small
playlists, N1 never-filed artists, M2 mood coverage, A3 learning curve), this
plan adds only what the review found that the package does not say, and names
the package. Rules, lanes, the agent brief and the merge routine are
BUILD-7 §1, §2.4, §8 and BUILD-8 §5; they apply unchanged.

Every number here is one of three kinds, and says which:

- **Her Score run** (PC, 2026-11-18, the numbers in BUILD-8 §1);
- **re-measured for this plan** on public data, with the script named, so
  anyone can run it again (§2);
- **checked in code**, with the file named.

Contents:

0. The short version
1. How the sound pipeline works today
2. Measurements run for this plan
3. Findings, stage by stage
4. Work packages: quick wins, then full upgrades
5. What cannot be fixed, and what to do instead
6. Order, lanes and owner decisions
7. Progress table

---

## 0. The short version

1. **Drum & bass loses its genre partly because of its tempo.** About half of
   DnB is read at 85-90 rather than 170-180 (Beatport, 20 of 40 tracks read
   inside 160-180). `identify()` then marks DnB *down* for that reading and
   hip-hop *up*: an 87 fits hip-hop's 80-105 fully, while DnB gets only
   `OCTAVE_CREDIT` 0.6 for its double, so its support is cut by 26%
   (`core/ontology/tempo.mjs`, `core/audio/identify.mjs`). The same 0.6 makes
   Score's "tempo fits the playlist's genre" count a correct 87 as a miss,
   which is a large part of her 51% of 213. Fix: full credit at double time
   for the genres whose own convention is "87 or 174" (T1, a quick win
   inside build 8's D1).
2. **The BPM a listener sees is the raw reading, not the settled one.** The
   sound card, Shuffle, Tidy and Library's tempo range show `dsp.bpm` as
   measured, so a DnB track shows 87, while the "Sounds like" slot
   shows the octave its genre settles. Folding a reading into the DJ range of
   the genre it is in (×2 or ×½ only) moves DnB readings in range from
   **19 to 31 of 40** and hip-hop from **17 to 30 of 49**, and moves **no**
   House, Techno or Breaks reading off Beatport's own number (T2).
3. **A fifth of tempos are hidden that could be shown.** BPM shows only at
   confidence ≥ 0.3. Of the readings between 0.15 and 0.3 (19% of tracks),
   **84% are right up to half/double time** (59 of 70); after T2's fold they
   can show as "about 174" (T3). 55% of DnB and 51% of hip-hop sit below 0.3
   today.
4. **Listening is strictly one track at a time on one CPU thread.** Lookup,
   download, decode and the model run in series (`core/audio/worker.js`
   `runQueue`), the WASM runtime is single-threaded (`numThreads = 1`, no
   cross-origin isolation on GitHub Pages), and each of the four top-ups
   (tempo/key, CLAP, Beat This, key v4) downloads the preview again. Nothing
   in the page times any of it, so phone against PC is unmeasured. Quick wins:
   time each stage (L1), overlap the network with the model (L2), one download
   per top-up record (L3). Full upgrades: one worker per core on a PC (U1) and
   WebGPU where the browser has it (U2).
5. **A model update would switch sound off for every account.** `MODEL` is
   checked in `isCurrent()`, and `audioIndex()` drops every record whose model
   differs, so bumping the ear empties the index until the whole library is
   heard again (7,161 tracks on her PC). Rule: a new ear goes in as a second
   ear (`EARS`, record v2 already supports it) and takes over per account
   only when it covers the library and passes Score (R1).
6. **The ear's geometry is not the problem.** Two cheap changes to how a
   track is compared to a playlist were measured on 374 public scene tracks:
   centring each account's embeddings lost 2.7 points of top-1, scoring each
   window separately changed nothing (§2.1). Both are closed. Build 8's levers
   (who is heard, small playlists, never-filed artists) stay the right ones.
7. **Non-electronic music is named coarsely.** The ear knows 400 Discogs
   styles; the ontology has 108 genres, 59 of them electronic. All 35 Latin
   styles map to one node, 25 jazz styles to four, 27 folk/world/country styles
   to four, reggae has no roots, rocksteady or ska (checked:
   `core/sources/audio-vocab.mjs` against `core/ontology/genres.mjs`). For a
   listener whose playlists are "Reggaeton", "Bossa" or "Roots", the ear's
   own vote can say only "Latin" or "Reggae" (G1). The ear itself is fine
   there: 81% top-1 by sound on 18 mostly non-electronic genres, against 68%
   on scene genres (§2.2).
8. **Deezer already sends a BPM** for about half of mainstream tracks, in the
   lookup the page makes, and the page drops it. Where both exist it agrees
   with the measured tempo 76% of the time (84% when the measure is sure). A
   free second opinion (T4); almost absent for scene music (5%).
9. **What cannot be fixed:** tracks Deezer has no preview for, songs whose
   character is outside the 30 s preview, and key on every track from 20 s of
   audio. §5 says what to do instead of each.

---

## 1. How the sound pipeline works today

| Stage | What happens | Where | Measured |
| --- | --- | --- | --- |
| **Queue** | Five tiers: being played, unfiled liked songs, weak playlists' members, untagged artists, exemplars per genre playlist, then the rest; most-listened artists first inside each | `core/audio/queue.mjs` | Her run: 572 of 600 held-out tracks heard; 7,161 analysed |
| **Find** | Spotify's ISRC → Deezer `track/isrc:` (JSONP). ISRC must match; Deezer's length within ±3 s of Spotify's, else `IDENTITY` miss. Misses are cached 90 days | `core/audio/fetch.mjs`, `record.mjs` `MISS_TTL_MS` | Phase 0: name matching was wrong 1 time in 19, so ISRC or nothing |
| **Download** | Two ~10 s byte ranges of the 30 s preview (start and middle), ~330 KB | `fetch.mjs` `windows()` | Phase 0: same top-1 as the whole preview 82% of the time |
| **Decode** | Each window decoded on its own (OfflineAudioContext), 16 kHz mono | `web/audio/controller.mjs`, `core/audio/decode.mjs` | |
| **Hear** | Discogs-EffNet on mel patches: 400 style scores, a 1280-d embedding, per-patch top styles; heads for mood, voice, danceability. One WASM thread, in a Worker | `core/audio/infer.mjs`, `heads.mjs`, `docs/audio-worker.js` | |
| **Measure** | Tempo per window (autocorrelation comb, prior at 120), reconciled across windows; slow readings under 74 doubled when the pulse is steady; key v4 (CNN + v3 chroma), loudness | `core/audio/dsp/*.mjs` | Tempo 84% ±1 BPM on Beatport half B; key 57.3% exact, sure keys 62.5% on 85% (BUILD-5-PROGRESS) |
| **Second ears** | MAEST (Deep listen, ≥ 8 GB), CLAP (Wi-Fi), Beat This (opt-in, octave-flagged tempos only) | `core/audio/maest.mjs`, `clap.mjs`, `dsp/beats.mjs` | MAEST 61 vs 60, not used to place (BUILD-8 §1.2) |
| **Name a genre** | Votes from the model's styles, the filed tracks it sounds most like, artist tags; tempo checks each genre; the path goes down while a child holds half its parent | `core/audio/identify.mjs` | Her run: genre 72%, sub-genre 92% when named; DnB 77 of 199; tempo fits 51% of 213 |
| **Place** | Cosine to each playlist's centroid of unit embeddings (≥ 5 heard members), or the prototype learner; joins the blend per situation (S1) | `core/intrinsic/audio.mjs`, `audio-learn.mjs`, `space.mjs` | Her run: sound-first 60 / 86, blend 66 / 89, never-filed with sound 63% |
| **Show** | BPM at confidence ≥ 0.3 ("87/174" when flagged unsure), key at ≥ 0.65, playlist tempo range in Library (E3) | `web/audio/dsp-view.mjs`, `web/ui/sound.mjs`, `web/app/soundslots.js`, `web/screens/{shuffle,tidy,lists}.mjs` | |

---

## 2. Measurements run for this plan

Both are new scripts under `scripts/audio-sound/`, measurement only (the
page never loads them), run here on 2026-11-18. They hear audio exactly as the
page does: two ~10 s windows, `measureWindows()` for tempo, the shipped
EffNet for sound. These are public sets, not her library; her library is
measured by the in-page Score run, which is where every bar in §4 is read.

### 2.1 Placing by sound: centred and per-window scoring (`eval.mjs --set scene`)

374 tracks from public Deezer playlists, 15 scene genres (the same set and
rules as `scripts/audio-near`: 25 per genre, one track per artist),
leave-one-out nearest centroid, by sound alone.

| Variant | top-1 | top-2 | 9 per genre (20 draws) |
| --- | --- | --- | --- |
| Joined windows, centroid (**today**) | **67.9%** | 84.2% | **62.4%** |
| Joined, centred on the set's mean | 65.2% | 84.8% | 61.3% |
| Each window scored on its own | 67.9% | 84.2% | 62.5% |
| Each window, centred | 66.8% | 86.4% | 62.1% |
| Middle window only | 63.4% | 82.4% | 58.2% |

- **Centring hurts top-1** (−2.7 points; bassline 15 → 11, UK garage 7 → 4,
  phonk 19 → 15 of 25) for about half a point of top-2. Closed.
- **Per-window scoring changes nothing** (±0.1). Closed.
- **Both windows matter**: the middle window alone loses 4.5 points, so the
  start window is not noise (an intro still says something).
- So the ear's geometry is not where accuracy is lost, which agrees with
  build 8 (nearest members +0.2, MAEST +1). The levers are the ones build 8
  lists (who is heard, small playlists, the artist) and the tempo and naming
  fixes below.

### 2.2 Outside electronic music (`eval.mjs --set broad`)

449 tracks from public Deezer playlists, 18 genres mostly outside
electronic music (25 per genre, one track per artist), same method as §2.1.

| Variant | top-1 | top-2 | 9 per genre (20 draws) |
| --- | --- | --- | --- |
| Joined windows, centroid (**today**) | **80.8%** | 93.3% | 78.7% |
| Joined, centred | 80.8% | 92.7% | 78.7% |
| Each window on its own | 81.7% | 93.3% | 79.2% |
| Middle window only | 79.7% | 91.5% | 76.9% |

Per genre, today (of 25): classical 25, house 25, punk 23, jazz 23, reggae 23,
drum and bass 22, rnb 21, metal 21, trap 20, country 20, folk 20, indie rock
19 of 24, latin 19, afrobeats 18, dancehall 17, pop 17, **hip-hop 15, soul
15**.

- **The ear separates broad genres well** (81% top-1, 79% from nine
  examples), better than scene genres (68%). So for a listener with
  non-electronic playlists, placing by sound already works; what is coarse is
  the *naming* (§0 point 7, G1), not the hearing.
- The weakest are the genres that overlap in sound: hip-hop against trap and
  rnb, soul against rnb and pop, dancehall against reggae and afrobeats.
  Those are where tags and the bridge must carry more of the blend, which S1's
  per-situation weights already allow.
- Per-window scoring is +0.9 here (±0 on scene genres): under the +1 bar that
  closed three windows. Still closed; noted in case a Score arm wants it.

### 2.3 Tempo per genre (`genre-tempo.mjs`, Beatport EDM Key Dataset)

369 tracks with a Beatport genre and BPM (Zenodo 1101082; the same set and the
same "middle 30 s as two 10 s windows" as `beatport-eval.mjs`). "Right up to
×2" counts a reading equal to Beatport's number, or twice or half of it.
"In DJ range" uses `core/ontology/tempo.mjs` `TEMPO` for the genre.

| Beatport genre | n | Beatport's own number is below the DJ range | Exact ±1 | Right up to ×2 | Flagged unsure | In DJ range: as read → ×2/×½ fold into the range |
| --- | --- | --- | --- | --- | --- | --- |
| Electronica / Downtempo | 97 | 3 | 79% | 92% | 34 | 29% → 40% |
| Techno | 50 | 3 | 88% | 94% | 15 | 88% → 92% |
| Breaks | 49 | 10 | 84% | 90% | 10 | 63% → 67% |
| Hip-Hop / R&B | 49 | 2 | 69% | 94% | 28 | 35% → 61% |
| House | 43 | 0 | 93% | 95% | 10 | 88% → 91% |
| Dubstep | 41 | 8 | 68% | 93% | 18 | 61% → 80% |
| **Drum & Bass** | 40 | **32** | **28%** | 65% | 24 | **48% → 78%** |
| All | 369 | 58 | 75% | 90% | 139 | 55% → 68% |

What it says:

- **Beatport itself writes 32 of 40 DnB tracks at 85-90** (and several at
  116-119, two thirds of 174). So "87 or 174" is a convention, not an error,
  and a strict ±1 score on DnB (28%) mostly measures which convention was
  picked. Listeners and DJs expect 170-180.
- The reading is in the DnB range for only 19 of 40 tracks. Folding by ×2
  into the genre's range takes it to 31; also allowing ×3/2 (a reading at
  ~116 is a 3:2 slip on a 174 track; six DnB tracks here) takes it to 37. The
  3:2 fold is only safe where the genre is known to be DnB.
- The fold **moved no House, Techno or Breaks reading off Beatport's number**
  (0 of 142). It did move 7 DnB readings off Beatport's 87 (to 174, which is
  the point) and 6 Hip-Hop / R&B readings: Beatport's Hip-Hop / R&B mixes
  trap at 140 with rap at 90, so a fixed hip-hop range is wrong for it. That is
  why T2 folds into the **playlist's own measured range** (E3) first and the
  genre table only second.
- **Confidence bands** (all 365 read): below 0.15, 26 of 34 right up to ×2;
  **0.15-0.3, 59 of 70 (84%)**; 0.3-0.6, 161 of 171; ≥ 0.6, 86 of 90. Of 57
  octave errors, 45 were flagged unsure, and on 45 the flagged alternate was
  Beatport's number.

### 2.4 Tempo against Deezer's own BPM

Deezer's track object has a `bpm` field, and the `track/isrc:` lookup the
page already makes returns it (`core/audio/fetch.mjs` reads the same JSON
and drops it). Read for every track in §2.1 and §2.2:

- **Scene genres: Deezer states a BPM for 18 of 374 tracks (5%).**
- **Broad genres: 235 of 449 (52%).**
- Where both exist (222 broad tracks), the DSP agrees with Deezer on 169
  (76%); reads half on 19, double on 9, 3:2 on 9, something else on 16 (7
  of those metal). At DSP confidence ≥ 0.3 they agree on 92 of 109 (84%).

Deezer's number is not a ground truth (it is unverified, and absent for
almost all scene music), so this is agreement, not accuracy. But it is a free
second opinion on mainstream music, exactly where the Beatport check says
nothing, at no extra request. T4 uses it.

---

## 3. Findings, stage by stage

### 3.1 Listen (find, download, hear)

- **Coverage.** 572 of 600 held-out tracks heard on her library (95%). The
  misses fall into five cached reasons (`MISS` in `record.mjs`): no ISRC,
  not on Deezer, no preview, a different-length recording (`IDENTITY`), too
  short. The listening status already counts them (`controller.mjs`
  `refresh()`), but Score does not report the funnel, so nobody knows which
  reason costs most on her library or another account's. This is the
  hearing half of build 8's A7 coverage funnel (L4).
- **`IDENTITY` is strict on purpose.** ±3 s is Deezer's whole-second rounding
  plus slack; a radio edit against an extended mix under one ISRC is a real
  different recording. Keep it. Do not loosen without the funnel's count.
- **Order.** The queue is good: being played first, then the inbox, then weak
  playlists. Build 8's M2 (mood near-misses) and A3 (learning curve) extend
  it; nothing more here.
- **Speed.** Strictly serial: `runQueue` awaits lookup → two range fetches →
  decode → mel → model → DSP → (CLAP) for one track before the next starts.
  The network wait (two round trips to Deezer, two to the CDN) and the
  model's CPU time never overlap. The runtime is single-threaded WASM because
  GitHub Pages cannot send the headers multi-threading needs
  (`build-web.mjs` line ~290). Each top-up (`topUpDsp`, `topUpClap`,
  `topUpBeats`, `topUpKeyNet`) looks the track up and downloads the windows
  again, so a record that needs two top-ups is downloaded three times.
- **Nothing is timed.** There is no per-stage timing anywhere in the page, so
  "how fast on a phone" and "what to speed up first" cannot be answered from
  the hosted page. The one browser figure on record is MAEST at ~2.3 s per
  10 s window.
- **Hangs** are handled since L0: 60 s per track, 5 min per model load
  (`core/audio/timeout.mjs`); a timed-out step is retried on a later run.
  Nothing to add.
- **Phone against PC.** A phone listens to "playing + unfiled" on Wi-Fi only;
  MAEST needs ≥ 8 GB; CLAP is Wi-Fi only. A phone browser also pauses a page
  that is not on screen, which no web page can change (§5).

### 3.2 Analyse (models, tempo, key, labels)

- **Tempo** is good where it is sure and is settled per genre in only one
  place: `identify()` calls `resolveOctave` **only when the tracker itself
  flagged the reading** (`t.alt` is null otherwise). A confident 87 on a DnB
  track is never moved. §2.3 shows a confident wrong octave is the common DnB
  case (DnB readings at 85-89: 12 of 40).
- **3:2 slips** (a 174 track read at ~116, a 140 track at ~93) are not
  handled anywhere: `combineTempo` and `tempoFit` know only ×2 and ×½.
- **Key** is at its limit for 20 s of audio (BUILD-5-PROGRESS "Key v4", memory
  `audio-key-v3`): don't re-tune. Sure keys on 85% of tracks is the product.
- **Mood, voice, energy labels**: shown only through the label review and mood
  chips; coverage, not the model, is the problem (BUILD-8 M2). Nothing more
  here.
- **Model updates.** `isCurrent()` rejects any record whose `MODEL` differs and
  `audioIndex()` skips it, so changing the ear would make sound vanish for
  every account until each has heard its whole library again (R1).

### 3.3 Suggest a genre

- **Drum & bass (77 of 199 named).** Two causes found in code, both
  measurable: (a) the tempo penalty in §0 point 1 pushes DnB read at 87
  towards hip-hop, dancehall and downtempo, whose ranges contain 87; (b) the
  ear's 400 styles have "Drum n Bass", "Jungle" and "Halftime" but no liquid,
  neurofunk or jump-up, so sub-genres come only from library neighbours.
  Build 8's D1 already plans (b) (name against her own Rollers/Jungle/Liquid
  playlists) and octave-aware ranges; T1 below is D1's tempo part, specified
  from the code.
- **The Score metric itself under-counts.** `identifyAccuracy` counts tempo as
  fitting when `tempoFit` ≥ 0.8, and a double-time reading can score at most
  0.6, so a right 87 for DnB is always "doesn't fit". After T1 the same tracks
  must be re-scored before anyone reads the 51% as an accuracy number.
- **Non-electronic coverage.** See §0 point 7 and §2.2. The ontology's
  breadth decides what a listener's playlist names can be matched to
  (`gaps.mjs` `conceptLabel`, the playlist concept parser), not only what the
  ear can say.
- **`byGenre` is keyed by the first concept only** (`truth[0]`), so a track
  in both "Jungle" and "Breaks" counts under one. Fine for a display; worth
  knowing when reading per-genre rows.

### 3.4 Suggest a playlist

- Her numbers (BUILD-8 §1): sound-first 60%, blend 66%, never-filed with
  sound 63% against 58% for the blend. S1 (sound joins the blend per
  situation) is merged and waits on her next Score run. Build 8's N1, S2 and
  B1 cover never-filed artists, small playlists and mixed playlists.
- **What build 8 does not cover**: how a track's embedding is formed. Today a
  track is one vector, the mean over both windows joined, compared by raw
  cosine to playlist centroids. Two cheap per-account changes were measured
  for this plan (§2.1): centring on the account's own mean embedding, and
  scoring each window separately. Both were measured and closed (P1, P2).

### 3.5 Show BPM and key

- **Five surfaces, two answers.** `dspSoundVM` (sound card), `shuffle.mjs`
  `mixBpmOf`, `tidy.mjs` and the Library range use the raw `dsp.bpm`;
  `soundslots.js` uses `identify()`'s settled `bpm.value` (with "Tempo read
  the way its genre is felt" as the title). The same DnB track can show 87 on
  one card and 174 on another.
- **The Library range (E3) is shown at "the octave most members were measured
  in"** (`core/intrinsic/tempo.mjs`), so a DnB playlist whose members mostly
  read 87 shows "85-89 BPM".
- **Unsure display.** At 0.3 and above: a number, or "87/174" when flagged.
  Below 0.3: nothing. Key: shown at ≥ 0.65 only. The key rule is right (it
  is measured). The tempo rule hides a band that is right up to ×2 84% of the
  time (§2.3).
- **Half-time genres** (`HALF_TIME`: dubstep, trap, drill, phonk) get full
  credit at half tempo in `tempoFit`. DnB, jungle and footwork, whose
  convention is the opposite way round (written at either), do not.

---

## 4. Work packages

Format (BUILD-8 §2): goal, why (which number), what (files, checked), measure
and bar set before the run, effort (S ≈ hours, M ≈ a day, L ≈ more), lane.
**Every bar is read in the hosted page** (her Score run, or a line the page
prints on its own), never from a local script; the public-set scripts in §2
are how a package is developed and checked, not how it is switched on. A
package that misses its bar ships display-only and says so. Nothing is pooled
across accounts, no Spotify content goes into a model, filing stays tap-only
(SMARTER-GENRES §3).

### Quick wins

#### T1. Double time counts for drum & bass (lane E, S; part of BUILD-8 D1)

**Goal.** A DnB track read at 87 is not marked down as DnB, and Score's
tempo line counts it as fitting.

**What.** `core/ontology/tempo.mjs`: a `DOUBLE_OK` set (drum-and-bass and its
children, jungle, footwork, juke, breakcore) that gets full credit at ×2 in
`tempoFit`, as `HALF_TIME` does at ×½. `identify()`: call `resolveOctave` on
every confident reading with its ×2 / ×½ partners as candidates, not only on
flagged ones, so the genres heard pick the octave. No change to the DSP or to
stored records. Re-score `identifyAccuracy` on the same tracks and print
both.

**Measure and bar.** On her Score run, same tracks with/without:
**DnB named 77/199 → ≥ 95/199** (D1's full bar of 110 needs its library part
too), **tempo fits 51% → ≥ 70% of 213**, genre-right overall no loss (72%).
**Effort** S. Unit tests on `tempoFit` and `identify` with a 87-read DnB
fixture.

#### T2. One BPM everywhere, in the listener's convention (lanes E + U, S)

**Goal.** Every surface shows the same BPM for a track, in the octave its
genre is played at.

**What.**
- `core/audio/match.mjs`: `displayTempo(record, { playlistRange, genres })`
  returns `{ bpm, from: 'measured'|'playlist'|'genre', alt? }`. Order: the
  measured reading if it sits in the range of a playlist the track is in or
  is suggested for (E3's `tempoRangeOf` per playlist, per account); else ×2
  or ×½ if that lands in the range; else the same against the genre table
  for `identify()`'s genre; else the reading as measured.
- Use it in `web/audio/dsp-view.mjs` (sound card), `web/screens/shuffle.mjs`,
  `web/screens/tidy.mjs` and `web/app/soundslots.js`.
- E3's Library range: show it at the octave the **genre table** prefers when
  the playlist's genre has a row (`core/intrinsic/tempo.mjs`), so a DnB
  playlist reads "170-176".
- Matching (`mixesWith`, DJ order) already treats ×2 as a mix
  (`tempoRelation`); unchanged.

**Measure and bar.** In the page: a Score line "BPM shown inside its
playlist's range: N% → M%" over heard filed tracks with a confident tempo,
and the count of readings the fold moved. **Bar: +15 points in range on
playlists with a DnB, dubstep or hip-hop genre; on house, techno and
breaks playlists, ≤ 1% of readings moved** (Beatport: 0 of 142). **Effort** S.

#### T3. Show "about" tempos instead of hiding them (lane U, S; after T2)

**Goal.** Fewer blank BPMs, without showing wrong ones as sure.

**What.** `dsp-view.mjs`: readings with confidence 0.15-0.3 show as "~174"
(lighter, title "about 174 BPM; measured from 20 s of the preview") **only
when T2 settled them** against a playlist range or the genre table. Below
0.15 stays hidden. The exact number at ≥ 0.3 is unchanged.

**Measure and bar.** Beatport, before shipping: the 0.15-0.3 band right up to
×2 is 84% (59/70); after T2 the shown octave must be right on ≥ 80% of that
band in the DJ convention. In the page: share of heard tracks with a BPM
shown, before/after. **Effort** S.

#### T4. Deezer's own BPM as a free second opinion (lane E, S)

**Goal.** More tempos settled and shown on mainstream music, at no extra
cost.

**What.** `core/audio/fetch.mjs` `lookup()` keeps `json.bpm` when it is above
0 (it is in the response the page already gets); `record.mjs` stores it as
`source.deezerBpm` (optional field, no version bump). Use: (1) when the DSP
flagged half/double unsure and Deezer's number equals one of the two
candidates, take that one; (2) when DSP and Deezer agree within 2 BPM, raise
the shown confidence to at least 0.3. Never use Deezer's number alone.

**Measure and bar.** In the page: a Score line "Deezer and the measured tempo
agree on N of M". Before switching (2) on, on §2.2's set, the share of tracks
with a BPM shown rises **≥ 10 points**, and on GTZAN (annotated beats, looked
up on Deezer by artist and title, measurement only) the agreed readings are
right ±2 BPM on **≥ 90%**. Records heard before T4 get the field at their
next top-up. **Effort** S.

#### L1. Time every stage of listening, in the page (lane M, S)

**Goal.** Know, per device, where the seconds go.

**What.** `core/audio/worker.js` `analyseOne` and the top-ups record
`ms: { lookup, download, decode, mel, model, dsp, clap }` on the result (not
stored in the record). `web/audio/controller.mjs` keeps a rolling median per
stage and the device class (`navigator.hardwareConcurrency`,
`deviceMemory`, mobile UA hint). Shown on the Listening status line ("about
2.1 s a track: 0.9 s waiting for Deezer, 0.8 s hearing") and copied into the
Score report so a phone run and a PC run can be compared.

**Bar.** None (measurement). Required before L2, U1 and U2 so each has a
before. **Effort** S.

#### L2. Fetch the next track while this one is heard (lane M/E, S-M)

**Goal.** The network wait and the model time overlap.

**What.** `runQueue`: a one-ahead prefetch (lookup + both windows for track
n+1 while track n decodes and runs). Never more than one ahead (memory and
Deezer's rate limit: 50 requests per 5 s). The signed preview URL is still
used at once (fetch.mjs rule: never cached). Stop and timeout behaviour
unchanged; a prefetched track whose run is stopped is simply dropped.

**Measure and bar.** L1's tracks per minute on the same device, same queue:
**≥ 1.4× on a PC on Wi-Fi**, no rise in `FAILED`, records byte-identical
(unit test with fake fetch and a fake ear). **Effort** S-M.

#### L3. One download per record for all top-ups (lane M, S)

**Goal.** A record that needs tempo/key, CLAP and key v4 is downloaded once,
not three times.

**What.** `controller.mjs`: gather every top-up a record needs
(`needsDsp`, `needsClap`, `needsBeatsFlagged`, `needsKeyNet`), download and
decode once, run each, store once. Per-run budgets stay per top-up.

**Measure and bar.** L1's download count and seconds per topped-up record:
**downloads per record ≤ 1.1**; records identical to today's path (unit test).
**Effort** S.

#### L4. Hearing coverage funnel in Score (lane M, S; the hearing half of BUILD-8 A7)

**Goal.** Say, for this account, how many tracks are heard and why the rest
are not.

**What.** `core/review/autoscore.mjs`: from the store, count heard and each
`MISS` reason, over the library and over the held-out set; Engine shows
"Heard 7,161 of 7,450. Not on Deezer 180, no preview 60, a different version
40, no ISRC 9". Each reason links to §5's "instead".

**Bar.** Display only; must print on a library with no audio ("nothing heard
yet"). **Effort** S.

#### R1. A new ear never switches sound off (lane E, S; a rule plus a guard test)

**Goal.** Changing or adding a model never empties anyone's sound index.

**What.** Write the rule into `core/audio/record.mjs`'s header and
`docs/AUDIO-BUILD-PLAN.md`: `MODEL` is not bumped for a new backbone; a new
ear is added to `EARS` (as MAEST and CLAP were), filled by a top-up, and used
for placement per account only when it covers ≥ 90% of heard tracks and the
Score gate picks it (`gate.mjs` `earChoice`, as for MAEST). A test fails if
`MODEL` changes without `MIN_RECORD_VERSION` and a migration note.

**Bar.** The test. **Effort** S.

#### P1, P2. Centred sound space; per-window scoring: measured, closed

Both were measured for this plan (§2.1) and lose or tie: centring −2.7 top-1,
per-window ±0.1. Not built. What would reopen them: a Score run on an
account whose playlists are mixed (B1's finding), where per-window scoring
could still help a two-sound playlist; it would be a Score arm, not a
default.

### Full-scale upgrades

#### U1. One listening worker per core on a computer (lane M, M)

**Goal.** A PC hears a large library several times faster.

**What.** Several Workers, each with its own single-threaded WASM session
(no shared memory, so no cross-origin isolation needed). Count:
`min(4, hardwareConcurrency − 1)` on a computer with ≥ 8 GB, 1 on a phone or
an unknown device. The queue is split round-robin; lookup stays in the page
(JSONP needs it) behind L2's prefetch, rate-limited across workers. Memory:
EffNet is 18 MB per session; MAEST (89 MB) and CLAP (77 MB) stay at one
worker.

**Measure and bar.** L1, same queue, same PC: **≥ 2.5× tracks per minute
with 4 workers**, no new failures, identical records. On a phone: unchanged.
**Effort** M. **Depends on** L1, L2.

#### U2. WebGPU where the browser has it (lane M, M-L)

**Goal.** The model step is several times faster on machines with a GPU.

**What.** Load `ort.webgpu` when `navigator.gpu` exists and a small
probe passes, else WASM as today. Same models. An equivalence check on a
fixed fixture at load: embeddings within cosine 0.999 of the WASM answer,
styles' top-3 identical, else fall back to WASM for the session. Per-record
`ep: 'webgpu'|'wasm'` kept for diagnosis.

**Measure and bar.** L1's model ms per track: **≥ 3× faster where WebGPU
loads**, equivalence check passing on Chrome (Windows, Android) and Safari.
**Effort** M-L. Honest risk: WebGPU on phones is uneven; the fallback is
the feature.

#### U3. A second place to hear tracks Deezer cannot play (lane K, M; bonus)

**Goal.** Hear some of the tracks that are `NOT_ON_DEEZER` or `NO_PREVIEW`.

**What.** First a **probe in the page** (as W1 does for MusicBrainz): does the
iTunes Search API answer a browser (JSONP `callback=`), and does its 30 s
AAC preview fetch with CORS and decode? It could not be checked from here
(Apple answered this container with 403). If yes: for a miss only, search
by artist and title, accept a result only when its length is within ±2 s and
the artist matches exactly; store with `source.kind: 'itunes-name'` and a
lower identity, never used for the ISRC-strict paths. If no: the package stops
at the probe and says so.

**Measure and bar.** L4's funnel: **misses heard ≥ 30%** of the two reasons
it targets, and on tracks heard both ways (a check sample that Deezer *does*
have), the same record top-1 ≥ 95%. **Effort** M. Bonus only (CLAUDE.md):
silent and costless where it fails.

#### G1. Genre vocabulary beyond electronic music (lane E, M)

**Goal.** A listener whose playlists are "Roots Reggae", "Reggaeton",
"Bossa Nova", "Bebop" or "Afro House" gets genre names and sound votes at that
level.

**What.** `core/ontology/genres.mjs`: add children where the ear can already
tell them apart (§2.2: the ear separates broad genres at 81%): Latin (reggaeton, salsa, bossa nova,
cumbia, bachata), jazz (bebop, swing, fusion, smooth), reggae (roots,
rocksteady, ska, lovers rock), folk/world (afrobeat, highlife, celtic,
flamenco), soul/funk (gospel), plus their tempo rows. Map the Discogs styles
in `audio-vocab.mjs` `STYLE_MAP` to them. No new data source; nothing
learned. The playlist-name parser picks them up through the same ontology.

**Measure and bar.** (a) Public: §2.2's set (extended with sub-genre
playlists), the share of tracks whose `identify()` path reaches the right
sub-genre node, before/after. (b) In the page,
for any account with such playlists: `identifyAccuracy` genre-right on
non-electronic playlists, no loss on electronic ones. **Bar: ≥ +10 points
on (a) for the genres added, and no loss overall on her Score.** **Effort** M.

#### U4. Sound for never-heard tracks by their artist (lane E, M; extends BUILD-8 N1)

N1 pools an artist's heard tracks to score the artist. The same pooled
artist vector can stand in for an **unheard** track by that artist (a miss
from §5, or not yet reached by the queue), marked as "by its artist's sound"
and weighted lower. **Measure:** top-1 on held-out tracks whose own record
is removed but whose artist has ≥ 3 heard tracks, against the blend without
sound. **Bar: +3 points on those tracks, no loss elsewhere.** **Effort** M.
**Depends on** N1.

---

## 5. What cannot be fixed, and what to do instead

| Limit | Why it can't be fixed | What to do instead |
| --- | --- | --- |
| **No Deezer preview** (not on Deezer, no preview, region-locked) | The page can only hear audio a public, CORS-open source serves; Spotify's own previews are gone for new apps | Place from tags, the bridge and the artist's other heard tracks (U4); try a second source (U3); L4 says how many |
| **No ISRC** (local files, some uploads) | Nothing to look the recording up by, and name matching was wrong 1 time in 19 | Same as above; never guess by name on the strict path |
| **Spotify's audio features** | `/audio-features` and `/recommendations` answer 403/404 (README) | Tempo and key from the preview (§2.3) |
| **The preview is 30 s, and only 20 s is heard** | Deezer serves 30 s; a third window measured +0.3 top-1 for 50% more work (`scripts/audio-near`) | Keep two windows; T3 shows "about" when unsure; Beat This for flagged tempos |
| **A track whose character is outside the clip** (long intro, a drop after 2 min) | The preview's position is Deezer's choice | Sections and hybrids already flag a clip that changes (`sections.mjs`); the listener's tap corrects it and the learner keeps it |
| **Key on every track** | Measured at its limit for 20 s (57.3% exact; BUILD-5-PROGRESS "Key v4") | Show sure keys only (85% of tracks); no new key work (BUILD-8 D3) |
| **Tempo that changes inside a track** | One BPM per track is the display's shape | The two windows disagreeing lowers confidence (`combineTempo`); shown as unsure |
| **Exact BPM by convention** (DnB 87 vs 174) | Both are "right"; Beatport itself is split | Show the listener's convention: their playlist's range first, the genre's second (T2) |
| **Listening on a phone with the screen off** | Mobile browsers pause pages that are not on screen; a web page cannot run in the background | Listening resumes where it stopped; a computer hears the library faster (U1) and every device reads the same records once synced |
| **One ear for all of music** | The ear is trained on Discogs styles; weak on scene genres (29% top-1 by label) | It is used as an ear, the account's playlists are the names (unchanged design); G1 widens what it can name |

---

## 6. Order, lanes and owner decisions

Usage is low: at most three threads at once, none of lane E beside another
lane E thread (BUILD-7 §2.2). Start no wave without asking.

| Wave | Packages | Fits beside build 8 |
| --- | --- | --- |
| S0 | **T1** (lane E, with or as D1's first step), **L1** + **L4** (lane M), **R1** (rule + test) | Wave 0 is lane M too; L1/L4 share `autoscore.mjs` with A1-A7, so one thread does them together |
| S1 | **T2**, **T3**, **T4** (lanes E + U), **L2**, **L3** (lane M) | After T1; L2/L3 own `worker.js`/`controller.mjs` |
| S2 | **G1** (lane E) | After BUILD-8 wave 1 (I1, I2) |
| S3 | **U1**, then **U2** (lane M); **U3** (lane K); **U4** (lane E, after N1) | Last; each needs L1's before |

**File ownership added.** Lane M (measure and listening speed):
`core/audio/worker.js`, `web/audio/controller.mjs`, `docs/audio-worker.js`'s
source in `build-web.mjs`. Lane E adds `core/ontology/tempo.mjs`,
`core/ontology/genres.mjs`, `core/sources/audio-vocab.mjs`. Lane U adds
`web/audio/dsp-view.mjs`, `web/ui/sound.mjs`.

**Owner decisions.**

| Id | Question | Recommendation |
| --- | --- | --- |
| SD1 | Show BPM in the listener's convention (174 for DnB, the playlist's own octave first) rather than as measured? | Yes: the measured octave is a convention, and the playlist says which one this listener uses |
| SD2 | Show "~174" for unsure tempos (T3) instead of nothing? | Yes, lighter and with "about" in the title |
| SD3 | Try a second preview source (U3, iTunes Search, name + length match, bonus only)? | Yes to the probe; decide on the rest from its result |
| SD4 | Use more of a computer's cores and its GPU while listening (U1, U2)? | Yes on a computer; phones unchanged |

## 7. Progress table

| Id | Package | Wave | Lane | State | PR | Bar |
| --- | --- | --- | --- | --- | --- | --- |
| T1 | Double time counts for DnB | S0 | E | Built, awaiting her Score run | | DnB named ≥ 95/199; tempo fits ≥ 70% |
| L1 | Time every stage | S0 | M | Not started | | measurement |
| L4 | Hearing coverage funnel | S0 | M | Not started | | display |
| R1 | A new ear never switches sound off | S0 | E | Not started | | guard test |
| T2 | One BPM everywhere | S1 | E, U | Not started | | +15 in range; ≤ 1% moved on house/techno |
| T3 | "About" tempos | S1 | U | Not started | | ≥ 80% right in the 0.15-0.3 band |
| T4 | Deezer BPM as a second opinion | S1 | E | Not started | | +10 shown; ≥ 90% right on GTZAN |
| L2 | Prefetch the next track | S1 | M | Not started | | ≥ 1.4× tracks/min |
| L3 | One download per top-up | S1 | M | Not started | | ≤ 1.1 downloads/record |
| P1, P2 | Centred space, per-window scoring | – | E | Closed (measured, §2.1) | | −2.7 / ±0.1 top-1 |
| G1 | Genres beyond electronic | S2 | E | Not started | | +10 on the broad set; no loss |
| U1 | Worker per core | S3 | M | Not started | | ≥ 2.5× on 4 cores |
| U2 | WebGPU | S3 | M | Not started | | ≥ 3× model step |
| U3 | Second preview source | S3 | K | Not started | | ≥ 30% of misses heard |
| U4 | Unheard tracks by artist sound | S3 | E | Not started | | +3 on those tracks |
