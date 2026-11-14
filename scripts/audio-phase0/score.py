"""Score results.json from ref.py. python -I score.py <workdir>"""
import json, sys
import numpy as np

WD = sys.argv[1]
R = json.load(open(f'{WD}/results.json'))
P = 'Electronic---'
EXACT = {
    'donk': {P+'Donk'}, 'bassline': {P+'Bassline'}, 'speed garage': {P+'Speed Garage'},
    'uk garage': {P+'UK Garage'}, 'jungle': {P+'Jungle'}, 'drum and bass': {P+'Drum n Bass'},
    'grime': {P+'Grime', 'Hip Hop---Grime'}, 'hard house': {P+'Hard House'},
    'deep house': {P+'Deep House'},
    'techno': {P+x for x in ['Techno', 'Hard Techno', 'Minimal Techno', 'Deep Techno', 'Dub Techno']},
    'trance': {P+x for x in ['Trance', 'Hard Trance', 'Progressive Trance', 'Psy-Trance', 'Tech Trance', 'Goa Trance']},
    'uk rap': {'Hip Hop---Grime', P+'Grime', 'Hip Hop---Gangsta', 'Hip Hop---Hardcore Hip-Hop', 'Hip Hop---Trap', 'Hip Hop---Pop Rap', 'Hip Hop---Thug Rap', 'Hip Hop---Britcore'},
    'phonk': set(), 'jersey club': set(), 'footwork': set(),
}
# Neighbours a listener would accept as "right area" (only used for the family column).
FAMILY = {
    'donk': {P+x for x in ['Hard House', 'Bassline', 'Hands Up', 'Makina', 'Jumpstyle', 'Hardstyle']},
    'bassline': {P+x for x in ['UK Garage', 'Speed Garage', 'Donk']},
    'speed garage': {P+x for x in ['UK Garage', 'Bassline', 'Garage House']},
    'uk garage': {P+x for x in ['Speed Garage', 'Garage House', 'Bassline', 'Broken Beat']},
    'jungle': {P+x for x in ['Drum n Bass', 'Breakbeat', 'Hardcore', 'Breaks']},
    'drum and bass': {P+x for x in ['Jungle', 'Breakbeat']},
    'grime': {P+'Dubstep', 'Hip Hop---Trap', 'Hip Hop---Gangsta', 'Hip Hop---Hardcore Hip-Hop'},
    'hard house': {P+x for x in ['Donk', 'Hard Trance', 'Hardstyle', 'Makina', 'Jumpstyle']},
    'deep house': {P+x for x in ['House', 'Tech House', 'Garage House', 'Minimal']},
    'techno': {P+x for x in ['Tech House', 'Minimal', 'Industrial', 'Schranz']},
    'trance': {P+x for x in ['Hands Up', 'Progressive House', 'Eurodance']},
    'uk rap': {'Hip Hop---Cloud Rap', 'Hip Hop---Conscious', 'Hip Hop---Boom Bap', P+'Hip Hop'},
    'phonk': {'Hip Hop---Trap', 'Hip Hop---Screw', 'Hip Hop---Miami Bass', 'Hip Hop---Bass Music', 'Hip Hop---Horrorcore', 'Hip Hop---Cloud Rap'},
    'jersey club': {P+'Ghetto House', P+'Juke', P+'Ghetto', 'Hip Hop---Bounce', 'Hip Hop---Miami Bass'},
    'footwork': {P+'Juke', P+'Ghetto House', P+'Ghetto'},
}

ok = [r for r in R if r.get('status') == 'ok']
lab = [r for r in ok if r['set'] == 'labelled']
print(f"tracks: {len(R)}  analysed: {len(ok)}  not heard: {len(R)-len(ok)}")
for s in ('labelled', 'mine'):
    all_s = [r for r in R if r['set'] == s]
    print(f"  {s}: {sum(r.get('status')=='ok' for r in all_s)}/{len(all_s)} heard; misses: "
          f"{sorted(set(r.get('status') for r in all_s if r.get('status')!='ok'))}")

print("\n== 1. Does the model's LABEL match the genre? (hit@k = genre style in top k) ==")
print(f"{'genre':14s} {'n':>3s} {'@1':>4s} {'@3':>4s} {'@5':>4s} {'fam@3':>6s}  most common top-1")
tot = np.zeros(4); totn = 0
for g in EXACT:
    rs = [r for r in lab if r['label'] == g]
    if not rs: continue
    h = np.zeros(4)
    tops = {}
    for r in rs:
        names = [n for n, _ in r['top5']]
        ex, fam = EXACT[g], EXACT[g] | FAMILY[g]
        h += [names[0] in ex, any(n in ex for n in names[:3]), any(n in ex for n in names[:5]),
              any(n in fam for n in names[:3])]
        tops[names[0]] = tops.get(names[0], 0) + 1
    common = sorted(tops.items(), key=lambda x: -x[1])[:2]
    print(f"{g:14s} {len(rs):3d} {h[0]/len(rs):4.0%} {h[1]/len(rs):4.0%} {h[2]/len(rs):4.0%} {h[3]/len(rs):6.0%}  "
          + ', '.join(f"{n.split('---')[1]}×{c}" for n, c in common))
    if EXACT[g]:
        tot += h; totn += len(rs)
