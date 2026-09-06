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

### Using the hosted version

Click **Connect Spotify**. If sign-in is refused, that is Spotify's 25-user cap
on development-mode apps — the page now offers *use your own Spotify app*
right there when that happens, so nobody has to hand their account email to
the person running the page just to be added to a list. Registering one takes
about a minute and needs no secret — authentication uses PKCE — or the owner
can still add your email under **User Management** in their app's dashboard
if they'd rather manage it that way.

**Sharing it with a couple of friends.** Send them the page, but send them
[`?setup`](https://emmachilds98-wq.github.io/Betterfy/?setup) with it — that
opens the *Use a different Spotify app* panel, which is also linked from the
landing page's fineprint. Two things make their own app worth the minute it
takes rather than a fallback for when something breaks:

- **The 25-user cap** is per app, so on the default app they need the owner to
  add their account email first. On their own app they are the only user.
- **The rate limit is per app too, not per listener.** Every account signing in
  with the default app spends the same budget, and a cold library read is
  several hundred calls — so two people reading their libraries on the same
  afternoon is exactly the "Spotify is handling too many requests" screen. Their
  own app has a budget nobody else can touch.

Nothing else changes: same page, same features, no secret, nothing shared with
whoever sent the link. Paste the redirect URI the setup panel shows into the
new app (**Add**, then **Save** — adding without saving looks identical until
sign-in fails), then paste the client ID back.

There is no setting that removes the cap for everyone without Spotify's
involvement: Spotify's own **Extended Quota Mode** is the only way to let any
Spotify account sign in with no allow-list at all, and that's an application
the developer submits through their dashboard for Spotify to review — not a
switch this project can flip on its own, and not guaranteed for a small,
non-commercial app. Bringing your own app sidesteps the cap entirely in the
meantime, since each person's app has only ever needed to authorise its own
creator.

The prebuilt genre tags shipped with the page cover one person's artists, so
your suggestions may start thin. The **Playlists** view shows your tag coverage
and can fill the gaps in your browser given a free
[Last.fm key](https://www.last.fm/api/account/create) — paste the **API key**
only; Betterfy only ever reads public tag data, so the shared secret that
comes with a Last.fm app is not needed anywhere in this project. The
**Discover** screen asks for the same key inline the first time you open it,
so a first-time listener never has to go hunting for the Playlists screen
just to get started. A free
[Discogs token](https://www.discogs.com/settings/developers), also on
Playlists, is optional and only ever fills an artist Last.fm has nothing on
at all — a real Last.fm tag always wins.

**A wrong suggestion is usually a wrong tag, not a wrong model.** Last.fm's
tags are per *artist*, not per track, and crowd-submitted — a same-named act,
a stray scrobble, or a niche artist with three taggers is enough to mistag
everything they've made. If Tidy keeps suggesting somewhere a track plainly
doesn't belong, open it there: tags now show under every misfiled and
newly-added track, and **Wrong tags?** next to an artist's name opens an
editor — remove the bad one, add the right one, or re-ask Last.fm, and it's
remembered on this device from then on. The **Playlists** view also now flags
which playlists it had no real signal for and silently defaulted to genre —
worth a pass, since that default is exactly what turns a mood or context
playlist into noisy Tidy suggestions.

### On a phone

The hosted page is built for an iPhone first. Open it in Safari, then
**Share → Add to Home Screen**: it runs full-screen with its own icon, and the
layout keeps clear of the notch, the Dynamic Island and the home indicator
rather than sliding under them.

- **Bottom tab bar** — Home, File, Tidy, Discover, Shuffle, and **More** for
  New playlists, Playlists and History. Counts ride the icons. Duplicates,
  Misfiles and Cross-filed were three screens asking the same question, so
  they are one screen, **Tidy**, with a section each.
- **Swipe left or right** anywhere on a screen to move to the next or previous
  one; the dots under the header show where you are. Arrow keys do the same
  thing on a keyboard.
- **File into one playlist or several.** Tapping a suggested playlist (or
  adding one from the dropdown) only selects it — nothing reaches Spotify
  until you tap **File** or swipe the card right, so a misclick is a non-event
  rather than something to undo. Swipe right confirms whatever's selected, or
  falls back to the best guess if you haven't picked anything; **left** still
  skips, and tapping the artwork still plays.
- **Pull down** at the top of any screen to re-sync from Spotify.
- Settings and More open as sheets from the bottom edge; flick the handle down
  to dismiss.

Each of the five screens owns one of the five colours in the Betterfy mark, so
the card on Home, the tab you tap and the screen you land on are all the same
colour — and it is the same colour every time, not whatever the accent happened
to spin off. The accent itself still colours the buttons, the highlights and
the hues on the screens behind More, with a readability correction, since a
yellow and a blue at the same lightness are nowhere near as legible as each
other.

Betterfy opens in **Nightshift**, its dark theme. Daylight and System are both
in Settings; System follows the phone, including its sunset schedule.

The local app (`npm start`) is still laid out for a desktop browser.

**The home-screen app signs itself in.** The first time you open it it goes to
Spotify on its own and comes straight back, because Spotify already has the
grant — nothing to tap. It only tries that once per sign-in: if it is refused
it lands on the normal landing screen and stays there rather than bouncing.
Disconnecting, or Spotify itself revoking the sign-in, resets that — the next
open tries the same silent round trip again rather than leaving you with a
button to tap forever. There is no way to hand a sign-in across from Safari,
because iOS keeps the two sets of data apart, but there is no need to type
anything either.

**The first read on a new device takes a while.** iOS gives a home-screen app
its own storage, separate from Safari's — so adding Betterfy to your Home
Screen means signing in again and reading the whole library again, several
hundred calls for a large one. That read is paced to stay under Spotify's
limit, and it is banked as it goes: a rate limit, a locked screen or iOS
reclaiming the page behind you costs only the piece in flight, and opening the
app again picks up where it stopped rather than starting over. Playlists are
matched on the snapshot id Spotify stamps them with, so every read after the
first only fetches what has actually changed.

**If sign-in says "too many requests".** Spotify rate-limits its accounts
service per app rather than per listener, so a busy few minutes can refuse
anyone's sign-in with a 429. Betterfy now waits it out rather than making it
worse: a rate-limited refresh leaves you signed in and offers *Try again*
instead of dropping you back at the sign-in screen, and reopening the
home-screen app never re-sends an authorization code it has already used.
Whenever Spotify says how long the wait actually is, that screen now counts
it down and retries itself when it reaches zero — the same fix the "asked
for a pause" screen below already had, brought to every sign-in path that
can hit this 429 (a stale refresh, an interrupted code exchange, the
home-screen app's own silent first attempt), so a wait that's genuinely
being handled never again looks like the app has simply stopped.

**If it keeps happening.** A short, silent pause is Spotify's shared,
per-app quota having a busy moment — the countdown above absorbs plenty of
that on its own, with nothing to look at until it's done. Reaching the
fallback screen at all means that silent budget is already spent, which is
a different problem: this page's *default* client ID is shared by everyone
who has it open, so no amount of local waiting fixes it while that shared
quota stays busy. So the fallback screen says so immediately and offers the
actual fix — **Use your own Spotify app** — which takes about a minute to
set up and gives you a quota nobody else can spend; *Try again* right above
it still works too, for whenever waiting it out is good enough. The same
escape hatch already existed for the 25-account cap (`access_denied`); this
is it surfacing for a persistent rate limit too, rather than only when Spotify has
flatly refused the account.

**If it says "Spotify asked for a pause".** A short throttle while reading a
large library is waited out on its own, counting down on screen. A longer one
used to be sat through silently too — up to ten minutes at a time, several
times over, which looked exactly like the app being stuck. Now anything
longer than a few seconds shows a *Try again* screen with the real wait
instead, and that screen retries itself the moment the wait is up — there is
nothing to tap, and nothing lost either way: the parts of the read already
finished are banked, so it carries on rather than starting over.

**A dropped request is not a lost sign-in.** A phone changes cell mid-request,
hands over to Wi-Fi, and now and then leaves a request hanging with nobody
coming back to it — and `fetch()` has no deadline of its own. Both cases used
to end the same way, because a dropped request throws a `TypeError` ("Load
failed", in Safari) with nothing on it to say it was transient. So one blip in
the middle of a several-hundred-call read was taken as a *permanent* answer,
and there were only two of those available: bank the playlist in flight as
empty — losing every track in it until somebody happened to edit that playlist
— or decide the sign-in was dead and offer **Start over**, which cleared the
token, which sent you to the accounts service, which is rate-limited per app,
which answered `429`. That is where "stuck at too many requests, then it times
out and can't get the playlists" came from: one dropped request that should
simply have been asked again.

Now every call has a deadline and a dropped, hung or `5xx` one is retried;
if it still will not go through, that is reported as something to come back
to, not as a sign-out. A read is only ever recorded as an empty playlist when
Spotify has actually refused *that playlist* (`403`/`404`) — and even then it
is stored without a snapshot id, so the next read asks again instead of
trusting the empty answer forever. A token that stops working mid-read is
refreshed once before anyone believes it. And the wall you land on when
something genuinely unexpected happens leads with **Try again**, which keeps
the sign-in and resumes from the banked pieces; signing out is still there,
one line below, for whoever actually wants it.

**The pace was the other half of it.** The read used to be floored at 70ms
between calls — fourteen a second, several times what a Spotify app without
Extended Quota is allowed — and it recovered a tenth of its back-off on every
success, so it walked back down to that floor within thirty calls and straight
into the next `429`. It is 250ms now, backing off hard and recovering slowly,
with a ceiling high enough to be a real pause. The pace Spotify last agreed to
is also written down, because iOS discards the page behind you and every reopen
used to start at full speed again — including the reopen straight after a
rate limit.

**And a retry costs less.** `/me` and the playlist index are banked with the
rest of the read, so a retry goes straight back to the playlist it stopped on
instead of re-spending those calls first — which, on a busy shared quota, was
sometimes the whole budget, leaving the retry to fail in the same place having
read nothing new.

### Staying on the current version

GitHub Pages caches the page for about ten minutes, and a tab you left open
keeps whatever it loaded — so an old Betterfy can sit in front of you looking
perfectly normal. Two things fix that, both reachable **before you connect
anything**:

- **Check for updates**, next to *Connect Spotify* on the very first screen
  (and the ⬇ button in the top-right corner, from any screen). It fetches the
  published page over the network and compares its build stamp with the one
  you're running, then tells you either that you're current or that a newer
  build exists.
- Every load runs that check quietly in the background. If a newer build is
  published, a bar appears offering **Update now** — never forced, because a
  reload halfway through filing would lose your place. Updating clears the
  caches and reloads; your Spotify sign-in and synced library survive it.

The build you're running is printed under the buttons on the landing screen and
in the **More** sheet once you're in.

The corner buttons, in order: **⬇ Check for updates**, **⟳ Re-sync library**
(only once a library is loaded — this one re-reads Spotify, not the page), and
**⚙ Settings** — appearance (Nightshift/Daylight/System), an accent colour
(twelve presets, each a matched pair so the same choice reads correctly on
both themes), an app-icon preview, compact rows, and remembered filters.
Hue/depth/brightness sliders and the per-region toggles are still there under
**Custom colour** — one fewer than before, since the stat tiles the "Stat
tiles" toggle governed have been replaced by the coloured cards on Home.
Settings is reachable from the landing screen too.

## Why it uses Last.fm and Discogs

Verified against a freshly registered Spotify app in September 2026:

| Endpoint | Status |
|---|---|
| `GET /audio-features/{id}` | `403` |
| `GET /recommendations` | `404` |
| `GET /artists/{id}` → `genres` | field absent entirely — 0 tags across 956 artists |
| `GET /playlists/{id}/tracks` | `403` — renamed to `/playlists/{id}/items` |
| `POST /users/{id}/playlists` | `403` — use `POST /me/playlists` |

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

## Setup

Requires Node 22+ (uses built-in `fetch`; no dependencies).

1. **Spotify app** — https://developer.spotify.com/dashboard → Create app.
   Add redirect URI `http://127.0.0.1:8888/callback` exactly; `localhost` is
   rejected. Tick Web API. Copy the client ID and secret.
2. **Last.fm key** — https://www.last.fm/api/account/create
   Optionally connect Spotify scrobbling at
   https://www.last.fm/settings/applications — Spotify's API only returns your
   last 50 plays and keeps no history, Last.fm keeps everything from that day on.
3. **Discogs token** (optional) — https://www.discogs.com/settings/developers
   → Generate token. Only fills artists Last.fm has nothing on; leave it blank
   and `npm run setup` skips that step rather than failing on it.
4. Copy `.env.example` to `.env` and fill it in.

```bash
npm run setup     # authorise, snapshot the library, fetch tags, classify playlists
```

`npm run setup` opens a browser once for Spotify authorisation. The Last.fm
fetch takes roughly 20 minutes for ~5,600 artists and is resumable — rerun it
if interrupted and it continues from where it stopped. The Discogs pass that
follows only touches artists still empty after that, so it's a much shorter
run — or an instant no-op with no `DISCOGS_TOKEN` set.

## Use

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

### The local app (`npm start`)

**Refresh** sits at the top right of Overview — the first page you land on —
and again in the rail. Both re-fetch the current data from the server, which
takes seconds. A full Spotify re-read is the separate *Re-read from Spotify*
section further down Overview, and takes minutes.

Next to Refresh in the rail, **Settings** opens a panel with:

- **Appearance** — System / Light / Dark.
- **Accent colour** — 24 preset swatches, plus hue, depth (saturation) and
  brightness (lightness) sliders for fine control.
- **Apply colour to** — toggle the accent on or off per region (navigation
  highlight, primary buttons, stat tiles, progress bar, tags & chips,
  hover/focus), so you can, say, keep a loud accent on buttons but keep the
  nav neutral.
- **Compact rows**, for denser lists, and **remember last filters**, to
  keep the Cross-filed/Misfiles thresholds you last picked across reloads.

All of it is stored in the browser's `localStorage`, per device.

## How the filing model works

Spotify supplies no genre, so a track's signal is the union of its artists'
Last.fm tags. Each playlist becomes the centroid of its members. Tags are
IDF-weighted, otherwise "electronic" — true of half this library — dominates
every comparison and every playlist looks alike.

Playlists are classified onto axes in `playlists.config.json`
(genre / mood / era / event / DJ set / context / inbox). Only genre and mood
playlists receive automatic filing; a track is only compared against playlists
**on its own axis**, because a metal track legitimately sits in both "Metal" and
a mood playlist and neither placement is wrong.

Edit `playlists.config.json` by hand — the rules that generate it are a first
guess, and everything downstream reads the file, not the rules.

## Design decisions worth knowing

- **Remixes are not duplicates.** Extended mixes, VIPs, bootlegs and live cuts
  are different records and are never merged. Only cosmetic differences
  (remaster tags, `feat.` credits, punctuation) are normalised away.
- **Within a playlist vs across playlists.** The same track twice in one
  playlist is a mistake. The same track in five playlists is usually deliberate,
  so it is surfaced for review and never auto-removed.
- **Axes are guessed from names, then from dates.** A playlist named for a club
  or a decade says what it is. One named for whoever you were with that night
  does not, and used to fall through to *genre* — where it competed for
  suggestions with the real genre buckets and turned up in Misfiles as noise.
  A playlist whose tracks all landed within a few days and which has had
  nothing added for over a month is read as an event instead. Both halves are
  needed: "added in one go" alone would catch a playlist someone built last
  week by dropping fifty tracks in at once. Every playlist on the Playlists
  screen says what its guess was made from, and correcting one overrides both.
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
  moves on.
- **Shuffle spaces artists rather than randomising.** Uniform random clumps; the
  greedy max-spacing interleave takes the artist with the most tracks left,
  skipping any used within a cooldown window. It defaults to **All Songs —
  Betterfy**, a playlist Betterfy keeps topped up with everything in your
  library — build or refresh it from the button on the Shuffle screen. It's a
  real Spotify playlist, not a snapshot: running it again only ever adds
  whatever's missing since the last time, and never duplicates a track that's
  already there.
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
| `norm.mjs` / `credits.mjs` | track identity and collaboration-credit splitting |
| `profile.mjs` | tag vectors, playlist centroids, IDF, ranking |
| `enrich-lastfm.mjs` / `enrich-discogs.mjs` / `tagstore.mjs` | fetch and merge genre tags — Discogs only ever fills what Last.fm left empty |
| `listening.mjs` | real listening behaviour (top artists, recent plays) as a weight per artist — best-effort, works with no Spotify auth available too |
| `snapshot.mjs` | dumps the whole library to `library.json` |
| `actions.mjs` | every library mutation, with the undo log |
| `server.mjs` + `ui/` | the local app |
| `build-web.mjs` + `docs/` | the browser build for GitHub Pages |
| `make-icons.mjs` | renders the logo to the PNG sizes browsers and phones ask for |

`build-web.mjs` bundles `norm`, `credits` and `profile` verbatim into the page,
so the browser and local builds score identically and cannot drift apart. It
refuses to build if a secret appears in the output.

## Data sources, and what they're worth

| Source | Verdict |
|---|---|
| **Last.fm** artist tags | The genre backbone. Good coverage, sends `access-control-allow-origin: *` so it works from the browser too. |
| **Discogs** release styles | Wired as a fallback: only queried for an artist Last.fm returned nothing for at all, tallying `style` across that artist's releases (Breakbeat / Techno / Electro — finer than Last.fm's one flat tag per artist). Needs a token in the `Authorization` header from Node, so this side is verified; the browser build sends it as a query param instead to avoid a custom header, which has **not** been checked against a real response — confirm it under Playlists once you have a token. |
| **MusicBrainz** | Planned as identity glue — no key, but wants a contact string in the User-Agent, which a browser `fetch` cannot set. Nothing reads `MUSICBRAINZ_CONTACT` yet. |
| **GetSongBPM** | Tempo, key and Camelot notation — but only **20% coverage** measured over a 40-track sample of a current UK electronic library. Superseded by the Rekordbox import below; nothing calls it. |
| **Deezer** | Has a public BPM field, but it was empty for 4 of 5 tested tracks. Not worth wiring. |

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
