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

`README.md` § "Where to start reading" is the front door for people; this list
is the same map for an agent.

- **Handoff (2026-11-18): start at `docs/BUILD-7-PLAN.md` §0.** It covers what
  #158 to #168 shipped, the owner's decisions, and the packages since. The rest
  of the plan (2026-11-17, after #157): state of main, a verdict on every
  leftover, what waits on the owner (in-page clicks only), the ranked build 7
  packages in waves and lanes, and a runbook for running it as a Claude
  project (coordinator + parallel threads, file ownership, merge order, how to
  report). Paste-ready thread briefs: `docs/BUILD-7-BRIEFS.md`.

- `docs/DESIGN-PLAN.md` — the design and layout plan (2026-11-18, review 2):
  principles, screen-by-screen findings, packages L0–L5, L7 and L8 with gates, and
  thread briefs. Run it alongside build 7.

- `README.md` — what's actually wired, what was tried and rejected and why
  (read "Design decisions worth knowing" and "Data sources, and what
  they're worth" before assuming a new signal is worth adding).
- `docs/review/USER-REVIEW.md` (screens, design, screenshots) and
  `docs/review/ENGINE-REVIEW.md` (matching accuracy and the design to raise
  it), both from 2026-11-16.
- `V2-PLAN.md` — the longer-range architecture review; still mostly
  aspirational, but the "what v1 actually is" and defects sections are
  accurate and worth reading before a big change.
- `docs/GENRE-RECOGNITION-PLAN.md` — why filing went into non-genre
  playlists, what was fixed, and the ranked signals for genres crowd tags
  can't see (donk: 4 artists tagged in the whole shipped table).
- `docs/AUDIO-ANALYSIS-PLAN.md` — v3 phase 5: track-level genre/mood/
  similarity from 30-second Deezer previews (looked up by the ISRC Spotify
  already gives) run through an ONNX model in the listener's browser. Phase 0
  is measured (its §0): the model's labels are weak on scene genres, but
  placing by sound against the account's own playlists works, so the owner
  chose Option B (learn from your playlists), then C. Read its §2 before
  re-checking any of the external facts it lists.
- `docs/AUDIO-BUILD-PLAN.md` — how B and C got built: work packages, the
  frozen contracts (`core/audio/mel.mjs`, `core/audio/record.mjs`), file
  ownership, and the gate. Any audio work starts from it.
- `docs/BUILD-5-PROGRESS.md` — the build 5 log and the key and tempo model
  measurements; check it before re-measuring or re-tuning anything.
- `web/README.md` — since build 5's A1 the template is markup only: the
  page's script lives in `web/app/*.js` and `web/screens/*.js`, classic
  scripts joined in the order `web/manifest.mjs` lists, and the stylesheet in
  `web/styles/` partials. Script and CSS changes go there, never back into
  `docs/app.template.html`; `npm run shots` screenshots every screen offline.
- `docs/SMARTER-GENRES-PLAN.md` — the genre plan: free
  similar-artist bridges (Deezer, ListenBrainz via Wikidata, measured on the
  owner's library), calibrated confidence, the Gaps screen for proposing new
  playlists, and §3's reading of Spotify Developer Terms v10 (no Spotify
  content into AI/ML models, no pooling it across accounts). Read §3 before
  proposing any LLM feature or anything shared between users.
- `docs/RELEASE-RADAR-PLAN.md`, `docs/ENGINE-V3-ARCHITECTURE.md`,
  `docs/THINKING-ENGINE-PLAN.md`, `docs/TUNING.md` — new releases, the v3
  evidence engine, the account-native engine, and how to tune the v3 engine's thresholds.
- `docs/archive/` — superseded plans (UPGRADE-PLAN, HANDOFF, SOUND-EVERYWHERE,
  UI-BUILD, BUILD-5, BUILD-6, the 2026-11-16 handoff, NEXT-WORKPLAN), each
  headed with what replaced it; `docs/archive/README.md` lists them. Code
  comments still cite them as `docs/<NAME>.md`: read that as
  `docs/archive/<NAME>.md`. Don't plan from them.
- Tests are the source of truth for behavior, not comments: `npm test`
  (unit tests, ~2.5 min) and `npm run e2e` (browser specs),
  before and after any change to `profile.mjs`, `axes.mjs`, or the browser
  build's mirrored classify()/buildReports() logic.
