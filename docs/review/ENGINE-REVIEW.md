# Betterfy matching engine: deep review (2026-11-16)

This review asks how well the app listens to tracks and uses real knowledge
and evidence to match genre, sub-genre and mood playlists, and what the
strongest design would be. It was written from `main` at `e491a9e` and is
review only: no code was changed. It pairs with
[USER-REVIEW.md](USER-REVIEW.md) and
[HANDOFF-2026-11-16.md](../archive/HANDOFF-2026-11-16.md).

All numbers here come from the repo's own docs:

- AUDIO-ANALYSIS-PLAN §0
- SMARTER-GENRES-PLAN (the owner's run, 2026-11-15)
- the build 6 progress notes

Estimates are labelled as estimates.

## The answer

On the owner's library (run of 2026-11-15: 29 genre playlists, 600 scored
tracks):

- the top pick is right **58%** of the time;
- the right playlist is in the top three **79%** of the time;
- the engine is **never confident enough to call anything Sure**.

Listening is built and measured on test sets, but it has not yet been scored
on the owner's library.

The gap is not one missing model. Four things hold matching back:

- Almost all knowledge is about the **artist**, not the track.
- Listening reduces each playlist to **one average sound**.
- Genre and sub-genre are **one flat choice among 29**.
- **Mood playlists get no suggestions at all.**

The strongest design fixes each one. It hears each track against every
member of a playlist. It looks up knowledge **per recording** by ISRC. It
decides **family first, then sub-genre**. It weighs each source by how often
it has been right **on the owner's filing**. It commits only when the
evidence agrees.

Estimated result: **70 to 78% top-1 on sub-genre, about 90% on family, and
Sure on a third or more of cards.** This is an estimate, not a measurement.
Each layer below has its own number and bar.

## How a track is matched today

Three engines score every (track, genre playlist) pair. A fitted blend joins
them, and a calibrator decides how sure to sound.

1. **Tag engine** (`core/engine.mjs`). Sources are Last.fm, Discogs,
   Wikidata and the shared tag table, almost all keyed by **artist**. Tags
   are mapped onto the genre ontology (`core/ontology/genres.mjs`: parents,
   aliases, contradictions).
2. **Account-native engine** (`core/intrinsic/space.mjs`). It uses where the
   owner filed this artist and its Deezer/ListenBrainz similar artists, plus
   weak hints (era, label, album type, popularity).
3. **Sound** (`core/intrinsic/audio.mjs`, `audio-learn.mjs`).
   - Input: two 10-second windows of the Deezer preview, run through
     EffNet-Discogs. MAEST is optional on laptops.
   - Each playlist becomes one centroid, or a small logistic model once it
     has 10 or more heard members.
   - Sound gets a say only after `core/validate/gate.mjs` sees +5 points on
     never-filed artists with no loss overall. Until then it is display-only.
4. **Blend and calibrate** (`core/intrinsic/blend.mjs`, `calibrate.mjs`).
   - One tag-vs-native weight per account.
   - Temperature plus isotonic calibration.
   - "Confident" means the calibrated lower bound clears 9 in 10.
5. **Mood, context and unnamed playlists** are excluded
   (`core/playlists/axes.mjs`). Only a playlist whose name names a genre
   receives suggestions.

| Measured | Top-1 | Top-2 / 3 | Source |
| --- | --- | --- | --- |
| Owner's library, tag engine | 54% | 77% (top-3) | SMARTER-GENRES, owner run 2026-11-15 |
| Owner's library, native + similar artists | 58% | 79% (top-3) | same run |
| Owner's library, never-filed artists, without → with similar artists | 11% → 49% | | same run |
| Owner's library, confident calls | none | | same run |
| Sound alone, 15 genres, ~9 examples each (EffNet) | 58% | 76% (top-2) | AUDIO-ANALYSIS §0 |
| Sound alone, 40 examples each (learner) | 70% | 88% (top-2) | AUDIO-ANALYSIS §0, WP-L1 |
| Sound alone, EffNet + MAEST joined | 64% | 86% (top-2) | AUDIO-ANALYSIS §0, WP-C1 |
| Genre labels read straight off the model | 29% | 58% (top-3) | AUDIO-ANALYSIS §0 |
| Tempo within ±1 BPM (confidence ≥ 0.3) | 86% | | Beatport set |
| Key exact / MIREX (v3) | 55% / 65% | | Beatport half B. Below the 60% bar, so hidden |

The sound rows use playlists by other people on Deezer, named after a genre,
not the owner's filing. Their confusions sit between real neighbours: UKG and
bassline, speed garage and UKG, trance and donk.

## Where it is weak

Each row compares current behaviour with the strongest available approach.
Rows are ranked by expected cost on a scene-heavy electronic library.

