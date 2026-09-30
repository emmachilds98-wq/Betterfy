# Release Radar — build plan

A radar over **every artist in your library**, newest release first, scrollable
back through time, filterable to one artist.

This document is the plan, not the implementation. It exists because the hard
part of Release Radar is not fetching albums — it is that a naive
implementation produces a feed that looks right and is wrong, in seven
specific ways that are all invisible until you own a real library. Each one is
named below with the rule that answers it.

---

## 1. Why this one is buildable at all

Most of what would make this easy is gone. Verified against a freshly
registered app in September 2026 (README, "Why it uses Last.fm and Discogs"):
`/recommendations` is `404`, `/audio-features` is `403`, and `/artists/{id}`
returns no `genres` field at all.

What still answers:

| Endpoint | Use | Status |
|---|---|---|
| `GET /artists/{id}/albums` | the entire feature | works, paged, 50/page |
| `GET /albums?ids=` | batch detail, 20 ids per call | works |
| `GET /me/following?type=artist` | followed artists | works, **but see scopes** |
| `GET /browse/new-releases` | market-wide new releases | works, not personalised |

There is **no** bulk "new releases for these artists" endpoint. The feature is
one request per artist, and every design decision below follows from that.

**Scopes.** The hosted app requests ten scopes
(`docs/app.template.html:1414`); `user-follow-read` is not among them. Adding
it re-prompts every existing user for permission and risks their sign-in on
any hiccup. So Release Radar is built from **the artists in your library** —
which is what was asked for anyway — and "artists you follow but own nothing
by" is explicitly out of scope for v1. If it is ever wanted, it is a separate,
opt-in re-auth, never a silent scope widening.

This satisfies CLAUDE.md's bar: every account has a library, no export, no
desktop app, nothing to install.

---

## 2. The artist set

Distinct artists across, in priority order:

1. every track in every owned playlist
2. liked songs
3. `top_artists` (three windows) and `recently_played`

Deduplicated by Spotify artist id. Credited artists, not just the first-billed
one — a listener who owns one track by a producer wants to know when that
producer releases. Expect **~1,000 artists** for a library of this size (956
measured, README).

Two known traps, both already solved elsewhere in this repo and to be reused
rather than re-derived:

- **Collaboration credits.** `credits.mjs` already splits `"Shy FX & T Power"`
  and `"dwarde & Tim Reaper"`. A duo is often a distinct artist id with its own
  catalogue; both the duo and its members belong in the set.
- **"Various Artists".** A single id that appears on thousands of
  compilations. Hard-excluded by id, not by name.

---

## 3. The sync, and what it costs

~1,000 artists × 1 request = ~1,000 requests for a cold sync. The hosted app's
`sp()` already paces adaptively, sits out `429`s within a hold budget, and
surfaces `QUOTA_EXCEEDED` honestly rather than promising a countdown that will
not help (`docs/app.template.html:1783`). Release Radar must run **inside**
that machinery, never around it.

Three rules make the cost bearable:

**Resumable by construction.** Per-artist state in IndexedDB under the
existing `betterfy` database, keyed `radar:artist:{id}`, carrying a `shape`
version like the library parts already do. A sync interrupted at artist 400
resumes at 400, not 0.

**Prioritised by listening, not by playlist order.** This is the signal
CLAUDE.md explicitly points at: `/me/top/artists` across three windows plus
recently-played. An interrupted first sync should already have covered the
artists you actually play. Reuse `listeningWeights()` from `profile.mjs` — the
same weighting the tag enrichment already sorts by (`byListening`).

**Re-checked on a cadence, not every run.** An artist who released last month
is worth checking weekly; one silent for eight years is worth checking
quarterly. Proposed, and to be treated as a declared prior until measured:

| Last release | Re-check after |
|---|---|
| within 90 days | 7 days |
| within 2 years | 30 days |
| older | 90 days |

`cache.mjs`'s `worthReasking()` is the same idea for tags and its reasoning
("a real gap is not permanent") carries over; this wants its own function
because the input is a release date rather than a tag count.

