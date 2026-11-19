# Sound engine plan: listen, analyse, name, place, show tempo (2026-11-18, after `0e47de1`; revised the same day for SD2)

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

**Revised 2026-11-18 for the owner's answer to SD2:** *"When bpm is unsure we
should say unknown but improve engine and how we find these things so we can
give all the right info."* So T3 now shows one sure BPM or "BPM unknown" (no
"~174", no "87/174"), §2.5-§2.6 add what is known about tempo outside
electronic music and every place a BPM could come from, and four new
packages (T5-T8) bring the number of unknowns down with more evidence rather
than a lower bar.

**Expanded 2026-11-18 (round 2), owner: *"improve and expand on the upgrade
plan"*.** §2.7 adds three probes run for this round (ListenBrainz genre tags
on scene artists, Deezer album genres, the Essentia heads and similarity ears
that fit the shipped ear). §4b adds fourteen packages across all five stages,
and it folds in build 8's leftovers where sound can help: never-filed
artists (N1), small playlists (S2), drum & bass naming (D1), big mixed
playlists (B1) and artist genre coverage (W1, Wikidata at 4%). §4c maps every
metric to the packages that move it.

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
4b. Round 2: deeper and broader
4c. Which package moves which number
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
3. **An unsure tempo says "unknown", never a guess** (owner's answer to SD2,
   2026-11-18). Today BPM shows only at confidence ≥ 0.3, as "87/174" when
   the octave is unsure, and as a blank below that. After T3 every surface
   shows either one BPM that is sure, or "BPM unknown" with the reason on
   tap. No "~174", no "87/174". 55% of DnB and 51% of hip-hop sit below 0.3
   today, and outside electronic music the tempo is right on only 61.5% of
   GTZAN, so "unknown" would be common. That is the honest answer, and §0
   point 4 is how the count comes down.
4. **Fewer unknowns comes from more evidence, not a lower bar** (owner,
   2026-11-18: "improve engine and how we find these things"). Unsure
   readings get a ladder of cheap second opinions, each measured before it
   counts: Deezer's own BPM (T4), the last third of the preview that is
   downloaded today and never heard (T5), Beat This on every unsure reading,
   not just octave-flagged ones and switched on by default (T5), a
   confidence that is calibrated per genre family so "sure" means the same
   right-rate everywhere (T6), and a better detector for the music it is
   weakest on: classical 25%, jazz 47%, metal 52%, country 56% on GTZAN (T7).
   A listener can also tap the beat on an unknown track (T8). The page prints
   "BPM known on N% of heard tracks, right on M% of the checked ones" so the
   count can be watched going down.
5. **Listening is strictly one track at a time on one CPU thread.** Lookup,
   download, decode and the model run in series (`core/audio/worker.js`
   `runQueue`), the WASM runtime is single-threaded (`numThreads = 1`, no
   cross-origin isolation on GitHub Pages), and each of the four top-ups
   (tempo/key, CLAP, Beat This, key v4) downloads the preview again. Nothing
   in the page times any of it, so phone against PC is unmeasured. Quick wins:
   time each stage (L1), overlap the network with the model (L2), one download
   per top-up record (L3). Full upgrades: one worker per core on a PC (U1) and
   WebGPU where the browser has it (U2).
6. **A model update would switch sound off for every account.** `MODEL` is
   checked in `isCurrent()`, and `audioIndex()` drops every record whose model
   differs, so bumping the ear empties the index until the whole library is
   heard again (7,161 tracks on her PC). Rule: a new ear goes in as a second
   ear (`EARS`, record v2 already supports it) and takes over per account
   only when it covers the library and passes Score (R1).
7. **The ear's geometry is not the problem.** Two cheap changes to how a
   track is compared to a playlist were measured on 374 public scene tracks:
   centring each account's embeddings lost 2.7 points of top-1, scoring each
   window separately changed nothing (§2.1). Both are closed. Build 8's levers
   (who is heard, small playlists, never-filed artists) stay the right ones.
8. **Non-electronic music is named coarsely.** The ear knows 400 Discogs
   styles; the ontology has 108 genres, 59 of them electronic. All 35 Latin
   styles map to one node, 25 jazz styles to four, 27 folk/world/country styles
   to four, reggae has no roots, rocksteady or ska (checked:
   `core/sources/audio-vocab.mjs` against `core/ontology/genres.mjs`). For a
   listener whose playlists are "Reggaeton", "Bossa" or "Roots", the ear's
   own vote can say only "Latin" or "Reggae" (G1). The ear itself is fine
   there: 81% top-1 by sound on 18 mostly non-electronic genres, against 68%
   on scene genres (§2.2).
9. **Deezer already sends a BPM** for about half of mainstream tracks, in the
   lookup the page makes, and the page drops it. Where both exist it agrees
   with the measured tempo 76% of the time (84% when the measure is sure). A
   free second opinion (T4); almost absent for scene music (5%).
10. **Round 2: the biggest untried levers are cheap.** (a) The shipped ear
   has 25 more ready-made heads in the same model family (instruments,
   acoustic/electronic, five binary moods, bright/dark), each a few hundred
   KB on the embedding already computed (H1). (b) Rhythm, which the ear
   barely sees, separates the scene pairs it confuses most (UK garage 7 of
   25, bassline 15 of 25), from onset envelopes the tempo code already makes
   (H2). (c) **Artist genres for scene producers exist where nobody has
   looked**: ListenBrainz serves MusicBrainz's genre tags keyless and
   CORS-open, and had tags for **17 of 22** scene artists with an MBID
   ("bassline", "uk garage", "jungle"; §2.7), against Wikidata's 4% (G3).
   (d) An artist with three heard tracks can be named by its own sound when
   no source knows it (G2). (e) Hearing order can serve the leftovers
   directly: every member of a small playlist and three tracks of each
   never-filed artist heard first (F2).
11. **What cannot be fixed:** tracks Deezer has no preview for, songs whose
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
| **Show** | BPM at confidence ≥ 0.3 ("87/174" when flagged unsure; blank below 0.3; T3 replaces both with one sure BPM or "BPM unknown"), key at ≥ 0.65, playlist tempo range in Library (E3) | `web/audio/dsp-view.mjs`, `web/ui/sound.mjs`, `web/app/soundslots.js`, `web/screens/{shuffle,tidy,lists}.mjs` | |

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
  the *naming* (§0 point 8, G1), not the hearing.
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

