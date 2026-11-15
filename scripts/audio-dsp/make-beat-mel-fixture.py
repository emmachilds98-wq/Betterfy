# Writes test/fixtures/beat-mel.json: Beat This's own LogMelSpect (torchaudio)
# on a short deterministic signal, so test/audiobeats.test.mjs can hold
# core/audio/dsp/beat-mel.mjs to it.
#
#   pip install torch torchaudio beat-this   (CPU wheels are enough)
#   python3 scripts/audio-dsp/make-beat-mel-fixture.py
import json, math, os, numpy as np, torch
from beat_this.preprocessing import LogMelSpect

SR, N = 22050, 22050  # one second
t = np.arange(N) / SR
# a 220 Hz tone, a 3 kHz tone and two Hann clicks; the test rebuilds the
# same samples from this formula, so they are not stored
x = 0.3 * np.sin(2 * np.pi * 220 * t) + 0.1 * np.sin(2 * np.pi * 3000 * t)
for b in np.arange(0, 1, 0.5):
    i = int(b * SR); x[i:i + 200] += np.hanning(200) * 0.8
x = x.astype(np.float32)
spec = LogMelSpect()(torch.from_numpy(x.copy())).numpy()
here = os.path.dirname(os.path.abspath(__file__))
out = os.path.join(here, '..', '..', 'test', 'fixtures', 'beat-mel.json')
json.dump({
    'note': 'beat_this LogMelSpect on 1 s of x = 0.3 sin(2π220t) + 0.1 sin(2π3000t), plus 0.8·hanning(200) at samples 0 and 11025; frames 0, 10, 25, 50 and the last',
    'frames': int(spec.shape[0]),
    'rows': {str(i): [round(float(v), 5) for v in spec[i]] for i in [0, 10, 25, 50, spec.shape[0] - 1]},
}, open(out, 'w'))
print(out, spec.shape)
