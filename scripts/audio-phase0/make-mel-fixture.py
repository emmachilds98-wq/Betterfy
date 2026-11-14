"""Generate test/fixtures/mel-essentia.json, the reference core/audio/mel.mjs
is held to.

python -I make-mel-fixture.py <repo root>    (needs `pip install essentia numpy`)

The signal is synthetic and deterministic. synth() is mirrored exactly in
test/mel.test.mjs (sweep + LCG noise, float64 then rounded to float32), so no
audio is committed, only Essentia's answer for it. Two lengths pin down
FrameGenerator's last-frame rule: whether a final partial frame is emitted
(zero-padded) or dropped.
"""
import json, sys
import numpy as np
import essentia
essentia.log.infoActive = False
essentia.log.warningActive = False
import essentia.standard as es

SR = 16000

def synth(n):
    out = np.empty(n, np.float64)
    state = 12345
    for i in range(n):
        state = (state * 1664525 + 1013904223) % 2**32
        u = state / 2**32 - 0.5
        t = i / SR
        out[i] = 0.5 * np.sin(2 * np.pi * (100 + 1500 * t) * t) + 0.2 * u
    return out.astype(np.float32)

cases = []
for n in (16000, 16100, 8000 + 384):
    sig = synth(n)
    mel = [es.TensorflowInputMusiCNN()(f) for f in
           es.FrameGenerator(sig, frameSize=512, hopSize=256, startFromZero=True)]
    cases.append({'samples': n, 'frames': len(mel),
                  'mel': [[round(float(v), 6) for v in row] for row in mel]})
    print(n, 'samples ->', len(mel), 'frames', file=sys.stderr)

out = {'about': 'Essentia TensorflowInputMusiCNN on synth(n); see scripts/audio-phase0/make-mel-fixture.py',
       'essentia': essentia.__version__, 'sampleRate': SR, 'frameSize': 512, 'hopSize': 256, 'cases': cases}
json.dump(out, open(f'{sys.argv[1]}/test/fixtures/mel-essentia.json', 'w'), separators=(',', ':'))
