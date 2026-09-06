# Working on Betterfy

## Build for the Spotify library, not for one desktop tool

The hosted app is used by multiple accounts (not just the one it was
originally tuned on), each with only their own Spotify library, playlists,
liked songs, and listening history. **A feature only counts as a real
improvement if it works from that — every account has it, no export, no
external app, nothing to install.**

External enrichment (Rekordbox tempo/key, Discogs release styles) is fine to
add, but only as a fully optional bonus: silently absent and zero-cost for
anyone who doesn't have it, never something the core filing/tagging/misfile
model leans on. Before adding a data source, check whether it needs a manual
step outside Spotify (an export, a desktop app, a token most people won't
bother getting) — if so, it's a bonus feature, not infrastructure, and
should be scoped and described that way.

Spotify's own audio-feature endpoints (`/audio-features`, `/recommendations`)
are dead — `403`/`404`, verified against a real app registration (see
README's "Why it uses Last.fm and Discogs"). There is no tempo/energy/valence
signal left to read from Spotify itself, for anyone. Don't go looking for one.

What *is* real, universal, Spotify-native signal, already flowing but not
fully used: `/me/top/artists` (three time windows) and recently-played,
currently only used to seed Discovery. Prefer extending from there — e.g.
weighting which artists' tag gaps get filled first by actual listening —
over anything that needs a file most users won't have.

## Where the fuller context lives

- `README.md` — what's actually wired, what was tried and rejected and why
  (read "Design decisions worth knowing" and "Data sources, and what
  they're worth" before assuming a new signal is worth adding).
- `V2-PLAN.md` — the longer-range architecture review; still mostly
  aspirational, but the "what v1 actually is" and defects sections are
  accurate and worth reading before a big change.
- Tests are the source of truth for behavior, not comments: `npm test`
  before and after any change to `profile.mjs`, `axes.mjs`, or the browser
  build's mirrored classify()/buildReports() logic.
