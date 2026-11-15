# Build 5 — progress log

Live status of `docs/BUILD-5-PLAN.md` §8's waves. Update this file with every
merge so a fresh session can pick up where the last one stopped.

## Done (on `main`)
- Wave 0: #97 (S1–S4, Spotify fixes, filing fixes, UI-A)
- Wave 1: A1 split (#102)
- Wave 2: A2 classifier (#107), A5 patcher + A8 goldens (#103), §5.1 feedback (#110), key step 1 (#106)

## In flight
- PR #112 (`claude/kind-thompson-swvghc`): A6 router ✅, A7 build conventions ✅, A3 store ✅
- UI-B motion tokens + View Transitions (agent running, joins #112 or follow-up)
- Default Last.fm key (`LASTFM_PUBLIC_KEY`, baked at build) + one-tap "Analyse my library" (agent running)

## Next
- Wave 3: A4 screens → ES modules, in 3 groups:
  (home, inbox, inbox-actions) · (tidy, lists, new, shuffle) · (discover, sources, engine, history); UI-D 4-tab shell + Settings sheet
- Wave 4: UI-C, UI-E, UI-F, UI-G; §5.2–§5.6
- Deferred (need model export + measurement): Beat This tempo, S-KEY key step 2

## Notes for agents
- Worktrees can start from a stale base: first `git checkout -B <branch> <current tip>`.
- After merging branches, run `npm run build:web` once and commit the rebuilt `docs/` (build stamp must match across page and worker).
