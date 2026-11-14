# Audio analysis — phase 0 measurement scripts

Measurement only. Nothing here ships in the app or runs in CI. These scripts
produced the phase 0 numbers recorded in `docs/AUDIO-ANALYSIS-PLAN.md`, and
`ref.py` is the Essentia reference that phase 1's JS mel front-end parity
fixture is generated from.

| File | What it does |
|---|---|
| `ref.py` | Reference pipeline. It looks up Deezer previews for genre-labelled Deezer playlists plus a list of your own tracks (`mine.json`, `[{artist,title}]`), runs Discogs-EffNet on each (full preview, then two ~10 s `Range` fetches), and writes `results.json`. Audio is held in a temp file for one analysis and then deleted. |
| `score.py` | Reads `results.json` and reports label hit@k, leave-one-out nearest-centroid placement by embedding (few-shot by sound), partial vs full download, speed, and what the model hears on your own tracks. |
| `mel_np.py` | The EffNet mel front end, written from scratch in numpy with no Essentia: Hann, \|rfft\|, Slaney mel ×96 with `unit_tri` normalisation over 0–8 kHz, power, `log10(1+10000x)`. It matches Essentia's `TensorflowInputMusiCNN` to within 3e-4 and gives identical model outputs. It's the template for `core/audio/mel.mjs`. |
| `time-web.cjs` + `time-web.html` | Times `onnxruntime-web` (WASM) inference in headless Chromium. |

## Running

Work in a scratch directory outside the repo, because the model is
CC BY-NC-SA and is not committed:

```bash
python3 -m venv venv && ./venv/bin/pip install essentia onnxruntime numpy
mkdir models && (cd models && curl -O https://essentia.upf.edu/models/feature-extractors/discogs-effnet/discogs-effnet-bsdynamic-1.onnx -O https://essentia.upf.edu/models/feature-extractors/discogs-effnet/discogs-effnet-bsdynamic-1.json)
./venv/bin/python -I path/to/scripts/audio-phase0/ref.py .
./venv/bin/python -I path/to/scripts/audio-phase0/score.py .
```

For the browser timing, copy `time-web.html` and the `.onnx` into a folder
where `npm install onnxruntime-web@1.31.1` has been run, then
`node time-web.cjs <that folder>`. It needs Playwright and Chromium.

The Python `essentia` package is AGPL-3.0. It's a development-time reference
only and must never be bundled into the page.
