# MAEST, the second ear (WP-C1): build and measurement scripts

Nothing here runs in the page or in CI. Work in a scratch folder outside the
repo: the fp32 model is 344 MB.

| File | Does |
|---|---|
| `quantise.py` | Makes `docs/models/discogs-maest-10s-pw-2-int8.onnx` from Essentia's `discogs-maest-10s-pw-2.onnx`: keeps the two outputs the page reads, int8 weights. 344 MB → 88.6 MB |
| `measure.py <dir> [per-genre]` | 15 genre-labelled Deezer playlists × 10 tracks (one per artist), two 10 s windows each, through EffNet, MAEST fp32 and MAEST int8. Needs `maest10.onnx` and `maest10-int8.onnx` (un-pruned) in `<dir>`, and ffmpeg. Writes `measure.json` |
| `measure-layers.py <dir>` | The same tracks through int8 MAEST, keeping the token mean of layers 3, 6, 8, 10, 11 and the CLS/DIST tokens. Writes `measure2.json` |
| `score.py measure.json` | Leave-one-out nearest-centroid placement per ear, int8 vs fp32 agreement, timing |

Results (2026-11-15, 144 tracks; recorded in `docs/AUDIO-ANALYSIS-PLAN.md` §0):

- int8 vs fp32: same top style 93%, top-5 overlap 96%, embedding cosine median 0.9985 (min 0.9977).
- Placement top-1 / top-2: EffNet 55.6% / 79.9%. MAEST layer 6 (Essentia's default embedding) 52.1% / 77.8%; **layer 8 61.1% / 80.6%**; layer 11 61.1% / 82.6%; layer 10 58.3% / 84.7%. EffNet + MAEST layer 8 joined: 63.9% / 86.1%.
- The layer was picked on these same tracks, so the margin is slightly flattered. The owner's Score run is the real test.
- Speed: native onnxruntime 0.15 s per window (int8, 4 cores). onnxruntime-web 1.31.1 WASM single-threaded in headless Chromium: 1.1 s to load, ~2.3 s per window, so ~5 s per track plus the download.
