"""Train and measure the learned key model (key v4, keynet).

    python3 scripts/audio-dsp/keynet-train.py <features dir[,dir...]> <out dir> [--folds 5] [--epochs 40]

Reads keynet-features.mjs output. Trains only on half A (5-fold inside A for
model selection: each fold's model keeps the epoch with the best accuracy on
its own held-out fifth of A). Half B is touched once, at the end, by the
averaged ensemble: that is the number reported.

Model: a small all-convolutional net in the spirit of Korzeniowski & Widmer
(ISMIR 2018): five 5x5 conv layers of 8 channels, a full-frequency conv to
48 channels, a 1x1 conv to 24 keys, mean over time. Trained with random
transposition (shift the 105-bin crop by 2 bins per semitone, rotate the
label) and random 10 s time crops. Weights are ours (MIT, from a CC BY-SA
dataset's labels), exported to ONNX for onnxruntime-web.
"""
import json, sys, os, glob, random, math
import numpy as np
import torch, torch.nn as nn, torch.nn.functional as F

BINS, MARGIN, CROP = 129, 12, 105
feat_dir, out_dir = sys.argv[1], sys.argv[2]
def arg(k, d):
    return type(d)(sys.argv[sys.argv.index(k) + 1]) if k in sys.argv else d
FOLDS, EPOCHS, PER_EPOCH, TCROP = arg('--folds', 5), arg('--epochs', 40), arg('--per-epoch', 2000), arg('--tcrop', 100)
CH, HID = arg('--ch', 8), arg('--hid', 48)
os.makedirs(out_dir, exist_ok=True)
torch.set_num_threads(os.cpu_count())

# feat_dir may list several feature dirs, comma-separated (e.g. Beatport EDM Key
# plus GiantSteps Key made with --train-only).
meta = []
for d in feat_dir.split(','):
    for f in sorted(glob.glob(os.path.join(d, 'meta-*.jsonl'))):
        meta += [dict(json.loads(l), dir=d) for l in open(f) if l.strip()]
def load(m):
    a = np.fromfile(os.path.join(m['dir'], m['id'] + '.f32'), dtype=np.float32)
    return a.reshape(m['segs'], m['frames'], BINS)
A = [m for m in meta if m['half'] == 'A']
B = [m for m in meta if m['half'] == 'B']
print(f'A {len(A)} tracks, B {len(B)} tracks', flush=True)
XA = {m['id']: load(m) for m in A}

class KeyNet(nn.Module):
    def __init__(s, ch=CH, hid=HID):
        super().__init__()
        layers, c = [], 1
        for _ in range(5):
            layers += [nn.Conv2d(c, ch, 5, padding=2), nn.BatchNorm2d(ch), nn.ELU()]
            c = ch
        s.body = nn.Sequential(*layers)
        s.drop = nn.Dropout(0.3)
        s.freq = nn.Conv2d(ch, hid, (1, CROP))
        s.bn = nn.BatchNorm2d(hid)
        s.out = nn.Conv2d(hid, 24, 1)
    def forward(s, x):  # x: (B, T, 105) standardised log-spectrogram
        h = s.body(x.unsqueeze(1))
        h = F.elu(s.bn(s.freq(s.drop(h))))
        return s.out(s.drop(h)).mean(dim=(2, 3))  # (B, 24) logits

def rot(label, s):  # crop moved up s semitones = audio transposed down s
    mode, pc = divmod(label, 12)
    return mode * 12 + (pc - s) % 12

def batch(tracks, n):
    xs, ys = [], []
    for _ in range(n):
        m = random.choice(tracks); x = XA[m['id']]
        seg = x[random.randrange(len(x))]
        t0 = random.randrange(max(1, seg.shape[0] - TCROP + 1))
        s = random.randrange(-6, 6)
        xs.append(seg[t0:t0 + TCROP, MARGIN + 2 * s: MARGIN + 2 * s + CROP])
        ys.append(rot(m['label'], s))
    return torch.from_numpy(np.stack(xs)), torch.tensor(ys)

