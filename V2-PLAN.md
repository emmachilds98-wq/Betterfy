# Betterfy v2 — review and upgrade plan

Written against `73f3d97` (v1.0). Line references are to that commit.

> **Progress.** The v2.0 slice is done, plus search-and-add from v2.1 and most
> of the design brief in §7 — incremental sync, live local state, transactional
> undo, the request guard, a test suite with CI, and a rebuilt interface on a
> shared stylesheet. What is left of v2.1–v2.3 is unchanged below.
> Items marked **✔ done** were shipped after this plan was written.

---

## 1. What v1 actually is

Betterfy is a **library auditor**: snapshot the library, compute reports offline,
present a queue of decisions. The pipeline is
`snapshot → enrich-lastfm → axes → dupes/misfile → report-*.json → UI`.

That model is exactly right for the problems it was built for, and the domain
judgment in it is the most valuable thing in the repo:

- **ISRC-first duplicate classification** (`dupes.mjs`) — same ISRC means the same
  master however differently two releases are labelled, and different ISRCs mean
  different recordings however identical the titles look. Most dedupe tools get
  this wrong in both directions.
- **Remixes are not duplicates** (`norm.mjs`) — `versionOf` keeps VIPs, extended
  mixes, bootleg and live cuts apart while stripping remaster tags, `feat.`
  credits and punctuation. Conservative in the right direction: it under-merges.
- **Axes** (`axes.mjs`, `profile.mjs`) — a track is only ever compared against
  playlists on its own axis, so a metal track in a mood playlist isn't flagged as
  misfiled. This is the insight that makes the misfile report usable at all.
- **IDF weighting** — without it "electronic" is true of half the library and
  every playlist centroid looks the same.
- **Within-playlist vs across-playlist duplicates** — a track twice in one
  playlist is a mistake; a track in five playlists is a decision. Never conflated.
- **An append-only action log with undo**, and dry-run-by-default on every CLI.

None of that should be rewritten. It is the product.

## 2. Why it can't do what you're asking for

You want to *resort, manage, and actively add songs*. Three things block that
structurally — not as missing features, but as consequences of the architecture.

### 2.1 There is no way to add a song

The only `/search` calls in the codebase resolve discovery results back to
Spotify IDs (`discover.mjs:105`, `docs/app.template.html:768`). Nothing lets you
type a track name and put it somewhere. Every write path starts from a track
that is *already* in your library. That is the whole gap between an auditor and
a manager.

### 2.2 The snapshot goes stale the moment you act

`server.mjs:16` loads `library.json` at boot. Mutations go to Spotify but never
back into `lib`, and `reload()` only runs after a child-process pipeline step. So
after your first filing, the rail counts, the Overview meters, and every report
are wrong until you re-run a two-minute snapshot. The browser build has the same
problem with `LIB` in IndexedDB.

This is why it feels like a report rather than an app.

### 2.3 It only works where you're sitting

A 212px fixed rail, keyboard-driven, `@media (max-width:820px)` collapsing the
rail into a horizontal scroll strip. Emptying a filing backlog is a sofa and
commute activity.

## 3. Defects worth fixing regardless of v2

**✔ done — Security: the local server was CSRF-open.** `readBody` (`server.mjs:93`)
`JSON.parse`s the body regardless of content type, and no route checks `Origin`
or `Host`. Any page open in your browser can issue a *simple* cross-origin POST
(form-encoded or `text/plain`, no preflight) to `http://127.0.0.1:8787/api/remove`
and delete tracks from a named playlist. Nothing would appear in the UI.
Fix: require `content-type: application/json`, reject non-same-origin `Origin` /
`Sec-Fetch-Site`, and validate the `Host` header (that closes DNS rebinding too).

**✔ done — An Undo button that throws.** `POST /api/unlike` (`server.mjs:129`) logs
`undoable: true`; the History view renders an Undo button for it; `undo()`
(`actions.mjs:56`) handles only `add` and `remove` and throws
`Cannot undo "unlike"`. The web build already re-likes via `PUT /me/tracks` —
port that, or stop marking it undoable.

**✔ done — Move is not one action.** `POST /api/move` (`server.mjs:120`) writes two log
entries. Undo reverses one of them, so a moved track cannot be put back in a
single click, and a half-failed move leaves the track in both playlists with no
record that they were related.

**✔ done — Undo-remove is quadratic in API calls.** `actions.mjs:62` re-snapshots the
entire playlist inside a nested loop, once per restored position. Five tracks
restored to a 2,000-track playlist is five full paginated reads.

**The builds have already drifted.** `README.md:123` and `build-web.mjs:3` claim
the browser and local builds "cannot drift apart" because the scoring modules are
bundled verbatim. That's true of `norm`, `credits` and `profile` — but the axis
classifier, the duplicate report and the misfile report are *re-implemented* in
`docs/app.template.html`. Compare `classify()` (`app.template.html:359`) with
`axes.mjs`: the browser adds `festival`, `set`, `relax|calm|hype|sad|happy`, drops
`bloc party|e1`, and drops the entire `OVERRIDE` map. The two builds give
different answers today.