**Cold-start honesty.** The first sync is minutes, not seconds. The UI must
show real progress and be usable while it runs — partial results, ordered
correctly, with a visible "still reading N artists" state. It must never
present an incomplete radar as complete.

---

## 4. The seven accuracy problems

This is the part that decides whether the feature is any good.

### 4.1 Release dates are not all the same precision

`release_date_precision` is `day`, `month` or `year`. A `year`-precision
release sorts as 1 January and jumps above everything from that month.

**Rule.** Store the raw string and the precision. Sort by a resolved
timestamp, but **never display a day you were not told**: render "2026",
"March 2026", "12 March 2026". A radar that invents precision is lying in the
one field the whole page is sorted by.

### 4.2 The same album appears many times, once per market

Spotify returns market-specific album ids. Without `market`, one release can
appear a dozen times with different ids and identical content.

**Rule.** Always pass `market=from_token`. Then dedupe survivors on
`(normalised name, release_date, total_tracks, primary artist id)` —
`norm.mjs` already exists for the name half. Keep the earliest date seen, and
keep every id seen so a later pass recognises it.

### 4.3 `appears_on` floods the feed; excluding it loses the good stuff

`include_groups=appears_on` is mostly Various-Artists compilations. But it is
also where remixes and guest verses live — often the thing a listener most
wants to know about.

**Rule.** Two lanes, not one decision. Fetch `album,single` for the main feed;
fetch `appears_on` too, but file it as **Features**, shown as a separate,
collapsed-by-default strip. Never mix them in the primary chronology.

### 4.4 Reissues are not new releases

A 1996 jungle record reissued in 2026 arrives with a 2026 release date and
sits at the top of the radar as if it were new. This is the single most
annoying failure mode of every release feed.

**Rule, and it needs no vocabulary.** A release whose tracks you **already
own** is not new to you. Compare the release's track ISRCs against the ISRCs
already in `library.json` (snapshot already captures `isrc` per track). An
overlap above a threshold marks it `reissue` and drops it out of the default
feed into a "Reissues and repackages" filter.

Deliberately *not* done by matching "Remastered", "Anniversary", "Deluxe" in
the title. That is one library's vocabulary and it fails on the next account —
the same mistake `axes.mjs`'s venue regex makes, which the v3 engine exists to
undo.

Where ISRCs are missing, fall back to `(normalised track name, duration
within 2s)` and mark the verdict as weaker, rather than guessing confidently.

### 4.5 "New to you" and "new in the world" are different questions

A 2019 album by an artist you started listening to last week is new *to you*
and old in the world.

**Rule.** Default sort is the world's: newest release date first, which is
what was asked for. But carry `firstSeenAt` (when this sync first saw it) so a
second sort — "new to your library" — is available later without a re-fetch.
Do not build the second view in v1; do store the field, because it cannot be
backfilled.

### 4.6 Already-owned releases must be marked, not hidden

Half a radar's value is "I already have this". Hiding it makes the feed look
wrong; not marking it makes it useless.

**Rule.** Every release carries `owned: none | some | all`, computed against
library track ids and ISRCs. Shown as a quiet marker, never a filter by
default.

### 4.7 An artist id is not a person

`/artists/{id}/albums` returns what that **credited id** appears on. Aliases
(Aphex Twin / AFX / Polygon Window) are separate ids with separate
catalogues. There is no Spotify endpoint that links them — `related-artists`
was deprecated with the rest.

**Rule.** Do not attempt alias resolution in v1. Report per credited artist.
MusicBrainz *can* link aliases and the adapter already exists
(`core/sources/musicbrainz.mjs`), so this is a later, optional enrichment —
bonus, never infrastructure, exactly as CLAUDE.md requires.

---

## 5. Data model

```
radar:artist:{id}   { shape, id, name, checkedAt, lastReleaseDate,
                      albumIds: [...], error? }
radar:release:{key} { shape, key, ids: [...], name, artists: [{id,name}],
                      releaseDate, precision, albumType, totalTracks, img,
                      lane: 'main' | 'features',
                      owned: 'none'|'some'|'all',
                      reissue: bool, reissueBasis: 'isrc'|'weak'|null,
                      firstSeenAt }
radar:index         { shape, at, artists: n, releases: n, cursor }
```