### 2.5 Tempo outside electronic music (already measured, not re-run)

From `docs/BUILD-5-PROGRESS.md` ("Tempo: non-EDM check (GTZAN)"), with
`scripts/audio-dsp/gtzan-tempo-eval.mjs`: 998 GTZAN clips with annotated
beats, the same two 10 s windows. Right ±1 BPM, shipped tempo:

| disco | hiphop | reggae | pop | rock | blues | country | metal | jazz | classical | **all** |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 89% | 80% | 75% | 70% | 62% | 59% | 56% | 52% | 47.5% | 25% | **61.5%** |

Against 84% on Beatport. So tempo is good on music with a drum machine and
weak on played, swung or rubato music, and most of the "unknown" tempos after
T3 will be there. The errors are not only octaves: on jazz and metal more
than half of the misses are neither ×2 nor ×½ (BUILD-5-PROGRESS's x/y
columns). That is why T7 is a detector change and not another fold.

Also already measured: Beat This on Beatport, octave-flagged records only,
82.7% against 80.9% (fixed 21, broke 14; inside the CI), so it ships opt-in
and off by default. It has **not** been measured on GTZAN, the music it was
built for (its paper reports state-of-the-art beat tracking across many
non-electronic sets). T5 and T7 measure it there first.

### 2.6 Where else a BPM could come from (checked 2026-11-18)

| Source | What it gives | Verdict |
| --- | --- | --- |
| Spotify `/audio-features` | tempo | Dead (403/404, README). Don't look again (CLAUDE.md) |
| Deezer `track.bpm` | an unverified BPM | **Use** (T4): 52% of mainstream, 5% of scene tracks, no extra request |
| The preview's last 10 s | 50% more audio for the detector | **Use for unsure tempos only** (T5): already reachable by the same signed URL, one more byte range |
| Beat This (self-hosted, MIT) | beat times, so a tempo and its octave | **Use on every unsure reading** (T5), default on where listening runs, once it passes its bar |
| The account's own playlists | the octave a listener files a track at | **Use for the octave only** (T2); never to raise confidence in the number |
| The listener's tap | a tempo they felt | **Optional** (T8): in-page, per account, also a check set |
| iTunes Search | a preview, no BPM | For hearing misses only (U3), not a BPM source |
| MusicBrainz, Last.fm, Discogs | no BPM field | Nothing to use |
| AcousticBrainz | BPM per recording | Shut down by MetaBrainz (stopped in 2022; dumps only, no live API), and a dump is far too large for a hosted page. Rejected |
| GetSongBPM API | BPM by artist and title | Already measured (README "Data sources"): **20% coverage** on a 40-track sample of a UK electronic library, and nothing calls it. It also needs one app key that a public page would expose, plus a backlink, and it matches by name (wrong 1 in 19 here). Rejected |
| Rekordbox, Beatport, Tunebat | DJ-checked BPM | Need an export or scraping. The owner has no Rekordbox library; not for every account (CLAUDE.md) |

So the plan uses what every account already has (the preview, Deezer's
lookup, its own playlists, a self-hosted model) and adds nothing that needs a
key, an export or an app.

---

### 2.7 Round 2 probes (2026-11-18)

**ListenBrainz genre tags on scene artists.** 30 UK scene artists (DnB,
jungle, bassline, UK garage, dubstep). The MusicBrainz id came from a
MusicBrainz name search, for this measurement only. 22 resolved; 8 hit
MusicBrainz's rate limit (503) and were not retried. Then
`api.listenbrainz.org/1/metadata/artist/?artist_mbids=…&inc=tag`, batched:

- It answers with `access-control-allow-origin: *` and needs no key, so the
  hosted page can call it.
- **17 of 22 had artist tags**, and the tags are scene-level: Hamdi
  "bass house, bassline, uk garage"; Coco Bryce "uk garage, bass music,
  jungle"; Nia Archives "jungle"; Burial "future garage, dubstep"; Sammy
  Virji "uk garage, bassline". The 5 without tags were newer or smaller
  names (Kahn, Hedex, Pa Salieu, Silva Bumpa, T2).
- 1 of 22 was a namesake ("Dimension" resolved to a jazz-fusion artist). So
  name matching is not safe here either: the id has to come from an exact
  source.
- `metadata/lookup` (MBID by artist and track name) answers **401 without a
  user token**, so it can't be used.

Compare Wikidata's genres: 4% of her artists (BUILD-8 §1.3) and 35% of 600
in the README's live sample, weakest on scene producers.

**Deezer album genre and label.** `api.deezer.com/album/{id}` (the track
lookup the page already makes carries `album.id`) returns `genres` (here
"Electro") and `label`. The genres are Deezer's top-level list (about 20:
Electro, Dance, Rap/Hip Hop, R&B, Reggae, Jazz, Latin...), so they are
family-level only. That is exactly what family first (BUILD-8 I1) and the
non-electronic families (G1) need. Coverage on her library is unmeasured.

**Essentia heads and ears for the shipped model.** The Essentia models page
(the same source and the same CC BY-NC-SA 4.0 licence as the shipped files,
`docs/models/LICENSE`) lists **28 heads on the Discogs-EffNet embedding**;
the page ships 3 of them (mood-theme, voice, danceability). Among the rest:
`mtg_jamendo_instrument`, `mtg_jamendo_genre`, `mood_{aggressive, happy,
party, relaxed, sad, acoustic, electronic}`, `nsynth_{acoustic_electronic,
bright_dark}`, `timbre`, `tonal_atonal`, `approachability`, `engagement`,
`mtt`. The page also lists **contrastive similarity ears** trained to place
tracks of the same artist (`discogs_artist_embeddings-effnet`) or the same
label (`discogs_label_embeddings-effnet`) close together, which is what
placing is.

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
- **Non-electronic coverage.** See §0 point 8 and §2.2. The ontology's
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
  is measured). For tempo the owner chose (SD2, 2026-11-18): **one sure BPM
  or "BPM unknown"**, never a guess or a pair (T3). The 0.15-0.3 band, right
  up to ×2 84% of the time (§2.3), is not shown as "about"; it is where T5's
  second opinions are tried first, because it is closest to sure.
