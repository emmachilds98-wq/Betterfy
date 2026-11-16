# Run Deezer S-KEY (code MIT; weights research/non-commercial only) over the
# same Beatport tracks and window beatport-eval.mjs uses (middle 30 s, half B),
# and write { id: "D minor" } for score-skey.mjs. Measurement only; nothing ships.
#
#   python3 skey-predict.py <skey repo dir> <mp3 dir> <out.json> [--half B]
# The skey repo dir holds skey/*.py and skey/models/skey.pt (from the S-KEY repo).
import sys, os, json, subprocess, numpy as np, torch
sys.path.insert(0, sys.argv[1])
from skey.key_detection import load_checkpoint, load_model_components, infer_key
mp3, out = sys.argv[2], sys.argv[3]
half = sys.argv[sys.argv.index('--half') + 1] if '--half' in sys.argv else 'B'

def half_of(i, seed=1):
    M = 0xFFFFFFFF
    h = (2166136261 ^ seed) & M
    for ch in str(i):
        h ^= ord(ch); h = (h * 16777619) & M
    h ^= h >> 13; h = (h * 0x5bd1e995) & M; h ^= h >> 15
    return 'A' if h % 2 == 0 else 'B'

ck = load_checkpoint(os.path.join(sys.argv[1], 'skey/models/skey.pt'))
sr = int(ck['audio']['sr'])
hcqt, net, crop = load_model_components(ck, torch.device('cpu'))
res = {}
for f in sorted(os.listdir(mp3)):
    if not f.endswith('.mp3'): continue
    i = f.split(' ')[0].rsplit('.', 1)[0]
    if half_of(i) != half: continue
    r = subprocess.run(['ffmpeg', '-v', 'quiet', '-i', os.path.join(mp3, f), '-ac', '1', '-ar', str(sr), '-f', 'f32le', '-'], capture_output=True)
    a = np.frombuffer(r.stdout, np.float32)
    if len(a) < 30 * sr: continue
    t0 = len(a) // 2 - 15 * sr
    x = torch.from_numpy(a[t0:t0 + 30 * sr].copy())
    if x.abs().max() > 0: x = x / x.abs().max()
    res[i] = infer_key(hcqt, net, crop, x, torch.device('cpu'))
    if len(res) % 50 == 0: print(len(res), flush=True)
json.dump(res, open(out, 'w'))