**✔ done — `playTrack` does the opposite of its comment.** `actions.mjs:97` says "without
disturbing a queue", but `PUT /me/player/play` with `uris` replaces the playback
context — it wipes whatever you were listening to.

**Scale.** `misfile.mjs:81-82` does `lib.liked.find()` inside a `map` (O(n²))
before an O(n²) greedy clustering pass. The UI then hard-caps what it will show:
`slice(0,60)` on duplicates, `slice(0,80)` on cross-filed and misfiles, and
`backlog(limit = 400)` (`server.mjs:58`) against a backlog of ~850. Most of what
the tool finds is unreachable.

**Owned playlists only.** `snapshot.mjs:27` filters to `owner.id === me.id`.
Collaborative playlists you don't own are listed but never read, so you can't
file into them.

**✔ partly done — No tests, no CI, no lint.** For a tool that mutates a hand-curated library, the
identity functions — `norm`, `versionOf`, `baseTitle`, `trackKey`, `parts` — are
the ones that decide whether two records are the same thing. A regex tweak there
silently merges a VIP with its original, and if you then remove one, that's not
recoverable from the log. `verify-untouched.mjs` exists but nothing runs it.

---

## 4. The v2 architecture

### 4.1 From batch report to live index

Replace `library.json` + `report-*.json` with **one store** — SQLite locally,
IndexedDB in the browser — holding `tracks`, `artists`, `playlists`,
`placements`, `tags`, `actions`.

Three consequences, in order of value:

1. **✔ Incremental sync.** Spotify returns a `snapshot_id` per playlist. Re-read
   only the playlists whose `snapshot_id` changed. A two-minute full sync becomes
   a few seconds. This is the cheapest high-leverage change in the whole plan.
2. **✔ Local writes applied in place.** Every mutation applies to the local copy first,
   appends to the action log, then calls Spotify, then reconciles. Counts and
   reports stay correct without re-running anything. *This is what turns it from
   a report into a manager.*
3. **Reports become derived views**, recomputed incrementally against the store
   instead of being regenerated as JSON files. Deleting `report-*.json` as an
   interchange format is what removes the pressure to maintain two
   implementations.

### 4.2 One implementation of the domain logic

Move `norm`, `credits`, `profile`, plus the axis classifier, the duplicate
verdicts and the misfile scorer into a `core/` directory with **no Node
built-ins**. Node imports it directly; `build-web.mjs` inlines the same files.
Nothing is mirrored, so nothing can drift. The README's claim becomes true.

### 4.3 Transactional undo

Give the log a `txn` id. Related mutations share one; undo operates on a
transaction, not an entry. `move` becomes one undoable unit. Add handlers for
`unlike` and `create-playlist`.

---

## 5. Feature plan

### A. Add & search — the missing half

- **✔ Search and add**, with each result annotated by where you already have it
  and destinations ranked by the same axis-aware model the Inbox uses. Shipped
  as the **Find & add** view; the `⌘K` command-bar treatment is still to come.
- **✔ Duplicate guard on add.** `trackKey()` runs against the whole library
  before you file, so a different pressing of a record you own is flagged
  rather than silently added.
