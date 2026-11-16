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

- `docs/review/HANDOFF-2026-11-16.md` — **start here after build 6**: what
  is merged, what waits on the owner (Radar probe, Score + Tune paste, key,
  teach queue), auto-file rejected, and the proposed next waves. With
  `docs/review/USER-REVIEW.md` (screens, design, screenshots) and
  `docs/review/ENGINE-REVIEW.md` (matching accuracy and the design to raise it).

- `README.md` — what's actually wired, what was tried and rejected and why
  (read "Design decisions worth knowing" and "Data sources, and what
  they're worth" before assuming a new signal is worth adding).
- `V2-PLAN.md` — the longer-range architecture review; still mostly
  aspirational, but the "what v1 actually is" and defects sections are
  accurate and worth reading before a big change.
- `docs/BUILD-5-PLAN.md` — **start here for build 5** (2026-11-14): the full
  review of the current build, verified bugs, the open-PR verdicts, the
  restructure (Phase A), the 4-tab UI and motion system (Phase B), smarter
  functions (Phase C), audio/knowledge upgrades (Phase D) and the wave order.
  Supersedes HANDOFF §6 and UI-BUILD-PLAN §2/§6.
- `docs/HANDOFF.md` — the sound features: the current state (what's merged, what's
  open on GitHub, what waits on the owner's machine), a file map of the sound
  features, and the ranked next work. Newer than `UPGRADE-PLAN.md`.
- `docs/SOUND-EVERYWHERE-PLAN.md` — the round that spread sound to Tidy,
  Playlists, Shuffle and Discover (S1–S4 merged) and the key work (S5).
- `docs/UPGRADE-PLAN.md` — the older (2026-10-31) order of work across the open PRs
  and plans, and what was waiting on the owner then.
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
- `docs/AUDIO-BUILD-PLAN.md` — how B and C get built: work packages for
  parallel agents, the frozen contracts (`core/audio/mel.mjs`,
  `core/audio/record.mjs`), file ownership, and the gate. Any audio work
  starts from its package list.
- `docs/UI-BUILD-PLAN.md` — the UI refresh for the audio features: the
  review, the sound-layer view models (`web/ui/sound.mjs`), and who owns which
  stylesheet partial in `web/styles/`. CSS goes in a partial, never back into
  `docs/app.template.html`; `npm run shots` screenshots every screen offline.
- `web/README.md` — since build 5's A1 the template is markup only: the
  page's script lives in `web/app/*.js` and `web/screens/*.js`, classic
  scripts joined in the order `web/manifest.mjs` lists. Script changes go
  there, never back into the template.
- `docs/SMARTER-GENRES-PLAN.md` — the current genre plan: free
  similar-artist bridges (Deezer, ListenBrainz via Wikidata, measured on the
  owner's library), calibrated confidence, the Gaps screen for proposing new
  playlists, and §3's reading of Spotify Developer Terms v10 (no Spotify
  content into AI/ML models, no pooling it across accounts). Read §3 before
  proposing any LLM feature or anything shared between users.
- Tests are the source of truth for behavior, not comments: `npm test`
  (unit tests, ~2.5 min) and `npm run e2e` (browser specs),
  before and after any change to `profile.mjs`, `axes.mjs`, or the browser
  build's mirrored classify()/buildReports() logic.