def centre(x):  # inference input: the middle 30 s, centre crop
    return torch.from_numpy(np.ascontiguousarray(x[:, :, MARGIN:MARGIN + CROP]))

def mid_of(m, x):  # for A, the segment nearest the middle stands in for the page's preview
    return x[len(x) // 2: len(x) // 2 + 1] if m['half'] == 'A' else x

@torch.no_grad()
def predict(model, tracks, xs):
    model.eval()
    return np.stack([F.log_softmax(model(centre(mid_of(m, xs[m['id']]))), -1)[0].numpy() for m in tracks])

def mirex(p, r):
    if p == r: return 1.0
    pm, pp = divmod(p, 12); rm, rp = divmod(r, 12)
    if pm == rm and (pp - rp) % 12 in (5, 7): return 0.5
    if pm != rm:
        maj, mn = (pp, rp) if pm == 0 else (rp, pp)
        if (maj + 9) % 12 == mn: return 0.3
        if pp == rp: return 0.2
    return 0.0

def score(logp, tracks):
    pred = logp.argmax(1); lab = np.array([m['label'] for m in tracks])
    return float((pred == lab).mean()), float(np.mean([mirex(p, r) for p, r in zip(pred, lab)]))

random.seed(1); torch.manual_seed(1)
ids = sorted(m['id'] for m in A); random.Random(7).shuffle(ids)
fold_of = {i: k % FOLDS for k, i in enumerate(ids)}
oof = np.zeros((len(A), 24), dtype=np.float32)
models = []
for k in range(FOLDS):
    tr = [m for m in A if fold_of[m['id']] != k]; va = [m for m in A if fold_of[m['id']] == k]
    ckpt = os.path.join(out_dir, f'keynet-fold{k}.pt')
    model = KeyNet()
    if os.path.exists(ckpt):  # resume: a finished fold is kept
        model.load_state_dict(torch.load(ckpt)); models.append(model)
        idx = [i for i, m in enumerate(A) if fold_of[m['id']] == k]
        oof[idx] = predict(model, va, XA); print(f'fold {k} loaded', flush=True); continue
    opt = torch.optim.AdamW(model.parameters(), lr=3e-3, weight_decay=1e-3)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=3e-3, total_steps=EPOCHS * (PER_EPOCH // 32))
    best, best_state = -1, None
    for ep in range(EPOCHS):
        model.train()
        for _ in range(PER_EPOCH // 32):
            x, y = batch(tr, 32)
            loss = F.cross_entropy(model(x), y, label_smoothing=0.05)
            opt.zero_grad(); loss.backward(); opt.step(); sched.step()
        acc, mx = score(predict(model, va, XA), va)
        if acc > best: best, best_state = acc, {kk: v.clone() for kk, v in model.state_dict().items()}
        print(f'fold {k} ep {ep} loss {loss.item():.3f} val exact {acc:.3f} mirex {mx:.3f}', flush=True)
    model.load_state_dict(best_state)
    idx = [i for i, m in enumerate(A) if fold_of[m['id']] == k]
    oof[idx] = predict(model, va, XA)
    torch.save(best_state, os.path.join(out_dir, f'keynet-fold{k}.pt'))
    models.append(model)
    print(f'fold {k} best val exact {best:.3f}', flush=True)

np.save(os.path.join(out_dir, 'oof-A.npy'), oof)
print('A out-of-fold (net):', score(oof, A))
# Half B, once.
XB = {m['id']: load(m) for m in B}
logpB = np.mean([predict(mdl, B, XB) for mdl in models], axis=0)
np.save(os.path.join(out_dir, 'logp-B.npy'), logpB)
json.dump({'A': [m['id'] for m in A], 'B': [m['id'] for m in B]}, open(os.path.join(out_dir, 'order.json'), 'w'))
print('B ensemble (net):', score(logpB, B))
dspB = np.log(np.clip(np.array([m['probs'] for m in B]), 1e-6, 1))
print('B DSP v3 (probs argmax):', score(dspB, B))