| # | Weakness today | Best available approach | Why it matters |
| --- | --- | --- | --- |
| 1 | **Knowledge is per artist.** An artist who makes house and techno gets the same tags on every track | Per-**recording** knowledge. Go ISRC → MusicBrainz recording → release, then read the release-group's community genres and the Discogs release it links to, whose **styles** are set per release. Use Last.fm `track.getTopTags` where a key exists | Sub-genre is exactly where artists cross over |
| 2 | **One average sound per playlist** (a centroid, or a linear model built from it) | Score against the playlist's **nearest members** (k-NN) as well as its average: the standard few-shot approach when a class has sub-styles | A "Jungle & Breaks" or "UKG" playlist holds two or three sounds. Its average sits between them |
| 3 | **Two 10 s windows** of a 30 s preview | Three or four windows, pooled, with disagreement kept as a hybrid signal | Phase 0 saw tracks change between intro and drop. It costs about 0.1 s per track |
| 4 | **Flat choice among 29 playlists.** Rollers vs Jungle counts as wrong as Rollers vs Techno | **Hierarchical**: family first (DnB, garage, house, techno, hard dance…), then the sub-genre inside it. The ontology already has parents | The measured confusions are almost all inside a family |
| 5 | **One blend weight** (tags vs native); sound gated on or off; the same weight for every track | Weigh each source by its **measured reliability on the owner's filing** and by situation, and let **agreement** between independent sources drive confidence | This is why nothing is ever Sure: calibration sees one blended score, not "three sources agree" |
| 6 | **Learning waits for a refit.** Accepts, rejects and moves feed `audio-feedback.mjs` and the correction log, but the next card doesn't change | Online prototype update: a filing joins the playlist's members **now**, and a reject marks (artist, playlist) negative **now** | The teach queue (#142) failed its gate because single answers barely count. Same fix |
| 7 | **Mood playlists get nothing** | Mood is multi-label. Score each mood playlist on its own (fits or not) from its members' sound plus tempo and energy, shown as an "also fits" chip | The owner asked for mood matching |
| 8 | **Model labels** are weak names (29%), and the mood/voice/energy heads are unreviewed | Use the model as an ear (embedding) and the owner's playlists as the names, as already planned. Labels only as tie-breakers after the label review passes 70% | Correct as built. Keep it |
| 9 | **Key** at 55% exact | A small learned key model (S-KEY class, about 325 KB), or Beat This, both already scoped | Matters for DJ ordering, not genre. Keep it hidden until it passes |

The ear is good: MAEST plus EffNet reach 64% top-1 from about nine examples
per genre. The bigger wins are around it: weaknesses 1, 2, 4 and 5.

## The strongest design

Five layers. Each is usable by any account with no key and nothing to
install, and each stays within CLAUDE.md and SMARTER-GENRES §3:

- Pretrained models hear Deezer's preview, not Spotify data.
- Weights are fitted on the account's own filing and stay on the device.
- Nothing is pooled across accounts.

### 1. Listen properly

- **Three windows** across the preview (start, middle, late), pooled. Keep
  the per-window spread as evidence of a hybrid.
- **Two ears where the device allows**: EffNet everywhere, MAEST added on
  laptops (64% vs 56% top-1 on the same set).
- **Average plus nearest members.** The score mixes the cosine to the
  centroid with the mean cosine to the 3 to 5 closest heard members. The mix
  is fitted on the owner's filing.
- **Tempo as evidence, key not yet.** Use tempo as a soft BPM range per
  playlist: it separates 128 house, 140 garage and 174 DnB.

### 2. Know each recording, not just the artist

- **ISRC → MusicBrainz recording → release → release-group genres and tags,
  plus the linked Discogs release → its styles** ("Liquid Funk", "Jungle",
  "Speed Garage").
- **Trust order per track:** release styles > recording or release genres >
  artist tags > similar-artist bridge. Every source carries its level.
- **Verify first:**
  - that MusicBrainz answers a browser request (`musicbrainz.mjs` assumes a
    custom User-Agent is needed, which a browser can't set);
  - that Discogs' release endpoint is keyless at its free rate.

  If either check fails, that source is a laptop-only bonus, per CLAUDE.md.
  The first number to take is coverage on the owner's liked songs.

### 3. Decide family first, then sub-genre

- Group the genre playlists by ontology parent.
- Step one picks the family; its probability is the sum of its playlists'.
- Step two picks inside the family, where sound and release styles weigh
  most.
- The card says "**Drum & bass**: Rollers or Jungle?", with the family
  committed and only the last step asked.

### 4. Weigh evidence by what has been right for this account

- **One weight per source**: release knowledge, artist tags, artist history,
  similar artists, sound, tempo. Fit them by the same held-out grid search
  `blend.mjs` uses, on artist-held-out folds. That is a handful of numbers
  per account, not a trained model (R1).
- **Fitted per situation**: artist already filed; never-filed but heard;
  never-filed and unheard.
- **An agreement count** in calibration: how many independent sources rank
  the same playlist first. "Sure" means a calibrated lower bound of at least
  95% on held-out filing, with its coverage shown on the Score card.

### 5. Learn from every tap, and cover mood

- **Online update**: a filing joins the playlist's members before the next
  card, and a reject or move-away marks the (artist, playlist) pair negative
  for the session. Background refits replace these quick updates.
- **Ask the most useful question**: the teach queue picks tracks whose top
  two picks are close **and** whose artist has many unfiled tracks.
- **Mood as a second, separate decision**:
  - Each mood playlist with 12 or more heard members gets a fits-or-not
    score: nearest members on sound, plus its tempo and energy range.
  - It shows as an "also fits Late Night" chip, only above a threshold
    fitted for 80% precision on its own held-out members.
  - It never competes with the genre pick.
  - Model mood labels stay explanations until the owner's label review
    passes.

## Expected gains and how each is measured

The baseline is the 2026-11-15 run: 58% top-1, 79% top-3, no Sure calls.

Every layer is measured the same way:

- the existing Score harness;
- artist-held-out folds;
- with and without the layer, on the same tracks;
- a bar set before the run.

A layer that misses its bar stays display-only.

| Layer | Estimated gain (top-1) | Basis | Number that decides it | Bar to ship |
| --- | --- | --- | --- | --- |
| Sound in the blend (built, not yet scored on the owner's library) | +5 to +10 overall, more on never-filed artists | Sound alone is 58–70% on test sets. Its errors (neighbouring sub-genres) differ from artist-history errors (unfiled artists) | `core/validate/gate.mjs` | +5 on never-filed artists, no loss overall (unchanged) |
| Three windows | +1 to +2 | Phase 0: patch agreement within one preview ranged 17–100% | Sound-only top-1, two vs three windows | ≥ +1, no loss on any family |
| Nearest members with the centroid | +2 to +4 on playlists with 30+ heard members | Standard few-shot behaviour with sub-styles. Not yet measured here | Sound-only top-1, centroid vs mix | ≥ +2 overall |
| Per-recording knowledge | +3 to +8 on artists in 2+ playlists, near zero elsewhere | Only 18% of the owner's artists sit in two or more playlists | Coverage first, then top-1 on multi-playlist artists | Coverage ≥ 40% and ≥ +3 on those artists |
| Family first, then sub-genre | About 0 on sub-genre top-1. Family top-1 about 88–92% | Sound top-2 is 80–88% with confusions inside families. Owner top-3 is already 79% | Family top-1, and sub-genre top-1 given the right family | Family ≥ 85% |
| Per-source, per-situation weights + agreement | +2 to +5. Sure on about 30–50% of cards | Synthetic blend fit added 3 points. Agreement is missing from calibration today | Sure precision and coverage on held-out filing | Sure ≥ 95% precise at ≥ 25% coverage |
| Online learning from taps | Small on Score. Large in use | The teach gate failed because single answers barely count | Teach gate and live kept-rate | Teach gate passes, and ≥ 95% Sure kept-rate over 30 days |
| Mood "also fits" chips | New capability | Sound placement worked on genres with no model label (phonk 50%, jersey club 80%) | Per mood playlist, precision at the fitted threshold | ≥ 80% precision, ≥ 12 heard members |

**Combined estimate:** about 70 to 78% top-1 on sub-genre, about 90% on
family, and Sure on a third or more of cards at 95% precision. The gains
overlap, so this is a judgement, not a sum.

**The honest limit.** Some playlists stay close neighbours: UKG vs speed
garage, rollers vs jungle, trance vs donk. On those the best engine asks,
and the design makes asking one tap between two.

## Build order

1. **Owner's run:** "Listen to my music", then Score + Tune, then paste the
   summary. This settles the sound gate and sets the baseline.
2. **Probe per-recording knowledge** (no UI). Measure MusicBrainz and
   Discogs release-style coverage on liked songs, and whether both answer
   from a browser.
3. **Hear better:** three windows, nearest members, tempo ranges.
4. **Decide better:** family then sub-genre, per-source and per-situation
   weights, agreement in calibration, and the three File-card states from
   [USER-REVIEW.md](USER-REVIEW.md).
5. **Learn live:** online updates and the reworked teach queue, then re-run
   the teach gate.
6. **Mood chips.**

Each package is one PR with its with/without numbers in the description: no
feature without a number that shows it works.
