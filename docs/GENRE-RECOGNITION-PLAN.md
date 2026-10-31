# Recognising genres properly — plan

Written 2026-10-31, after the owner ran the engine gate on their library and
reported: *both engines equally bad, still putting tracks in random playlists
that aren't genre specific; newer and wider genres like donk and dnb
struggle.* Everything below marked *measured* was measured in this repo the
same day.

---

## 1. What was actually wrong

Three separate faults, each enough on its own to produce "random playlists":

| Fault | Where | Measured |
|---|---|---|
| **Non-genre playlists were filing targets.** A playlist with nothing else in its name was *defaulted* to genre and took suggestions; mood playlists did too; the account-native engine filed into every playlist with enough tracks | `classify()` in the page, `buildSpace()` in `core/intrinsic/space.mjs` | "Sunday", "Bangers", "Favourites" all counted as genre buckets |
| **One genre, many spellings, counted as unrelated.** The tag engine used each tag's exact text as its own dimension, so "dnb" and "drum and bass" had nothing in common | `trackVec()` in `profile.mjs` | drum and bass split across 7 spellings, UK garage across 6, hip hop between "hip hop" and "hip-hop" (361 vs 723 artists merged) |
| **Scene genres missing from the vocabulary.** No donk, hard house, makina, jersey club, footwork, phonk; "scouse house" and "bouncy house" collapsed into plain House | `core/ontology/genres.mjs` | 14 of 60 scene genres tested were unplaceable |

## 2. Fixed (branch `claude/zen-faraday-7t7l1f`)

- **Both engines file only into genre playlists**, meaning playlists whose
  name names a genre ("Donk", "D&B Rollers", "Tech House", "UKG"). Mood
  playlists and unrecognised names land under **Playlists → Needs your
  input**, where one tick makes them a genre playlist. A genre in the name
  beats a mood word, so "Happy Hardcore", "Dark Techno" and "Deep House" are
  genre playlists. The score now asks "which of my *genre* playlists", for
  both engines alike.
- **Spellings merged, meanings kept.** dnb / d&b / drum n bass / drum'n'bass
  → drum and bass; ukg / uk-garage → uk garage; 2step / 2-step → 2 step. It
  deliberately does *not* fold "rave" into hardcore or "trip hop" into
  downtempo, because those are distinctions worth keeping. The donk family
  (donk, scouse house, bouncy house, UK bounce) is merged on purpose: one
  scene, each name too rare to survive alone.
- **Vocabulary 3.1.0:** hard house, donk, makina, jumpstyle, jersey club,
  footwork/juke, gqom, phonk, UK funky; "rollers" and drum'n'bass as dnb.

## 3. What tags can never fix

*Measured:* 95% of artists in the shipped tag table (4,637 of 4,866) already
carry at least one genre the vocabulary recognises. So for most music the
vocabulary isn't the bottleneck. **The crowd tags themselves are coarse.**
Donk is the clearest case: after merging every spelling, **4 artists** in the
whole table are tagged with it. A donk producer is tagged "hard house",
"dance", "techno", or nothing at all. No amount of matching recovers a
label nobody applied.

So niche and newer genres need signals that don't depend on someone on
Last.fm having typed the right word. These are the candidates, strongest
first.

## 4. The signals, ranked

### A. Audio: hear the track itself (*strongest for niche genres*)

The Discogs-EffNet model in `docs/AUDIO-ANALYSIS-PLAN.md` outputs 400
Discogs styles straight from 30 seconds of audio. *Checked:* that list
includes **Donk, Drum n Bass, Jungle, Makina, Hard House, Bassline, Speed
Garage, UK Garage, Grime, Juke, Jumpstyle, Hardstyle, Gabber, Happy
Hardcore**. Discogs editors label records at release level with these exact
styles, which is why the model knows them when Last.fm's crowd doesn't.

- **Catches:** a donk track by an artist nobody has tagged, and a dnb
  artist's one house record (tags give every record an artist made the same
  answer; audio doesn't).
- **Cost to you:** about 0.5 MB downloaded per track analysed, plus 22 MB
  once for the model. Wi-Fi only by default.
