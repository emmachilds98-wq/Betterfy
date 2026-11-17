# Next work plan (2026-11-16, after #149)

**Start here.** This plan replaces `docs/review/HANDOFF-2026-11-16.md` §"next
waves" for what to build next. It covers the state of `main`, the owner's
standing rules, what waits on her, and six ranked engine packages with files,
gates and how each is measured. The owner approved items 1 to 4 on 2026-11-16,
then asked for this plan before any of them were built. **Nothing below is
built yet.**

## 1. Owner's standing rules

Every package below must keep to these. They come from emma, in this project's
threads.

- **On by default, and shown as on.** Anything that helps every account runs
  without a switch, a key to paste or a setup step. Settings ▸ "What's helping
  your picks" (#149) lists each source as on, with a live check. A new source
  gets a row there.
- **Hosted only.** Every check runs in the page on GitHub Pages, on whichever
  Spotify account is signed in. Never ask the owner to run `node …` or export
  a file. A measurement that needs her library is a button or an automatic
  run in the page, never a script. (`radar.mjs`, `validate-placement.mjs` etc.
  are fine for developers, never a step for her.)
- **Merge when green.** Standing approval: merge each PR to `main` once
  `npm test` and `npm run e2e` pass on GitHub. Open PRs as drafts, then mark
  ready and squash-merge. She checks `main` herself.
- **Filing stays tap-only.** Auto-file was rejected. Nothing writes to Spotify
  without a tap. "Sure" changes how a card looks and what the sure batch
  offers, never what gets written without a tap.
- **Build for every account.** `CLAUDE.md` "Build for the Spotify library":
  per-account data only, nothing pooled across accounts, no Spotify content
  into AI/ML models (`docs/SMARTER-GENRES-PLAN.md` §3). Optional sources
  that need a personal token (Discogs) stay a bonus.
- **Low usage.** Few threads at once, no new wave without asking her.
- **Secrets.** The built-in Last.fm key is the app's read-only API key
  (`node build-web.mjs --lastfm-key=…` bakes it into `DEFAULT_LFM_KEY`, and
  rebuilds keep it). The Last.fm shared secret is never used, committed,
  logged or stored.

## 2. What is on `main` now

| PR | What it did |
| --- | --- |
| #143 | The 2026-11-16 reviews: `docs/review/USER-REVIEW.md`, `ENGINE-REVIEW.md`, `HANDOFF-2026-11-16.md` |
| #144 | Deep listen (MAEST, CLAP) on by default; built-in Last.fm key; listening pill fits the header; green "Sure" only when sound or filing history backs the pick (`pickBacked`/`backedBand`, `core/review/filequeue.mjs`); phone File layout |
| #145 | Engine: `near` Score arm (`audioScores` mixes the centroid with the 5 nearest members, used only via `gate.mjs nearChoice`); family first (`core/intrinsic/family.mjs`, used at family top-1 ≥ 85%); `learnFiled` updates the spaces on every accepted filing; teach gate measured with sound |
| #146 | Wave F UI: Library rows with health and sound, Engine screen under Library, playable Discover rows |
| #147 | Mood "also fits" chips (`core/intrinsic/mood.mjs`, ≥ 12 heard members, ≥ 80% held-out precision); listening on unless the listener chose off (`bf_audio.offChosen`); Last.fm fills thin artists quietly on every load |
| #148 | Release Radar on Discover, with an in-page "Check it works on this account" |
| #149 | Settings ▸ "What's helping your picks": every source shown on, with a live check |

No PRs are open.

**Already on by default:** listening (Deezer previews by ISRC, EffNet), both
deep ears on laptops on Wi-Fi, Last.fm artist tags (built-in key, every load),
Wikidata genres (every load), Deezer and ListenBrainz similar artists (during
a Score run), listening-weighted enrichment order, learning from each tap.

**Gated on the owner's Score run** (each switches itself on only when her
numbers clear its bar): sound in the blend (`gate.mjs audioGate`), the deep
ear (`earChoice`), nearest members (`nearChoice`, +2 overall, no loss on
never-filed), family first (85%), mood chips (80% per playlist), fitted
weights, the blend, teach questions, Fill this playlist.

**Her baseline** (Score, build 2026-11-16-1633, 80 playlists, 1,311 liked):
today's engine 54% top-1 / 77% top-3; blended 67% / 88%; with sound 61% /
82%; nothing confident ("Sure" on 0%); teach 23% → 23%. Weakest playlists:
Dancehall (0% of 7), D&B Jungle Alarms 13%, Late Night House 14%, Alt/Indie
19%, Chill Rap 25%.

