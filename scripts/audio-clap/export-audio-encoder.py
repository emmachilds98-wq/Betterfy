#!/usr/bin/env python3
"""Export CLAP's audio encoder for the page, and the test fixture (WP-C2).

Writes:
  docs/models/larger_clap_music-audio-q8-1.onnx   ~71 MB, int8 weights
      input  input_features [n, 1, 1001, 64]  (core/audio/clap.mjs clapFeatures)
      output audio_embeds   [n, 512]          L2-normalised
  test/fixtures/clap-fixture.json
      the reference front end's output on two synthetic signals (generated the
      same way in test/audioclap.test.mjs), and their audio embeddings from
      the full-precision model and from the exported int8 one.

Quantisation is dynamic int8 on MatMul/Gemm only (onnxruntime's
MatMulInteger, which onnxruntime-web's WASM backend runs); convolutions stay
float. The script fails if the int8 model's embedding drifts below cosine
0.99 from the float model on either fixture signal.

Same environment as build-text-table.py, plus `pip install onnx onnxruntime`.
    .venv/bin/python scripts/audio-clap/export-audio-encoder.py --checkpoint music_audioset_epoch_15_esc_90.14.pt
"""
import json, math, os, sys, tempfile

import numpy as np
import torch

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import clap_model  # noqa: E402
pack = clap_model.pack

ROOT = os.path.dirname(os.path.dirname(HERE))
MODEL_OUT = os.path.join(ROOT, "docs", "models", "larger_clap_music-audio-q8-1.onnx")
FIXTURE_OUT = os.path.join(ROOT, "test", "fixtures", "clap-fixture.json")
SR = 48000
SECONDS = 10


def park_miller(n, seed):
    """Deterministic noise in [-1, 1), the same in JS (products stay below 2^53)."""
    out, x = np.empty(n), seed
    for i in range(n):
        x = (x * 16807) % 2147483647
        out[i] = x / 1073741823.5 - 1
    return out


def kicks():
    """A 128 BPM four-on-the-floor kick with an off-beat hat."""
    n = SR * SECONDS
    t = np.arange(n) / SR
    beat = 60 / 128
    ph = np.mod(t, beat)
    kick = np.sin(2 * np.pi * (50 * ph + (100 / 30) * (1 - np.exp(-30 * ph)))) * np.exp(-8 * ph)
    off = np.mod(t + beat / 2, beat)
    hat = park_miller(n, 7) * np.exp(-60 * off) * 0.25
    return (0.8 * kick + hat).astype(np.float32)


def piano():
    """A plucked, decaying C-major arpeggio with six harmonics."""
    n = SR * SECONDS
    t = np.arange(n) / SR
    notes = [261.63, 329.63, 392.0, 523.25, 392.0, 329.63]
    y = np.zeros(n)
    for k in range(int(SECONDS / 0.5)):
        f, s = notes[k % len(notes)], int(k * 0.5 * SR)
        tt = t[s:] - t[s]
        env = np.exp(-3 * tt) * (1 - np.exp(-200 * tt))
        y[s:] += env * sum(np.sin(2 * np.pi * f * h * tt) / h ** 1.5 for h in range(1, 7))
    return (0.2 * y).astype(np.float32)


SIGNALS = {"kicks": kicks, "piano": piano}
FRAMES_KEPT = [0, 1, 2, 250, 500, 999, 1000]


class Encoder(torch.nn.Module):
    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, x):
        longer = torch.zeros((x.shape[0], 1), dtype=torch.bool)
        e = self.m.get_audio_features(input_features=x, is_longer=longer)
        e = getattr(e, "pooler_output", e)
        return torch.nn.functional.normalize(e, dim=-1)


def main():
    arg = sys.argv[sys.argv.index("--checkpoint") + 1] if "--checkpoint" in sys.argv[:-1] else None
    model, proc = clap_model.load(clap_model.checkpoint_path(arg))
    enc = Encoder(model).eval()
    feats = {}
    for name, fn in SIGNALS.items():
        f = proc.feature_extractor(fn(), sampling_rate=SR, return_tensors="pt")
        feats[name] = f["input_features"]  # [1, 1, 1001, 64]
    batch = torch.cat(list(feats.values()))
    with torch.no_grad():
        ref = enc(batch).numpy()

    import onnxruntime as ort
    from onnxruntime.quantization import QuantType, quantize_dynamic
    with tempfile.TemporaryDirectory() as tmp:
        fp32 = os.path.join(tmp, "clap-audio-fp32.onnx")
        torch.onnx.export(enc, (batch,), fp32, input_names=["input_features"], output_names=["audio_embeds"],
                          dynamic_axes={"input_features": {0: "n"}, "audio_embeds": {0: "n"}}, opset_version=17, dynamo=False)
        quantize_dynamic(fp32, MODEL_OUT, weight_type=QuantType.QInt8, op_types_to_quantize=["MatMul", "Gemm"])
    sess = ort.InferenceSession(MODEL_OUT, providers=["CPUExecutionProvider"])
    # One clip per run, as clap.mjs runs it: dynamic int8 picks its activation
    # scale per input tensor, so a batch's clips would shift each other slightly.
    q8 = np.concatenate([sess.run(None, {"input_features": batch[i:i + 1].numpy()})[0] for i in range(len(batch))])
    cos = [float(np.dot(q8[i], ref[i]) / np.linalg.norm(q8[i]) / np.linalg.norm(ref[i])) for i in range(len(ref))]
    if min(cos) < 0.99:
        raise SystemExit(f"int8 encoder drifted: cosine {cos}")

    fixture = {
        "about": "Made by scripts/audio-clap/export-audio-encoder.py; signals regenerated in test/audioclap.test.mjs",
        "sr": SR, "seconds": SECONDS, "framesKept": FRAMES_KEPT,
        "signals": {},
    }
    for i, name in enumerate(SIGNALS):
        f = feats[name][0, 0].numpy()
        fixture["signals"][name] = {
            "frames": [[round(float(v), 4) for v in f[t]] for t in FRAMES_KEPT],
            "meanPerBand": [round(float(v), 4) for v in f.mean(axis=0)],
            "embFloat": pack(ref[i]),
            "embInt8": pack(q8[i]),
            "int8Cosine": round(cos[i], 5),
        }
    os.makedirs(os.path.dirname(FIXTURE_OUT), exist_ok=True)
    with open(FIXTURE_OUT, "w") as fh:
        json.dump(fixture, fh, indent=1)
        fh.write("\n")
    print(f"{MODEL_OUT}: {os.path.getsize(MODEL_OUT) / 1e6:.1f} MB, int8 cosine {[round(c, 4) for c in cos]}")
    print(f"wrote {FIXTURE_OUT}")


if __name__ == "__main__":
    main()
