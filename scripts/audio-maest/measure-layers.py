# Scratch: MAEST (fp32 and int8) vs effnet on Deezer genre playlists, two 10 s windows per track.
import json, os, re, subprocess, sys, tempfile, time, urllib.parse, urllib.request
import numpy as np, onnxruntime as ort
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'audio-phase0'))
from mel_np import mel
D = sys.argv[1]; PER = int(sys.argv[2]) if len(sys.argv) > 2 else 10
QUERY = {'uk garage': ('uk garage', r'garage|ukg'), 'bassline': ('bassline', r'bassline'), 'speed garage': ('speed garage', r'speed garage'),
 'donk': ('donk', r'donk|bouncy'), 'jungle': ('jungle', r'\bjungle'), 'drum and bass': ('drum and bass', r'dnb|drum ?(&|and|n) ?bass'),
 'grime': ('grime', r'\bgrime\b'), 'hard house': ('hard house', r'hard house'), 'deep house': ('deep house', r'deep house'), 'techno': ('techno', r'\btechno'),
 'trance': ('trance', r'\btrance'), 'uk rap': ('uk rap', r'uk rap'), 'phonk': ('phonk', r'\bphonk'), 'jersey club': ('jersey club', r'jersey'), 'footwork': ('footwork juke', r'footwork|juke')}
def get(u, raw=False):
    for i in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': 'audio-measure/0.1'}), timeout=30) as r:
                b = r.read(); return b if raw else json.loads(b)
        except Exception as e: err = e; time.sleep(1 + i)
    raise err
def tracks(g, n):
    q, rx = QUERY[g]
    pls = [p for p in get('https://api.deezer.com/search/playlist?' + urllib.parse.urlencode({'q': q, 'limit': 25}))['data'] if re.search(rx, p['title'], re.I) and p.get('nb_tracks', 0) >= 10]
    out, seen = [], set()
    for pl in pls[:4]:
        for t in get(f"https://api.deezer.com/playlist/{pl['id']}/tracks?limit=100")['data']:
            a = t['artist']['name'].lower()
            if a in seen or not t.get('preview'): continue
            seen.add(a); out.append({'label': g, 'artist': t['artist']['name'], 'title': t['title'], 'preview': t['preview']})
            if len(out) >= n: return out
    return out
def decode(b):
    with tempfile.NamedTemporaryFile(suffix='.mp3') as f:
        f.write(b); f.flush()
        pcm = subprocess.run(['ffmpeg', '-v', 'quiet', '-i', f.name, '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'], capture_output=True).stdout
    return np.frombuffer(pcm, np.float32)
so = ort.SessionOptions(); so.intra_op_num_threads = 4
EFF = ort.InferenceSession('' + os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'docs', 'models') + '/discogs-effnet-bsdynamic-1.onnx', so)
M8 = ort.InferenceSession(f'{D}/maest10-int8.onnx', so)
MEAN, STD = 2.06755686098554, 1.268292820667291
def effnet(m):
    n = (len(m) - 128) // 62 + 1
    x = np.stack([m[i*62:i*62+128] for i in range(n)])
    outs = EFF.run(None, {EFF.get_inputs()[0].name: x})
    act = [o for o in outs if o.shape[-1] == 400][0]; emb = [o for o in outs if o.shape[-1] == 1280][0]
    return act.mean(0), emb.mean(0)
def maest(sess, m):
    if len(m) < 626: m = np.concatenate([m, m[:626 - len(m)]])  # repeat to fill one patch
    x = ((m[:626] - MEAN) / (STD * 2))[None].astype(np.float32)
    names = [o.name for o in sess.get_outputs()]
    t = time.time(); outs = dict(zip(names, sess.run(['activations', 'layer_06_embeddings'], {'melspectrogram': x}) if False else sess.run(None, {'melspectrogram': x}))); dt = time.time() - t
    return outs['activations'][0], {k: (outs[k][0].mean(0) if k!='cls' else outs['layer_06_embeddings'][0][:2].mean(0)) for k in ['layer_03_embeddings','layer_06_embeddings','layer_08_embeddings','layer_10_embeddings','layer_11_embeddings','cls']}, dt
res = []
for g in QUERY:
    for t in tracks(g, PER):
        try:
            a = decode(get(t['preview'], raw=True))
        except Exception as e: print('skip', e, file=sys.stderr); continue
        W = int(10.3 * 16000)
        if len(a) < 2 * W: continue
        wins = [a[:W], a[len(a)//2 - W//2: len(a)//2 + W//2]]
        r = {k: t[k] for k in ('label', 'artist', 'title')}
        E, M, Q, dts = [], [], [], []
        for w in wins:
            m = mel(w); Q.append(maest(M8, m))
        r['artist_title'] = t['artist'] + ' - ' + t['title']
        for k in Q[0][1]: r[k] = np.mean([q[1][k] for q in Q], 0).tolist()
        res.append(r)
    print(g, sum(1 for r in res if r['label'] == g), file=sys.stderr)
json.dump(res, open(f'{D}/measure2.json', 'w'))
