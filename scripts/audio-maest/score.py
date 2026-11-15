import json, sys, numpy as np
R = json.load(open(sys.argv[1]))
labels = sorted(set(r['label'] for r in R)); print(len(R), 'tracks', len(labels), 'genres')
u = lambda v: v / np.linalg.norm(v, axis=-1, keepdims=True)
def arr(k): return u(np.array([r[k] for r in R], np.float64))
y = np.array([labels.index(r['label']) for r in R])
def loo(X):
    t1 = t2 = 0
    for i in range(len(X)):
        m = np.ones(len(X), bool); m[i] = False
        C = u(np.stack([X[m & (y == c)].mean(0) for c in range(len(labels))]))
        s = C @ X[i]; o = np.argsort(-s); t1 += o[0] == y[i]; t2 += y[i] in o[:2]
    return t1 / len(X), t2 / len(X)
E, M, Q = arr('eff_emb'), arr('m32_emb'), arr('m8_emb')
for name, X in [('effnet', E), ('maest fp32', M), ('maest int8', Q), ('both (effnet+maest int8)', u(np.hstack([E, Q])))]:
    a, b = loo(X); print(f'{name:28s} top-1 {a:.1%}  top-2 {b:.1%}')
cos = (M * Q).sum(1); print('int8 vs fp32 embedding cosine: median %.4f min %.4f' % (np.median(cos), cos.min()))
A32 = np.array([r['m32_act'] for r in R]); A8 = np.array([r['m8_act'] for r in R])
print('int8 vs fp32 same top-1 style: %.1f%%' % (100 * (A32.argmax(1) == A8.argmax(1)).mean()))
ov = [len(set(np.argsort(-a)[:5]) & set(np.argsort(-b)[:5])) / 5 for a, b in zip(A32, A8)]; print('top-5 overlap mean %.2f' % np.mean(ov))
dt = np.array([d for r in R for d in r['dt']]); print('native CPU s/window fp32 %.3f int8 %.3f' % tuple(np.median(dt, 0)))
