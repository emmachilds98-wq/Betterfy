"""Phase 0 reference pipeline (scratch; measurement only, nothing committed).

Usage: python -I ref.py <workdir>
  workdir/models/discogs-effnet-bsdynamic-1.{onnx,json} must exist.
  Writes workdir/results.json. Audio is held in a temp file only for the
  duration of one analysis and deleted straight after (plan rule: never store
  audio).
"""
import json, os, sys, time, tempfile, urllib.request, urllib.parse, ssl
import numpy as np
import onnxruntime as ort
import essentia
essentia.log.infoActive = False
essentia.log.warningActive = False
import essentia.standard as es

WD = sys.argv[1]
CTX = ssl.create_default_context(cafile=os.environ.get('SSL_CERT_FILE') or None)
META = json.load(open(f'{WD}/models/discogs-effnet-bsdynamic-1.json'))
CLASSES = META['classes']
SESS = ort.InferenceSession(f'{WD}/models/discogs-effnet-bsdynamic-1.onnx')

def get(url, headers=None, raw=False):
    req = urllib.request.Request(url, headers={'User-Agent': 'Betterfy-phase0/1.0', **(headers or {})})
    with urllib.request.urlopen(req, context=CTX, timeout=30) as r:
        body = r.read()
        return (body, r.status) if raw else json.loads(body)

# ---------- test sets ----------
LABELLED = ['donk', 'bassline', 'speed garage', 'uk garage', 'jungle', 'drum and bass',
            'grime', 'hard house', 'deep house', 'techno', 'trance', 'uk rap',
            'phonk', 'jersey club', 'footwork']
PER_GENRE = 10

import re
# Query, and the word the playlist TITLE must contain — Deezer's playlist search
# is loose ("donk" -> Donkey Kong, "footwork" -> a study playlist).
QUERY = {'donk': ('donk bounce', r'\bdonk'), 'bassline': ('bassline', r'\bbassline'),
         'speed garage': ('speed garage', r'speed garage|speed house'), 'uk garage': ('uk garage', r'garage|ukg'),
         'jungle': ('jungle', r'\bjungle'), 'drum and bass': ('drum and bass', r'dnb|drum ?(&|and|n) ?bass'),
         'grime': ('grime', r'\bgrime\b'), 'hard house': ('hard house', r'hard house'),
         'deep house': ('deep house', r'deep house'), 'techno': ('techno', r'\btechno'),
         'trance': ('trance', r'\btrance'), 'uk rap': ('uk rap', r'uk rap'), 'phonk': ('phonk', r'\bphonk'),
         'jersey club': ('jersey club', r'jersey'), 'footwork': ('footwork juke', r'footwork|juke')}

def deezer_playlist_tracks(g, n):
    q, rx = QUERY[g]
    pls = get('https://api.deezer.com/search/playlist?' + urllib.parse.urlencode({'q': q, 'limit': 25}))['data']
    pls = [p for p in pls if re.search(rx, p['title'], re.I) and p.get('nb_tracks', 0) >= 10]
    print(f"   {g}: using {[p['title'] for p in pls[:3]]}", file=sys.stderr)
    out, seen = [], set()
    for pl in pls[:3]:
        tr = get(f"https://api.deezer.com/playlist/{pl['id']}/tracks?limit=100")['data']
        for t in tr:
            a = t['artist']['name'].lower()
            if a in seen or not t.get('preview') or not t.get('readable', True):
                continue
            seen.add(a)  # one track per artist: stops the artist itself being what's learned
            out.append({'set': 'labelled', 'label': g, 'artist': t['artist']['name'], 'title': t['title'],
                        'preview': t['preview'], 'source': f"deezer playlist {pl['title']!r}"})
            if len(out) >= n:
                return out
    return out

def deezer_find(artist, title):
    q = f'artist:"{artist}" track:"{title}"'
    d = get('https://api.deezer.com/search?' + urllib.parse.urlencode({'q': q, 'limit': 5})).get('data', [])
    if not d:  # looser: plain text query
        d = get('https://api.deezer.com/search?' + urllib.parse.urlencode({'q': f'{artist} {title}', 'limit': 5})).get('data', [])
    for t in d:
        if t.get('preview') and artist.split(' ')[0].lower().strip('.,') in t['artist']['name'].lower():
            return t
    return None

