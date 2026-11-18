# Build 8 plan: identify and match better, analyse further, then upgrade (2026-11-18, after `de1adab`)

**Start here for what to build next.** `docs/BUILD-7-PLAN.md` stays the
reference for the standing rules, how a Claude project runs a plan and the
file-ownership map; this plan reuses its format and does not repeat it. It
answers the owner's ask: *"plan how to improve the identifying and matching and
further analysis, then plan for upgrading."*

Every number below is **her own Score run** (PC, 2026-11-18: 1,311 liked, 80
playlists, 29 genre destinations, 600 held-out tracks). Where a claim is about
code, it was checked in the files named. Where it could not be checked, it says so.

Contents:

1. What the numbers say, and where accuracy is lost
2. Identifying and matching: packages
3. Further analysis: what to measure next, and how Score shows it
4. Upgrade plan: ears, speed, other accounts, screens, data sources, decisions
5. Waves, lanes, file ownership, and the brief every agent gets
6. Not worth doing (measured and closed)
7. Progress table

---

## 1. What the numbers say

### 1.1 The scoreboard (top-1 / top-3 on 600 held-out tracks)

| Path | Top-1 / top-3 | Notes |
| --- | --- | --- |
| Engine alone (account-native) | 28 / 47 | Before fitting |
| Engine, fitted | 48 / 63 | |
| Engine + similar artists, fitted | 64 / 86 | Deezer + ListenBrainz bridge |
| Tag engine (today) | 54 / 77 | Last.fm, Wikidata, shared table |
| **Blended tags + engine** | **66 / 89** | Never-filed artists: 58 / 83 |
| With sound (sound-first) | 60 / 86 | Never-filed with sound: 63% |
| Audio gate | PASS, +31 overall | Sound coverage 572 of 600 heard; 7,161 analysed |

Read this carefully: the **blend is the best path at 66 / 89**. Sound-first
(60 / 86) is behind it overall and is the better path only for never-filed
artists (63% against 58%). S1 (sound joins the blend per situation, merged in
`de1adab`) is the package that combines them; the first Score on it is the
number to watch.

### 1.2 What was tried and did not move it (do not repeat)

| Tried | Result | So |
| --- | --- | --- |
| Second ear, MAEST | 61 against the first ear's 60; never-filed worse | Not used |
| Nearest tracks (`nearMix`) | +0.2 | Not used |
| Teach questions | 59 → 59 | Stays hidden |
| Learning from each tap | 23 → 23 overall; filed-artist subset 35 → 38 | Ships (helps in use), not a Score gain |
| E2 weights per situation | engine 48 → 50, blended 66 → 66 | Display-only |
| E3 tempo range per playlist | +0.33 | Under its bar (+1 or +3 on the weakest five); display-only |
| Family first | family top-1 74%; confident on 38% of tracks at 97% | **Not used: the bar is 85% top-1** (see C1) |
| Mood chips | 1 of 8 earned; several "only N of 12 heard"; precision too low | Mostly hidden |
| Pair checks | 8 of 8 pairs told apart; top-1 61 against 60 | On, small gain |
| Fill this playlist | recall@10 55% | On |

### 1.3 Where accuracy is lost, ranked by how many tracks it costs

1. **"Confident" is never earned, on any path.** The calibrator exists and is
   sound (`core/intrinsic/calibrate.mjs`: temperature, isotonic, Wilson lower
   bound, split-conformal short list). It says "none earned yet" because its
   rule is all-or-nothing: one threshold, lower bound ≥ 90%, over ≥ 20
   held-out tracks (`DEFAULTS.target`, `minConfident`). Meanwhile the
   evidence shows pockets that *are* sure: the family level is right on **97%
   of the 38% of tracks it is confident about**, and the sound short list (71%
   of tracks) holds the answer 90% of the time. The numbers are there; the
   gates ask the wrong question of them (C1, C2).
2. **Small playlists score near zero.** Dancehall 0% of 7, Dancehall & Early
   Jungle alarms 13% of 8, Late Night House 14% of 7. Seven held-out tracks
   cannot teach a centroid, and they are the playlists the owner most wants
   filled (S2).
