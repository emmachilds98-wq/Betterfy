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
on development-mode apps: either ask the owner of the page to add your account
email under **User Management**, or open *Use my own Spotify app* on the landing
page, register one in two minutes and paste your client ID. No secret is needed —
authentication uses PKCE.

The prebuilt genre tags shipped with the page cover one person's artists, so
your suggestions may start thin. The **Playlists** view shows your tag coverage
and can fill the gaps in your browser given a free
[Last.fm key](https://www.last.fm/api/account/create).

### On a phone

The hosted page is built for an iPhone first. Open it in Safari, then
**Share → Add to Home Screen**: it runs full-screen with its own icon, and the
layout keeps clear of the notch, the Dynamic Island and the home indicator
rather than sliding under them.

- **Bottom tab bar** — Overview, Inbox, Duplicates, Misfiles, and **More** for
  the other six screens. Unread counts ride the icons.
- **Swipe left or right** anywhere on a screen to move to the next or previous
  one; the dots under the header show where you are. Arrow keys do the same
  thing on a keyboard.
- **Swipe the inbox card right to file it** into its best-fitting playlist,
  **left to skip**, and tap the artwork to play. Every one of those is still a
  button, and filing is still undoable from the toast.
- **Pull down** at the top of any screen to re-sync from Spotify.
- Settings and More open as sheets from the bottom edge; flick the handle down
  to dismiss.

Each screen has its own colour, spun off the accent you pick in Settings, so
the tab bar, stat tiles and headers stay in step with it — including a
readability correction, since a yellow and a blue at the same lightness are
nowhere near as legible as each other.

The local app (`npm start`) is still laid out for a desktop browser.

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
home-screen app never re-sends an authorization code it has already used. Give
it a minute and tap *Try again*.

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
at the foot of the rail once you're in.

The corner buttons, in order: **⬇ Check for updates**, **⟳ Re-sync library**
(only once a library is loaded — this one re-reads Spotify, not the page), and
**⚙ Settings** — appearance (system/light/dark), an accent colour (24 presets
plus hue/depth/brightness sliders, and per-region toggles for where it
applies), compact rows, and remembered filters. Settings is reachable from the
landing screen too.

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
signal comes from **Last.fm** artist tags, with **Discogs** release styles for
fine-grained electronic subgenres, and **MusicBrainz** as the identity glue.

## Setup

Requires Node 22+ (uses built-in `fetch`; no dependencies).

1. **Spotify app** — https://developer.spotify.com/dashboard → Create app.
   Add redirect URI `http://127.0.0.1:8888/callback` exactly; `localhost` is
   rejected. Tick Web API. Copy the client ID and secret.
2. **Last.fm key** — https://www.last.fm/api/account/create
   Optionally connect Spotify scrobbling at
   https://www.last.fm/settings/applications — Spotify's API only returns your
   last 50 plays and keeps no history, Last.fm keeps everything from that day on.
3. **Discogs token** — https://www.discogs.com/settings/developers → Generate token.
4. Copy `.env.example` to `.env` and fill it in.

```bash
npm run setup     # authorise, snapshot the library, fetch tags, classify playlists
```

`npm run setup` opens a browser once for Spotify authorisation. The tag fetch
takes roughly 20 minutes for ~5,600 artists and is resumable — rerun it if
interrupted and it continues from where it stopped.

## Use

```bash
npm run dupes        # duplicates, split into within-playlist vs cross-filed
npm run misfile      # possible misfiles + where the unfiled backlog should go
npm run discover -- --like "Jungle & Breaks"   # new music, excluding all you own
npm run shuffle -- "Techno" --play             # spaced shuffle, played on your device
npm run consolidate  # maintain one playlist holding every unique track
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
- **Discovery subtracts what you own** — every artist and track in the library,
  including each artist named inside a collaboration credit, so a seed artist
  can't return as one half of a duo.
- **Shuffle spaces artists rather than randomising.** Uniform random clumps; the
  greedy max-spacing interleave takes the artist with the most tracks left,
  skipping any used within a cooldown window.
- **The mark is a sorted list that is also a play button.** Five stacked bars
  whose widths grow then shrink, so their right edge forms a play triangle. In
  the app it is inline SVG and re-tints to whichever accent colour you pick; at
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
| **Discogs** release styles | Precise for electronic subgenres (Breakbeat / Techno / Electro). |
| **MusicBrainz** | Identity glue. No key; wants a contact string in the User-Agent. |
| **GetSongBPM** | Tempo, key and Camelot notation — but only **20% coverage** measured over a 40-track sample of a current UK electronic library. Fine for mainstream catalogue, blank for most underground releases. |
| **Deezer** | Has a public BPM field, but it was empty for 4 of 5 tested tracks. Not worth wiring. |

Tempo and musical key data by [GetSongBPM](https://getsongbpm.com).

Generated files (`library.json`, `tags-lastfm.json`, `.tokens.json`, reports) are
gitignored — they're yours, not the project's.

## Licence

MIT.
