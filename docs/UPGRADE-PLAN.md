# Betterfy — next upgrades, in order

Written 2026-10-31 from a review of `main`, the three open draft PRs and
every plan in `docs/`. Facts marked *checked* were verified in this review,
not copied from an earlier doc. **Updated the same day:** #43 and #44 are
merged, and the engine now runs in the background (§4).

---

## What you need to do (the short version)

| # | You | Time | Why it matters |
|---|---|---|---|
| 1 | ~~Merge PR #43~~ | — | **Done**: merged and live |
| 2 | On the device your library is synced on: **More → Engine → Learn my library**, then **Score both engines**, then **Copy results** and paste it to me | ~3 min | This is the one number that decides what gets built next (§2). It can only come from your library: your library lives on your device, and nothing here can read it |
| 3 | Say **yes/no to PR #41** (keyless iTunes + MusicBrainz tags) | 1 min | I'll make it mergeable. You merge it, or tell me to |
| 4 | Answer the **three Release Radar questions** (§5), or say "use your defaults" | 1 min | The only thing blocking that build |
| 5 | Say **yes/no to filing into collaborative playlists** (§4) | 1 min | It adds new places the app can suggest, so it's your call |

Nothing else needs you. No new keys, no Spotify dashboard changes, no Firebase
changes. Every step below that isn't on this list is mine.

You can hand any merge to me instead: say "merge 43" (or 41, or 44) and I'll
do it. I won't merge anything without you asking.

---

## 1. Where things stand