## 3. Waiting on the owner

1. **Score + Tune paste.** Listening is now hearing her whole library. When
   it finishes: Library ▸ Engine (the "How well it knows you" card) ▸ **Score
   + Tune**, then **Copy results** and paste into the project. This sets the
   new baseline and decides every gate above. Package 1 removes the need for
   the button, but her paste is still the number every package is measured
   against.
2. **Radar "Works" check.** Discover ▸ Release Radar ▸ "Check it works on this
   account". It replaces `node radar.mjs --probe`. Paste what it says.

## 4. The work, ranked

Estimates are judgements against her baseline, not measurements. Every
package is one PR with its with/without numbers in the description, measured
by the Score harness (`core/validate/loo.mjs placementAccuracy`,
artist-held-out folds) on the same tracks, with a bar set before the run. A
package that misses its bar ships switched off (display-only) and says so.

### Package 1: Score + Tune runs by itself (approved)

**Why first.** Every gated feature waits for someone to press a button on
the Engine screen. Nothing improves for an account that never finds it, and
gates go stale as listening hears more.

**What.** A pure scheduler and a page timer.

- `core/review/autoscore.mjs` (new, add to `FILE_MODULES` in `build-web.mjs`
  so its exports are page globals). `autoScoreWhy({ last, now, heard, filed,
  listening, busy })` returns `'first' | 'listened' | 'heard' | 'weekly' |
  null`:
  - first: never scored on this device and ≥ 60 filed tracks;
  - listened: listening state `'done'` and ≥ 50 more heard than last run;
  - heard: ≥ 200 more heard and ≥ 25% more;
  - weekly: 7 days since the last run;
  - waits while listening is `'running'` unless the last run is ≥ 7 days
    old; never while `ENG.valRunning || TUNE.running`; a failed run is not
    retried for 6 hours.
  - `autoScoreLine(last, now)` for the Engine screen: "Last scored 2 h ago,
    after listening finished. Runs again by itself when listening has heard
    200+ more tracks, or in 7 days."
- `web/app/autoscore.js` (new, add to `web/manifest.mjs` after
  `app/analyse.js`): `autoScoreTick()` runs `engineValidate()`, then
  `engineTune()`, then `tuneApply()` (keeps only rows that cleared their bar
  on both halves). Records `{at, heard, why, ok}` in localStorage
  `bf_autoscore`. Started from `boot.js` after first paint: first check after
  60 s, then every 5 min, only while `!document.hidden`.
- `web/app/engine.js engineValidate`: after `blendRemember`, a run by hand
  calls `autoScoreNote('manual')` so the timer counts from it.
- `web/screens/engine.mjs`: the line under the Score buttons (`#autoScore`),
  via a ctx function `autoScoreText` from `web/app/screens.js`.
- **`web/app/datakeys.js`: register `bf_autoscore`** (group "Engine"). The
  "every key the page writes is in the registry" test fails otherwise; this
  was the one failure in the first attempt.
- Settings ▸ "What's helping your picks" (`web/screens/helpers.mjs`): a row
  "Checks itself weekly" with the last run's date.

**Gate.** Not an accuracy change, so no accuracy bar. Checks: unit tests for
every `autoScoreWhy` branch; an e2e spec on a fake account that sees a
Score run start by itself within the first tick (stub the 60 s delay); the
Engine screen shows the line. Watch phone cost: the run is in the engine
worker; skip it when `navigator.connection.saveData`.

**Measure.** Her paste after the first automatic run should match a run by
hand on the same build within a point (same folds, same tracks).

### Package 2: similar artists fetched in the background (approved)

**Built** (`web/app/bridgewarm.js`): gathered after Wikidata and Last.fm on every
load, unfiled artists first; File's sound picks and untagged, unheard cards
use them with no Score run; a Score run whose `bridgeVerdict` fails switches
File's use off (`bf_bridge_gate`). Settings row "Similar artists in File".

**Why.** The Deezer/ListenBrainz/Wikidata neighbour bridge took never-filed
artists from 11% to 49% top-1 on her library. Today it is fetched only for
the tracks a Score run scores (`engineValidate` → `engineBridge`), so File
only benefits once a Score run has happened and only for those artists.

**What.**