3. **Big mixed playlists are weak because they are mixed.** Alt/Indie 19% of
   54, Chill Rap/HipHop 25% of 51. That is 105 of 600 held-out tracks, 17% of
   the set, at under a quarter right. The nearest-members test (+0.2) says a
   different distance does not fix it, so the cause is probably the playlist,
   not the metric (B1).
4. **Never-filed artists: 205 tracks** (a third of the test set). The best
   path on them is 63% with sound, and the artist-level evidence that would
   help is thin: similar artists were looked up for 4,038 artists (Deezer
   3,458, ListenBrainz 1,424), Wikidata knows 4% of artists (770 asked, then
   rate-limited with 429s; the queue now spaces them) (N1, W1).
5. **Drum & Bass is named on 77 of 199 tracks**, and tempo fits only 51% of
   213. Naming genres by sound is 72% for genre and 92% for sub-genre *when
   it names one*; the loss is in not naming (D1).
6. **Mood labels** are short of heard tracks ("only N of 12 heard") and below
   the precision bar. This is a coverage problem, not a model problem (M2).
7. **History measures all say "not enough data yet".** Nothing learned from
   real use can be scored until filings accumulate (A5).

What is **not** the problem: the ear (a second ear and nearest tracks both
failed to help), tempo as evidence (+0.33), and the engine's mechanics (the
audio gate passes by +31).

---

## 2. Identifying and matching: packages

Format: goal, why (which number), what (files, checked), measure and bar,
effort (S ≈ hours, M ≈ a day, L ≈ more). **Every bar is read from the
account's own Score run, in the page, and the feature switches itself on for
that account when it clears and stays off (display-only) when it does not.**
Nothing writes to Spotify without a tap; nothing is pooled across accounts;
no Spotify content goes into an AI/ML model (SMARTER-GENRES §3 R1 to R3). The
ears are pretrained models hearing Deezer previews, as before.

Ranked by expected gain per effort.

### I1. Family first, judged on its confident part (lane E, S)

**Goal.** Use family-first when the *confident* family calls are right, not
only when family top-1 over every track reaches 85%.

**Why.** Family top-1 is 74%, but it is confident on 38% of tracks at 97%.
`familyInUse` (`core/intrinsic/family.mjs`, `FAMILY_GATE.minFamily: 0.85`)
tests `acc.family >= 0.85` on all tracks, so a family call that is right 97%
of the time where it speaks is thrown away because it stays silent on the
rest. `decideCard` already abstains when the family is not confident; the bar
judges the wrong population.

**What.** `core/intrinsic/family.mjs`: a second bar on the held-out
family-level result, `{ minPrecision: 0.95, minN: 20, coverage: 0.25 }` (the
same shape as `AGREE_GATE`), read from `familyAccuracy(..., { report })`'s
`sure`. `familyInUse` passes when either bar clears. Score shows "Family first:
confident on 38% at 97%". `web/app/classify.js`/`reports.js` are untouched; the
File card path (`decideCard`) already exists.

**Measure and bar.** Family-confident precision ≥ 95% on ≥ 20 held-out tracks
and ≥ 25% coverage (set before the run), plus no top-1 loss when the pick is
kept inside the confident family (`familyConfident`/`narrowToFamily`, already
wired by S1). **Effort** S.

### I2. "Sure" earned in pockets, not by one global threshold (lane E, M)

**Goal.** A Sure card on some real share of tracks, honest at ≥ 95% on
held-out tracks.