**Live (`main` → GitHub Pages):** the v1 app. It files, tags, finds
misfiles and duplicates, does Discovery, and syncs feedback across devices.
The v3 evidence engine (PR #42) is merged too, but **nothing in the app uses
it**. It runs only from the command line.

**Open draft PRs (checked: CI green on each one's last push):**

| PR | What it is | State |
|---|---|---|
| [#43](https://github.com/emmachilds98-wq/Betterfy/pull/43) | **Account-native filing engine.** It learns what *your* playlists mean from your own library (which artists you file together, label families from ISRCs, track format, era), with no Last.fm key needed. Phases 0–5 are built: the engine, the browser bundler that finally lets `core/` reach the phone, cold-start handling, the Rekordbox bonus, and an Engine screen that shows its suggestions next to today's without filing anything | 735 tests. Merges cleanly into `main`. **Its kill gate has never been run**, because that needs a real library |
| [#41](https://github.com/emmachilds98-wq/Betterfy/pull/41) | **Two more tag sources:** MusicBrainz genres/tags (on the id lookup already being made) and iTunes Search (no key at all, so it helps a brand-new account from the first click) | 7 weeks old. *Checked:* its only clash with #43 is the generated `docs/index.html`. Rebuilt, the two combined pass **752 / 752 tests**. Its one open item (does a real MusicBrainz response parse?) is now *checked*: it parses correctly |
| [#44](https://github.com/emmachilds98-wq/Betterfy/pull/44) | Plans only: `AUDIO-ANALYSIS-PLAN.md` and this file | Docs only |

**Older defects, re-checked against the code:**

| Defect (from `V2-PLAN.md` §3) | Now |
|---|---|
| Local server open to CSRF | **Fixed** (`trustedOrigin()` in `server.mjs`) |
| Undo button for "unlike" throws | **Fixed** (`actions.mjs` handles `unlike`) |
| No tests, no CI | **Fixed**: 638 tests on `main`, CI on every PR |
| Playlists you collaborate on but don't own are never read, so you can't file into them | **Still true**: `snapshot.mjs:27` and the browser's `owned` filter |
| `playTrack` replaces whatever you were listening to | **Still true** (now documented in the code, but not changed) |
| Duplicates list stops at 60 | **Still true** (`secDupes()`, `slice(0, 60)`) |
| Misfile build does a linear search inside a loop | **Still true** (`misfile.mjs:84`). Slow on big libraries, not wrong |

---

## 2. The decision that unblocks everything: the engine gate

PR #43 asks one question: **does the account-native engine place your tracks
in the right playlists at least as often as today's Last.fm-tag engine?** It
answers it fairly. It hides some of your own filing, asks both engines where
those tracks go, and compares their answers with where you actually put them.
A built-in leakage check makes sure it isn't marking its own homework.

That question can only be answered on a real library. A made-up one flatters
whichever engine the made-up data happens to suit. So it needs you, once.

### Your steps

1. Open Betterfy and press **⬇ Check for updates**. Take the update if it
   offers one.
2. Use the device where your library is already synced, so it doesn't spend
   minutes re-reading Spotify.
3. **More → Engine → Learn my library.** A few seconds. The top card then
   shows which *rung* it's on (how much of your library is filed to learn
   from).
4. Scroll to *Is it actually any better?* and press **Score both engines**.
   It runs in the background now, so the page stays usable. Just leave the
   screen open until it finishes.
5. Press **Copy results** and paste it to me. The summary holds rates,
   counts and the names of the playlists it understands least. It holds no
   track or artist names.

If you have a computer with the repo checked out, `npm run validate:placement`
gives the same comparison from the command line. That's optional; the phone is
enough.

### What I do with the answer

- **The new engine wins or ties:** build phase 6. That means showing its
  suggestion on the File screen with the score beside it, switching filing to
  it only once you've seen it win on your own library, keeping v1 as a
  fallback for one release, and then moving misfile detection onto it so a
  "this is in the wrong place" flag comes with reasons in your own terms
  ("sits with these artists, same label family as 7 tracks here").
- **It loses:** the per-playlist results say *which* buckets it doesn't
  understand. I re-plan around those rather than building further on a
  failed premise. The likeliest fix is the audio analysis in §6. #43's
  weakest case is a track by an artist you've never filed, which it can only
  place on "shape" (length, single or album, era). Audio is the one signal
  that hears the track itself.
- **Either way:** the engine moves into a Web Worker so the screen stops
  freezing. That's build plumbing that pays off whatever the result.

---

## 3. PR #41 — more tag sources

**My recommendation: merge it, after #43.** It improves today's engine, which
stays the default until the gate says otherwise. It most helps exactly the
listener `CLAUDE.md` cares about: one with no Last.fm key, because iTunes
needs none. The tag sources also stay useful afterwards. The new engine
uses them to put *names* on groups it has found.

The one caveat: iTunes matches artists by name, so a same-named act can win.
#41 already ranks it last for that reason and only asks it about artists
every other source left empty.

**Your step:** say yes or no. On yes, I merge `main` into #41's branch once
#43 is in, regenerate `docs/index.html` with the repo's build, run the tests,
and push. Then you merge it, or tell me to.

---

## 4. Small fixes I can do any time (no input needed)

In rough order of value:

**Done (same day):**

- **Engine in a Web Worker.** Measured in Chromium against the live build,
  with a 250-playlist, 21,000-entry test library: the longest freeze while
  scoring went from **6.2 s to 0.06 s**, and while learning from **1.7 s to
  0.35 s**. Tests hold the background and on-page paths to identical
  answers, and the page falls back to the old path if a worker can't start.
- **Copy results**, and a list of the playlists the engine understands
  least, on the score card.
- **Every Tidy list reaches the end.** Repeats stopped at 60, Cross-filed
  and Misfiles at 80. A test library with 1,578 cross-filed tracks showed 60
  with no way to the rest. They now show a page at a time with **Show more**.
- **Misfile speed.** `misfile.mjs` indexes liked songs once.

**Still to do:**

- **Sync tag corrections and axis overrides across devices.** Feedback
  already syncs (`FIREBASE.md`). These two still live on one device. The
  pattern exists and the Firestore free plan covers the size. Needs nothing
  from you.
- **Collaborative playlists: your call.** Playlists you can edit but don't
  own are never read, so you can't file into them. Reading them needs no new
  permission (`playlist-read-collaborative` is already requested), but it
  *adds new destinations*, so it changes what the app suggests. An earlier
  version of this list said it didn't, which was wrong. Say yes and I'll add
  it, with a switch to leave any of them out.

---

## 5. Release Radar — waiting on three answers

`docs/RELEASE-RADAR-PLAN.md` is a complete plan: a feed of new releases from
every artist in your library, built from Spotify alone. Its §10 asks three
questions. The defaults in brackets are the plan's recommendations:

1. Does Radar go on the main tab bar in place of Shuffle, or behind **More**?
   *(tab bar)*
2. How far back does the feed go by default? *(two years, older on demand)*
3. Should the first sync (minutes of Spotify requests) wait for a **Start**
   button, or run silently on first visit? *(Start button)*

**Your step:** answer, or say "defaults". Its phases 0–3 don't touch the
filing engine, so this can run in parallel with §2. Its last phase ("file
this new release into the right playlist") waits for the engine.

---

## 6. Audio analysis — after the gate

`docs/AUDIO-ANALYSIS-PLAN.md` plans track-level genre, mood and similarity
from the 30-second preview of each track, analysed in your own browser. No
keys, no exports. It's the strongest candidate for "what makes the engine
better next". But **it should wait for §2's number**: if the account-native
engine already wins, audio is a refinement. If it loses on artists you've
never filed, audio is the fix.

It also now depends on #43. #43's bundler is how the audio worker reaches
the page, and the audio fingerprint would plug in as one more signal in #43's
learned space as well as evidence for v3.

**Your steps, when we get there:**

- **Model licence.** The music models are free for non-commercial use only
  (CC BY-NC-SA). Fine for Betterfy as it is today, but they would ship in the
  repo under that licence, not MIT. Say OK, or say no.
- **Data cost.** About 0.5 MB downloaded per track analysed, plus a one-off
  22 MB model download. The plan defaults to Wi-Fi only and asks before the
  first run.
- I'll read Deezer's API terms on preview use and report back before
  anything ships.

---

## 7. Not recommended right now

- **Wiring the v3 evidence engine in on its own.** #43 does the job v3 was
  for, without leaning on Last.fm, and reuses v3's best parts (ontology,
  identity, correction log). Wiring v3 in separately would be building the
  thing #43 was written to replace.
- **Growing the 500-row manual benchmark** (`docs/TUNING.md`). #43's
  hide-and-ask test gets ground truth from your own playlists in seconds. Manual
  review is still useful for genre *names*, but it no longer blocks anything.
- **Following-only artists in Radar, or any new Spotify scope.** Adding a
  scope makes every existing user sign in again (Radar plan §1).

---

## Order of work

```
done: merge #43, Worker, Tidy paging
you: Learn + Score + Copy results ──► me: phase 6 (if it wins)
                                  └─► me: re-plan + audio (if it loses)
me:  corrections/overrides sync (§4) ─── any time
me:  #41 rebased ──► you: merge #41
you: 3 Radar answers ──► me: Radar phases 0–5
```
