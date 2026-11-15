# Build 5 — progress log

Live status of `docs/BUILD-5-PLAN.md` §8's waves. Update this file with every
merge so a fresh session can pick up where the last one stopped.

## Done (on `main`)
- Wave 0: #97 (S1–S4, Spotify fixes, filing fixes, UI-A)
- Wave 1: A1 split (#102)
- Wave 2: A2 classifier (#107), A5 patcher + A8 goldens (#103), §5.1 feedback (#110), key step 1 (#106)

## In flight
- PR #112 merged: A6 router, A7 build conventions, A3 store ✅
- UI-B motion tokens + View Transitions ✅ (PR open)
- Default Last.fm key (`LASTFM_PUBLIC_KEY`, baked at build) + one-tap "Analyse my library" (agent running)

- A4 pilot ✅: history, sources, engine are ES modules (convention in web/README.md "Screen modules (A4)")

- PR #114 open: default Last.fm key + one-tap Analyse, A4 pilot (history/sources/engine), merged with main #105/#111/#116/#117
- #114 merged (Last.fm key, Analyse, A4 pilot). #118 merged (A4 home/inbox, shuffle/discover)
- #119 merged (§7 measurements). A4 complete: every screen is a module (PR open)
- Running: UI-D 4-tab shell + Settings

## Next
- Wave 3: remaining A4 screens, in groups:
  (home, inbox, inbox-actions) · (tidy, lists, new) · (shuffle, discover); UI-D 4-tab shell + Settings sheet
- Wave 4: UI-C, UI-E, UI-F, UI-G; §5.2–§5.6
- Deferred (need model export + measurement): Beat This tempo, S-KEY key step 2

## Notes for agents
- Worktrees can start from a stale base: first `git checkout -B <branch> <current tip>`.
- After merging branches, run `npm run build:web` once and commit the rebuilt `docs/` (build stamp must match across page and worker).
- `test/pageload.test.mjs` loads the built page in Chromium: run it after any web/app load-order change.
