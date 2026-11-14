"""Build deep listen's MAEST model for the page (WP-C1). Build time only.

Downloads Essentia's ONNX export of MAEST (10 s, PaSST-weights, v2),
quantises its weights to int8 (dynamic quantisation: ~345 MB -> ~90 MB), and
writes docs/models/discogs-maest-10s-pw-2-int8.onnx plus a small JSON of
its inputs and outputs. It prints the input shape and every output's shape,
which is what core/audio/maest.mjs needs confirmed (frames, input rank, which
output is the 768-d embedding).

    pip install onnx onnxruntime==1.20.* numpy
    python3 scripts/audio-maest/export.py [--src path/to/discogs-maest-10s-pw-2.onnx]

Licence: CC BY-NC-SA 4.0, like the effnet models (docs/models/LICENSE).
"""
import argparse, json, os, sys, urllib.request

import numpy as np
import onnx
import onnxruntime as ort
from onnxruntime.quantization import quantize_dynamic, QuantType

URL = "https://essentia.upf.edu/models/feature-extractors/maest/discogs-maest-10s-pw-2.onnx"
OUT = "docs/models/discogs-maest-10s-pw-2-int8.onnx"
FRAMES, BANDS = 626, 96


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", help="a local copy of the fp32 ONNX; downloaded if absent")
    ap.add_argument("--out", default=OUT)
    a = ap.parse_args()

    src = a.src or "/tmp/discogs-maest-10s-pw-2.onnx"
    if not os.path.exists(src):
        print(f"downloading {URL}", file=sys.stderr)
        urllib.request.urlretrieve(URL, src)

    quantize_dynamic(src, a.out, weight_type=QuantType.QInt8)
    print(f"{a.out}: {os.path.getsize(a.out) / 1e6:.1f} MB (from {os.path.getsize(src) / 1e6:.1f} MB)")

    sess = ort.InferenceSession(a.out)
    ins = [{"name": i.name, "shape": [d if isinstance(d, int) else str(d) for d in i.shape]} for i in sess.get_inputs()]
    print("inputs:", ins)
    rank = len(ins[0]["shape"])
    x = np.zeros((2, 1, FRAMES, BANDS) if rank == 4 else (2, FRAMES, BANDS), np.float32)
    outs = sess.run(None, {ins[0]["name"]: x})
    meta = {"inputs": ins, "outputs": []}
    for o, v in zip(sess.get_outputs(), outs):
        print(f"output {o.name}: {list(v.shape)}")
        meta["outputs"].append({"name": o.name, "shape": list(v.shape)})
    meta["source"] = URL
    with open(a.out.replace(".onnx", ".json"), "w") as f:
        json.dump(meta, f, indent=1)


if __name__ == "__main__":
    main()
