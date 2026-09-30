# How to tune the engine

Everything the v3 engine is waiting on comes down to one thing: **its
thresholds are declared priors, and nothing has contradicted them.** This is
how you change that. It is your part of the work — it needs your library, and
nobody else's will do.

Roughly an hour of clicking gets the first real numbers.

---

## What "tuning" means here

The engine has 15 numbers in it — confidence thresholds, how much an
artist-level tag is worth against a track-level one, how settled a playlist
has to be to read as an event. `npm run benchmark:fit` sweeps every one of
them across its whole plausible range and re-runs the benchmark at each value.

Today it reports:

- **no number is set to a value that scores worse** — a test fails the build
  if that ever changes
- **but 4 of 15 are FLAT**: the benchmark got the same score at *every* value
  tried, so it has no opinion about them at all
- most of the rest sit on very wide plateaus — `SPECIFICITY.artist`, the
  number the engine's central fix rests on, passes anywhere from 0.15 to 0.85

That is not because the numbers are wrong. It is because 12 synthetic test
cases cannot tell them apart. **The fix is real cases from a real library**,
and the loop that produces them now runs end to end.

---

## The loop

```sh
npm run snapshot                  # 1. fresh library
npm run analyse:v3 -- --queue     # 2. run the engine, write the questions out
npm run build:review:v3           # 3. turn them into a page
open review-v3.build.html         # 4. answer them
                                  # 5. Download corrections.json, save it here
npm run benchmark:import          # 6. answers -> benchmark cases
npm run benchmark:fit             # 7. see which numbers are now pinned down
```

Steps 2–7 repeat. Step 1 only when your library has changed.

### 4 — answering

Each row is **one question, not one track**. Tracks resting on the same
evidence give the same answer, so they are asked once and answered together;
the row says how many ride on it. Answering 150 questions typically settles
600–900 tracks.

Three buttons per row:

- **the suggested genre** — confirms what the engine already thinks. Still
  worth clicking: a confirmed answer is a benchmark row, and confirmations are
  what stop the thresholds drifting in the permissive direction.
- **another genre** — type it; the field only accepts concepts the ontology
  knows, because an answer the engine cannot read back is not an answer.
- **Not sure** — **use this freely.** It is not a skip. A track a person
  looked at and could not place is a genuine known-bad case, and the benchmark
  needs those as much as it needs answers. Without them it only ever learns
  about the easy half of your library, which is the specific failure §26 warns
  against.

The **Unmapped tags** tab is the best value per click in the whole page: one
answer there ("schranz is a kind of hard techno") fixes every track in your
library carrying that tag.

### 6 — what the import does

Reads `library.json`, your provider caches, and `corrections.json`, and emits
benchmark cases in the same shape as the hand-written ones, into
`benchmark-cases.json`.

That file is **gitignored on purpose**. Real Last.fm tags cannot be committed
— it republishes somebody else's data and goes stale the next time the crowd
moves. So the committed benchmark stays synthetic and the number CI reports
stays honest, while your real cases constrain the weights locally, which is
the whole point.

Playlist membership is never included. How you file your music is nobody
else's business, and the classifier must never see it (§22).

---

## Aim, don't grind

`npm run benchmark:fit` now ends with a section headed **WHAT WOULD CONSTRAIN
THE FLAT ONES**. Read it. A flat parameter is a gap in the *shape* of the
cases, not a shortage of them — 500 more tracks of a shape already covered
would move none of them.

Currently it asks for:

| Number | What would pin it down |
|---|---|
| `HIGH_LEADER_SHARE` | one track that should be HIGH and one that should stop at LIKELY, differing only in how dominant the leading genre is |
| `HIGH_MARGIN_RATIO` | a well-corroborated track with a close second place |
| `EVENT_SETTLED_DAYS` | a **recent** event playlist — every event in the fixture is 200 days old, so no threshold under 180 can separate them |
| `CONTENT_LIFT` | a playlist whose name says nothing and whose contents lean only mildly one way |

So: when you hit a track where you think *"that's clearly X"* and the engine
hedged, or one where it was confident and shouldn't have been — those are the
valuable rows. Answer them first.

`EVENT_SETTLED_DAYS` needs no reviewing at all. It just needs you to have been
to a gig recently and made a playlist for it.

---

## What good looks like

Re-run `npm run benchmark:fit` after each round and watch two things:

1. **FLAT count falling.** Every parameter that leaves FLAT is one the
   benchmark now has an opinion about.
2. **Plateaus narrowing.** `SPECIFICITY.artist` passing in `[0.15 .. 0.85]`
   means almost nothing. The same number passing in `[0.30 .. 0.45]` means the
   benchmark is genuinely holding it in place.

Rough milestones, and they are estimates rather than measurements:

| Cases | What you should expect |
|---|---|
| ~50 | the first plateaus start narrowing; probably 1–2 leave FLAT |
| ~150 | most track thresholds meaningfully constrained |
| ~300 | plateaus narrow enough to move a number and mean it |
| ~500 | §26's bar. Misfile detection becomes defensible |

### The one thing to watch out for

If accuracy is **1.000 on 300 real cases**, be suspicious rather than pleased.
It most likely means you have been confirming the engine's suggestions and not
disagreeing with it. A benchmark that only contains cases the engine already
gets right cannot constrain anything — it is a mirror, not a test.

Disagreements and "not sure" answers are the rows with information in them.

---

## Then what

Once the flat count is down and the plateaus are tight, three things unlock in
order:

1. **Re-fit the weights.** With real plateaus, moving a number to the middle
   of its range is a decision with evidence behind it instead of a guess.
2. **Misfile detection (§21).** Deliberately not built: it produces "this
   track is in the wrong place", and a wrong one of those loses you your
   filing. It becomes defensible once the numbers behind it are earned.
3. **Wiring v3 into the app.** Everything else compounds with this, and it is
   why the order matters.

---

## Troubleshooting

**"No library.json"** — `npm run snapshot` first.

**The queue is tiny.** Good sign, mostly: it means the engine is confident
about most of your library. Check the coverage line in `npm run analyse:v3` —
if coverage is low but the queue is short, you are probably missing provider
caches (`npm run enrich`, `npm run enrich:discogs`).

**"skipped N with no provider evidence"** on import. Those tracks have answers
but nothing ever said anything about them, so there is nothing for the engine
to have got right or wrong. Not a bug, and not counted.

**Answers not appearing.** The page keeps working answers in the browser and
only becomes real when you press **Download corrections.json** and save it
beside `library.json`. The export merges onto what is already there — it never
replaces a previous session's answers.
