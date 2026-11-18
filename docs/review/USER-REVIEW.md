# Betterfy user review: what a user would want next (2026-11-16)

Written from `main` at `e491a9e` (build 6 waves 1 to 5 merged). Review only:
no code was changed to write it. Companion: [ENGINE-REVIEW.md](ENGINE-REVIEW.md)
(the deep review of matching). Current state and next waves:
[HANDOFF-2026-11-16.md](../archive/HANDOFF-2026-11-16.md).

## Verdict

The core loop is good: one card, a clear top pick with a percentage, File or
Skip, and undo everywhere. What holds it back for a user is trust and
legibility, not missing features. The app:

- shows numbers it can't yet stand behind (80% on a track it has never heard);
- leaks a raw error into the top bar;
- keeps its smartest parts (Engine, Score + Tune, the teach queue) in a
  Settings drawer most people will never open.

**How it was reviewed.** `npm run shots` drives every screen against a
synthetic library behind a fake Spotify: desktop and phone, dark and light,
72 screenshots. Selected screenshots are in [screens/](screens/). The
reviewer read the File, Tidy, Discover, Library, New playlists, Settings and
Engine screens as a DJ filing a liked-songs backlog into genre playlists.
Release Radar's screen (#135) is unmerged, so it was judged from its plan
only. The fake library has no real audio, so the sound layer was judged from
its component gallery.

**A caveat about the environment.** In the shots environment the CDN that
serves onnxruntime (jsdelivr) is blocked. That is what triggers the error
pill in item 1. The same thing would happen to a real user who is offline or
whose network blocks the CDN.

## Making the engine feel "always right"

No engine is literally always right. It can be right every time it commits,
and ask otherwise. Five changes get there, in this order.

1. **Abstain out loud.** Every card lands in one of three states:
   - *Sure*: one big button.
   - *Two-way*: "Rollers or Jungle?", with two equal buttons.
   - *Your call*: nothing pre-highlighted; the top three shown as equals.

   Today Rollers at 80% is highlighted green while the same card says "Not
   heard yet. Picks are from tags until it is." A tags-only pick should never
   wear the green Sure styling. The "Up next" strip labels nearly every card
   "Sure"; cap that with the measured per-account threshold (BUILD-6 §3.2).
2. **Show the reason in words, not a percentage.** For example: "3 of your
   Rollers tracks are by this artist · tags say liquid DnB · not heard yet".
   The evidence badges (tags, history, sound, learned) already exist in
   `web/ui/sound.mjs`. Put them on the File card under the top pick.
3. **Learn from every tap, immediately.** A Skip, picking #2 over #1, and an
   undo should visibly change the next card by the same artist. The teach
   queue is hidden because single answers barely count. Making them count
   (artist-level and playlist-prototype updates on each tap) unlocks it.
4. **Measure on the owner's library and show the number.** Add one line on
   File: "Last 30 days: 94% of my picks you kept". The reversal rate of Sure
   picks, per account, is the honest scoreboard. D1 and D3 are fixed on main,
   so this is buildable now.
5. **Fix or hide weak signals.** Key is 55% exact against a 60% bar, so it
   stays hidden. Tempo is good (84% on Beatport half B after the fold), so
   show it. A BPM shown with a "?" (87/174) beats a confident wrong one.

**Not recommended:**

- Auto-file: the owner rejected it on 2026-11-16.
- An LLM guessing genres from Spotify data: SMARTER-GENRES §3 R1 forbids it.

## Prioritised wishlist

P0 breaks trust or navigation. P1 is what a user would notice in the first
week. P2 is polish. Everything works from the Spotify library alone.