- `web/app/engine.js engineBridge(tracks)`: already caches raw answers in
  IndexedDB (`BRIDGE_KEY`, two months) in listening order (`inEnrichOrder`).
  Add `bridgeWarm()`: after first paint (and after Wikidata/Last.fm in
  `boot.js`'s chain, so they don't compete), fetch the bridge for the artists
  of unfiled liked songs first, then filed ones, at the existing rate
  limits, resumable, quiet.
- The File space (`web/app/soundfirst.js` / `engineSpace()`) builds with
  `bridge` from that cache, so picks for never-filed artists use neighbours
  without a Score run. `core/intrinsic/bridge.mjs`: `bridgeFrom(raw, lib)` turns
  the cache into a bridge and `withBridge(space, bridge)` applies it
  (`bridgeScores` per track); keep it behind the same `bridgeOn()` switch.
- Settings row: "Similar artists: N of M artists looked up".

**Gate.** Score "with similar artists" vs without on the same folds (already
in the Score card: `bridgeLines`). Ship on by default if never-filed top-1
rises ≥ 5 points with no overall loss (the 2026-11-15 run measured 11% → 49%). The background
fetch itself needs no gate; using it in File does, and the gate is the
existing bridge comparison.

**Measure.** Her next paste: "Never-filed artists … top-1" with bridge, and
the File screen's live kept-rate from History (`core/measure/history.mjs`).

### Package 3: song-level tags (approved; coverage check first)