# ---------- the model ----------
def melbands(audio16k):
    # Essentia's own front end for this model family (what TensorflowPredictEffnetDiscogs uses).
    fe = es.TensorflowInputMusiCNN()
    frames = [fe(f) for f in es.FrameGenerator(audio16k, frameSize=512, hopSize=256, startFromZero=True)]
    return np.array(frames, dtype=np.float32)  # [frames, 96]

def patches(mel, size=128, hop=62):
    if len(mel) < size:
        return np.empty((0, size, 96), np.float32)
    return np.stack([mel[i:i + size] for i in range(0, len(mel) - size + 1, hop)])

def analyse_bytes(b):
    with tempfile.NamedTemporaryFile(suffix='.mp3', delete=True) as f:
        f.write(b); f.flush()
        audio = es.MonoLoader(filename=f.name, sampleRate=16000, resampleQuality=4)()
    p = patches(melbands(audio))
    if not len(p):
        return None
    t0 = time.time()
    act, emb = SESS.run(None, {'melspectrogram': p})
    return {'act': act, 'emb': emb, 'secs': len(audio) / 16000, 'infer_s': time.time() - t0, 'n_patches': len(p)}

def top(act_mean, k=5):
    idx = np.argsort(-act_mean)[:k]
    return [(CLASSES[i], round(float(act_mean[i]), 3)) for i in idx]

# ---------- run ----------
def main():
    tracks = []
    for g in LABELLED:
        try:
            got = deezer_playlist_tracks(g, PER_GENRE)
        except Exception as e:
            got = []; print('playlist fail', g, e, file=sys.stderr)
        print(f'{g:14s} {len(got)} tracks', file=sys.stderr)
        tracks += got
    mine = json.load(open(f'{WD}/mine.json'))
    for m in mine:
        t = None
        try:
            t = deezer_find(m['artist'], m['title'])
        except Exception as e:
            print('find fail', m, e, file=sys.stderr)
        tracks.append({'set': 'mine', 'label': None, 'artist': m['artist'], 'title': m['title'],
                       'preview': t and t['preview'], 'deezer_match': t and f"{t['artist']['name']} - {t['title']}"})

    results = []
    for i, t in enumerate(tracks):
        r = dict(t)
        if not t['preview']:
            r['status'] = 'no preview'; results.append(r); continue
        try:
            full, _ = get(t['preview'], raw=True)
            a = analyse_bytes(full)
            if a is None:
                r['status'] = 'too short'; results.append(r); continue
            mean = a['act'].mean(0)
            r.update(status='ok', bytes_full=len(full), secs=a['secs'], infer_s=a['infer_s'], n_patches=a['n_patches'],
                     top5=top(mean), emb=a['emb'].mean(0).tolist(), act=mean.tolist(),
                     patch_top1=[CLASSES[int(np.argmax(x))] for x in a['act']])
            # Two ~10 s byte ranges (start and middle), as the handoff proposes.
            L = len(full); chunk = 165_000
            parts = []
            for start in (0, max(0, L // 2 - chunk // 2)):
                b, status = get(t['preview'], headers={'Range': f'bytes={start}-{start + chunk - 1}'}, raw=True)
                parts.append((status, b))
            acts, embs = [], []
            for status, b in parts:
                pa = analyse_bytes(b)
                if pa is not None:
                    acts.append(pa['act']); embs.append(pa['emb'])
            if acts:
                pm = np.concatenate(acts).mean(0)
                pe = np.concatenate(embs).mean(0)
                fe = a['emb'].mean(0)
                r.update(range_status=[s for s, _ in parts], bytes_partial=sum(len(b) for _, b in parts),
                         top5_partial=top(pm), emb_cos_partial_vs_full=float(fe @ pe / (np.linalg.norm(fe) * np.linalg.norm(pe))))
        except Exception as e:
            r['status'] = f'error: {e}'
        results.append(r)
        print(f"[{i+1}/{len(tracks)}] {r.get('status')} {t['artist']} - {t['title']} :: {r.get('top5', [''])[:2]}", file=sys.stderr)
    json.dump(results, open(f'{WD}/results.json', 'w'))

main()
