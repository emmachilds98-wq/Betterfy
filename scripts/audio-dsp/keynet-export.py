"""Export the key v4 ensemble (keynet-train.py's five fold models) as one ONNX graph.

    python3 scripts/audio-dsp/keynet-export.py <run dir> docs/models/keynet-v4.onnx

Input `spec` [1, T, 105] (keyspec.mjs's centre crop, T frames at 10/s),
output `logp` [1, 24]: the mean of the five models' log-softmax
(class = mode*12 + tonic pitch class, major 0-11, minor 12-23).
"""
import sys, os, torch, torch.nn as nn, torch.nn.functional as F
run, out = sys.argv[1], sys.argv[2]
sys.argv = ['x', '-', '-']
src = open(os.path.join(os.path.dirname(__file__), 'keynet-train.py')).read()
cls = src[src.index('class KeyNet'):src.index('def rot(')]
CH, HID, CROP = 8, 48, 105
exec(cls)
class Ens(nn.Module):
    def __init__(s, ms): super().__init__(); s.ms = nn.ModuleList(ms)
    def forward(s, x): return torch.stack([F.log_softmax(m(x), -1) for m in s.ms]).mean(0)
ms = []
for k in range(5):
    m = KeyNet(); m.load_state_dict(torch.load(os.path.join(run, f'keynet-fold{k}.pt'))); m.eval(); ms.append(m)
e = Ens(ms).eval()
torch.onnx.export(e, torch.zeros(1, 190, CROP), out, input_names=['spec'], output_names=['logp'],
                  dynamic_axes={'spec': {1: 'frames'}}, opset_version=17, dynamo=False)
print('wrote', out, os.path.getsize(out))