`key` is the dedupe key from §4.2, so the same release seen via three artists
is one row. `shape` invalidates the lot on a format change, the way `SHAPE`
already does for library parts (`docs/app.template.html:1973`).

---

## 6. Mobile UI

The app is phone-first: a five-slot tab bar plus a **More** sheet for three
secondary screens, swipe navigation that follows `VORDER`, one hue per screen
(`VHUE`), and a `main[data-view]` that re-renders wholesale.

Release Radar fits that grammar rather than inventing one.

**Placement.** A new view `radar`, `VTITLE` "Radar", hue `m2`
(`#C44BA6` — the app reuses hues already: `m4` serves both Shuffle and
Playlists). Inserted in `VORDER` directly after `discover`, so the swipe order
reads Home → File → Tidy → Discover → **Radar** → Shuffle. It belongs on the
**primary bar**, not behind More: a radar nobody sees is a radar nobody uses,
and Shuffle is the weakest of the five it would displace.

**Layout, top to bottom.**

1. **Sticky header strip** — "Radar", then one honest status line:
   *"1,042 artists · last checked 2 hours ago"*, or during a sync
   *"reading 412 of 1,042 artists"* with a thin progress rule. Tapping it
   starts a re-check.

2. **Filter row** — horizontally scrollable chips, thumb-height (44px min),
   the same `.chip` pattern the app already uses:
   `All · This month · Unheard · Singles · Albums · Features · Reissues`.
   Single-select. `Unheard` = `owned: none`.

3. **Artist search** — a single field, not a dropdown. A dropdown over 1,000
   artists is unusable on a phone. Type-ahead against the artist set, matching
   on normalised name (`norm.mjs`), showing up to 8 results as chips; choosing
   one filters the feed to that artist and pins a dismissible chip under the
   search field. The field collapses to a tappable search icon in the header
   once you scroll, so it costs no vertical space while browsing.

4. **The feed** — grouped under **sticky month headers** ("March 2026"), which
   is what makes "newest at top, scroll back through time" legible on a phone
   without a date picker. Within a month, newest first.

   Each row, 72px tall, one line of information density:

   ```
   ┌──────┬────────────────────────────────────────┬────────┐
   │ art  │ Release Title              [SINGLE]    │   ›    │
   │ 56px │ Artist Name                            │        │
   │      │ 12 Mar · owned                         │        │
   └──────┴────────────────────────────────────────┴────────┘
   ```

   - artwork 56px, `loading="lazy"`, never blocking layout
   - title one line, ellipsised; artist one line, `--ink-2`
   - a type pill only when it is not an album (`SINGLE`, `EP`, `FEATURE`)
   - `owned` marker only when owned — absence is the common case and should
     be silent
   - the whole row is the tap target; the chevron opens a sheet with the
     tracklist, a play button (the app already has playback), and "file this"
     once the v3 engine is wired in (§8)

5. **Virtualised scrolling.** A two-year radar over 1,000 artists is
   thousands of rows. Render a window, not the list — the app's existing views
   render whole and would stutter here. This is the one place Release Radar
   needs machinery the app does not already have.

**Empty and failure states, written out rather than left to chance:**

- never synced → an explainer and one button, with an honest time estimate
- syncing, no results yet → skeleton rows, not a spinner
- synced, nothing new → *"Nothing new since 4 March"*, not an empty page
- filtered to nothing → *"No singles this month"* with a clear-filter tap
- quota exceeded mid-sync → the partial radar stays usable and says exactly
  how far it got; `sp()` already produces this message honestly
- artist fetch failed → that artist is marked and retried next sync; one
  failure never fails the run

**Accessibility and touch.** 44px minimum targets, `aria-current` on the tab
the way the existing nav does, month headers as real headings, and the feed
announcing filter changes. Respect `prefers-reduced-motion` — already handled
globally at `docs/app.template.html:129`.

---

## 7. Phases

Each phase ships something usable and is independently reviewable.