**Measured 2026-11-16, fails the coverage bar; step 2 not built.** 200 real
tracks with ISRCs, 20 each from Deezer playlists for jungle, drum and bass,
UK garage, speed garage, dancehall, late night house, deep house, chill rap,
indie rock and bassline. A tag counts if it is a genre in the shipped table
(not junk, not the artist's name; Last.fm count ≥ 10). Last.fm
`track.getTopTags` (built-in key): 8% of songs had any tag at all, and 8% a
genre tag. Even Goldie, "Inner City Life" returns none. MusicBrainz by ISRC:
39% resolve to a recording, 11% carry a genre. Either source: **14%**.
Scene genres: 0% on jungle, D&B, UKG, speed garage, dancehall and house;
chill rap 5%; bassline 20/30%; indie rock 55% (Last.fm) / 75% (MusicBrainz).
MusicBrainz does answer CORS (`Access-Control-Allow-Origin: *`) but needs two
requests per song at 1/s (the `isrc` resource takes no `genres` inc). The gain
would land on indie/rock only, which artist tags already handle. Revisit only if
the owner's library turns out mostly indie/rock.

**Why.** Nearly every tag is about the artist. A diverse artist gives the
same cloud to every record (ENGINE-REVIEW "the honest limit"; V2-PLAN §4.1).
Only 18% of her artists sit in two or more playlists, so the gain is
concentrated there.

**What, in two steps.**

1. **Coverage probe in the page** (no UI beyond a line on the Engine
   screen). For a sample of 200 liked songs in listening order:
   - Last.fm `track.getTopTags` (artist + title, built-in key, 5/s);
     `core/sources/lastfm.mjs` already has `tagParams`/`extractTags` and
     `TAG_ENDPOINT`, and `enrich-lastfm-tracks.mjs` is the Node version of
     this exact pass (read it for the prioritisation and caching rules).
   - MusicBrainz recording by ISRC (`core/sources/musicbrainz.mjs
     resolveByIsrc`, `extractRecordingFromIsrc`, `toEvidence`), with
     `inc=genres+tags`. Note its header: MusicBrainz asks for an identifying
     User-Agent, which a browser cannot set. **Verify** in the page whether
     `musicbrainz.org/ws/2` answers CORS requests from GitHub Pages at 1
     request/s; if it does not, MusicBrainz is out and only Last.fm ships.
   - Report coverage: share of songs with ≥ 1 genre tag from each source.
2. **Wire it** only if coverage ≥ 40% of songs: cache per track in
   IndexedDB (`tags_track`, same `worthReasking` rules as `tags_extra`),
   fetched quietly after Last.fm artist tags in `boot.js`, most-played and
   least-sure first. Feed into the tag engine as track evidence that outranks
   artist tags for that track (see `core/evidence/` and
   `core/engine.mjs profileTrack`; the browser build mirrors `classify()`/
   `buildReports()` in `web/app/classify.js`/`reports.js`, and `CLAUDE.md`
   requires `npm test` and `npm run e2e` before and after touching those).

**Gate.** Coverage ≥ 40%, then top-1 on artists in 2+ playlists ≥ +3 points
with no overall loss, on the same folds. Otherwise it stays display-only
(shown on the track's card as "this song is tagged …").

**Measure.** A Score arm `trackTags` in `loo.mjs` (like the `near` arm),
reporting overall top-1, top-1 on multi-playlist artists, and coverage.

### Package 4: "Sure" only when sources agree (approved)

**Built** (this thread's PR): `core/intrinsic/agree.mjs` reads sound, filing
history, similar artists and tags as separate sources; `calibrate.mjs` fits
"confident" per agreement level and keeps it only when the cross-fitted
held-out check is ≥ 95% on ≥ 20 cards (`AGREE_GATE`). Score's paste line:
"Sure when sources agree: …". Off by itself until her Score run clears it.

**Why.** Nothing has ever earned "Sure" on her library. Calibration today
(`core/intrinsic/calibrate.mjs`) reads only the top score's margin. Sound,
tags and filing history make different mistakes, and a card where all three
pick the same playlist is far more often right than its margin says.
ENGINE-REVIEW layer 4 estimate: Sure on 30–50% of cards at ≥ 95%.

**What.**

- Every placement already carries its parts (`results[].parts`: `graph`,
  `audio`, `learned`, tag score via the blend, `bridge`). Add
  `agreement(parts)`: how many independent sources rank the same playlist
  first (tags, sound, filing history/graph, bridge), and whether any source
  ranks it below 3rd.
- `calibrate.mjs`: fit the threshold per agreement level (`fitCalibration`
  on rows grouped by agreement, each with its own Wilson lower bound),
  `decide()` takes the row's agreement. "Confident" then needs the bound to
  clear the target at that agreement level.
- `core/review/filequeue.mjs pickBacked` stays: Sure still needs sound or
  history behind it.
- Engine screen: "Sure when sources agree: N% of cards, right X% held out".

**Gate.** Sure precision ≥ 95% (Wilson lower bound ≥ 0.9, as today) on
held-out rows, at ≥ 25% coverage. Coverage below 25% still ships if precision
holds, but say so.

**Measure.** `calibrationReport` per agreement level in the Score card; live,
History's kept-rate on Sure filings over 30 days (≥ 95%).

### Package 5: the playlists it confuses (next)

**Built** (same PR): `core/intrinsic/pairs.mjs`, pairs taken from the
held-out rows' own confusions plus "Can't tell apart", same family only;
`PAIR_GATE` 70% two-way on ≥ 20 heard, and all pairs switch off if top-1 on
the Score rows would drop. Orders File's top two picks only, never on a Sure
card. Score's paste line: "Pair checks: …".

**Why.** Her weakest playlists are neighbours: rollers vs jungle, UKG vs
speed garage, Late Night House vs house. Family first (#145) already asks
"which one?" when only the family is sure. What's left is telling the two
apart.

**What.** For each pair the Score run lists under "Can't tell apart"
(`ENG.pairs`), a two-way sound score: the difference of the two playlists'
nearest-member scores (as `mood.mjs nearScore`), with a threshold fitted on
half the pair's heard members and checked on the other half. Used only to
order the two picks inside a family card, never to make a card Sure on its
own.

**Gate.** Per pair, held-out two-way accuracy ≥ 70% on ≥ 20 heard tracks;
overall top-1 not lower. Estimate +2 to +4 on the weakest playlists.

### Package 6: hear every song by default on laptops (next)

**Why.** New accounts default to "what I'm playing + unfiled" with up to 20
examples per genre playlist (`web/audio/settings.mjs`, `scopeIds`). Sound
placement and mood chips get better with more heard members per playlist.

**What.** `DEFAULT_AUDIO_SETTINGS.scope` stays narrow on phones; on a computer
(fine pointer, no touch screen, the test `web/app/audio-panel.js` already uses for Wi-Fi) on Wi-Fi,
default to `'all'`. A saved choice still wins.

**Gate.** None for accuracy; check the queue order still puts unfiled and
played tracks first (`core/audio/queue.mjs`).

### Package 7: the weakest playlists, and why (built, after #154)

**What was wrong with the old list.** Score's "Weakest" line (Dancehall 0%,
D&B Jungle Alarms 13%, Late Night House 14%, Alt/Indie 19%, Chill Rap 25%) was
read off the account-native engine *alone*: no tags, no similar artists, no
sound. That is not what File places with. On three seeds of the owner-shaped
fixture (`test/fixtures/shaped-library.mjs`) the engine-alone list's weakest
playlist rose from 14%/0%/7% to 43%/38%/83% in the top three once similar
artists were in. It also counted only the tracks inside Score's 600-track
sample (sorted by id), so "of 7" is 7 scored, not 7 in the playlist.

**Built.** `core/intrinsic/weak.mjs` reads the held-out rows of the engine
that places (with sound, else similar artists, else alone: the rows family
first and the pair checks use) and, per weak genre playlist (top 3 on < 50%
of ≥ 5 scored), names the likeliest reason and the honest fix:
`view` (half its tracks are in the partner: merge or keep as a pick),
`working` (a pair check now re-orders it), `few` (< 20 tracks: add N),
`twin` (shares ≥ 30% of artists with the partner, or sound can't tell them
apart: merge?), `unheard` (< 5 heard: listening hears it next), `partner`,
`scattered` (add examples). Each weak playlist's partner gets a pair check of
its own (`pairs.mjs` `extra`), used for the diagnosis only, never to re-order
a card. Paste lines: `Weakest (engine alone): …` (the old one, for
comparison) and `Weakest, as File places: …`. Kept in `bf_weak`; Library
shows "Playlists it gets wrong most" and a "Help it learn this one" section in
the playlist sheet (merge opens the wizard; nothing is written without its
tap); listening hears those playlists' tracks right after unfiled liked songs
(`queue.mjs` tier 2b, `scopeIds` `focus`).

**Tried and dropped.** Offering a weak playlist second when its pair check
says the track sounds like it: on synthetic libraries it fired on 0–3 cards
and was never right, so it was not shipped.

**Measure.** The owner's next automatic Score: the two Weakest lines side by
side, and each playlist's reason.

### Built after this plan: the first analysis starts by itself (2026-11-17)

A new account no longer presses "Analyse my library" or "Learn my library".
`web/app/analyse.js analyseFirst()` is asked before the first paint, so File
opens on the progress strip; `analyseAuto()` then runs, in the background and
in order: Wikidata genres, listening, Last.fm tags, and the Engine's map
(`engineAutoLearn()`, engine worker only, skipped with Data Saver). Every
later load learns the map again quietly (from the cache), so the Engine screen
opens on results. Auto Score + Tune waits while it runs (`autoScoreBusy`).
Checks: `test/webanalyse.test.mjs`, `test/e2e/firstrun.test.mjs`.

## 5. Not worth doing yet

| Idea | Why not | What would change it |
| --- | --- | --- |
| Key and BPM on cards | Key v3 is 55.3% held out, under its 60% bar (#116); BPM display hidden | A key model that clears 60% on the Deezer sets |
| Teach questions on by default | Teach gate: 23% → 23% on her library; shut on most fixture accounts | Package 4's agreement making single answers count, then re-run the gate |
| Three windows per track | Measured +0.3 points on 374 Deezer previews (`scripts/audio-near/README.md`), under the +1 bar | Nothing planned |
| Discogs release styles | Needs each listener's personal token | Stays an optional bonus |
| Auto-file | Rejected by the owner | — |
| Spotify audio features | `/audio-features`, `/recommendations` are dead (403/404) | — |
| Model mood/voice/energy labels | Waiting on her label review (≥ 70% on ≥ 20 tracks, PR #83 history) | Her review |

## 6. Order and how to run it

1. Package 1 (no accuracy risk, unlocks the rest).
2. Package 2 (largest measured gain already known: never-filed +38).
3. Package 3 step 1 (probe), then step 2 only if it clears coverage.
4. Package 4.
5. Packages 5 and 6 only after asking her.

One thread, one PR per package, draft → green → merge. After each merge,
ask her for a fresh Score + Tune paste only if the package's gate needs her
numbers (2, 3, 4, 5).

Before touching `profile.mjs`, `axes.mjs`, or the browser's mirrored
`classify()`/`buildReports()`: run `npm test` (~2.5 min) and
`npm run e2e` before and after. Rebuild `docs/` with
`node build-web.mjs --lastfm-key=<the app's API key>` so the built-in key
stays; generated files (`docs/index.html`, `docs/sw.js`,
`docs/engine-worker.js`) conflict on every merge from main: take main's and
rebuild.