print(f"{'ALL labelled':14s} {totn:3d} {tot[0]/totn:4.0%} {tot[1]/totn:4.0%} {tot[2]/totn:4.0%} {tot[3]/totn:6.0%}   (excl. phonk/jersey/footwork)")

print("\n== 2. Few-shot by SOUND: nearest genre centroid, leave-one-out ==")
print("   (each track removed, centroids rebuilt from the other ~9 per genre, track placed)")
labels = sorted({r['label'] for r in lab})
E = np.array([r['emb'] for r in lab]); E = E / np.linalg.norm(E, axis=1, keepdims=True)
Y = [r['label'] for r in lab]
hit1 = hit2 = 0; per = {}
conf = {}
for i in range(len(lab)):
    cents = {}
    for g in labels:
        idx = [j for j in range(len(lab)) if Y[j] == g and j != i]
        if idx:
            c = E[idx].mean(0); cents[g] = c / np.linalg.norm(c)
    sims = sorted(((float(E[i] @ c), g) for g, c in cents.items()), reverse=True)
    h1 = sims[0][1] == Y[i]; h2 = Y[i] in (sims[0][1], sims[1][1])
    hit1 += h1; hit2 += h2
    p = per.setdefault(Y[i], [0, 0, 0]); p[0] += 1; p[1] += h1; p[2] += h2
    if not h1: conf[(Y[i], sims[0][1])] = conf.get((Y[i], sims[0][1]), 0) + 1
print(f"{'genre':14s} {'n':>3s} {'top1':>5s} {'top2':>5s}")
for g in labels:
    n, a, b = per[g]
    print(f"{g:14s} {n:3d} {a/n:5.0%} {b/n:5.0%}")
print(f"{'ALL':14s} {len(lab):3d} {hit1/len(lab):5.0%} {hit2/len(lab):5.0%}   (chance ≈ {1/len(labels):.0%})")
print("most common confusions:", sorted(conf.items(), key=lambda x: -x[1])[:6])

print("\n== 3. Partial download (two ~10 s Range fetches) vs full preview ==")
pr = [r for r in ok if 'top5_partial' in r]
if pr:
    same1 = sum(r['top5'][0][0] == r['top5_partial'][0][0] for r in pr)
    ov3 = np.mean([len({n for n, _ in r['top5'][:3]} & {n for n, _ in r['top5_partial'][:3]}) / 3 for r in pr])
    cos = np.array([r['emb_cos_partial_vs_full'] for r in pr])
    bf = np.mean([r['bytes_full'] for r in pr]); bp = np.mean([r['bytes_partial'] for r in pr])
    st = sorted({s for r in pr for s in r['range_status']})
    print(f"n={len(pr)}  same top-1: {same1/len(pr):.0%}  top-3 overlap: {ov3:.0%}  "
          f"embedding cosine median {np.median(cos):.3f} (min {cos.min():.3f})")
    print(f"bytes: full {bf/1000:.0f} KB vs partial {bp/1000:.0f} KB ({1-bp/bf:.0%} saved); HTTP statuses {st}")

print("\n== 4. Speed (this container's CPU, onnxruntime, full 30 s preview) ==")
inf = np.array([r['infer_s'] for r in ok]); npch = np.array([r['n_patches'] for r in ok])
print(f"inference per track: median {np.median(inf)*1000:.0f} ms (p90 {np.percentile(inf,90)*1000:.0f} ms), patches {int(np.median(npch))}")

print("\n== 5. Your recently-played tracks: what the model hears ==")
for r in [r for r in R if r['set'] == 'mine']:
    if r.get('status') != 'ok':
        print(f"  ✗ {r['artist']} – {r['title']}: {r.get('status')}"); continue
    ts = ', '.join(f"{n.split('---')[1]} {p:.2f}" for n, p in r['top5'][:4])
    # sections that disagree with the overall winner = possible genre change inside the clip
    pt = r['patch_top1']; share = max(pt.count(x) for x in set(pt)) / len(pt)
    print(f"  {r['artist']} – {r['title']}  [{r.get('deezer_match')}]\n      {ts}   (patch agreement {share:.0%})")