- **Needs from you:** OK the model licence (free for non-commercial use,
  CC BY-NC-SA).
- **Risk:** the one unmeasured number is how many of your tracks Deezer has
  a preview for. Phase 0 of the audio plan measures it before anything is
  built.

### B. Combine the engines rather than choosing one

Today the two engines give two separate answers, and you found them equally
bad. They fail in *different* places:
- **The tag engine** fails when an artist's tags are wrong or missing.
- **The account-native engine** fails on an artist you've never filed, where
  it can only go on track length, release type and era.

A blended score (artist graph + tags + audio, once audio exists) is the
standard fix for two weak signals with uncorrelated errors. The weights are
fitted on your own held-out filing by the harness that already exists, and
the result is shown on the same Engine screen. No new data, little new code.

### C. Shared filing across Betterfy users ("shared tech")

Every Betterfy user who files a track into a playlist *named* "Donk" is
saying "this artist is donk", with more authority than Last.fm, because
these are the people who actually play it. Pooled across users:

- **Shared:** only `(Spotify artist id, genre concept)` pairs, taken from
  genre-named playlists. No playlist names, no user ids, no listening data.
  Opt-in.
- **Infrastructure:** the existing shared tag table already has a Firestore
  write path, App Check, shape checks on writes, and a human-reviewed PR
  merge into `docs/tags.json`.
- **Catches:** exactly the scene genres crowd tags miss, and it grows from
  real filing rather than from a word list.
- **Limit:** it needs other people using Betterfy to be worth much. With one
  account it's your own filing, which signal B already uses.
- **Needs from you:** a decision on whether Betterfy should share anything
  at all between accounts, and if so, opt-in only.

### D. More tag sources (#41)

[PR #41](https://github.com/emmachilds98-wq/Betterfy/pull/41) adds
MusicBrainz genres (on an id lookup Betterfy already makes) and iTunes
(no key at all, coarse genres). MusicBrainz's community genre list is
broader than Last.fm's top tags. Worth merging, but it is still crowd tags:
it narrows the gap for niche genres, it doesn't close it.

**Needs from you:** yes or no on #41.

### E. AI-assisted vocabulary growth ("skills")

The vocabulary still misses some real genres. *Measured:* the most common
genre-like tags it can't place include emo (75 artists), industrial (34),
deathcore (23), chillwave (21), ghettotech (15), hardbass (12) and EBM (12).
The repo already has a guarded way to grow it: `core/ai/reconcile.mjs` takes
proposed mappings and rejects any that invent a concept, and the review
queue collects every unplaced tag.

- **How it works:** an AI pass (Claude, run by a maintainer) proposes
  mappings for the unplaced tags. A person approves them in a PR, and they
  ship in the vocabulary for everyone.
- **Why this shape:** no API key or cost for any listener, nothing at
  runtime, and every change human-reviewed. It needs nothing from you
  beyond reviewing the PR.

Using AI *at runtime* (classifying each track with a model) would need a
paid API key per listener or a server. That breaks the project's
"no key, no server" rule, so it's not recommended.

### Not worth pursuing

- **Spotify:** no genres at all (`/artists` returns none; audio features are
  `403`). Verified in README.
- **Deezer's BPM field:** empty for 4 of 5 tracks tested (README).
- **GetSongBPM:** 20% coverage (README).

## 5. Order of work

| # | What | Who | Unblocks |
|---|---|---|---|
| 1 | Merge this branch's PR, then mark any genre playlists under **Playlists → Needs your input** | you | Both engines stop filing into non-genre playlists |
| 2 | Re-run **Engine → Learn my library → Score both engines → Copy results** | you | The number, now asked the right question |
| 3 | AI-assisted vocabulary pass (signal E) | me | emo, industrial, EBM… |
| 4 | Blend the engines (signal B) | me | Better than either alone, measured on your library |
| 5 | Audio phase 0: preview coverage + phone speed | me, then you to OK the licence | Donk and other untagged scene genres |
| 6 | Shared filing (signal C) | your decision first | Scene genres across accounts |
| 7 | #41 | your yes or no | Wider crowd tags |