| # | Phase | Contents |
|---|---|---|
| 0 | Artist set + cost measurement | Build the set from `library.json`, count it, measure real request cost against one account. No UI. Settles whether the cadence in §3 is right. |
| 1 | Sync engine | Per-artist fetch, resumable, prioritised, cadence-gated. Node CLI first (`radar.mjs`) so it can be run and inspected without touching the app. |
| 2 | Normalisation | §4.1–4.3: precision, market dedupe, two lanes. Fixtures + tests. |
| 3 | Ownership and reissues | §4.4–4.6: ISRC overlap, owned markers. The accuracy phase; needs its own test fixtures. |
| 4 | Mobile UI | The view, filters, search, virtualised feed, all states. |
| 5 | In-app sync | Port the sync into `sp()`/IndexedDB with progress and interruption. |
| 6 | Engine tie-in *(gated)* | "File this" on a release, using `core/recommend`. Gated on the v3 engine being wired in at all. |

**Testing.** Phases 2 and 3 are where the accuracy lives and they are testable
offline with captured fixtures — no network, same as `core/benchmark`. Capture
one real `/artists/{id}/albums` response per shape (day/month/year precision,
a market-duplicated release, a Various Artists comp, a reissue with shared
ISRCs) and assert against them. That fixture set is the deliverable of phase 2,
not an afterthought.

---

## 8. Deliberately not in v1

- **Followed artists you own nothing by** — needs `user-follow-read`, which
  needs re-auth of every existing user (§1).
- **Alias resolution** — no Spotify endpoint; MusicBrainz later, as a bonus.
- **Label radar** — Discogs knows labels, but it is an optional enrichment
  most accounts will not have, so it can never be the spine of the feature.
- **Push notifications** — a PWA can, but "we will tell you when your artists
  release" is a promise about background execution that a home-screen web app
  cannot reliably keep.
- **Pre-release / upcoming** — Spotify does not expose announced-but-unreleased
  records to third parties.

---

## 9. Beyond Release Radar — what else is worth building

Researched against what is actually in the repo, roughly in order of
value-per-effort.

**1. Wire the v3 engine into the app.** The largest single improvement
available and the one everything else compounds with. Blocked on one thing:
the benchmark is 12 synthetic cases, and `npm run benchmark:fit` reports 4 of
15 thresholds as uncontradicted rather than validated. The mechanism to fix
that now exists (`npm run analyse:v3 -- --queue`, then the review page) and
needs a real library worked through it, not more code.

**2. Release Radar × the filing engine.** Once (1) lands: a new release
arrives, and the engine says which of your playlists it belongs in, using
`missingFromPlaylist()`. This is the combination neither feature has alone,
and it is the strongest argument for doing them in this order.

**3. Listening-weighted enrichment.** CLAUDE.md points straight at it: tag
gaps should be filled for artists you actually play first. `analysisPriority()`
in `core/personal/relevance.mjs` already computes exactly this ordering and
nothing in the shipping app reads it yet.

**4. Misfile detection on Music DNA (§21).** Built up to the edge and
deliberately stopped: a misfile flag is an instruction to move somebody's
music, and the weights behind it are not fitted. Same unblock as (1).

**5. A "what changed" view.** The app syncs incrementally and already knows
what moved between snapshots, but never shows it. Cheap, and it makes every
other feature's effects visible.

**6. Track-level tags at scale.** `enrich-lastfm-tracks.mjs` exists and is the
one genuinely new question v3 asks — it is what fixes a diverse artist handing
the same cloud to every record they made. Currently opt-in from the CLI only.

---

## 10. Open questions for you

1. **Bar placement.** Radar on the primary tab bar in place of Shuffle, or
   behind More with the other three? My recommendation is the bar.
2. **How far back does the feed go by default?** Everything is technically
   possible, but "all releases ever by 1,000 artists" is tens of thousands of
   rows. Two years, with older on demand, is my recommendation.
3. **Cold sync consent.** A first sync is minutes of requests against a shared
   quota. Should it be an explicit "start" button (my recommendation), or
   silent on first visit?