- **Paste import.** Drop a set of Spotify links or a plain-text tracklist
  (a Boiler Room set, a label's Bandcamp page), resolve, review, file. The
  natural companion to the DJ-set playlists.
- **Crate.** A local staging list that isn't a Spotify playlist yet, for
  assembling a set before committing it.

### B. One review queue instead of four screens

Inbox, Duplicates, Cross-filed and Misfiles are four screens with four
interaction models for one activity: deciding about a track. Collapse them into
a single queue with a filter. Every open decision is the same card — what it is,
**why it was flagged**, and two to four one-key actions. The Inbox card is
already the right pattern; extend it.

Then add the two things that make a queue survivable:

- **Snooze / never flag this again**, persisted per track and per pair. Without
  it the misfile "low" band is dead weight — the same 400 speculative rows
  forever.
- **Bulk apply** with a preview and a single undo: *"accept all 38
  high-confidence misfiles."*

### C. Playback you can actually audition with

- Use the **Web Playback SDK** so the app is its own Spotify device. Auditioning
  stops hijacking whatever is playing on your phone. (Premium only — degrade to
  the current behaviour, honestly labelled, for free accounts.)
- A mini player with jump-to-0:30 / 1:30 / 2:30. Judging a track takes ten
  seconds if you can skip to the drop; filing speed is bounded by this.

### D. The tag backbone

Tag coverage is the ceiling on every suggestion in the app.

- Put **coverage on the Overview as a first-class number**, not buried in the
  Playlists view.
- Make tag fetching a **background job** with progress, not a blocking run.
- Wire the fallbacks the `.env.example` already anticipates: **MusicBrainz** and
  **Discogs** when Last.fm returns nothing.
- Bigger win: tags are currently **artist-level**, so every track by an artist
  scores identically. Discogs *release-level* styles are what separate a Tim
  Reaper jungle roller from his ambient B-side. This is the change that would
  most improve suggestion quality.
- `JUNK` in `profile.mjs` is a denylist doing real work; add a positive gate too —
  a tag must appear on ≥N artists library-wide before it can move a centroid.

### E. Be honest about multi-user

The hosted build is capped at 25 users by Spotify's development mode, and
extended quota is effectively unavailable to individual developers. Stop
optimising for "share with friends"; make **bring-your-own-client-ID the primary
path** — a 90-second guided setup with the copy-paste redirect URI the landing
page already half-provides.

---

## 6. Sequencing

| Release | Theme | Contents |
|---|---|---|
| **v2.0** ✔ | *It stays true* | Incremental sync via `snapshot_id`; local writes applied in place; transactional undo; CSRF fix; identity-function tests + CI. (The single `core/` is still outstanding — see §4.2.) |
| **v2.1** | *Add* | ✔ search-and-add and the duplicate guard. Still to do: `⌘K` command bar, paste import, crate. |
| **v2.2** | *One queue* | Unified review queue, snooze/dismiss, bulk apply, virtualised lists, mobile layout. |
| **v2.3** | *Ears* | Web Playback SDK, mini player, release-level tags via Discogs/MusicBrainz. |

v2.0 is not optional groundwork. Adding songs on top of a stale snapshot
produces duplicates, and a second implementation of the dedupe logic in the
browser produces different answers about them.

---

## 7. Brief for a design upgrader

### Keep

The type system — Archivo for headings, IBM Plex Sans for body, IBM Plex Mono
for every number — is genuinely good and unusual for a music tool: editorial,
not streaming-service. Tabular numerals on counts and durations are correct. The
token architecture with proper three-state theming (bare `:root`,
`prefers-color-scheme`, `[data-theme]`) is already right and should be handed
over as the spec. One accent plus semantic ok/warn/info is the right restraint.

**Do not turn this into Spotify green with a grid of album tiles.** It should
look like a filing desk, not a player. That's the product's whole posture.

### Fix

1. **No hierarchy of "what now."** The Overview is eight equal-weight metric
   tiles. A manager should open on the single next action — *"412 unfiled,
   about 35 minutes"* — with the rest secondary.
2. **✔ partly done — Four interaction models for one activity.** One row shape,
   one action grammar and one confidence display now run across all four; merging
   them into a single filtered queue is still v2.2. Duplicates uses a comparison
   table with per-option buttons; Cross-filed uses strikethrough chips; Misfiles
   uses inline move buttons; Inbox uses a large card with numbered keys. Unify on
   one card and one action grammar.
3. **✔ partly done — Density is wrong for triage.** Rows are dense with a fixed action column; virtual scrolling is still to do. Hundreds of items reviewed at speed, rendered
   as wrapping flex boxes with 11px padding. Needs a dense row with a fixed
   action column and virtual scrolling. Reference: Linear, Superhuman.
4. **✔ done — No artwork anywhere.** 40px in rows, 76px on the Inbox card. Defensible for pure data, wrong for *auditioning* —
   artwork is the fastest recognition cue when you're deciding whether a track
   belongs. Small (32px) and in the row, not a tile grid. Needs an explicit
   decision.
5. **✔ done — The explanation is buried.** `.why` is a grey inset at 12.5px, but the
   *reason* something is flagged is the most valuable content on the screen —
   it's what makes the tool trustworthy. Give it a real slot in the card.
6. **✔ done — No first-run, empty or error design.** Today: `Loading library…`, and a
   "Not ready" heading with a raw exception message. The first sync takes
   minutes; that's a designed screen, not a spinner.
7. **✔ done — Mobile is a media query, not a design.** It hides the brand and turns the
   rail into a horizontal scroll strip. Filing a backlog is a phone activity:
   one card, thumb-reachable actions, swipe to file/skip.
8. **✔ done — The keyboard model is partial and undocumented** — 1–3/P/S/U exist only in
   the Inbox and only in a sentence of body copy. Needs a real shortcut layer
   across the queue and a `?` overlay.
9. **Confidence is shown as a raw cosine percentage** ("57% fit"), which nobody
   can calibrate. Show three visual steps — strong / likely / speculative — and
   pair them with the tags that drove the match.
10. **The toast is the only feedback channel**: bottom-right, 3.5s, and it also
    carries Undo on a 9-second timer. An undo for a destructive change should not
    be a disappearing corner element. Make it persistent and dismissible.

### Deliverables to ask for

- Token spec, handed over from the existing CSS custom properties.
- The review-queue card in its four variants (unfiled / duplicate / cross-filed /
  misfile).
- Dense list row with fixed action column.
- Command bar with annotated search results.
- First-run and sync-progress screens; empty and error states.
- Mobile inbox.
- A decision on artwork, with a mock both ways.
