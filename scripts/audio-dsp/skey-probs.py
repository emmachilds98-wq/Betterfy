# S-KEY's full 24-way output (not just the argmax) for the same middle 30 s
# beatport-eval.mjs uses, for the DSP+S-KEY ensemble fit (fit-ensemble.mjs).
# Measurement only: S-KEY weights are research/non-commercial, nothing ships.
#   python3 skey-probs.py <skey repo dir> <mp3 dir> <out.json> [--half A|B] [--max n]
# Writes { id: { names: [...24 key names in the model's order], logits: [24 floats] } }.
import sys, os, json, subprocess, numpy as np, torch
sys.path.insert(0, sys.argv[1])
from skey.key_detection import load_checkpoint, load_model_components, key_map
mp3, out = sys.argv[2], sys.argv[3]
half = sys.argv[sys.argv.index('--half') + 1] if '--half' in sys.argv else None
max_n = int(sys.argv[sys.argv.index('--max') + 1]) if '--max' in sys.argv else 10**9

def half_of(i, seed=1):
    M = 0xFFFFFFFF
    h = (2166136261 ^ seed) & M
    for ch in str(i):
        h ^= ord(ch); h = (h * 16777619) & M
    h ^= h >> 13; h = (h * 0x5bd1e995) & M; h ^= h >> 15
    return 'A' if h % 2 == 0 else 'B'

ck = load_checkpoint(os.path.join(sys.argv[1], 'skey/models/skey.pt'))
sr = int(ck['audio']['sr'])
dev = torch.device('cpu')
hcqt, net, crop = load_model_components(ck, dev)
names = [key_map[i] for i in range(24)]
res = {}
for f in sorted(os.listdir(mp3)):
    if not f.endswith('.mp3'): continue
    i = f.split(' ')[0].rsplit('.', 1)[0]
    if half and half_of(i) != half: continue
    if len(res) >= max_n: break
    r = subprocess.run(['ffmpeg', '-v', 'quiet', '-i', os.path.join(mp3, f), '-ac', '1', '-ar', str(sr), '-f', 'f32le', '-'], capture_output=True)
    a = np.frombuffer(r.stdout, np.float32)
    if len(a) < 30 * sr: continue
    t0 = len(a) // 2 - 15 * sr
    x = torch.from_numpy(a[t0:t0 + 30 * sr].copy())
    if x.abs().max() > 0: x = x / x.abs().max()
    with torch.no_grad():
        lg = net(crop(hcqt(x.unsqueeze(0)), torch.zeros(1)))
        res[i] = {'names': names, 'logits': [round(float(v), 4) for v in lg.mean(0).flatten()]}
    if len(res) % 50 == 0:
        print(len(res), flush=True)
        json.dump(res, open(out, 'w'))
json.dump(res, open(out, 'w'))
