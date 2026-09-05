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
npm run snapshot     # re-read the library (incremental — see below)
npm run dupes        # duplicates, split into within-playlist vs cross-filed
npm run misfile      # possible misfiles + where the unfiled backlog should go
npm run discover -- --like "Jungle & Breaks"   # new music, excluding all you own
npm run shuffle -- "Techno" --play             # spaced shuffle, played on your device
npm run consolidate  # maintain one playlist holding every unique track
npm test             # identity and request-guard tests
```

`npm run snapshot` only re-reads playlists whose contents actually changed —
Spotify's per-playlist `snapshot_id` says which — so a re-sync takes seconds
rather than minutes. `npm run snapshot:full` forces a complete re-read.

Everything is **dry-run by default**. Commands that change your Spotify library
print what they would do and stop; add `--apply` to commit.

In the local app, changes apply to the in-memory library as well as to Spotify,
so the counts stay correct as you work — you don't need to re-snapshot to see
where you are. Related changes are grouped: a move is an add and a remove, and
**Undo reverses the whole thing in one step**.

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

## Files

| | |
|---|---|
| `spotify.mjs` | API client — token refresh, pagination, 429 retry |
| `norm.mjs` / `credits.mjs` | track identity and collaboration-credit splitting |
| `profile.mjs` | tag vectors, playlist centroids, IDF, ranking |
| `snapshot.mjs` | dumps the whole library to `library.json` |
| `actions.mjs` | every library mutation, with the undo log |
| `server.mjs` + `ui/` | the local app |
| `ui/theme.css` | the design system, shared by both front ends |
| `guard.mjs` | who may talk to the local server |
| `test/` | identity, restore-planning and request-guard tests |
| `build-web.mjs` + `docs/` | the browser build for GitHub Pages |

`build-web.mjs` bundles `norm`, `credits` and `profile` verbatim into the page,
so the two builds *score* identically. Everything else the browser build does —
axis classification, the duplicate report, the misfile report — is currently a
second implementation inside `docs/app.template.html`, and the two have already
drifted apart. Collapsing them into one shared module is the next structural
job; see `V2-PLAN.md`.

`ui/theme.css` is the single stylesheet: the local app links it and the browser
build inlines it, so the two cannot drift apart visually. `build-web.mjs` refuses
to build if a secret appears in the output, or if no client ID is supplied.

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

## Security

The local server holds live Spotify credentials on a fixed loopback port, so it
refuses anything that did not come from its own page: the `Host` header must be
one it serves (which closes DNS rebinding), a cross-site `Origin` or
`Sec-Fetch-Site` is rejected, and writes must be `application/json` — a content
type a plain form post cannot send. `guard.mjs` holds the checks and
`test/guard.test.mjs` covers them.

Tokens live in `.tokens.json` on your own machine and are gitignored. Nothing is
sent anywhere except Spotify, Last.fm, Discogs and MusicBrainz.

## Licence

MIT.
