# Deep listen's second ear: MAEST (WP-C1)

`core/audio/maest.mjs` runs MAEST, a transformer trained on the same 400
Discogs styles as effnet, on each 10 s preview window, and stores its styles
and 768-d embedding as a record's optional `maest` ear. It is off until the
listener ticks "Second ear (MAEST)" under Sources → Deep listen, and then only
on Wi-Fi on a computer with 8 GB or more (`web/audio/deep-settings.mjs`).

## Build the model (once, needs essentia.upf.edu)

```
pip install onnx onnxruntime==1.20.* numpy
python3 scripts/audio-maest/export.py
```

Writes `docs/models/discogs-maest-10s-pw-2-int8.onnx` (~90 MB, int8) and a
JSON of its inputs and outputs. Until that file is on the site, ticking the
switch says "The second ear couldn't load" and listening carries on without it.

## Check it against Essentia

```
BETTERFY_MAEST_DIR=docs/models npm test -- test/audiomaest.test.mjs
```

With `maest-reference.json` (from `reference.py`) beside the model, the test
also requires the style profile to match Essentia's. The three things it
confirms are options in `createMaestEar()`: `frames` (626), `normalise`
(MAEST's training mean and std), and the input rank (read from the model).
The reference output name in `reference.py` may need changing to whatever
`export.py` printed as the 400-wide output.

## Does it earn its place?

Sources → Engine → Score runs `core/validate/ears.mjs` whenever some record
has a MAEST ear: the same folds twice, once with effnet's embedding and once
with MAEST's, on exactly the tracks both have heard. "Copy results" includes
two "Second ear" lines. The bar, set before any number: at least +2 points
top-1 overall and no loss on never-filed artists, from 50+ paired tracks.
Passing is recorded, not acted on: the engine keeps effnet's ear until a later
change switches it.