**Why.** "Confident: none earned yet" on every path. The calibrator fits one
`tau` over all tracks and needs the Wilson lower bound ≥ 90% over ≥ 20, so a
mixed population never qualifies even when subsets do (I1's 97%).

**What.** `core/intrinsic/calibrate.mjs` and `agree.mjs`:

- **Mondrian (group-conditional) calibration**: fit `tau` separately per group
  the account can name without leaking the answer: the agreement level (already
  there: `byLevel`), the situation (filed artist / never filed but heard / never
  heard, E2's split) and the leading playlist's size band. Report the Sure share
  per group. A group with fewer than 20 held-out tracks keeps "not earned".
- **Per-playlist reliability as an input**: the held-out precision of a
  playlist's *calls* (not its recall) is already near what `weak.mjs` computes;
  a playlist whose calls are 95% right can be Sure at a lower probability than
  one whose calls are 60% right.
- Keep conformal short lists (`pmin`, `maxChoices: 3`); add per-group `pmin` so
  small playlists are not starved out of every short list.
- Keep the Wilson bound and the 95% held-out check (`AGREE_GATE`); change what
  is *grouped*, never how strict.

**Measure and bar.** Sure share and Sure precision on held-out tracks, from
`calibrationReport`: precision ≥ 95% with a lower bound, coverage ≥ 25% of
tracks on her account (the bar in ENGINE-REVIEW). Below that, Sure stays off
and the Score line says how close it got. **Effort** M. **Depends on** I1 (it
supplies the family groups).

### N1. Never-filed artists: pool the artist, fuse the bridge (lane E, M)

**Goal.** Lift the 205 never-filed tracks from 63% (sound) and 58% (blend).

**Why.** A third of the test set. On these the account has no filing history,
so only three things can speak: sound, the bridge (similar artists), and tags.
Right now they are scored one track at a time.

**What.**

- **Artist-level sound pooling** (`core/intrinsic/audio.mjs`,
  `space.mjs`): when an artist has several heard tracks in the library, score
  the artist's *mean embedding* against the playlists in addition to each track.
  One mixed-genre artist is noisy per track; four tracks average out. Uses only
  the account's own heard records. The File queue also offers the rest of an
  artist's tracks together (README, "Filing the rest of an artist at once"),
  so a better artist score helps that batch directly.
- **Fuse bridge and sound for this situation**: E2's `fitSituations`
  (`core/validate/weights.mjs`) already fits per situation; add `bridge` as a
  source part in the never-filed row and let S1's per-situation blend use it.
- **Coverage first.** Before any weighting, report the share of never-filed
  artists reaching at least one of: Last.fm tags, Wikidata genres, Deezer
  neighbours, ListenBrainz neighbours, heard tracks. The artists reaching
  none are a list the owner can see ("17 artists nothing knows yet").

**Measure and bar.** Top-1 on never-filed artists, with/without, same tracks:
**+3 points** (63 → 66), no loss overall. **Effort** M.

### S2. Small playlists: borrow from the family, ask for examples (lane E + U, M)

**Goal.** Playlists with under about 12 heard members (Dancehall 0 of 7,
Jungle Alarms 1 of 8, Late Night House 1 of 7) get a fair chance.

**Why.** The centroid of seven tracks is seven tracks; the learner needs ≥ 10
(`audio-learn.mjs`). Right now these playlists lose to bigger siblings that
look similar.

**What.**

- **Borrowed prior** (`core/intrinsic/space.mjs`, `family.mjs`): a small
  playlist's profile is its own members *plus* a down-weighted copy of its
  family siblings' profile (the ontology already gives parents,
  `core/ontology/genres.mjs`), shrinking toward its own as members arrive
  (empirical-Bayes shrinkage with a per-account strength fitted on
  held-out folds).
- **Score reports it per playlist**: with and without the prior, on playlists
  under 12 heard members only, so a gain there is not averaged away by the 600.
- **Ask for examples, in use** (`web/screens/lists.mjs` Library row, or
  Gaps): "Dancehall has 7 tracks; add 3 more and it will start to find
  others", with a one-tap path to Discover's "sounds like this playlist".
  `core/review/weakwords.mjs` already writes the reason words for weak
  playlists (`few`); this is its action.

**Measure and bar.** Playlist-level recall on playlists under 12 heard members,
pooled: **+10 points of recall** on that group (a group of about 20 tracks, so
the bar is on the pooled count, not per playlist), no top-1 loss on the other
playlists. **Effort** M.

### D1. Drum & Bass named, and tempo-aware (lane E, M)

**Goal.** Name DnB tracks by sub-genre on more than 77 of 199, and give tempo a
fair say.

**Why.** Tempo "fits" only 51% of 213, and DnB's own convention splits between
87 and 174 (BUILD-5-PROGRESS, Beatport labels), so a strict tempo check
mislabels a correct track as an error.

**Tempo part (a) is built as SOUND-ENGINE-PLAN T1:** `DOUBLE_OK` in `core/ontology/tempo.mjs` gives DnB, jungle, footwork, juke and breakcore (and children) full credit at ×2, and `identify()` lets the genres heard pick the octave of every confident reading. Her Score run confirms the 77 → ≥ 95 and 51% → ≥ 70% bars.

**What.** `core/audio/identify.mjs` (naming weights `SOURCES`, `SPECIFIC`,
`MIN_GENRE`) and `core/ontology/tempo.mjs`: (a) make the per-genre range
**octave-aware for DnB** (87 and 174 count as one); (b) name against *the
account's own sub-genre playlists* (Rollers, Jungle, Liquid) by sound
neighbours, which the naming path already supports through `neighbours` and
`playlistName`, as an extra source when the model's own label is weak; (c) tune
`specific` (0.4/0.5/0.6) is already a Tune row, so no new knob. Report named
share and precision per family in Score.

**Measure and bar.** DnB named share **77/199 → 110/199 (55%)** at sub-genre
precision ≥ 90% (today's 92% overall). **Effort** M. **Depends on** nothing
in lane E except the Score golden.

### B1. Big mixed playlists: diagnose, then offer a split (lane E + U, M)

**Goal.** Say why Alt/Indie (19% of 54) and Chill Rap/HipHop (25% of 51) are
weak, and fix what can be fixed.

**Why.** 17% of the test set sits in two playlists at under 25%. Nearest
members (+0.2) says the metric is not the cause. The candidates are: the
playlist is two or three styles under one name, or it is a *taste* playlist
with no sound in common.

**What.** Measure first, no engine change:

- **Spread per playlist** (`core/intrinsic/audio.mjs`): mean within-playlist
  cosine against between-playlist, and the number of clusters (k-medoids,
  k = 1 to 4, chosen by silhouette) among its heard members. A playlist with
  one tight cluster and weak accuracy has a *different* problem (tags); one
  with three clusters is a split candidate.
- **Multiple centroids** only where the spread says so: score a track against
  the nearest of the playlist's medoids, not the mean. Ships only on playlists
  where it wins on held-out folds (per-playlist gate), never globally.
- **Offer the split** through the existing merge/split wizard
  (`core/playlists/mergesplit.mjs`, `web/screens/new.mjs`): "Alt/Indie holds
  three sounds. Split?" The split is the owner's tap.

**Measure and bar.** (a) Medoid scoring: recall on the playlists it applies to
**+5 points**, no loss elsewhere. (b) If it misses, the Score line says "Alt/
Indie is one playlist with three sounds" and the split offer is the deliverable.
**Effort** M. Honest risk: the nearest-members result suggests (a) will miss;
(b) is still worth shipping.

### W1. Fill the knowledge gaps quietly: Wikidata, then MusicBrainz (lane K, M)

**Goal.** More never-filed artists reach a second source, with no button.

**Why.** Wikidata knows 4% of artists (770 asked; 429s). The Wikidata
requests are now queued (`core/sources/wikidata.mjs` `BATCH` 300 per query; the
queue lives in `web/app/keyless.js` `fillFromWikidata`), so the next run
should reach everyone asked. The 4% is likely to rise only a little: it knows
established artists, not scene producers (README "Data sources").

**What.**

1. Confirm the queue works on her account: coverage after one full pass (a
   number on the Settings "What's helping" row; `web/app/helpers.js`).
2. **MusicBrainz via the same queue pattern** (spaced, retried on 429, paced,
   visible-tab only, Data Saver off): for artists with an MBID but no genres,
   read artist-level tags. `core/sources/musicbrainz.mjs` is Node-only today
   because the custom User-Agent a browser cannot set is required; **first
   step is the probe the ENGINE-REVIEW listed and nobody ran: does
   `musicbrainz.org/ws/2` answer a browser request?** If not, this stops at the
   probe and says so.
3. Keep it a **bonus**: silent and zero-cost when absent (CLAUDE.md).

**Measure and bar.** Share of never-filed artists with at least one genre
source: report before and after. **Bar: +10 points of artist coverage** and no
top-1 loss. **Effort** M. Gain on top-1 is expected to be small; the bar is on
coverage because top-1 moves only through N1.

### R2. Same recording, other release: carry evidence across versions (lane E, S–M)

**Goal.** A track filed in one release informs its twin (same ISRC, or the
same title and artists, different release).

**Why.** `core/identity/track-identity.mjs` already links by ISRC (confidence
0.98) and keeps versions apart (remixes are never merged, README "Design
decisions"). **Not checked:** whether `space.mjs`'s placement uses that link
to carry a filing from one release to another. First step is to count, on her
library, unfiled liked tracks that have a filed twin (same recording, different
track id); if that is under 2% of the test set the package closes with that
number.

**What.** If it is above 2%: in `space.mjs`, a track with a filed twin takes
the twin's playlist as a strong `graph` part; version kinds that are the same
recording as the plain release (`track-identity.mjs`'s version table) count,
remixes do not. **Bar:** +1 top-1 on the tracks affected. **Effort** S–M.

### L1. Label and release identity, fitted not fixed (lane E, S)

**Goal.** Let the account decide how much the label matters.

**Why.** The ISRC registrant (the label or its distributor) is read in
`core/intrinsic/features.mjs` `registrantOf`, with a span-based discount for
aggregators. Its weight is fixed: 0.50 in `WEIGHTS`, 0.25 in
`SOUND_FIRST_WEIGHTS` (`core/intrinsic/space.mjs`). The owner's note said the
engine weight is "×8"; **that figure was not found in the code**, so the first
step is to find where it comes from (the fitted blend's tag-versus-native
weight is the likely place) before changing anything.

**What.** Add `registrant` (and `era`) as rows in `core/validate/tune.mjs`
`PARAMS.sound` with a grid that includes today's value, so Tune sweeps them per
account on both halves like the other rows. No new data source.

**Bar.** Tune's own rule (passes on both halves). **Effort** S.

### M2. Mood chips earn their way with the heard they have (lane E, S)

**Goal.** More than 1 of 8 mood playlists earns a chip.

**Why.** Several fail on "only N of 12 heard" (`MOOD_GATE.minMembers: 12`,
`core/intrinsic/mood.mjs`), a coverage problem the listening queue can fix:
those playlists' unheard members are not the ones it hears first.

**What.** `core/audio/queue.mjs`: hear the members of mood playlists that are
within 6 of the minimum, ahead of the rest (the same rule that already hears
weak genre playlists first, `weak.mjs`). Do not lower `minPrecision` (0.8).

**Bar.** Chips earned: 1 of 8 → 3 of 8 at ≥ 80% held-out precision. **Effort** S.

### X1. Pair checks: show which pairs stay tied (lane E, S)

**Goal.** Name the pairs the engine can order and the ones it cannot.

**Why.** Pair checks told 8 of 8 pairs apart and added +1 top-1 (61 against
60). The next gain is the other direction: the pairs where *neither* sound nor
tags separate the two playlists (the "twin" reason in `weak.mjs`), so the
card says "Rollers or Jungle: tracks like this are filed in both" and the owner
can decide to merge them. **What.** Surface `pairsImpact`
(`core/intrinsic/pairs.mjs`) for the pairs that fail, linked to the merge
wizard. **Bar.** Display and a one-tap path; no accuracy claim. **Effort** S.

---

## 3. Further analysis: what to measure next, and how Score shows it

All of these run in the page on the account's own library inside the existing
Score run (`core/validate/loo.mjs`, `core/review/autoscore.mjs`, shown by
`web/screens/engine.mjs`), once per weekly run, with a Copy button. None needs
a script, a file or a click she does not already make.

| Id | What it measures | Shows as | Files |
| --- | --- | --- | --- |
| A1 | **Confusion by family**: for each family, how often a track whose true playlist is in it lands in each other family and each sibling | A small matrix under "Family first", the top three confusions in words ("Rollers read as Jungle 9 times") | `core/intrinsic/family.mjs` (rows already carry truth and scores), `loo.mjs` |
| A2 | **Per-playlist reliability**: recall (of its members, how many are found) *and* precision (of its calls, how many are right), with held-out n | Library's weakest list gains "calls right 62% of 13; finds 20% of its own" | `core/intrinsic/weak.mjs` already holds the reasons; add precision |
| A3 | **Learning curve**: top-1 as a function of heard count (25%, 50%, 75%, 100% of heard tracks, same held-out tracks) | One line: "Another 100 heard tracks would add about N points", and tells listening what to hear | `loo.mjs` (`limit`), `core/audio/queue.mjs` |
| A4 | **Error audit**: the 20 most confidently wrong tracks, each with the reason in words (the source that voted for the wrong playlist; the playlist's size; "twin" or "scattered") | A list under Score with the track, the pick, the truth, the reason; each row has "Why" and Fix | `core/intrinsic/explain.mjs` already writes the why for a card |
| A5 | **History measures that fill themselves**: kept-rate by tier, skip rate, accept-after-suggest, with the minimum counts (`MIN_N`, `core/measure/history.mjs`) and "N more filings to measure this" instead of "not enough data" | A progress count on each, so "not enough data yet" becomes "9 of 10 filings" | `core/measure/history.mjs` |
| A6 | **Source reliability by situation**: which source is right when it disagrees with the others, for filed, never-filed, unheard | Feeds I2's groups; shown as one table | `core/validate/weights.mjs` |
| A7 | **Coverage funnel**: of the library's artists, how many have tags, Wikidata, a bridge, heard tracks | The "17 artists nothing knows yet" line (N1), per source | `core/intrinsic/bridge.mjs`, `web/app/helpers.js` |

**Bar for A1 to A7:** each prints for a library with enough rows (the same
minimum counts as the measure behind it), prints "needs N more" otherwise, and
has a unit test on `test/fixtures/shaped-library.mjs`. They change no
placement; they exist so the next plan can rank by evidence.

---

## 4. Upgrade plan: build 8 and after

### 4.1 Models and ears (measured winners only)

- **Keep the first ear on every device.** MAEST (second ear) is 61 against 60,
  worse on never-filed, so it is *not* used for placement. It stays under Deep
  listen for the things it is for (labels), not for matching.
- **Nothing new to try before A3.** The learning curve decides whether more
  heard tracks (cheap) or a better model (expensive) is the lever. Do not
  start a model package without it.
- **Key (D3, owner decision).** Key v4 is shipped as "sure keys only"
  (62.5% / 71.3% on 85% of tracks, BUILD-5-PROGRESS). The remaining idea, a
  licensable learned key model or the whole 30 s preview, only matters for DJ
  ordering, not matching. **Recommendation: no.** S-KEY's weights are
  research/non-commercial and cannot be hosted from the app without the
  owner clearing it with Deezer.
- **Beat This** stays an opt-in for flagged tempos; D1 handles DnB octaves in
  the ontology instead of a model.

### 4.2 Performance

- First File card on a large library is 16 s (P1, #189). Target after build 8:
  under 10 s. Lever: draw from the cached last session first
  (`web/app/boot.js`, the offline shell), read the library after.
- Score run time on the account's device: record it per run (it should show on
  the Score card) before adding A1 to A7, so the added work has a budget
  (aim: weekly run ≤ 60 s on her PC, run in the worker, never blocks input).
- Listening throughput: the 7,161 analysed tracks are a one-time cost; the new
  cost is the per-run top-up. Hear order is set by I2/M2/A3 (weak playlists
  and mood near-miss first).

### 4.3 Onboarding for other accounts

CLAUDE.md's rule is that a feature counts only if every account has it. The
numbers above come from one library with scene playlists and a rich Deezer
preview coverage (572 of 600 heard). For another account:

- A Score line **"your library's shape"** (Library, once): how many genre
  playlists, how many heard, how many with a bridge, and which of build 8's
  gates are on or "waiting for N more". The honest state of every gate for
  *this* account, in one place, so a listener with 20 filed songs sees "File
  works from your tags; sound needs 60 filed" and not a blank.
- `test/e2e/accounts.test.mjs` already runs small, mood-only, typical and
  large; **add each build 8 package's off state** to those specs (a gate that
  does not clear must leave File exactly as before).
- Never ask for an export, a desktop app or a token (CLAUDE.md). W1's
  MusicBrainz is bonus only.

### 4.4 UI follow-ups

- **A2 and A4 reach the user**, in words, in Library (weakest playlists) and
  File ("why this pick"), not only in Settings > Engine.
- **S2's "add examples" prompt** and **B1's split offer** sit in Library rows,
  not a new screen.
- **I1/I2**: a Sure card keeps one filled button; two-way keeps two equals
  (U1, already built). The only new UI is the Score lines and one sentence of
  "why this is Sure" in the evidence line.
- DESIGN-PLAN is complete; any new screen goes through its principles.

### 4.5 Data sources

| Source | Decision | Rule |
| --- | --- | --- |
| Wikidata | Queued (done); measure coverage after one pass (W1) | On by default, no key |
| MusicBrainz in the page | Probe whether the browser can call it (W1); stop at the probe if not | Bonus; scoped and described as such |
| Deezer, ListenBrainz | Keep; measure per-artist reach (A7) | Already on |
| Last.fm song-level, MusicBrainz song-level | Measured at 14% / 11% coverage; closed | See §6 |
| Discogs styles | Keep as an optional bonus behind a token | Never core |
| `/me/top/artists`, recently played | **Spotify-native and universal.** Wikidata already asks most-listened artists first (`keyless.js`, `inEnrichOrder`); extend the same order to the Last.fm/bridge gaps and to which never-filed artists the listening queue hears first (CLAUDE.md names this) | Needs no file; ranks work, never changes a placement |

### 4.6 Owner decisions

| Id | Question | Recommendation |
| --- | --- | --- |
| D1 | "Send to the team" opens a pre-filled GitHub issue? (from build 7) | Yes |
| D2 | Pages built by Actions instead of committed `docs/`? (from build 7) | Yes: ends the rebuild-on-every-merge conflicts that this plan's parallel lanes will hit |
| D3 | Key research thread? | No |
| D4 (answered yes, 2026-11-18) | May Sure be offered on a card where the family is confident but the playlist is not (I1)? It is a larger target than today's one-playlist Sure | Yes: it is shown as "Drum & bass: Rollers or Jungle?", and the tap decides. This is what family first already does |
| D5 | If B1 finds Alt/Indie is three sounds, is a split offer in Library welcome? | Yes: the split is her tap, with one undo |

Nothing here waits on an in-page click except her next Score run, which runs
by itself weekly; ask her once, at the start, to open the page so the first
build 8 numbers arrive.

---

## 5. Waves, lanes, file ownership, and the brief every agent gets

### 5.1 Waves

Usage is low: **at most three threads at once, none of lane E in parallel with
another lane E thread** (BUILD-7 §2.2). Start no wave without asking her.

| Wave | Packages | Why this order |
| --- | --- | --- |
| 0 | A1, A2, A3, A4, A5, A7 (lane M, display-only) | Costs nothing in accuracy, tells the next waves where to look, and A5's counters need time to fill |
| 1 | I1, then I2 (lane E, one at a time) | The "Sure" payoff; I1 is a small gate change that unlocks I2's groups |
| 2 | N1, S2, D1 (lane E, one at a time), W1 and M2 beside them (lane K) | Biggest numeric gaps; W1 is not lane E |
| 3 | B1, L1, R2, X1 (lane E, one at a time) | Depend on A1/A2/A4's findings |
| 4 | Model and key research (D3) | Only if A3 says more audio, not more data, is the lever |

### 5.2 Lanes and ownership

Same rules as BUILD-7 §8. Added lane **K (knowledge)**: `core/sources/*`,
`web/app/keyless.js`, `web/app/helpers.js` row for each source,
`web/app/bridgewarm.js`. Lane **E** (engine) owns `core/intrinsic/*`,
`core/validate/*`, `core/audio/identify.mjs`, `core/audio/queue.mjs`,
`core/ontology/tempo.mjs`, `web/app/soundfirst.js`, the Score golden, and the
mirrored `classify()`/`buildReports()` only with `npm test` and `npm run e2e`
before and after (CLAUDE.md). Lane **M** (measure): `core/review/autoscore.mjs`,
`web/screens/engine.mjs`, `core/measure/history.mjs`. Lane **U** (File,
Library UI): the files BUILD-7 §8 lists, plus `web/screens/lists.mjs` for S2
and B1 (add-only until the lane's package merges).

### 5.3 The brief every agent gets

1. **Base on the latest `main`.** Check `git log` first; worktrees can start
   stale (`git checkout -B <branch> <current tip>`).
2. **Read** `CLAUDE.md`, `docs/BUILD-7-PLAN.md` §1 (standing rules) and §2.4
   (how a thread works), this plan's package, and the docs it cites.
3. **One package, one PR, a draft first.** Title `Build 8 <id>: <what changed
   for a listener>`. The description lists with/without numbers on the same
   tracks, the bar set before the run, and what switches itself on or stays
   off.
4. **Hold the rules.** Per-account data only; nothing pooled; no Spotify
   content into AI/ML; filing stays tap-only; no external step for a listener;
   a bar missed ships display-only and says so.
5. **Tests.** `npm test` (~2.5 min) and `npm run e2e` before and after. **E2e
   is load-sensitive locally: if a spec fails only under load, CI decides.**
6. **Register keys and modules.** New localStorage or IndexedDB key in
   `web/app/datakeys.js`; new `core/` module in `build-web.mjs`
   `FILE_MODULES`; new script in `web/manifest.mjs`; CSS in a `web/styles/`
   partial.
7. **Generated files last.** After merging the latest `main`, rebuild
   `docs/` once with the baked Last.fm key
   (`node build-web.mjs --lastfm-key=<the app's API key, read from the current
   build>`); never hand-edit generated files; take `main`'s on a conflict and
   rebuild. `test/buildguard.test.mjs` must pass.
8. **Merge when green.** Mark ready when both CI steps pass, squash-merge
   (standing approval), delete the branch.
9. **Report in the BUILD-7 shape** (`<id> merged as #NNN … Numbers … Switched
   on … Owner needed`).

---

## 6. Not worth doing (measured and closed in this build)

| Idea | Result | What would reopen it |
| --- | --- | --- |
| Second ear (MAEST) in placement | 61 against 60, never-filed worse | A different, larger model measured on her library |
| Nearest tracks in the score | +0.2 | A playlist set where medoids win (B1 reports it) |
| Teach questions | 59 → 59 | More taps in History (A5) |
| Tempo range as a penalty | +0.33 | A genre set with tight ranges and no octave convention |
| Naming by model label alone | 29% genre | Never; the account's playlists are the names |
| Song-level tags | 14% / 11% coverage | A scene-genre source |
| Auto-file | Rejected | The owner changing her mind |

## 7. Progress table

| Id | Package | Wave | Lane | State | PR | Numbers / notes |
| --- | --- | --- | --- | --- | --- | --- |
| A1, A2, A5 | Mix-ups by family, playlist precision, counts that fill | 0 | M | Built | | display only; A3, A4, A6, A7 not started |
| I1 | Family first on its confident part | 1 | E | Merged, switches itself on at the next Score run | #199 | bar: confident ≥ 95% at ≥ 25% on ≥ 20 tracks; D4 = yes (family-level Sure offered) |
| I2 | Sure earned in pockets | 1 | E | Not started | | bar: Sure ≥ 95% at ≥ 25% of tracks |
| N1 | Never-filed artists | 2 | E | Not started | | bar: +3 top-1 on 205 tracks |
| S2 | Small playlists | 2 | E, U | Not started | | bar: +10 recall on the under-12 group |
| D1 | Drum & Bass named | 2 | E | Tempo part built as SOUND-ENGINE T1 (awaiting Score run); (b) library naming not started | | bar: 77/199 → 110/199 at ≥ 90% |
| W1 | Wikidata coverage, MusicBrainz probe | 2 | K | Not started | | bar: +10 points artist coverage |
| M2 | Mood chips earn their way | 2 | E | Not started | | bar: 1 → 3 of 8 |
| B1 | Big mixed playlists | 3 | E, U | Not started | | bar: +5 recall where medoids apply |
| L1 | Label weight fitted per account | 3 | E | Not started | | find the "×8" first |
| R2 | Same recording, other release | 3 | E | Not started | | count the twins first; closes under 2% |
| X1 | Pairs that stay tied | 3 | E | Not started | | display |
