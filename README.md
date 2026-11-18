# Betterfy

Keep a large Spotify library in order: find duplicates, catch tracks filed in the
wrong playlist, empty the "liked but never filed" backlog, discover music you
don't already own, and shuffle a playlist so it actually sounds shuffled.

Built because Spotify's Web API stopped providing the data this needs.

**Two ways to run it:**

| | |
|---|---|
| **[Use it in the browser](https://emmachilds98-wq.github.io/Betterfy/)** | Nothing to install. Authorise your own Spotify and work on your own library — there is no server, so nothing leaves your browser. |
| **Run it locally** | Everything the web version does, plus discovery, spaced shuffle with playback control, an undo log, and full Last.fm/Discogs enrichment. |

## Where to start reading

| If you want | Read |
|---|---|
| To use the app | This file, from "What's in the app" down |
| The current state of the work, and what's next | [`docs/BUILD-7-PLAN.md`](docs/BUILD-7-PLAN.md) §0, with the thread briefs in [`docs/BUILD-7-BRIEFS.md`](docs/BUILD-7-BRIEFS.md) and the design plan in [`docs/DESIGN-PLAN.md`](docs/DESIGN-PLAN.md) |
| What to build next (matching, analysis, upgrades), on the owner's real numbers | [`docs/BUILD-8-PLAN.md`](docs/BUILD-8-PLAN.md) |
| The rules for working on it | [`CLAUDE.md`](CLAUDE.md) |
| How the page's script and styles are laid out | [`web/README.md`](web/README.md) |
| The audio contracts and how sound was measured | [`docs/AUDIO-BUILD-PLAN.md`](docs/AUDIO-BUILD-PLAN.md) (frozen contracts), [`docs/AUDIO-ANALYSIS-PLAN.md`](docs/AUDIO-ANALYSIS-PLAN.md), [`docs/BUILD-5-PROGRESS.md`](docs/BUILD-5-PROGRESS.md) (key and tempo measurements) |
| What may and may not be done with Spotify data | [`docs/SMARTER-GENRES-PLAN.md`](docs/SMARTER-GENRES-PLAN.md) §3 |
| The engines | [`docs/ENGINE-V3-ARCHITECTURE.md`](docs/ENGINE-V3-ARCHITECTURE.md), [`docs/THINKING-ENGINE-PLAN.md`](docs/THINKING-ENGINE-PLAN.md), [`docs/TUNING.md`](docs/TUNING.md), [`docs/GENRE-RECOGNITION-PLAN.md`](docs/GENRE-RECOGNITION-PLAN.md), [`docs/review/ENGINE-REVIEW.md`](docs/review/ENGINE-REVIEW.md) |
| New releases | [`docs/RELEASE-RADAR-PLAN.md`](docs/RELEASE-RADAR-PLAN.md) |
| The screens, reviewed with screenshots | [`docs/review/USER-REVIEW.md`](docs/review/USER-REVIEW.md) |
| Firebase (shared tags, sync across devices) | [`FIREBASE.md`](FIREBASE.md) |
| The long-range architecture review | [`V2-PLAN.md`](V2-PLAN.md) |
| Older plans, now done or replaced | [`docs/archive/`](docs/archive/README.md) |

## What's in the app

Four tabs, plus a Settings sheet. On a phone they sit in a bar along the
bottom; swipe left or right to move between them, or use the arrow keys.

- **File** is home. A "today" line at the top says what is waiting (to file,
  new releases, to tidy, what listening is doing), each part a tap to where it
  lives. Below it, one card at a time for a liked track that isn't in a genre
  or mood playlist yet, with the playlists it most likely belongs in marked
  Sure, Likely or Unsure. Tapping a playlist only selects it: nothing reaches
  Spotify until you tap **File** or swipe the card right. Swipe left skips,
  and tapping the artwork plays. Sure cards can be filed in one go, and filing
  one track offers the same artist's other waiting tracks too.
- **Tidy**: **Wrong place** (by tags and by sound), **Repeats** (the same track
  twice in one playlist) and **In two playlists**, with a Sure / Likely /
  Unsure filter. Every change can be undone from History.
- **Discover**: music you don't already own, from "fans also like" for the
  artists you actually play (Deezer and ListenBrainz, plus Last.fm with a
  key), ranked by how it sounds against your playlists. **New releases** by
  artists in your library are here too.
- **Library**: your playlists, each with its axis (genre, mood, event…) and
  how tidy it is, **Suggested playlists**, and a detail sheet per playlist
  (fill it, merge, split). **New playlists** (genres you're not covering) and
  **Shuffle** (spaced, and DJ order by tempo) open from here.
- **Settings**: **Under the hood** holds *Listening and genre sources*, *How it
  picks* (the engine's score on your own filing) and *History* (everything
  written to Spotify, with undo). Then appearance (Nightshift, the dark
  default, Daylight or System), accent colour, behaviour, **Re-sync library
  from Spotify**, **Sync across devices** and **Check for updates**.

**Listening is on by default.** The page fetches each track's 30-second
preview (found by the ISRC Spotify already gives) and analyses it in your
browser, on Wi-Fi only unless you say otherwise. A heard track is filed by
how it sounds; one not heard yet is filed by its artists' tags, and the card
says which. Nothing needs a key, an export or an install.

On an iPhone, open the page in Safari, then **Share → Add to Home Screen**: it
runs full-screen and signs itself in the first time (Spotify already has the
grant). Its storage is separate from Safari's, so the first library read
happens again there; it is paced, banked as it goes and resumes where it
stopped.

## Signing in, and your own Spotify app

Click **Connect Spotify**. Authentication is PKCE, so there is no secret
anywhere. If Spotify refuses the sign-in, or lets it through and then answers
the first read with a 403, that is its user cap on development-mode apps
(5 users per app since the February 2026 update), and the page offers **Use
your own Spotify app** right there. Registering one takes about a minute; the
setup panel shows the redirect URI to paste (**Add**, then **Save**), then
you paste the client ID back. Send friends
[`?setup`](https://emmachilds98-wq.github.io/Betterfy/?setup), which opens that
panel directly.

Their own app is worth it rather than a fallback, for three reasons:

- **The user cap is per app.** On the default app each friend needs the
  owner to add their account email first, and only five fit.
- **The rate limit is per app and pooled per developer account**, so client
  IDs registered under one person's account share one quota. A cold library
  read is several hundred calls; two people reading on the shared app on the
  same afternoon is the "too many requests" screen.
- **Registering an app needs Premium** on the account that creates it (not on
  every account that signs in to it).

The box refuses the default client ID (printed in the page's source, so the
easiest wrong thing to paste) and anything that isn't a 32-character client
ID, and the panel says in words which app is in use. Extended Quota Mode is
not an option: since 15 May 2025 Spotify only accepts it from registered
businesses with 250,000+ monthly users. If `CONTACT_EMAIL` is set at build
time (see `.env.example`), the panel also offers **ask to be added**, a plain
`mailto:`; left blank, the option doesn't exist.

**When Spotify says wait.** Every call has a deadline; a dropped, hung or 5xx
call is retried, and a token that stops working mid-read is refreshed once
before anything is believed. A short throttle is waited out with a countdown
that retries by itself; a long one, or a read whose pauses never end, shows
*Try again* with the real wait and **Use your own Spotify app** beside it. A
429 with `reason: QUOTA_EXCEEDED` skips the countdown, since waiting won't
change it. The read is paced at 250 ms or slower, remembers the last pace
Spotify accepted, and banks every piece (including `/me` and the playlist
index), so a retry costs only the piece in flight. A playlist is recorded as
empty only when Spotify refused *that playlist*, and then without a snapshot
id, so the next read asks again.

**When the browser refuses storage.** Blocked cookies, a locked-down private
window or an in-app web view can throw on `localStorage` or refuse IndexedDB.
All storage goes through shims that fall back to memory and never throw, so
the app still runs and simply re-reads next time. Sign-in checks for
`crypto.subtle` and that the PKCE verifier persisted before it redirects, and
every async handler reports its failure in a toast rather than failing
silently.

## Genre tags, and sharing them

Spotify supplies no genre at all (see "Why it uses Last.fm and Discogs"
below), so the page reads artist tags from four keyless or optional sources,
in this order for an artist with none:

1. the shared table shipped with the page, `docs/tags.json`;
2. **Wikidata** genres, automatically every time the page opens;
3. **Last.fm**, with the shared read-only key the hosted page ships
   (`LASTFM_PUBLIC_KEY` at build time) or your own free
   [API key](https://www.last.fm/api/account/create) to raise limits (the API
   key only; the shared secret is never needed);
4. **Discogs** release styles, with an optional
   [token](https://www.discogs.com/settings/developers), for an artist Last.fm
   has nothing on or fewer than three tags for. Discogs tallies are rescaled
   to Last.fm's 0–100 so the two can be averaged, and a real Last.fm tag
   always wins.

All of it is under Settings › Under the hood › *Listening and genre sources*,
with **Ask again now** to re-run.

**A wrong suggestion is usually a wrong tag.** Last.fm tags are per artist and
crowd-submitted, so a same-named act or three stray taggers can mistag an
artist's whole catalogue. Tags show under misfiled and new tracks, and
**Wrong tags?** beside an artist opens an editor (remove, add, or re-ask
Last.fm); corrections stay on your device.

**The shared table.** Optionally, the browser offers each freshly fetched
Last.fm answer, for an artist the shipped table doesn't cover, to a shared
Firestore collection (`betterfy-1a983`; `TAGS_PROJECT` and `TAGS_KEY` are
baked into the page and are public by design). A scheduled Action
(`.github/workflows/tags.yml`, `npm run tags`) folds them into
`docs/tags.json`. What keeps that cheap and safe:

- **Nothing reads the database at runtime**; browsers only write, and the
  merge is a build step.
- **Gaps only**: an artist already in `tags.json` is never overwritten.
- **A human checks the truth.** `merge-tags.mjs` checks a contribution's shape,
  not whether it's true, so the merge opens a PR on the rolling
  `shared-tags-update` branch rather than pushing to `main`.
- **App Check**, off by default (`APPCHECK_SITE_KEY`, `APPCHECK_APP_ID`):
  a reCAPTCHA v3 token Firestore can require, so the unauthenticated write
  can't be scripted. Turn on enforcement only after tokens show up in Monitor
  mode.
- **Pruning**, with `FIREBASE_SERVICE_ACCOUNT` as an Actions secret: the merge
  deletes each contribution once it's accounted for. Without it the
  collection just grows.
- **Entirely optional**, per `CLAUDE.md`: with no project configured the page
  makes no request. Discogs answers are not shared yet, because the browser's
  query-param auth hasn't been checked against a real response.

The rules are in `firestore.rules` (`npx firebase-tools deploy --only
firestore:rules`, already live on `betterfy-1a983`). To point a fork
elsewhere: `npm run build:web -- --tags-project=<id> --tags-key=<key>`, or
`TAGS_PROJECT` / `TAGS_KEY` in `.env`.

**Sync across devices** (Settings) uses the same project to share skip and
reject feedback, hand-corrected tags and playlist types between two of your
own devices. Each device signs in to Firebase anonymously (nothing to do with
your Spotify account) and a second device links with a six-digit code.
Nothing is created until you tap **Link another device**. Design and rules:
[`FIREBASE.md`](FIREBASE.md).

## Staying on the current version

GitHub Pages caches the page for about ten minutes, and an open tab keeps what
it loaded. Every load checks quietly for a newer build and, if there is one,
offers **Update now** (never forced, so a reload can't lose your place; your
sign-in and library survive it). **Check for updates** does the same on demand,
on the landing screen and under Settings › About, where the running build is
printed. **Re-sync library from Spotify** (Settings › Your library) is a full
re-read of every playlist against a per-app quota, so it lives there and
nowhere else; normal filing keeps the library current by itself.


## What ships, and what must never

Three values are baked into `docs/index.html` on purpose, and it is worth being
able to tell them apart from the ones that would be a real leak:

| Ships | Why it is safe |
|---|---|
| `SPOTIFY_CLIENT_ID` | Names an app. Authentication is PKCE, so no secret is involved — this is the design, not a compromise. |
| `TAGS_PROJECT` | A Firebase project name. |
| `TAGS_KEY` | A Firebase *web* key. It identifies a project rather than authorising anything; `firestore.rules` is what actually decides. |

| Never ships | |
|---|---|
| `SPOTIFY_CLIENT_SECRET` | Only `auth.mjs` / `spotify.mjs` use it, locally, and only because the local app refreshes tokens the classic way. The web build has no use for it at all. |
| `LASTFM_API_KEY`, `LASTFM_SHARED_SECRET` | The hosted page asks each listener for their own key, kept in their browser. |
| `DISCOGS_TOKEN` | Same. |

`build-web.mjs` refuses to write a page containing any of the second group. It
checks the **values** in `.env`, not just the variable names — a secret pasted
into the template by hand arrives with no name attached, which is the shape a
real accident takes. `test/buildguard.test.mjs` runs the real build script
against a poisoned copy of the repo to prove the guard fires.

`.tokens.json` (your Spotify refresh token), `library.json`, `rekordbox.json`
and the `report-*.json` files are all gitignored — they are yours, and none of
them belongs in a public repo.

## Why it uses Last.fm and Discogs

Verified against a freshly registered Spotify app in September 2026:

| Endpoint | Status |
|---|---|
| `GET /audio-features/{id}` | `403` |
| `GET /recommendations` | `404` |
| `GET /artists/{id}` → `genres` | field absent entirely — 0 tags across 956 artists |
| `GET /playlists/{id}/tracks` | `403` — renamed to `/playlists/{id}/items` |
| `POST /users/{id}/playlists` | `403` — use `POST /me/playlists` |
| `PUT`/`DELETE /me/tracks?ids=` | removed on a client ID created after Feb 2026 — use `PUT`/`DELETE /me/library?uris=` (comma-separated `spotify:track:{id}`, max 40) instead. A grandfathered client ID still serves the old form, so every like/unlike call in this project tries the new path first and falls back to the old one, rather than picking one and breaking the other kind of app. |

So Spotify can no longer tell you the genre, mood or tempo of anything. Genre
signal comes from **Last.fm** artist tags — the backbone, covering most of a
library — with **Discogs** release styles as the fallback for an artist
Last.fm has nothing on at all: Discogs' per-release `style` field (Jungle,
Deep House, Electro) is tallied across an artist's catalogue the same way
Last.fm's tag counts are, so it plugs straight into the same model rather
than needing one of its own. It only ever fills a total gap and never
outranks a real Last.fm tag. `MUSICBRAINZ_CONTACT` is still in
`.env.example` for a planned identity-resolution pass — nothing reads it yet,
so leave it blank until that lands.

## How the filing model works

Spotify supplies no genre, so a track's signal is the union of its artists'
Last.fm tags. Each playlist becomes the centroid of its members. Tags are
IDF-weighted, otherwise "electronic" — true of half this library — dominates
every comparison and every playlist looks alike.

Last.fm's cloud is not all one kind of thing, though, so `tagFacet()` sorts
each tag into **genre / mood / era / occasion / descriptor** first — "deep
house" is a sound, "chill" is a feel, "90s" is a decade, "workout" is a
Saturday, "british" is a passport. Each axis then weighs them for the question
it is actually asking: a genre bucket is scored almost entirely on sound, a
mood bucket leads on feel with sound underneath. Nothing is dropped to zero, so
an artist with no mood tags at all still scores on what it has.

Playlists are classified onto axes in `playlists.config.json`
(genre / mood / era / event / DJ set / context / inbox). Only genre and mood
playlists receive automatic filing; a track is only compared against playlists
**on its own axis**, because a metal track legitimately sits in both "Metal" and
a mood playlist and neither placement is wrong.

Edit `playlists.config.json` by hand — the rules that generate it are a first
guess, and everything downstream reads the file, not the rules.

### Sound first, once a track has been heard

With **Listen to my music** on (the default since 2026-11-15; Settings › Under the hood › *Listening and genre sources* switches it off), the File
screen files a heard track by **how it sounds**, not by who made it. Its picks
come from the account-native engine with sound leading: each genre playlist's
sound prototype (the average of your own heard tracks in it, nudged toward a
track you file there and away from one you turn down), the playlist it sounds
nearest, and only then the artist graph. In the app the learner is prototypes
only: no model is fitted to your playlist membership
([`docs/archive/BUILD-5-PLAN.md`](docs/archive/BUILD-5-PLAN.md) §2 item 3). The logistic-regression variant in
`core/intrinsic/audio-learn.mjs` is kept for offline measurement only. That graph now learns from **genre playlists
only**, so a mood playlist or a one-night event playlist can't teach that a
jungle artist and a house artist "go together". The tag engine's best pick
stays on the card as the third choice. A track not heard yet (or with no
preview) gets the tag picks, exactly as before, and the card says why.

This is the owner's call, made ahead of the audio gate in
`docs/AUDIO-BUILD-PLAN.md`: the Score run under Settings › Under the hood › *How it picks* still measures it on
your own filing ("Adding how it sounds"), so it can be checked rather than
assumed. Nothing about it needs a key, an export or an install: every account
has previews, found by the ISRC Spotify already gives.

### What a heard track is: genre, sub-genre, tempo, and what it matches

A heard track's File card also says what it **is**: "Sounds like Drum & Bass ›
Jungle · 174 BPM", with a confidence chip. Tap it for why, the filed tracks it
sounds most like (and which playlists they're in), and the heard tracks it
**mixes with** (a tempo you can beatmatch, straight or half/double time, most
alike first). `core/audio/identify.mjs` and `core/audio/match.mjs` work it out
from four things:

- **the sound model's styles** (Discogs-EffNet): good at families, weak on
  scene genres, so it never decides alone;
- **your library**: the twelve filed tracks it sounds most like, and what their
  genre playlists' names say. This is what knows that "hard house" at 150 with
  your Donk playlist's sound is donk;
- **the artist's tags**, at a discount;
- **tempo** (`core/ontology/tempo.mjs`, a reviewed working range for every
  genre): settles "87 or 174?" by the genre it sounds like, and marks down a
  genre whose range excludes a confidently measured tempo (172 BPM is not
  breakbeat).

Votes add up the genre tree, so a split between jungle and liquid still agrees
on Drum & Bass, and a sub-genre is named only when it holds at least half of
its genre's support. Two genres in one clip are shown as a blend.

Tempo also counts in sound-first filing now: the share of a playlist's heard
tracks a track could be beatmatched with (Rekordbox data wins where present).
The Score run measures naming on tracks you've already filed ("Naming genres
by sound": genre and sub-genre right, model alone vs with your library, and how
often the tempo fits the playlist's genre). All of it is nearest-neighbour
lookups and counts on your own heard tracks, plus the per-playlist prototypes
above (averages of your own heard tracks): no model is fitted to your playlist
membership, and nothing is shared.

## Design decisions worth knowing

- **Remixes are not duplicates.** Extended mixes, VIPs, bootlegs and live cuts
  are different records and are never merged. Only cosmetic differences
  (remaster tags, `feat.` credits, punctuation) are normalised away.
- **Within a playlist vs across playlists.** The same track twice in one
  playlist is a mistake. The same track in five playlists is usually deliberate,
  so it is surfaced for review and never auto-removed.
- **Axes are guessed from names, then from dates, then from the tags.** A
  playlist named for a club or a decade says what it is. One named for whoever
  you were with that night does not, and used to fall through to *genre* —
  where it competed for suggestions with the real genre buckets and turned up
  in Misfiles as noise. A playlist whose tracks all landed within a few days
  and which has had nothing added for over a month is read as an event instead.
  Both halves are needed: "added in one go" alone would catch a playlist
  someone built last week by dropping fifty tracks in at once. With neither
  saying anything, the tags get the last word — see the next bullet. Every
  playlist on the Playlists screen says what its guess was made from, and
  correcting one overrides all three.
- **Not every tag is a genre, and reading them as if they were hid real
  misfiles.** Last.fm hands back one flat cloud per artist with no type in it,
  and every tag in it used to count equally as evidence of what a track sounds
  like. Measured on a two-bucket fixture where House and Jungle happen to share
  "chill / 90s / party / british": a jungle track sitting in the house playlist
  scored **0.499** at home — enough to bury it in the lowest confidence band —
  purely on that coincidence of feel, decade, occasion and nationality. Reading
  the genre tags as the genre evidence puts the same track at **0.085** and the
  top band. On the Playlists screen every row now shows what its tracks are
  actually tagged with ("64% genre · 19% mood"), and tag chips throughout the
  app draw the non-genre ones back, so you can see how much of your "genre
  data" is really genre. The vocabulary is Last.fm's, which is global — this is
  not one listener's playlist names, so it works for an account nobody has
  tuned for. Whole tag only, never a substring: "chill" is a mood, "chillstep"
  is a genre, the same lesson the name rules learned. And anything unrecognised
  stays a genre, because being wrong in that direction only costs the status
  quo.
- **A feature colours a track; it does not define it.** `trackVec()` used to
  average every credited artist's tags equally — a drum & bass tune with a
  guest MC who happens to have a stronger Last.fm following as a grime artist
  pulled the whole track toward grime, at full strength, on Spotify's own
  billing order alone. Credited artists are now weighted by billing position
  (the primary, first-listed artist carries the full weight of a solo track;
  a feature colours it at half that), so the actual producer's sound still
  leads and a well-tagged guest can no longer outvote them. Measured against
  no data of any kind — this only changes what happens once more than one
  credited artist actually has tags.
- **Thin data is not the same as strong data, and used to be treated
  identically.** An artist Last.fm barely answered — one tag, just over the
  count-≥10 floor — used to shape a centroid exactly as confidently as one
  with fifteen tags at 80-100. Below three tags, an artist's contribution is
  now scaled down with how little there actually is (to a third at a single
  tag); at three or more, nothing changes from before this existed. The same
  three-tag line is what makes a Last.fm answer "thin" everywhere else in this
  README — the point past which it is trusted at face value. A suggestion
  built entirely on thin data is flagged in the UI ("thin data" next to its
  tag chips) rather than presented with the same confidence as one backed by
  real coverage.
- **A tag only one artist in the whole library has is exactly as likely to be
  a misspelling as a real answer.** Last.fm's tags are crowd-submitted with no
  spellchecker and no curated genre list to check them against, so a stray
  scrobble or a one-off tagger's typo looks, to the model, identical to a
  genuinely rare micro-genre. `tagGate()` (`profile.mjs`) requires a tag to be
  attested by at least two artists across the whole library before it can
  shape a centroid at all — cheap for a real genre with any following, and it
  quietly drops the ones that are just noise from a single bad answer. The
  real cost: a genuinely one-artist niche genre in a small library loses its
  only distinguishing tag, which is why the bar is kept at two, not higher.
- **A same-named artist can poison a tag fetch worse than an empty one.**
  Last.fm's `artist.gettoptags` is queried by name with autocorrect on, and
  more than one artist shares a name in electronic music alone — an
  autocorrect that lands on the wrong one returns a confident, wrong tag set,
  which is worse than nothing because it actively misfiles every track by the
  real artist. With a free `MUSICBRAINZ_CONTACT` set (see `.env.example`),
  `npm run enrich` now looks up each artist's exact MusicBrainz id first, from
  the Spotify artist URL MusicBrainz volunteers attach to an artist page — an
  exact match, no name-fuzziness involved — and asks Last.fm for that id
  (`mbid=`) instead of a name when one is found. Off by default, and Node-only:
  the lookup needs a custom `User-Agent` a browser `fetch` cannot set, so the
  hosted page's name+autocorrect path is unchanged either way. Not yet
  confirmed against a live MusicBrainz response from every environment this
  runs in — see `musicbrainz.mjs` for what to check if a shape mismatch ever
  shows up as "MusicBrainz never seems to match anything."
- **At first login there is no third-party data at all, and the model used to
  have nothing to say about that.** Coverage on day one is whatever fraction
  of a brand-new account's artists happen to already be in the shipped
  `docs/tags.json` — for a library that doesn't overlap much with it, `rank()`
  returns nothing for most of the backlog and the Inbox looks broken rather
  than merely under-tagged. `artistHistory()` (`profile.mjs`) is a fallback
  that needs no tags and no third-party call at all: if most of an artist's
  *other* tracks already live in one of your own playlists, an unfiled track
  by them is suggested there on that basis alone, and it only ever steps in
  when tag-based ranking has nothing confident to say. It's a placement
  count, not a similarity score, so it's shown as "4 of 5 other tracks by
  this artist are already here" rather than a misleading tag-fit percentage.
  Only the primary, first-billed artist is matched, same billing-order
  reasoning as `trackVec()`'s confidence weighting above.

  Finding a real use for this surfaced a latent bug it would otherwise have
  tripped over: the "All Songs" mirror playlist holds a copy of every track
  by construction, so `classify()` and `axes.mjs` were both letting it become
  a filing target — meaning it would always "win" a history count (every
  artist's own copy sitting inside it) and, for the existing tag-based model
  too, contribute a same-as-average-of-everything centroid to every ranking.
  Both now exclude it explicitly, the same way it was already excluded from
  the tag baseline.
- **A playlist that says nothing in its name is asked what it is made of.**
  The one thing left after the name and the dates is the tags, read as a
  facet mix against *your own library's* baseline rather than a fixed share —
  mood tags are a small slice of anybody's cloud, and a threshold tuned on one
  library would be wrong for the next. A playlist carrying getting on for twice
  the mood weight of everything else you own is a mood playlist in your
  vocabulary, whatever the raw percentage. Decades read as an era, occasions
  as context. It is a last resort by construction: it never overrules a name,
  a date or a correction of yours, so nothing that was already being read
  correctly starts being read differently. (This is not the tag-coherence rule
  that was tried and rejected — that asked how *tightly* a playlist's tags
  agree, which turned out to measure how broad it is. This asks which *kind* of
  tag holds it together.)
- **Spotify's own playlists are an inflow, not a destination.** Discover
  Weekly, Release Radar, On Repeat, Daily Mix, Your Top Songs, My Shazam
  Tracks — everyone has them under exactly those names, so this needs no
  vocabulary of yours at all. Read as genre buckets they were filing targets,
  which meant Tidy offering to move your music into a playlist Spotify
  overwrites every Monday. Playlists named for a situation (Gym, Study, Road
  Trip, a wedding) are read as context for the same reason: there is no genre
  in them for anything to be compared against.
- **A playlist can go wrong two ways: one track, or the whole thing drifting.**
  Misfiles catches the first — a track that fits another playlist on the same
  axis far better than the one it's actually in, flagged only past a wide
  margin so ordinary cross-genre overlap stays quiet. The **Playlists** screen
  now also catches the second: a playlist whose newest additions score low
  against everything added before them — the same measurement, just run on a
  playlist's recent quarter against its older three-quarters instead of one
  track against a centroid. Neither auto-corrects anything; both are a
  prompt to look, not a verdict. The drift threshold is a first pass, not
  yet checked against a real library the way the misfile margin was — expect
  to tune it once you can see it against your own playlists.
- **A tag gap that was never answered is not an answer.** Filling a Last.fm
  gap costs a request and is cached so it is only ever paid once, which makes
  it important which answers are worth keeping. "Last.fm has nothing on this
  artist" and "that request failed" both arrive as an empty array, and both
  used to be written down as the artist's permanent tag set — so one bad minute
  of signal froze every artist it touched as untaggable, on that device, for
  good. Only an answer that actually landed is cached now, and the count on
  **Fetch missing tags** means the same thing the run does (it used to offer to
  fetch tags for artists it then reported as "Nothing missing").
- **Nor is a thin one, forever.** A genuine "nothing here" or "barely
  anything" answer is not a request-that-failed, but it is not permanent
  either — Last.fm's crowd tags and Discogs' catalogue both grow, so an
  artist who really had fewer than three usable tags six months ago may not
  still be that thin. `worthReasking()` (`cache.mjs`) re-asks anything thin
  after about six months, and asks again immediately for anything that
  actually errored; a well-tagged artist is never re-asked at all, since
  there is no upside. **Fetch missing tags** now covers this on the hosted
  page too — "missing" means thin, not just absent. A hand-correction you
  make in the tag editor is stamped as freshly checked so this can never
  quietly overwrite it later.
- **Real listening now steers more than Discovery.** Your top artists over
  Spotify's three windows plus recent plays — previously only used to seed a
  Discovery run — now also decide which artist's tag gap gets filled first
  when you hit **Fetch missing tags** (so an interrupted fetch still covers
  what actually matters), and note on a Misfiles row when you're playing that
  artist heavily right now, since that's more likely a deliberate keep than a
  mistake. It's a note, not a rule: misfile confidence itself doesn't change,
  because that's the one number with direct tests against it.
- **Discovery subtracts what you own** — every artist and track in the library,
  including each artist named inside a collaboration credit, so a seed artist
  can't return as one half of a duo. **Everything I listen to** weights your
  top artists over the three windows Spotify keeps and your recent plays, with
  the filed library behind them as a floor — so an artist you had on all month
  steers a run harder than a playlist you filed once and never played. Seeding
  from a single playlist instead gives you that playlist's radio, and costs no
  requests at all. Results come one card at a time: the album
  cover, a scrubber that drives your own Spotify device, and the playlists the
  track would fit — ranked by the same model the inbox files with, since
  discovery also pulls the new artist's Last.fm tags. Take the suggestion or
  overrule it from the dropdown; either way the track is added and the card
  moves on. With **Listen to my music** on, the picks are heard too (ISRC →
  Deezer preview, kept in memory, never in your library's store) and the cards
  still to come are re-ranked by how close each sounds to the seed — calibrated
  so 100% means "as close as the seed's own tracks are to each other". A heard
  pick also gets playlists by sound (the filed tracks it sounds like vote), so
  a pick with no tags can still be offered somewhere (`core/audio/discover.mjs`).
- **Shuffle spaces artists rather than randomising.** Uniform random clumps; the
  greedy max-spacing interleave takes the artist with the most tracks left,
  skipping any used within a cooldown window. Artists are indexed by how many
  tracks they have left rather than rescanned on every placement — the scan was
  quadratic, and on a twelve-thousand-track source it cost about twelve seconds
  of blocked main thread *per redraw of the screen*. The order is also cached
  against the playlist it was built from now, so an unrelated redraw doesn't
  re-roll it; **Shuffle again** is the deliberate re-roll.
- **All Songs — Betterfy is a shuffle source, and only that.** A playlist
  Betterfy keeps topped up with everything in your library, so Shuffle has
  something better to default to than whichever bucket happens to be biggest —
  build or refresh it from the button on the Shuffle screen. It's a real
  Spotify playlist, not a snapshot: running it again only ever adds whatever's
  missing since the last time, and never duplicates a track that's already
  there. Everything else in the app treats it as a *view* of the library rather
  than a place anything was filed, because it holds a copy of every track by
  construction. Read as an ordinary playlist it broke three screens at once:
  every liked song counted as filed, so the File queue emptied; every track was
  suddenly "in more than one playlist", so Cross-filed swelled to the whole
  library; and two pressings of one record, happily filed apart, met inside it
  and were reported as a repeat.
- **The mirror is remembered by id, and three things used to break that.**
  *Renaming it* — the first thing anyone does to a playlist they mean to keep —
  made a lookup by name unable to find it, so the next refresh built a second
  one and poured a copy of the whole library into that; the id survives a
  rename, and the name is only the fallback for the first refresh after this
  change. It is still looked up *inside* your playlist list rather than fetched
  by id, because Spotify never really deletes a playlist, it unfollows it, and
  `GET /playlists/{id}` keeps answering for one you threw away — requiring it
  to still be in your library is what makes deleting it and pressing the button
  mean "build me a new one". *Track relinking* is the second: Spotify swaps a
  track for whichever pressing is playable in your market and hands the
  original back under `linked_from`, so the id you added is often not the id
  you read back — matched on the visible id alone, every relinked track looked
  missing on every single refresh and was added again each time. Both ids now
  count as present. *And the damage from before that* is cleared out: a track
  in the mirror more than once has its surplus copies removed, deleted by
  position from the end backwards (deleting by URI would take out the copy
  that should stay, and a local file with no id still holds its slot, so
  positions have to be counted including the ones that carry nothing). The
  shuffled `🔀` playlist is pinned by id for the same reason.
- **The mark is a sorted list that is also a play button.** Five stacked bars
  whose widths grow then shrink, so their right edge forms a play triangle. In
  the app it is inline SVG and keeps its five colours whatever accent you pick; at
  favicon size the gaps close up and it degrades into the triangle alone, which
  is the point. `npm run build:icons` re-renders `docs/icon-*.png`,
  `apple-touch-icon.png` and the maskable icon from that same geometry — no
  image editor, and no chance of the files drifting from the markup.

## Files

| | |
|---|---|
| `spotify.mjs` | API client — token refresh, pagination, 429 retry |
| `merge-tags.mjs` | Folds contributed Last.fm tags into `docs/tags.json` |
| `firestore.rules` | Shared tag table — deliberately public, shape-checked |
| `storage.rules` | Per-account private blobs — not provisioned yet, see `FIREBASE.md` |
| `FIREBASE.md` | Verified project state, console steps, and the cross-device sync plan |
| `norm.mjs` / `credits.mjs` | track identity and collaboration-credit splitting |
| `profile.mjs` | tag vectors, playlist centroids, IDF, ranking, the tag gate, the filing-history fallback |
| `enrich-lastfm.mjs` / `enrich-discogs.mjs` / `tagstore.mjs` | fetch and merge genre tags — Discogs fills a total gap and blends into a thin one |
| `musicbrainz.mjs` | resolves a Spotify artist to a MusicBrainz id, so enrich-lastfm.mjs can ask Last.fm by id instead of a name — Node-only, optional |
| `listening.mjs` | real listening behaviour (top artists, recent plays) as a weight per artist — best-effort, works with no Spotify auth available too |
| `snapshot.mjs` | dumps the whole library to `library.json` |
| `actions.mjs` | every library mutation, with the undo log |
| `legacy/server.mjs` + `ui/` | the older local app (developer-only; see "From a checkout") |
| `build-web.mjs` + `docs/` | the browser build for GitHub Pages |
| `core/` | the engines the page runs (audio, account-native placement, review queue, playlists, new releases, measurement) and the v3 evidence classifier, measured beside v1; see below |
| `enrich-lastfm-tracks.mjs` | track-level Last.fm tags, prioritised by what you play and what the engine is least sure about — optional, resumable |
| `legacy/analyse-v3.mjs` | developer-only: runs the v3 engine over your `library.json` and existing caches: bands, playlist types, relationships, and the review queue |
| `make-icons.mjs` | renders the logo to the PNG sizes browsers and phones ask for |

`build-web.mjs` bundles `norm`, `credits` and `profile` verbatim into the page,
so the browser and local builds score identically and cannot drift apart. It
refuses to build if a secret appears in the output.

### The v3 evidence engine (`core/`)

`core/` started as an evidence-based classifier built beside v1 rather than
instead of it: a versioned genre ontology, one evidence record every provider
maps into, and a deterministic classifier that reconciles up and down the
genre tree and is allowed to answer "not enough evidence". Its v3 classifier
(`core/engine.mjs`) is still measured beside v1 rather than driving the File
card. Most of the rest of `core/` is in the page: the audio code
(`core/audio/`), the account-native engine below, the review queue
(`core/review/`), playlists, new releases (`core/release/`), measurement, and
the suggestion layer (`core/recommend/`, which only ever suggests: a test
enforces that it produces no move or removal).

- It reads track-level Last.fm tags when it has them (`npm run enrich:tracks`),
  which is what fixes a diverse artist handing one tag cloud to everything
  they made; without them it reports lower confidence.
- It reads playlists too: what each one is (genre, mood, occasion, event, era,
  artist, DJ set, mixed) and which ones are duplicates, views of one
  collection, or event copies of a bigger bucket, recognising events by shape
  (a date plus a word the ontology doesn't know) with no venue list.
- Your corrections live in an append-only layer (`core/personal/`) that never
  touches provider evidence, so an engine change never loses them.
- `core/ai/` is a constraint layer with no model wired to it: if one ever is,
  it can only choose between candidates the evidence already produced, capped
  at "likely". None of the accuracy numbers involve a model.

```sh
npm run benchmark             # accuracy and false-positive rate, per confidence band
npm run benchmark:compare     # v1 against v3 on the same fixtures
npm run benchmark:playlists   # playlist type and relationship accuracy
npm run benchmark:fit         # which of the engine's thresholds the benchmark actually pins down
npm run analyse:v3 -- --queue # your library: bands, playlist types, and the questions worth asking
```

`benchmark:fit` is worth being blunt about: some thresholds are uncontradicted
rather than validated, and it names the kind of case that would constrain
each one. Full write-up: [`docs/ENGINE-V3-ARCHITECTURE.md`](docs/ENGINE-V3-ARCHITECTURE.md).

### The account-native engine (`core/intrinsic/`), which needs no key at all

`CLAUDE.md` says external enrichment must never be something the core filing
model leans on, and a tag engine leans on Last.fm completely. This engine
fixes that with a reframe: "what genre is this track?" needs an outside
vocabulary, but **"which of this account's playlists does it belong with?"
needs none**, because a playlist is already a labelled training set of what
*you* mean by it.

| Signal | Where it comes from |
|---|---|
| How it sounds: each playlist's prototype, the average of your own heard tracks in it | 30-second previews, analysed in the browser |
| Artist co-occurrence, as PPMI over **your own genre playlists** | playlist membership |
| Neighbours of an artist you've never filed: of their Deezer and ListenBrainz neighbours you *have* filed, where did they go? | keyless lookups; the sources never name a genre |
| Label family, from the **ISRC registrant** (weighted by how many playlists it spans, so an aggregator weights itself to zero) | `isrc` |
| Add-session cohesion | `added_at` |
| Format shape (a seven-minute cut on a two-track release is a club record) | duration, album type, track counts |
| Era | release date |
| Tempo and key | heard tracks; your Rekordbox import wins where present |

**Your filing is the answer key.** Hide a track, ask where it goes, compare:
held-out placement accuracy runs per account in seconds, with a leakage canary
in the harness. *How it picks* in Settings runs it on your own library and
scores both engines on the same folds; Score + Tune also runs by itself. It
also says which **rung** your account is on ("not enough filed yet" is a
different sentence from "low confidence"), and the playlists it can't tell
apart.

**How sure it may sound is fitted, not guessed** (`core/intrinsic/calibrate.mjs`):
a placement is *Sure* only if suggestions at that level were right 90% of the
time (with a lower confidence bound) and the sources agree, a short list is
built to hold the right playlist about nine times in ten (split conformal
prediction), and otherwise it says it isn't sure. Thresholds are fitted on
half the tracks and checked on the other half.

It measures agreement with *your* habits, not musical truth: a systematically
misfiled library is reproduced faithfully.

```sh
npm run validate:placement              # the intrinsic engine against v1, on YOUR library.json
npm run validate:placement -- --reports # which of your buckets are the same thing twice
npm run validate:placement -- --sweep   # which weights your library actually pins down
npm run validate:placement -- --bridge  # with and without the neighbour bridge
```

Plan, execution log and measured numbers:
[`docs/THINKING-ENGINE-PLAN.md`](docs/THINKING-ENGINE-PLAN.md) and
[`docs/SMARTER-GENRES-PLAN.md`](docs/SMARTER-GENRES-PLAN.md).


### Filing the rest of an artist at once

File a track, and if the same artist has more tracks waiting, the File screen
offers to put those in the same playlist too. Every track is listed and can
be unticked. Anything you've already turned down for that playlist is left
out. Each playlist gets its own History entry, and one undo takes the lot
back.

### New playlists: genres you're not covering

**Library › New playlists** (`core/recommend/gaps.mjs`, phase 3 of
`docs/SMARTER-GENRES-PLAN.md`) proposes three things, and creates nothing
without a tap:

- **Genres with no playlist.** The genres your liked and loosely filed music is
  in that none of your genre playlists is for, rolled up to the level you'd name
  a playlist at. Forty bassline tracks are offered as "Bassline", not lost
  inside "UK Garage". A genre a broader playlist could take is still offered
  when there's enough of it: a "House" playlist doesn't swallow donk. What
  you're playing now, from Spotify's top artists and recently-played, comes
  first.
- **Playlists that are two genres.** Genre playlists whose tracks split into two
  genres, including one inside the other: "Bass" becomes Bassline plus the rest
  of UK Garage. Making a half copies those tracks into a new private playlist,
  and the original is never edited.
- **Groups in your backlog**, as before.

Genres come from your artists' tags (the shared table, plus Last.fm or Discogs
if you've set them up), read through the same vocabulary as everything else.
Artists with no genre in their tags are counted and said, not guessed at.

## From a checkout (developers)

**Developer-only.** Nothing in this section is needed to use Betterfy: every
account gets the whole app from the hosted page, with no checkout, export or
install. The Node side predates the hosted page. It works on a `library.json`
snapshot and is how the engines are measured; the hosted page is the app.
The Node CLIs below and everything under `legacy/` are kept for measurement
and comparison only, and new features don't go there.

### Setup

Requires Node 22+ (uses built-in `fetch`; no dependencies).

1. **Spotify app** — https://developer.spotify.com/dashboard → Create app.
   Add redirect URI `http://127.0.0.1:8888/callback` exactly; `localhost` is
   rejected. Tick Web API. Copy the client ID and secret.
2. **Last.fm key** — https://www.last.fm/api/account/create
   Optionally connect Spotify scrobbling at
   https://www.last.fm/settings/applications — Spotify's API only returns your
   last 50 plays and keeps no history, Last.fm keeps everything from that day on.
3. **Discogs token** (optional) — https://www.discogs.com/settings/developers
   → Generate token. Fills a total Last.fm gap and blends into a thin answer;
   leave it blank and `npm run setup` skips that step rather than failing on it.
4. **MusicBrainz contact** (optional, no signup) — any string identifying you
   or this install, e.g. an email address. Lets `npm run enrich` resolve each
   artist's exact MusicBrainz id ahead of the Last.fm fetch, so a same-named
   artist can't get autocorrected onto by mistake. Leave it blank and every
   artist is looked up by name exactly as before this existed.
5. Copy `.env.example` to `.env` and fill it in.

```bash
npm run setup     # authorise, snapshot the library, fetch tags, classify playlists
```

`npm run setup` opens a browser once for Spotify authorisation. The Last.fm
fetch takes roughly 20 minutes for ~5,600 artists and is resumable — rerun it
if interrupted and it continues from where it stopped. The Discogs pass that
follows only touches artists still empty after that, so it's a much shorter
run — or an instant no-op with no `DISCOGS_TOKEN` set.

### Commands

```bash
npm run dupes        # duplicates, split into within-playlist vs cross-filed
npm run misfile      # possible misfiles + where the unfiled backlog should go
npm run discover -- --like "Jungle & Breaks"   # new music, excluding all you own
npm run shuffle -- "Techno" --play             # spaced shuffle, played on your device
npm run consolidate  # maintain one playlist holding every unique track
npm run rekordbox -- "collection.xml" --write  # import tempo/key from Rekordbox
```

Everything is **dry-run by default**. Commands that change your Spotify library
print what they would do and stop; add `--apply` to commit.

### The local app (`npm start`, developer-only)

Developer-only, and not maintained as a product. `legacy/server.mjs` and
`ui/` are the older desktop-browser app: an Overview
page with **Refresh** (re-fetch from the local server, seconds) and a separate
*Re-read from Spotify* (minutes), and a Settings panel for appearance and
accent colour stored in `localStorage`. The hosted page has replaced it for
everyday use.

## Data sources, and what they're worth

| Source | Verdict |
|---|---|
| **Last.fm** artist tags | The genre backbone. Good coverage, sends `access-control-allow-origin: *` so it works from the browser too. |
| **Discogs** release styles | Wired as a fallback: only queried for an artist Last.fm returned nothing for at all *and actually answered about* (a dropped request is not an empty answer), tallying `style` across that artist's releases (Breakbeat / Techno / Electro — finer than Last.fm's one flat tag per artist) and rescaling the tally to Last.fm's 0–100 so the two can be averaged at all. Needs a token in the `Authorization` header from Node, so this side is verified; the browser build sends it as a query param instead to avoid a custom header, which has **not** been checked against a real response — confirm it under Settings › Under the hood › *Listening and genre sources* once you have a token. |
| **MusicBrainz** | Identity glue, wired into `npm run enrich` (`musicbrainz.mjs`): resolves a Spotify artist to an exact MusicBrainz id from the Spotify URL on its artist page, so the Last.fm fetch that follows can ask by id instead of a name autocorrect might match onto a same-named artist. No key, but wants a contact string in the User-Agent (`MUSICBRAINZ_CONTACT`) — off with none set. Node-only: the custom header a browser `fetch` cannot set is exactly what this needs, so the hosted page is unaffected either way. The response shape it parses is written from MusicBrainz's documented ws/2 JSON, unconfirmed against a live response from every environment — see `musicbrainz.mjs`. |
| **GetSongBPM** | Tempo, key and Camelot notation — but only **20% coverage** measured over a 40-track sample of a current UK electronic library. Superseded by the Rekordbox import below; nothing calls it. |
| **Deezer** | Its public BPM field was empty for 4 of 5 tested tracks, so it isn't used for tempo. Its **related artists** are used, by the neighbour bridge below: keyless, reached by the ISRC Spotify already gives (ISRC → recording → credited artist, so no name matching), and read through a sandboxed frame because Deezer sends no CORS header. Measured on the owner's library: 81% of the scene artists Wikidata doesn't know have a related list. |
| **ListenBrainz** | Similar artists from real listening sessions: keyless and CORS-open, keyed by MusicBrainz id. Used by the neighbour bridge. 90% of the owner's scene artists that have an MBID got at least one neighbour in the library. |
| **Wikidata** | Spotify artist id → MusicBrainz id and genres, exactly, 300 per query, keyless, CORS-open. The MBIDs are how the page reaches ListenBrainz without MusicBrainz's one-request-a-second limit. The genres fill artists that have **no tags at all**: automatically every time the page opens, before Last.fm (Settings → Sources → **Ask again now** re-runs both). Measured live on 600 of the owner's artists, 35% had genres, and 92% of those read as genres in the vocabulary. It never touches a tagged or corrected artist, never goes to the shared table, and Last.fm replaces it when you have a key. It knows established artists far better than scene producers. |
| **Every Noise at Once** | Checked 2026-11-18 and **not used**. Three reasons, each enough on its own: (1) its `robots.txt` sets `ai-train=no, use=reference` and disallows AI agents by name, so it can't be collected into a bundled snapshot; (2) its artist-to-genre lists are Spotify's own genre tagging, frozen in late 2023, so shipping them would be the compilation of Spotify Content that Developer Terms IV.3.1.1 rules out (see `docs/SMARTER-GENRES-PLAN.md` §3); (3) what's left, a 2-D map of genre neighbours, says jungle sits next to drum & bass, which the family ontology (`core/ontology/genres.mjs`) already knows. It can't separate an account's own splits such as jungle vs rollers (rollers isn't one of its genres); that's the job of the per-pair sound check (`core/intrinsic/pairs.mjs`). |

Tempo and musical key now come from **your own Rekordbox collection**, not a
third-party lookup — `npm run rekordbox -- "path/to/collection.xml" --write`
matches it against `library.json` (exact artist+title+version first, base
title next, so an extended mix never gets silently treated as the original)
and writes `rekordbox.json`. Nothing reads that file back into the scoring
model or the UI yet — it's an import step ahead of that wiring, not a dead
end, but today it's a report you'd open by hand.

Generated files (`library.json`, `tags-lastfm.json`, `.tokens.json`, reports) are
gitignored — they're yours, not the project's.

## Licence

MIT.
