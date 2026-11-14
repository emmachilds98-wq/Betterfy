"""Essentia's own MAEST answer for the test's two synthetic windows (WP-C1).

test/audiomaest.test.mjs builds a 440 Hz and a 660 Hz tone, 10 s each at
16 kHz, runs them through core/audio/maest.mjs and the int8 model, and, when
this file's output is beside the model, requires the mean style profile to
match Essentia's within int8 error (cosine > 0.98). That one check confirms
the front end, the normalisation, the patching and the quantisation together.

    pip install essentia-tensorflow numpy
    curl -LO https://essentia.upf.edu/models/feature-extractors/maest/discogs-maest-10s-pw-2.pb
    python3 scripts/audio-maest/reference.py discogs-maest-10s-pw-2.pb > "$BETTERFY_MAEST_DIR/maest-reference.json"
"""
import json, sys

import numpy as np
from essentia.standard import TensorflowPredictMAEST

SR = 16000


def tone(f, seconds=10):
    t = np.arange(int(seconds * SR)) / SR
    return (0.3 * np.sin(2 * np.pi * f * t)).astype(np.float32)


model = TensorflowPredictMAEST(graphFilename=sys.argv[1], output=sys.argv[2] if len(sys.argv) > 2 else "StatefulPartitionedCall:0")  # as the MTG demo reads v1
acts = [np.squeeze(model(tone(f))) for f in (440, 660)]
acts = [a.mean(axis=0) if a.ndim == 2 else a for a in acts]
print(json.dumps({"activations": np.mean(acts, axis=0).round(6).tolist()}))