- **Unknown is a value, not a gap.** Shuffle's mix order, Tidy's tempo sort
  and the Library range must treat an unknown tempo as unknown (left out of
  the range, placed by sound in a mix), not as 0 or as its raw reading.
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

#### T3. One sure BPM, or "BPM unknown" (lane U, S; after T2; SD2 answered)

**Goal.** A listener never sees a tempo the engine is not sure of, and never
sees a blank that looks like a bug. Owner's rule (2026-11-18): *"when bpm is
unsure we should say unknown"*.

**What.**
- `core/audio/match.mjs` (beside T2's `displayTempo`): `tempoShown(record,
  ctx)` returns `{ state: 'sure', bpm, from }` or `{ state: 'unknown', why }`.
  Sure means: confidence ≥ `BPM_MIN_CONF` (0.3) **and** the octave is settled
  (not flagged, or flagged and settled by T2's playlist/genre range, T4's
  Deezer number or T5's Beat This), or a T5/T6 rule that has passed its bar
  says so. Everything else is unknown. `why` is one of `no-audio` (never
  heard: L4's miss reason), `no-beat` (the preview has no steady pulse),
  `octave` (87 or 174, nothing settled it), `unsure` (a pulse, but the
  reading is not reliable).
- `web/audio/dsp-view.mjs`, `web/ui/sound.mjs`, `web/screens/shuffle.mjs`,
  `web/screens/tidy.mjs`, `web/app/soundslots.js`: show the number when sure;
  else "BPM unknown" in the muted text style, with the reason on tap or
  hover ("The beat wasn't clear in the 30 s preview", "Could be 87 or 174:
  file it to a playlist and it will settle", "Not heard yet: no preview on
  Deezer"). The "87/174" pair goes. A track the listener tapped (T8) shows
  their number, marked as theirs.
- Sorting and ranges: unknown tempos are left out of the Library range (E3)
  and of Tidy's tempo sort, and Shuffle's mix order places them by sound
  alone (§3.5).
- Score report: **"BPM known on N% of heard tracks"**, and per reason, so
  every later package (T4-T8) moves one printed number.

**Measure and bar.** Before shipping, on Beatport half B and GTZAN odd clips
(the held-out halves): of the BPMs `tempoShown` calls sure, **≥ 90% right in
the DJ convention** (±1 BPM, the genre's octave) on each set; the share sure
is printed, not barred (it is what T4-T8 raise). In the page: no surface
shows a raw reading (unit test over the five view models), and the Score line
prints on a library with nothing heard. **Effort** S.

#### T4. Deezer's own BPM as a free second opinion (lane E, S)

**Goal.** More tempos settled and shown on mainstream music, at no extra
cost.

**What.** `core/audio/fetch.mjs` `lookup()` keeps `json.bpm` when it is above
0 (it is in the response the page already gets); `record.mjs` stores it as
`source.deezerBpm` (optional field, no version bump). Use: (1) when the DSP
flagged half/double unsure and Deezer's number equals one of the two
candidates, take that one; (2) when DSP and Deezer agree within 2 BPM, raise
the shown confidence to at least 0.3. Never use Deezer's number alone: a
track with only Deezer's BPM and no confident reading stays "unknown" (T3).

**Measure and bar.** In the page: a Score line "Deezer and the measured tempo
agree on N of M". Before switching (2) on, on §2.2's set, the share of tracks
with a BPM shown rises **≥ 10 points**, and on GTZAN (annotated beats, looked
up on Deezer by artist and title, measurement only) the agreed readings are
right ±2 BPM on **≥ 90%**. Records heard before T4 get the field at their
next top-up. **Effort** S.

#### T5. Settle unsure tempos with more listening (lanes E + M, M)

**Goal.** Fewer "BPM unknown", from more evidence on exactly the tracks that
are unsure, at a cost paid only for them.

**What.** A ladder that runs only on records `tempoShown` calls unknown with
`why` `unsure` or `octave`, cheapest step first, each a top-up (and, after
L3, inside the same one download):
1. **Hear the rest of the preview.** Today two ~10 s windows of the 30 s
   preview are downloaded (`fetch.mjs` `windows()`); for an unsure tempo add
   the third (20-30 s), one more byte range from the same signed URL, and
   re-run `combineTempo` over three windows. More beats in the
   autocorrelation is the plainest way to a surer reading. Tempo fields only;
   the embedding stays two-window (the +0.3 top-1 of a third window was not
   worth it for sound, §5). `dsp.windows: 3` is stored.
2. **Beat This on every unsure reading**, not only octave-flagged ones, and
   **on by default** where listening runs (the owner's rule that every part
   that helps is on by default, 2026-11-16), Wi-Fi only on a phone as today.
   It settles a reading when its beat tempo agrees with D1's number or one of
   its ×2, ×½ or ×3/2 partners within 2 BPM; D1 keeps the number. When the
   two disagree the track stays unknown. `BEATS_FILL_PER_RUN` stays the
   per-run budget, now spent on the unknown list in queue order.
3. **The track's own playlists, for the octave only** (T2's range): a
   reading whose number is sure but whose octave is not is settled by the
   range of the playlist it is filed in. Never used to make an unsure number
   sure.

**Measure and bar.** Each step on its own, held-out halves (Beatport B,
GTZAN odd), against T3's rule: of the readings the step moves from unknown
to sure, **≥ 90% right in the DJ convention**, and the step must move
**≥ 15% of the unknowns it is tried on**; a step that misses either ships
switched off. In the page: Score's "BPM known on N%" before/after each step,
and L1's seconds per topped-up record. **Effort** M. **Depends on** T3 (the
rule), L1 (the timing), and best after L3 (one download).

#### T6. A confidence that means the same everywhere (lane E, S-M)

**Goal.** "Sure" is right 90% of the time on every kind of music, so that a
reading on house is not hidden for a number that only jazz needs, and a
reading on jazz is not shown for a number that only house earns.

**What.** Today one threshold (0.3) is used for all music, and the right-rate
behind it differs: on Beatport ≥ 0.3 is right ±1 BPM on 86%, and below it 85 of 104
are right up to ×2 (§2.3); on GTZAN the same 0.3 means much less (61.5% overall). Fit a small,
monotone (isotonic) map from `{ confidence, pulse, windows agreeing,
octaveAmbiguous, Beat This agreed }` to "right in the DJ convention", **per
genre family** (electronic, hip-hop/R&B, rock/metal, jazz/blues, classical,
other) on Beatport half A + GTZAN even clips. The family comes from
`identify()`'s genre path, else the artist's tags; with no family, the
strictest map. `tempoShown` uses it in place of the flat 0.3. The map is a
small constant table in `core/audio/dsp/tempo-calib.mjs`; nothing is learned
in the page and nothing is pooled across accounts.

**Measure and bar.** Held-out halves: **every family's shown BPMs ≥ 90%
right**, and the share shown **≥ +10 points** over the flat 0.3 rule on
Beatport (where the 0.15-0.3 band is 84% right up to ×2, §2.3). If a family
cannot reach 90% at any coverage it shows nothing sure from DSP alone and
waits for T5/T7. **Effort** S-M. **Depends on** T3.

#### T7. A better detector for played, swung and slow music (lane E, M-L)

**Goal.** Raise GTZAN from 61.5% without losing Beatport's 84%, so classical,
jazz, metal, country and blues stop being mostly unknown.

**What.** Measure first, on GTZAN (998 clips, already scripted) and Beatport
B, then build only what wins:
- **Beat This's own tempo as the number**, not only the octave, for music
  outside the electronic family: its beats are tracked frame by frame, so a
  tempo that drifts (rubato, swing, a live drummer) is followed rather than
  averaged away by a 6 s autocorrelation. D1 refines it to ±1 BPM only when
  D1's comb has a peak within 3% of it.
- **A tempogram over the whole heard audio** (three windows, T5) with
  harmonic summation over 1, 2, 3 and 4 beat periods, so 3:2 and 4:3 ghosts
  (the "neither ×2 nor ×½" misses on jazz and metal) lose to the true pulse.
- **A wider slow range**: `tempo()` searches 60-200; ballads, classical and
  doom sit at 50-70. Searching 45-220 with the prior unchanged, gated by
  `pulse` as the slow fold is.
- **Which wins, per family**: the combined rule picks D1 or Beat This per
  genre family by T6's calibration, not by hand.

**Measure and bar.** GTZAN odd clips (held out; tune on even): **≥ 70% right
±1 BPM overall (from 61.5%), no genre down by more than its CI**; Beatport B
**no loss** (84.0%). In the page: Score's "BPM known on N%" on non-electronic
playlists, before/after. If Beat This does not beat D1 on GTZAN either, the
package records the number and stops (as P1/P2 did). **Effort** M-L.
**Depends on** T5 (three windows, Beat This on by default), T6.

#### T8. Tap the beat on an unknown tempo (lane U, S; optional)

**Goal.** A listener who knows the tempo can set it in two seconds, and the
engine gets a true check set from every account that uses it.

**What.** On "BPM unknown" in the sound card, a "Tap the beat" control: eight
taps or more, median interval, snapped to D1's nearest candidate within 4%
when there is one. Stored per account beside the record as
`tap: { bpm, at }`, synced like other per-account choices, shown as theirs,
and never pooled or sent anywhere. Score reports "taps agree with the
measured tempo on N of M" (the in-page check set the owner's library has
never had, since there is no Rekordbox export).

**Bar.** Display and measurement only; must not change any other track.
**Effort** S.

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

## 4b. Round 2: deeper and broader (2026-11-18)

The same format and rules as §4: every bar is read in the page, a package
that misses ships display-only, nothing is pooled across accounts, no
Spotify content goes into a model. Ranked within each stage by expected gain
per effort.

### Listen

#### F1. A second lookup on Deezer itself when the ISRC misses (lane K, S-M)

**Goal.** Hear tracks whose Spotify ISRC is not the one Deezer files the
same recording under (re-releases, compilations, label re-uploads).

**Why.** `NOT_ON_DEEZER` is often "not under this ISRC": the same master is
issued under several ISRCs. L4's funnel will count it; U3 goes to another
service, while this stays on Deezer.

**What.** For an `ISRC` miss only, `search?q=artist:"…" track:"…"` through
the same JSONP path. Accept only if the artist name is identical after
normalising, the title matches after removing "(Original Mix)" and similar
suffixes, and **the duration is within ±1 s** (tighter than `IDENTITY`'s
±3 s, because there is no ISRC). Store `source.kind: 'deezer-name'`. The
record is used for sound but never on the ISRC-strict paths (R2's
cross-release evidence, the shared table).

**Measure and bar.** Before switching on, in the page: take 200 heard tracks
(ISRC found), pretend each missed, and run the name lookup. It must find
the same Deezer track id on **≥ 97%**, with the wrong-track rate
**≤ 1%** (against name-only's 1 in 19). Then L4's funnel: **≥ 25% of ISRC
misses heard**. **Effort** S-M.

#### F2. Hear the leftovers first (lane M, S; serves BUILD-8 S2, N1, D1)

**Goal.** The tracks that build 8's weakest packages need are heard before
the rest of the library.

**Why.** S2's small playlists have 7 or 8 heard members, N1's artist
pooling needs several heard tracks per artist, and D1 names DnB against her
own sub-genre playlists. All three run short of *heard* tracks before they
run short of method.

**What.** `core/audio/queue.mjs`, two tiers placed after "unfiled liked
songs": (1) **every member of a playlist with under 12 heard members**;
(2) **up to three tracks of each never-filed artist** in the inbox, chosen
from the artist's most-played tracks (CLAUDE.md: rank by `/me/top/artists`
and recently played, which is Spotify-native and universal). Order inside
each tier: most-listened artists first, as today.

**Measure and bar.** In the page, printed by L4: heard share of members of
under-12 playlists (**bar 100%** once the queue reaches the tier),
never-filed artists with ≥ 3 heard tracks (**bar ≥ 60%** of those with
three tracks in the library), and the time to the first File card
unchanged (BUILD-8 §4.2). **Effort** S. **Depends on** nothing; best before
N1 and S2 are scored.

### Analyse

#### H1. More heads on the same embedding (lane E, S-M)

**Goal.** More labels per heard track and a richer profile, at almost no
listening cost.

**Why.** M2's mood chips earn 1 of 8, mostly because of "only N of 12 heard"
and low precision on the 56-class mood-theme head. Binary heads
(`mood_party`, `mood_relaxed`, `mood_aggressive`) are trained for exactly
one question each. For non-electronic playlists, instruments and
acoustic/electronic separate what styles don't (§2.2: hip-hop against rnb,
soul against pop).

**What.** Ship the heads as files under `docs/models/` (each a few hundred
KB; same licence; credited where the others are), run them in `heads.mjs` on
the embedding already computed, and store a small `labels2` block on the
record (no `MODEL` bump, R1). Use them in two ways: (a) as mood and
instrument chips through M2's existing earn-your-place gate; (b) as a
16-number profile appended to the placement vector **with a weight fitted
per account on Score's held-out folds** (zero when it doesn't help, as E2
does).

**Measure and bar.** (a) M2: **chips earned 1 → ≥ 3 of 8** at M2's
precision bar. (b) On §2.2's broad set first, then her Score: **≥ +1 top-1
overall, ≥ +3 on hip-hop/rnb/soul/pop**, no loss on scene genres. If (b)
misses, (a) still ships. **Effort** S-M. Cost check: L1's model time per
track rises **≤ 5%**.

#### H2. A rhythm fingerprint (lane E, M)

**Goal.** Tell apart the scene genres that sound alike to the ear but are
played differently: UK garage's 2-step, bassline's four-to-the-floor at 135,
jungle's chopped breaks against a rollers' steady 2-step, dancehall's
riddim against afrobeats.

**Why.** The ear's weakest scene genres are rhythm genres (§2.1: UK garage 7
of 25, bassline 15 of 25; §2.2: dancehall 17, hip-hop 15). Discogs-EffNet
looks at about 2 s of spectrogram at a time, which is shorter than one
bar, so the pattern across a bar is barely in the embedding.

**What.** `core/audio/dsp/rhythm.mjs`: from the four band onset envelopes
that `tempo.mjs` already computes (kick, body, snare, hats), fold each onto
one bar of 16 steps at the measured tempo. Align to the downbeat where Beat
This gave one (T5), else make it shift-invariant by taking the magnitude of
the 16-step DFT. That gives 4 × 16 numbers per track, normalised and
stored as `dsp.rhythm`, appended to the placement vector with a per-account
fitted weight (as H1(b)). It is computed in the worker from audio already
decoded; no new model.

**Measure and bar.** §2.1's scene set and §2.2's broad set (scripts exist):
**≥ +3 top-1 on the scene set**, ≥ +5 on UK garage, bassline and jungle
together, no loss on the broad set. Then her Score: no loss overall, and
D2's DnB sub-genre line rises. A miss closes it (as P1/P2). **Effort** M.

#### H3. A similarity ear (lane E + M, M; after BUILD-8 A3)

**Goal.** An ear trained to put tracks of the same artist or label close
together, which is closer to "goes in the same playlist" than style
labels are.

**Why.** The ear's geometry is where scene genres sit at 68% (§2.1). MAEST,
a bigger *style* model, did not beat it (61 against 60), so a bigger model
of the same kind is not the lever. A model trained on *similarity* is a
different bet.

**What.** Measure first: `discogs_artist_embeddings-effnet` and
`discogs_label_embeddings-effnet` on §2.1 and §2.2 with `eval.mjs`
(leave-one-out centroid, the same windows). Only the winner goes on, as a
second ear in `EARS` (R1), filled by a top-up through L3's single download,
and used per account only when the Score gate picks it (`gate.mjs`
`earChoice`, as for MAEST). About 18 MB, the same as the first ear.

**Measure and bar.** Public sets: **≥ +3 top-1 on the scene set, no loss on
the broad set**, or it stops there. Her Score: **≥ +1 overall and no loss
on never-filed**. **Effort** M. **Depends on** A3 (BUILD-8 §4.1: no model
package before the learning curve), R1, L3.

#### K1. "Key unknown", and the whole preview for unsure keys (lanes U + E, S)

**Goal.** Key follows the same rule as tempo, and more keys are sure.

**Why.** Key shows at ≥ 0.65 or not at all, so a blank means unsure (the
same problem T3 fixes for BPM). Key was found to need "more audio than two
10 s windows" (BUILD-5-PROGRESS key v3 conclusion), and T5 downloads the
third window for unsure tempos anyway.

**What.** `tempoShown`'s twin `keyShown` (sure / unknown with a reason), used
by the same five view models; the reason on tap is "Not sure from the 30 s
preview". When T5 fetches the third window, also re-run key v4 on all three
for records whose key is unsure (`keepKeyNet` keeps the rest).

**Measure and bar.** Beatport half B, held out: **sure keys on 85% → ≥ 90%
of tracks** at the same right-rate (62.5% exact, 71.3% MIREX on sure
keys), or the third-window part ships off. **Effort** S. **Depends on** T3,
T5.

### Suggest a genre

#### G3. MusicBrainz genres through ListenBrainz (lane K, S; supplements BUILD-8 W1)

**Goal.** Scene artists that Last.fm and Wikidata don't know get
fine-grained genres, with no key and no MusicBrainz call from the browser.

**Why.** Wikidata knows 4% of her artists (BUILD-8 §1.3). ListenBrainz had
tags for 17 of 22 scene artists with an MBID, at scene level (§2.7). W1's
MusicBrainz step is blocked on a browser probe; this needs none.

**What.** `core/sources/listenbrainz.mjs` (it already holds the
similar-artist call): `artistTags(mbids)` batched through
`/1/metadata/artist/?inc=tag`, through the same spaced queue as Wikidata
(`keyless.js`), obeying the `X-RateLimit-*` headers it exposes, and
visible-tab only. **MBIDs only from exact sources**: Wikidata's Spotify id
→ MBID (already fetched), or MusicBrainz's Spotify URL relation if W1's
probe passes. Never by name (1 of 22 namesakes in §2.7). Tags map through
the same vocabulary as Last.fm's (`genre_mbid` marks MusicBrainz's curated
genres, which are preferred), fill artists with no tags only, never go to
the shared table, and show as "MusicBrainz" in Settings' sources (the
owner's rule that every source that helps is on and shown, 2026-11-16).

**Measure and bar.** W1's coverage line: **share of never-filed artists with
at least one genre source, +10 points**, and top-1 no loss. Also print
"MusicBrainz tags for N of M artists with an MBID". **Effort** S.

#### G2. An artist's genre from its own sound (lane E, S-M; with BUILD-8 N1, W1)

**Goal.** An artist no source knows, but with three or more heard tracks,
gets a genre anyway.

**Why.** After G3 and W1, the artists left are the newest scene producers:
exactly the ones in her inbox. Naming by sound is 72% right on genre and 92%
on sub-genre when it names one (BUILD-8 §1.1), and pooling three tracks is
steadier than one (N1's premise).

**What.** N1's pooled artist vector → `identify()` → the artist's genre, with
`source: 'sound'` at a weight below every tag source. Used only where the
artist has no tags; never shared; shown as "by its sound" and replaced as
soon as a tag source answers. An artist whose heard tracks name different
families gets none (a mixed artist is left to the per-track path).

**Measure and bar.** Before switching on, on her artists that **do** have
tags (held out): the sound-named family agrees with the tags' family on
**≥ 85%**, and the sub-genre on ≥ 70% where both name one. Then the
coverage line **+15 points** on never-filed artists, and N1's never-filed
top-1 no loss. **Effort** S-M. **Depends on** N1 (the pooled vector), F2
(three heard tracks).

#### G4. Deezer album genre and label (lane K, S)

**Goal.** Every heard track gets a family-level genre and a record label
from the service already used to hear it.

**Why.** Family first (I1) needs family evidence, and G1's non-electronic
families need a name from somewhere for artists outside Last.fm. BUILD-8
L1 fits label identity and needs labels.

**What.** `fetch.mjs`: after a successful track lookup, the album id is
known; fetch `/album/{id}` once per album (cached per album, 90 days, inside
the 50-per-5-s budget, behind the track lookups in priority). Store
`source.deezerGenres` (ids) and `source.label`. Map Deezer's ~20 genres to
ontology families in `audio-vocab.mjs`. Used as a family vote at a low
weight in `identify()` and as I1's family evidence; never at sub-genre
level.

**Measure and bar.** In the page: share of heard tracks with a Deezer
genre (printed), family top-1 on never-filed artists **+2 points**, or the
share of tracks with any family evidence **+15 points**, with no loss
overall. Label: handed to BUILD-8 L1 as data, no bar here. **Effort** S.

#### D2. Drum & bass sub-genres by sound (lane E, M; the sound half of BUILD-8 D1)

**Goal.** Rollers, jungle, liquid, neuro and jump-up named from the
account's own sub-genre playlists, not from the ear's labels, which have
none of them except Jungle.

**What.** T1 (the tempo penalty) plus: H2's rhythm fingerprint (jungle's
breaks against rollers' 2-step is a rhythm difference); prototypes from
her own DnB sub-genre playlists, with S2's borrowed family prior for the
small ones (Jungle Alarms 1 of 8); G3's tags ("jungle", "liquid funk" are
MusicBrainz genres) as the artist vote. All three already exist as sources
in `identify()` or will after their packages; D2 is their weights, fitted
on her Score.

**Measure and bar.** D1's bar: **DnB named 77/199 → ≥ 110/199 at ≥ 90%
sub-genre precision**. **Effort** M. **Depends on** T1, H2, S2.

### Suggest a playlist

#### B2. Big mixed playlists, the sound side (lane E, M; extends BUILD-8 B1)

**Goal.** B1's diagnosis says *why* Alt/Indie (19% of 54) and Chill
Rap/HipHop (25% of 51) are weak; B2 adds the sound evidence for each
answer.

**What.** For each playlist B1 flags: (1) **spread by stage**: compute B1's
cluster count separately on the embedding, H1's labels and H2's rhythm. A
playlist that is one cluster in mood but three in style is a *mood*
playlist, and it should be matched on mood, by S1's per-situation weights;
(2) **per-window scoring reopened only here** (P2 measured ±0.1 globally,
but a two-sound playlist is its one possible use); (3) the Library row says
which it is ("Chill Rap/HipHop is held together by mood, not sound").

**Measure and bar.** B1's: **+5 recall where medoids or mood-matching
apply**, no loss elsewhere; else the Library sentence is the deliverable.
**Effort** M. **Depends on** B1, H1.

#### P3. Listening sessions as a weak vote (lane K, S; probe first)

**Goal.** Use what the listener plays around a track as evidence of where
it goes.

**What.** `/me/player/recently-played` (50 items, with each item's
`context`) is read when the page opens and appended per account, locally.
A liked, unfiled track that is played repeatedly between members of
playlist X gets a small vote for X. It is Spotify-native, universal, and
needs no file.

**Measure and bar.** After two weeks of normal use, the share of unfiled
inbox tracks with ≥ 2 session neighbours in one playlist. **If under 10%,
close it.** Otherwise a Score arm: **+1 top-1** on those tracks. **Effort**
S. Honest risk: 50 items per read is small, and most listening may be
playlist-context plays of tracks already filed.

### Rejected or deferred in round 2

| Idea | Why not now | What would reopen it |
| --- | --- | --- |
| A large self-supervised music model (MERT and similar) | 90M+ parameters, several times MAEST; non-commercial weights; MAEST (bigger than the first ear) gained 1 point | H3 wins, and A3 says the ear, not coverage, is the limit |
| Lyrics or vocal language (Whisper-class model in the page) | 40 MB and up, slow on a phone, only vocal tracks, 30 s of lyrics | A listener with language-split playlists (Latin, K-pop) on Score |
| YouTube, SoundCloud, Bandcamp audio | No public CORS preview API, or the terms bar it | Never on the core path |
| Audius (open API, full tracks) | Small catalogue, name matching only | After U3, as a bonus probe, if L4 shows scene misses are large |
| ListenBrainz `metadata/lookup` by name | Needs a user token (401, §2.7) and is name matching | Never on the strict path |
| Spotify artist `genres` | Absent for every artist (README) | Spotify restoring it |
| GetSongBPM | 20% coverage, a public key, name matching (§2.6) | Never |

## 4c. Which package moves which number

Every number is printed by the page (Score, the Listening line or Engine), so
progress is read where the owner reads it.

| Number (today) | Packages that move it | Bar |
| --- | --- | --- |
| Blend top-1 overall (66 / 89) | S1 (built), H1, H2, H3, G4, B2 | each no loss; H1 ≥ +1, H3 ≥ +1 |
| Never-filed artists (58 blend, 63 sound) | F2, U4, G2, G3, BUILD-8 N1 | N1 +3, U4 +3, G2 no loss |
| Small playlists (Dancehall 0/7...) | F2, BUILD-8 S2, D2 | S2 +10 recall on the under-12 group |
| Big mixed playlists (19% / 25%) | B2, BUILD-8 B1 | +5 recall where it applies |
| DnB named (77/199) | T1, H2, D2, G3 | ≥ 95 (T1), ≥ 110 at ≥ 90% (D2) |
| Tempo fits (51% of 213) | T1, T2 | ≥ 70% |
| Artist genre coverage (Wikidata 4%) | G3, G2, G4, BUILD-8 W1 | G3 +10, G2 +15, W1 +10 points |
| BPM known on N% of heard (new line) | T4, T5, T6, T7, T8 | shown BPMs ≥ 90% right; each step ≥ 15% of unknowns |
| Sure keys (85% of tracks) | K1 | ≥ 90% at the same right-rate |
| Heard share (572 of 600) | F1, U3, L4 | F1 ≥ 25% of ISRC misses; U3 ≥ 30% |
| Mood chips earned (1 of 8) | H1, F2, BUILD-8 M2 | ≥ 3 of 8 |
| Seconds per track (unmeasured) | L1, L2, L3, U1, U2 | L2 1.4×, U1 2.5×, U2 3× |

---

## 5. What cannot be fixed, and what to do instead

| Limit | Why it can't be fixed | What to do instead |
| --- | --- | --- |
| **No Deezer preview** (not on Deezer, no preview, region-locked) | The page can only hear audio a public, CORS-open source serves; Spotify's own previews are gone for new apps | Place from tags, the bridge and the artist's other heard tracks (U4); try a second source (U3); L4 says how many |
| **No ISRC** (local files, some uploads) | Nothing to look the recording up by, and name matching was wrong 1 time in 19 | Same as above; never guess by name on the strict path |
| **Spotify's audio features** | `/audio-features` and `/recommendations` answer 403/404 (README) | Tempo and key from the preview (§2.3) |
| **The preview is 30 s, and only 20 s is heard** | Deezer serves 30 s; a third window measured +0.3 top-1 for 50% more work (`scripts/audio-near`) | Keep two windows for sound; hear the third only for unsure tempos (T5); T3 says "BPM unknown" rather than guess |
| **A track whose character is outside the clip** (long intro, a drop after 2 min) | The preview's position is Deezer's choice | Sections and hybrids already flag a clip that changes (`sections.mjs`); the listener's tap corrects it and the learner keeps it |
| **Key on every track** | Measured at its limit for 20 s (57.3% exact; BUILD-5-PROGRESS "Key v4") | Show sure keys only (85% of tracks); no new key work (BUILD-8 D3) |
| **Tempo that changes inside a track** | One BPM per track is the display's shape | The windows disagreeing lowers confidence (`combineTempo`); shown as "BPM unknown" (T3), or tapped by the listener (T8) |
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
| S1 | **T2**, **T3**, **T4** (lanes E + U), **L2**, **L3** (lane M) | After T1; L2/L3 own `worker.js`/`controller.mjs`. T3 goes first in the wave: it sets the "unknown" rule the rest measure against |
| S1b | **T5**, **T6** (lanes E + M), **T8** (lane U) | After T3 and L3; T5's top-up lives in `controller.mjs` (lane M), so it follows L2/L3 in the same thread or after them |
| S1c | **F2** (lane M), **G3**, **G4** (lane K), **K1** (lanes U + E) | F2 any time after L1; G3 and G4 are small and share the keyless queue, so one thread; K1 after T3/T5 |
| S2 | **G1**, **T7** (lane E, one after the other); **H1**, **H2** (lane E) | G1 after BUILD-8 wave 1 (I1, I2); T7 after T5/T6; H1 then H2, since H2 reuses H1's fitted-weight slot |
| S2b | **G2**, **D2** (lane E), **F1** (lane K) | G2 after N1 and F2; D2 after T1, H2 and S2 (it is build 8's D1, so the build 8 thread owns it or hands it over) |
| S3 | **U1**, then **U2** (lane M); **U3** (lane K); **U4** (lane E, after N1); **H3** (lane E + M, after A3); **B2** (lane E, after B1); **P3** (lane K, probe) | Last; each needs L1's before |

**File ownership added.** Lane M (measure and listening speed):
`core/audio/worker.js`, `web/audio/controller.mjs`, `docs/audio-worker.js`'s
source in `build-web.mjs`. Lane E adds `core/ontology/tempo.mjs`,
`core/ontology/genres.mjs`, `core/sources/audio-vocab.mjs`. Lane U adds
`web/audio/dsp-view.mjs`, `web/ui/sound.mjs`. T3's `tempoShown` and T2's
`displayTempo` live together in `core/audio/match.mjs` (lane E); T6's table
in a new `core/audio/dsp/tempo-calib.mjs` (lane E).
Round 2: lane K adds `core/sources/listenbrainz.mjs` `artistTags` (G3) and
the album fetch in `core/audio/fetch.mjs` (G4, F1; shared with lane M, so
G4/F1 go after L2/L3 or in the same thread); lane E adds
`core/audio/dsp/rhythm.mjs` (H2) and the head list in `core/audio/heads.mjs`
(H1); lane M owns the queue tiers in `core/audio/queue.mjs` (F2). The keyless
queue in `web/app/keyless.js` belongs to BUILD-8 W1's thread: G3 goes there,
or after it.

**Owner decisions.**

| Id | Question | Recommendation |
| --- | --- | --- |
| SD1 | Show BPM in the listener's convention (174 for DnB, the playlist's own octave first) rather than as measured? | Yes: the measured octave is a convention, and the playlist says which one this listener uses |
| SD2 | Show "~174" for unsure tempos (T3) instead of nothing? | **Answered 2026-11-18: no.** Unsure shows "BPM unknown", and the engine is improved so fewer are unsure (T5-T8) |
| SD3 | Try a second preview source (U3, iTunes Search, name + length match, bonus only)? | Yes to the probe; decide on the rest from its result |
| SD4 | Use more of a computer's cores and its GPU while listening (U1, U2)? | Yes on a computer; phones unchanged |
| SD5 | May an artist nobody has tagged be given a genre from its own sound (G2), shown as "by its sound"? | Yes: it is local to the account, replaced by any real tag, and only switched on past its 85% bar |
| SD6 | May the page read recently played and keep it locally, to learn from listening sessions (P3)? | Yes to the two-week probe; it reads only what Spotify already shows her |

## 7. Progress table

| Id | Package | Wave | Lane | State | PR | Bar |
| --- | --- | --- | --- | --- | --- | --- |
| T1 | Double time counts for DnB | S0 | E | Built, awaiting her Score run | | DnB named ≥ 95/199; tempo fits ≥ 70% |
| L1 | Time every stage | S0 | M | Built (display and measurement only): per-stage timings per track and per top-up in the controller, rolling median on the Listening panel and in the Score report; key `bf_listen_timing` | | measurement |
| L4 | Hearing coverage funnel | S0 | M | Built (display only): library → ISRC → Deezer → preview → downloaded → heard, with miss reasons, in Settings › Listening and as Score report lines | | display |
| R1 | A new ear never switches sound off | S0 | E | Not started | | guard test |
| T2 | One BPM everywhere | S1 | E, U | Built: `displayTempo`/`foldIntoRange` in `core/audio/match.mjs`; `identify().bpm.shown` feeds "Sounds like", Tidy and the Library range (folded to the playlist genre's octave); sound card and Shuffle fold with the same helper. Bar unit-tested on Beatport-shaped numbers (DnB 19 → 39 of 40 in range, 0 of 142 house/techno moved); the real-set run needs the Beatport files (not in this checkout) and her Score run prints the in-range lines | | +15 in range; ≤ 1% moved on house/techno |
| T3 | One sure BPM or "BPM unknown" | S1 | U | Built: `tempoShown` (sure / unknown with `why`), "BPM unknown" on the sound card, "Sounds like", Tidy and Shuffle; the 0.15-0.3 band stays unknown (SD2: no "about"); Score prints "BPM known on N%" with reasons. The ≥ 90% right bar is not yet measured (needs Beatport half B / GTZAN odd) | | shown BPMs ≥ 90% right; "known on N%" printed |
| T4 | Deezer BPM as a second opinion | S1 | E | Built: `lookup()` keeps `deezerBpm`, stored as `source.deezerBpm` (no version bump; top-up fills older records); `tempoOf` applies it (settles a flagged octave when it equals a candidate, agreement within 2 BPM raises conf to 0.3, disagreement keeps the measured one; never alone, so no-preview stays unknown per SD2); Score line "BPM from Deezer: agrees on X%". Unit-tested on shapes of §2.4 (76%/84%); **GTZAN not in this checkout: the ≥ 90% right and +10 shown bars are unmeasured** | | +10 shown; ≥ 90% right on GTZAN |
| L2 | Prefetch the next track | S1 | M | Built: `runQueue` fetches the next track (lookup + both windows) while this one is heard, one ahead, dropped on stop; scripted run (15 ms lookup, 35 ms download, 50 ms model, 8 tracks) 1.6× tracks/min, records identical (`test/audioprefetch.test.mjs`); real-device number needs a Score run with L1 | | ≥ 1.4× tracks/min |
| L3 | One download per top-up | S1 | M | Built: a per-run cache of the raw preview windows (`createPreviewCache`, 64 records, no URL kept) shared by the four top-ups; 1.0 downloads/record on the test, records identical; `ctrl.topupDownloads()` | | ≤ 1.1 downloads/record |
| T5 | Third window + Beat This on unsure tempos | S1b | E, M | Not started | | each step: ≥ 90% right, ≥ 15% of unknowns settled |
| T6 | Calibrated tempo confidence per family | S1b | E | Not started | | every family ≥ 90%; +10 shown on Beatport |
| T8 | Tap the beat | S1b | U | Not started | | display/measurement |
| P1, P2 | Centred space, per-window scoring | – | E | Closed (measured, §2.1) | | −2.7 / ±0.1 top-1 |
| G1 | Genres beyond electronic | S2 | E | Not started | | +10 on the broad set; no loss |
| T7 | Better detector for played/swung music | S2 | E | Not started | | GTZAN ≥ 70%; Beatport no loss |
| U1 | Worker per core | S3 | M | Not started | | ≥ 2.5× on 4 cores |
| U2 | WebGPU | S3 | M | Not started | | ≥ 3× model step |
| U3 | Second preview source | S3 | K | Not started | | ≥ 30% of misses heard |
| U4 | Unheard tracks by artist sound | S3 | E | Not started | | +3 on those tracks |
| F1 | Deezer name lookup for ISRC misses | S2b | K | Built | Built (F1 branch): `core/audio/namematch.mjs` + `lookupByName` in `fetch.mjs`; side fields `source.kind 'deezer-name'` + `source.match`, `nameTried` on misses; funnel "Found by search". Fixture-measured only; the 200-track real-library bar is still open. | ≥ 97% same track; ≥ 25% of misses heard |
| F2 | Hear the leftovers first | S1c | M | Built | Built: `leftovers` option of `audioQueue` (page passes it): small-playlist tier only; the never-filed-artist tier is tier 2 itself (their tracks are all unfiled liked songs). Bars read in the page. | 100% of under-12 members; ≥ 60% never-filed artists at 3 heard |
| H1 | More heads on the same embedding | S2 | E | Not started | | chips 1 → 3 of 8; +1 top-1 |
| H2 | Rhythm fingerprint | S2 | E | Not started | | +3 top-1 on the scene set |
| H3 | Similarity ear | S3 | E, M | Not started | | +3 scene set; +1 on Score |
| K1 | "Key unknown"; whole preview for unsure keys | S1c | U, E | Not started | | sure keys 85% → 90% |
| G2 | Artist genre from its own sound | S2b | E | Not started | | ≥ 85% family agreement; +15 coverage |
| G3 | MusicBrainz genres via ListenBrainz | S1c | K | Not started | | +10 coverage |
| G4 | Deezer album genre and label | S1c | K | Not started | | +2 family top-1 or +15 coverage |
| D2 | DnB sub-genres by sound | S2b | E | Not started | | 110/199 at ≥ 90% |
| B2 | Mixed playlists, sound side | S3 | E | Not started | | +5 recall where it applies |
| P3 | Listening sessions | S3 | K | Not started | | probe: close under 10% |
