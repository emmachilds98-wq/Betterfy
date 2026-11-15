# Export Beat This (CPJKU/beat_this, MIT code and weights) to ONNX for
# core/audio/dsp/beats.mjs, and check the export against PyTorch.
#
#   pip install torch torchaudio beat-this onnx onnxruntime   (CPU wheels are enough)
#   python3 scripts/audio-dsp/export-beat-this.py [checkpoint] [out.onnx]
#
# checkpoint: a local .ckpt, a URL, or a Beat This short name (default small0,
# fetched from the authors' server, cloud.cp.jku.at). out.onnx defaults to
# docs/models/beat-this-small0.onnx.
#
# The graph is the network only: input `input_spectrogram` [1, time, 128]
# (beat-mel.mjs output, zero-padded by 6 frames each side), outputs `beat` and
# `downbeat` logits [1, time]. Time is dynamic, so a 10 s preview window costs
# ~513 frames of attention rather than the training length of 1500.
#
#   python3 scripts/audio-dsp/export-beat-this.py --check other.onnx
# runs the same random spectrogram through a second ONNX file (for example a
# published export of the same checkpoint) and prints the largest difference.
import sys, os, numpy as np

def check(a_path, b_path):
    import onnxruntime as ort
    x = (np.random.default_rng(0).random((1, 513, 128)) * 3).astype(np.float32)
    outs = []
    for p in (a_path, b_path):
        s = ort.InferenceSession(p)
        name = s.get_inputs()[0].name
        if s.get_inputs()[0].shape[1] == 1500:  # fixed-length exports
            xx = np.zeros((1, 1500, 128), np.float32); xx[:, :513] = x
            o = s.run(None, {name: xx}); outs.append([v[:, :513] for v in o])
        else:
            outs.append(s.run(None, {name: x}))
    d = max(float(np.abs(u - v).max()) for u, v in zip(*outs))
    print(f'max |logit difference| {d:.2e}')
    return d

def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    if '--check' in sys.argv:
        sys.exit(0 if check(args[0], args[1]) < 1e-3 else 1)
    import torch
    from beat_this.inference import load_model
    ckpt = args[0] if args else 'small0'
    here = os.path.dirname(os.path.abspath(__file__))
    out = args[1] if len(args) > 1 else os.path.join(here, '..', '..', 'docs', 'models', 'beat-this-small0.onnx')
    model = load_model(ckpt, 'cpu').eval()
    x = torch.rand(1, 513, 128) * 3
    torch.onnx.export(model, (x,), out, input_names=['input_spectrogram'], output_names=['beat', 'downbeat'],
                      dynamic_axes={'input_spectrogram': {1: 'time'}, 'beat': {1: 'time'}, 'downbeat': {1: 'time'}},
                      opset_version=17, dynamo=False)
    import onnxruntime as ort
    s = ort.InferenceSession(out)
    for T in (513, 1012):
        x = torch.rand(1, T, 128) * 3
        with torch.no_grad(): ref = model(x)
        got = s.run(None, {'input_spectrogram': x.numpy()})
        d = max(float(np.abs(ref[k].numpy() - g).max()) for k, g in zip(('beat', 'downbeat'), got))
        print(f'T={T}: max |torch - onnx| {d:.2e}')
        assert d < 1e-3, 'export does not match PyTorch'
    print(out, os.path.getsize(out), 'bytes')

if __name__ == '__main__':
    main()