| # | Pri | Screen | What a user would want | What the screenshots show |
| --- | --- | --- | --- | --- |
| 1 | P0 | Top bar | A short status ("Listening paused · offline · Retry") that never pushes the tabs out | On desktop a failed model load prints the full error and jsdelivr URL across the header. The File/Tidy/Discover/Library tabs vanish on every screen except File ([discover](screens/desk-dark-discover.png), [library](screens/desk-dark-lists.png)) |
| 2 | P0 | File | Only a heard or history-backed pick gets the green Sure style. Tags-only picks show as a choice | Rollers 80% highlighted green next to "Not heard yet. Picks are from tags" ([file](screens/desk-dark-inbox.png)) |
| 3 | P0 | File (phone) | Picks 2 and 3 always visible above the action buttons and tab bar | At 390 px the File/Skip bar and the tab bar sit over the other picks ([phone](screens/phone-dark-inbox.png)). This is a full-page shot, so confirm on a real phone |
| 4 | P1 | File | One slim setup strip that disappears when done, so the card comes first | Five rows above the card: counts, three status pills, an Analyse button and its explanation, a mono "22 OF 42" line, gesture help |
| 5 | P1 | File | An evidence line under the top pick, and a "why not #2" on tap | Only a percentage bar. The badges exist in the gallery but not on the card |
| 6 | P1 | File | A visible "it learned" moment after a correction, and a 30-day kept-rate line | Nothing changes on screen after Skip or picking #2 |
| 7 | P1 | Library | Rows that show health, unfiled and misfiled counts, BPM range and top styles, sorted by "needs attention" | Ten identical rows: name, track count, axis chip, "files here" |
| 8 | P1 | Library sheet | Plain words instead of "Axis" and "receives suggestions", and a health score that reflects fit, not age | Health 95 "Healthy" with one note: "nothing added in 2+ years" ([sheet](screens/desk-dark-lists-sheet.png)) |
| 9 | P1 | Tidy | Open on the first tab with work, and recommend which version to keep and why | Opens on Repeats while Wrong place shows 0. "Keep 3:39" and "Keep 3:40" look equal ([tidy](screens/desk-dark-tidy.png)) |
| 10 | P1 | Discover | Playable rows with Like and Add-to-playlist, a default run on first visit, and Radar as a "New from artists you play" section | An empty card until a seed is picked and Find is pressed. Radar UI (#135) is unmerged |
| 11 | P1 | Engine | Move it out of Settings into a Library "How well it knows you" card, and drop "a second opinion that files nothing" | It reads as a separate product that does nothing. Score + Tune is a paste-to-developer flow ([engine](screens/desk-dark-settings-engine.png)) |
| 12 | P1 | DJ info | Tempo on cards and playlist profiles now. Key only once it clears 60% exact | Key is 55% exact and hidden, which is right |
| 13 | P2 | History | A "Recent changes · Undo" link on File, not only inside Settings | Undo is the main safety promise, but History sits third in a Settings drawer ([settings](screens/desk-dark-settings.png)) |
| 14 | P2 | New playlists | Sound-based proposals reachable from Library, with a one-line empty state | The empty state is a paragraph of bold labels. The proposal cards in the gallery are strong ([gallery](screens/gallery-ui6-desk-dark.png)) |
| 15 | P2 | Landing | "Use your own Spotify app", the build hash and "Check for updates" moved to a footer | A second big button and developer details compete with Connect Spotify |
| 16 | P2 | Settings | Listening, History and Your data first, with Appearance smaller | Twelve accent swatches get more room than the engine and undo |

## Design suggestions

The Nightshift look (warm black, ember accent, rounded cards) is distinctive
and should stay. The problems are hierarchy and density, not style.

- **One primary action per screen.** On File, the orange "Analyse my
  library" and the green "File in Rollers" both shout. After setup, only the
  File button should be filled.
- **Confidence as three chips, not a bar and a percentage.** Reuse the
  Sure / Likely / Unsure chips from the sound gallery.
- **Use the desktop width.** Everything sits in a column of about 740 px with
  empty gutters. Put the card on the left and a right rail with the
  evidence, Up next, and "recently filed · Undo".
- **Less mono.** Uppercase monospace ("22 OF 42 · LIKED 2024-05-01", chip
  labels) reads as debug output. Keep mono for numbers only.
- **Give playlists a face.** Library rows need the playlist cover and the
  colour section strip from `web/ui/sound.mjs`.
- **Status, never stack traces.** The listening pill holds at most four words
  and an icon. Details go in Settings > Listening.
- **Every empty state gets a button.** Discover's "Nothing found yet" should
  be the Find button itself.
- **Show the gestures once.** Replace the permanent "swipe right to file"
  line with a one-time animated hint.

## Suggested order of work

Each item is one PR, with a number that shows it works.

1. **Trust fixes (P0, about a day):** items 1 to 3. Bar: no screen loses its
   tabs in `npm run shots` with the model blocked.
2. **Honest engine:** the three card states, the evidence line, the
   per-account Sure threshold, per-tap learning, the kept-rate line (items 5
   and 6, and the section above). Bar: Sure-pick reversal ≤ 3% on the
   owner's Score run. Details in [ENGINE-REVIEW.md](ENGINE-REVIEW.md).
3. **Library and Discover worth returning to:** items 7 to 12. Radar merges
   after the owner's `radar.mjs --probe` run.
