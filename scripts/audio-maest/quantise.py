"""Make docs/models/discogs-maest-10s-pw-2-int8.onnx from Essentia's MAEST (WP-C1).

Build-time only; nothing here runs in the page or in CI.

    curl -O https://essentia.upf.edu/models/feature-extractors/maest/discogs-maest-10s-pw-2.onnx
    curl -O https://essentia.upf.edu/models/feature-extractors/maest/discogs-maest-10s-pw-2.json
    pip install onnx onnxruntime
    python3 -I quantise.py discogs-maest-10s-pw-2.onnx docs/models/discogs-maest-10s-pw-2-int8.onnx

Two changes to the published model, both allowed by its CC BY-NC-SA 4.0
licence (a derivative, shared under the same licence; see docs/models/LICENSE):

1. Only the two outputs the page reads are kept, `activations` (400 style
   sigmoids) and `layer_08_embeddings` (the layer core/audio/maest.mjs uses).
   The other twelve are [560 x 768] each and would be copied out of the WASM
   heap on every run for nothing.
2. MatMul/Gemm weights are dynamically quantised to int8 (onnxruntime's
   quantize_dynamic): 344 MB -> 88.6 MB, under GitHub's 100 MB file limit.
   Measured against the fp32 model on 144 Deezer previews: same top style 93%,
   top-5 overlap 96%, embedding cosine median 0.9985 (core/audio/maest.mjs).
"""
import sys, tempfile, os
import onnx
from onnxruntime.quantization import quantize_dynamic, QuantType

KEEP = ['activations', 'layer_08_embeddings']

def main(src, dst):
    m = onnx.load(src)
    outs = [o for o in m.graph.output if o.name in KEEP]
    assert [o.name for o in outs] == [n for n in [o.name for o in m.graph.output] if n in KEEP] and len(outs) == 2, 'unexpected outputs'
    del m.graph.output[:]
    m.graph.output.extend(outs)
    with tempfile.TemporaryDirectory() as d:
        mid = os.path.join(d, 'pruned.onnx')
        onnx.save(m, mid)
        quantize_dynamic(mid, dst, weight_type=QuantType.QInt8, op_types_to_quantize=['MatMul', 'Gemm'])
    print(dst, os.path.getsize(dst), 'bytes')

if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
