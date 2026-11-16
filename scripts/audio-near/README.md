# Nearest members and three windows: measured (2026-11-16)

`eval.mjs` scores two "hear better" ideas from `docs/review/ENGINE-REVIEW.md`
layer 1 by sound alone (EffNet), leave-one-out, on genre-labelled Deezer
playlists: the 15 genres of `scripts/audio-phase0/ref.py`, 25 tracks each, one
track per artist (374 heard).

| Variant | top-1 | top-2 |
| --- | --- | --- |
| two windows, centroid (today) | 67.1% | 83.4% |
| three windows, centroid | 67.4% | 84.5% |
| whole preview, centroid | 68.4% | 84.8% |
| two windows, nearest k=5 mix 0.3 | 66.3% | 85.0% |
| three windows, nearest k=3 mix 0.5 | 66.8% | 86.6% |
| 9 per genre, two windows, centroid (20 draws) | 61.6% | |
| 9 per genre, three windows, centroid | 62.3% | |
| 9 per genre, two windows, nearest k=3 mix 0.5 | 57.0% | |
| 9 per genre, three windows, nearest k=3 mix 0.3 | 59.4% | |

Read against the bars set in ENGINE-REVIEW before the run:

- **Three windows: not shipped.** +0.3 top-1 (+0.7 few-shot) against a bar of
  +1, for 50% more inference per track and a re-listen of every heard track.
- **Nearest members: not on by default.** It costs top-1 on these sets (−1 to
  −4.6 points) while adding about a point of top-2. These playlists are one
  genre each; a personal playlist that holds two or three sounds may behave
  differently, so it is scored as a Score arm (`near`, k=5 mix 0.3, the least
  harmful setting here) and used on File only when that account's run shows
  +2 points overall with no loss on never-filed artists (gate.mjs `nearChoice`).

Run it again with:

    node scripts/audio-near/eval.mjs <cacheDir> --ort <dir with onnxruntime-node@1.20.1> --per 25

It needs ffmpeg and network access to Deezer; previews stay in `<cacheDir>`.
