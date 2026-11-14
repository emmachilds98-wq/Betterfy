"""Export the learner fixture: genre-labelled Deezer previews -> embeddings only.

Usage: python -I export-embeddings.py <workdir> [per_genre=50] [out=test/fixtures/audio-learn-phase0.json]
  workdir/models/discogs-effnet-bsdynamic-1.onnx must exist (see README).

The phase 0 test set (ref.py) had ten tracks per genre, which cannot show a
learning curve at 40 examples per playlist. This draws the same 15 genres the
same way (Deezer playlists whose *title* names the genre, one track per artist
within a genre) but up to `per_genre` each, runs Discogs-EffNet on the full
30 s preview, and writes only what the learner needs: the label, the artist
(for artist-grouped folds), the Deezer track id, and the mean-over-patches
embedding packed exactly as core/audio/record.mjs's packEmbedding does (int8,
one scale, base64). No audio and no preview URL is written: each preview is
held in a temp file for one analysis and deleted (plan §0 rule 4).

Labels stay as noisy as phase 0's: a playlist title is the only ground truth.
"""
import base64, json, os, re, ssl, sys, tempfile, time, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor
import numpy as np
import onnxruntime as ort
import essentia
essentia.log.infoActive = False
essentia.log.warningActive = False
import essentia.standard as es

WD = sys.argv[1]
PER_GENRE = int(sys.argv[2]) if len(sys.argv) > 2 else 50
OUT = sys.argv[3] if len(sys.argv) > 3 else 'test/fixtures/audio-learn-phase0.json'
CTX = ssl.create_default_context(cafile=os.environ.get('SSL_CERT_FILE') or None)
SESS = ort.InferenceSession(f'{WD}/models/discogs-effnet-bsdynamic-1.onnx')

# Same genres and title rules as ref.py.
QUERY = {'donk': ('donk bounce', r'\bdonk'), 'bassline': ('bassline', r'\bbassline'),
         'speed garage': ('speed garage', r'speed garage|speed house'), 'uk garage': ('uk garage', r'garage|ukg'),
         'jungle': ('jungle', r'\bjungle'), 'drum and bass': ('drum and bass', r'dnb|drum ?(&|and|n) ?bass'),
         'grime': ('grime', r'\bgrime\b'), 'hard house': ('hard house', r'hard house'),
         'deep house': ('deep house', r'deep house'), 'techno': ('techno', r'\btechno'),
         'trance': ('trance', r'\btrance'), 'uk rap': ('uk rap', r'uk rap'), 'phonk': ('phonk', r'\bphonk'),
         'jersey club': ('jersey club', r'jersey'), 'footwork': ('footwork juke', r'footwork|juke')}


def get(url, raw=False, tries=4):
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'Betterfy-phase0/1.0'})
            with urllib.request.urlopen(req, context=CTX, timeout=30) as r:
                body = r.read()
            if raw:
                return body
            d = json.loads(body)
            if isinstance(d, dict) and d.get('error', {}).get('code') == 4:  # quota: wait and retry
                time.sleep(2 + k * 2); continue
            return d
        except Exception:
            if k == tries - 1:
                raise
            time.sleep(1 + k)


def tracks_for(g, n, taken):
    q, rx = QUERY[g]
    pls = get('https://api.deezer.com/search/playlist?' + urllib.parse.urlencode({'q': q, 'limit': 50}))['data']
    pls = [p for p in pls if re.search(rx, p['title'], re.I) and p.get('nb_tracks', 0) >= 10]
    out, artists = [], set()
    for pl in pls:
        data = get(f"https://api.deezer.com/playlist/{pl['id']}/tracks?limit=200").get('data', [])
        for t in data:
            a = t['artist']['name'].lower()
            if a in artists or t['id'] in taken or not t.get('preview') or not t.get('readable', True):
                continue
            artists.add(a); taken.add(t['id'])
            out.append({'label': g, 'artist': t['artist']['name'], 'deezerId': t['id'], 'preview': t['preview'],
                        'playlist': pl['title']})
            if len(out) >= n:
                return out
    return out


def embed(b):
    with tempfile.NamedTemporaryFile(suffix='.mp3', delete=True) as f:
        f.write(b); f.flush()
        audio = es.MonoLoader(filename=f.name, sampleRate=16000, resampleQuality=4)()
    fe = es.TensorflowInputMusiCNN()
    mel = np.array([fe(fr) for fr in es.FrameGenerator(audio, frameSize=512, hopSize=256, startFromZero=True)], np.float32)
    if len(mel) < 128:
        return None
    p = np.stack([mel[i:i + 128] for i in range(0, len(mel) - 128 + 1, 62)])
    _, emb = SESS.run(None, {'melspectrogram': p})
    return emb.mean(0)


def pack(emb):
    """Byte-for-byte core/audio/record.mjs packEmbedding."""
    m = float(np.abs(emb).max())
    s = m / 127 if m > 0 else 1.0
    q = (np.round(emb.astype(np.float64) / s).astype(np.int64) + 256) & 0xff
    return {'s': s, 'q': base64.b64encode(q.astype(np.uint8).tobytes()).decode()}


def main():
    taken, todo = set(), []
    for g in QUERY:
        got = tracks_for(g, PER_GENRE, taken)
        print(f'{g:14s} {len(got)}', file=sys.stderr)
        todo += got
    rows = []
    with ThreadPoolExecutor(4) as pool:
        for i, (t, body) in enumerate(zip(todo, pool.map(lambda t: _safe_get(t['preview']), todo))):
            if body is None:
                continue
            try:
                emb = embed(body)
            except Exception:  # an empty or truncated preview is a miss, not a crash
                emb = None
            del body
            if emb is None:
                continue
            rows.append({'label': t['label'], 'artist': t['artist'], 'deezerId': t['deezerId'], 'emb': pack(emb)})
            if i % 50 == 0:
                print(f'[{i + 1}/{len(todo)}]', file=sys.stderr)
    out = {'about': 'Discogs-EffNet (discogs-effnet-bsdynamic-1) mean embeddings of 30 s Deezer previews, '
                    'labelled by the genre named in the Deezer playlist title they came from. Embeddings only, '
                    'no audio. Made by scripts/audio-phase0/export-embeddings.py.',
           'model': 'discogs-effnet-bsdynamic-1', 'made': time.strftime('%Y-%m-%d'), 'rows': rows}
    with open(OUT, 'w') as f:
        json.dump(out, f, separators=(',', ':'))
    print(f'wrote {len(rows)} rows to {OUT}', file=sys.stderr)


def _safe_get(url):
    try:
        return get(url, raw=True)
    except Exception:
        return None


main()
