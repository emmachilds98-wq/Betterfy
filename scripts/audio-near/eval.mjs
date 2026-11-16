// Measures two "hear better" changes (docs/review/ENGINE-REVIEW.md layer 1) on
// genre-labelled Deezer playlists, by sound alone, leave-one-out:
//
//   windows: the two ~10 s windows the app downloads today (start, middle)
//            against three (start, middle, late) and the whole preview;
//   scoring: cosine to the playlist's centroid (today) against a mix of the
//            centroid and the mean cosine to the k nearest members.
//
// Measurement only: nothing here ships. The previews are cached in a scratch
// directory you name and never committed.
//
//   node scripts/audio-near/eval.mjs <cacheDir> --ort <dir with onnxruntime-node> [--per 25] [--seed 1]
//
// Needs ffmpeg on PATH (decodes to 16 kHz mono) and network access to
// api.deezer.com and its preview CDN.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { melFrames, melPatches, SAMPLE_RATE } from '../../core/audio/mel.mjs';
import { createEar } from '../../core/audio/infer.mjs';
import { EMB_DIM } from '../../core/audio/record.mjs';
import { nearMix } from '../../core/intrinsic/audio.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const CACHE = args[0];
if (!CACHE) { console.error('usage: eval.mjs <cacheDir> --ort <dir> [--per 25]'); process.exit(1); }
const PER = +opt('--per', 25);
const ORT = opt('--ort', null);
mkdirSync(join(CACHE, 'mp3'), { recursive: true });

// The same genres and title rules as scripts/audio-phase0/ref.py.
const QUERY = {
  donk: ['donk bounce', /\bdonk/i], bassline: ['bassline', /\bbassline/i],
  'speed garage': ['speed garage', /speed garage|speed house/i], 'uk garage': ['uk garage', /garage|ukg/i],
  jungle: ['jungle', /\bjungle/i], 'drum and bass': ['drum and bass', /dnb|drum ?(&|and|n) ?bass/i],
  grime: ['grime', /\bgrime\b/i], 'hard house': ['hard house', /hard house/i],
  'deep house': ['deep house', /deep house/i], techno: ['techno', /\btechno/i], trance: ['trance', /\btrance/i],
  'uk rap': ['uk rap', /uk rap/i], phonk: ['phonk', /\bphonk/i], 'jersey club': ['jersey club', /jersey/i],
  footwork: ['footwork juke', /footwork|juke/i],
};
const get = async u => { for (let i = 0; i < 4; i++) { try { const r = await fetch(u); if (r.ok) return r; } catch { /* retry */ } await new Promise(r => setTimeout(r, 800 * (i + 1))); } throw new Error(`fetch failed: ${u}`); };

async function trackList() {
  const f = join(CACHE, 'tracks.json');
  if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'));
  const out = [], seen = new Set();
  for (const [label, [q, rx]] of Object.entries(QUERY)) {
    const pls = (await (await get(`https://api.deezer.com/search/playlist?q=${encodeURIComponent(q)}&limit=25`)).json()).data
      .filter(p => rx.test(p.title) && (p.nb_tracks ?? 0) >= 10);
    let n = 0;
    for (const pl of pls.slice(0, 5)) {
      const tr = (await (await get(`https://api.deezer.com/playlist/${pl.id}/tracks?limit=100`)).json()).data ?? [];
      for (const t of tr) {
        const a = t.artist?.name?.toLowerCase();
        // One track per artist across the whole set: the artist must not be what is learned.
        if (!a || seen.has(a) || !t.preview || t.readable === false) continue;
        seen.add(a); out.push({ id: String(t.id), label, artist: t.artist.name, title: t.title, preview: t.preview });
        if (++n >= PER) break;
      }
      if (n >= PER) break;
    }
    console.error(`${label}: ${n}`);
  }
  writeFileSync(f, JSON.stringify(out));
  return out;
}

function decode(path) {
  const r = spawnSync('ffmpeg', ['-v', 'quiet', '-i', path, '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 'f32le', '-'], { maxBuffer: 64 << 20 });
  if (r.status !== 0 || !r.stdout?.length) return null;
  const b = r.stdout; return new Float32Array(b.buffer, b.byteOffset, b.length >> 2).slice();
}

// One window is WINDOW_BYTES (165,000) of a 128 kbps MP3: about 10.3 s.
const WIN = Math.round(10.3125 * SAMPLE_RATE);
const cut = (s, a) => s.subarray(Math.max(0, a), Math.min(s.length, a + WIN));
const VARIANTS = {
  two: s => [cut(s, 0), cut(s, Math.floor(s.length / 2 - WIN / 2))],
  three: s => [cut(s, 0), cut(s, Math.floor(s.length / 2 - WIN / 2)), cut(s, s.length - WIN)],
  full: s => [s],
};
const join_ = parts => { const o = new Float32Array(parts.reduce((n, p) => n + p.length, 0)); let i = 0; for (const p of parts) { o.set(p, i); i += p.length; } return o; };

async function embed(ear, samples) {
  const p = melPatches(melFrames(samples));
  const { embeddings } = await ear.run(p.data, p.patches);
  const m = new Float32Array(EMB_DIM);
  for (let q = 0; q < p.patches; q++) for (let k = 0; k < EMB_DIM; k++) m[k] += embeddings[q * EMB_DIM + k] / p.patches;
  let ss = 0; for (const v of m) ss += v * v; const n = Math.sqrt(ss) || 1;
  return m.map(v => v / n);
}

async function embeddings(tracks) {
  const f = join(CACHE, 'emb.json');
  const have = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {};
  const ort = (await import(ORT ? join(ORT, 'node_modules', 'onnxruntime-node', 'dist', 'index.js') : 'onnxruntime-node')).default;
  const ear = await createEar({ ort, modelUrl: join(process.cwd(), 'docs/models/discogs-effnet-bsdynamic-1.onnx'), sessionOptions: {} });
  let done = 0;
  for (const t of tracks) {
    if (have[t.id]) continue;
    const mp3 = join(CACHE, 'mp3', `${t.id}.mp3`);
    if (!existsSync(mp3)) {
      try { writeFileSync(mp3, Buffer.from(await (await get(t.preview)).arrayBuffer())); } catch { continue; }
    }
    const s = decode(mp3);
    if (!s || s.length < 2 * WIN) continue;
    const e = {};
    for (const [k, fn] of Object.entries(VARIANTS)) e[k] = Array.from(await embed(ear, join_(fn(s))), v => +v.toFixed(5));
    have[t.id] = e;
    if (++done % 25 === 0) { writeFileSync(f, JSON.stringify(have)); console.error(`embedded ${Object.keys(have).length}`); }
  }
  writeFileSync(f, JSON.stringify(have));
  return have;
}

const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

/** Leave-one-out top-1/top-2 over `rows` ({label, emb}) with `nearMix`'s scoring. */
function loo(rows, near) {
  const labels = [...new Set(rows.map(r => r.label))];
  const sums = new Map(labels.map(l => [l, new Float64Array(rows[0].emb.length)]));
  const members = new Map(labels.map(l => [l, []]));
  for (const r of rows) { const s = sums.get(r.label); for (let i = 0; i < s.length; i++) s[i] += r.emb[i]; members.get(r.label).push(r); }
  let t1 = 0, t2 = 0;
  const per = new Map(labels.map(l => [l, [0, 0]]));
  for (const r of rows) {
    const scores = labels.map(l => {
      const s = Float64Array.from(sums.get(l));
      const others = members.get(l).filter(m => m !== r);
      if (l === r.label) for (let i = 0; i < s.length; i++) s[i] -= r.emb[i];
      let ss = 0; for (const v of s) ss += v * v; const n = Math.sqrt(ss) || 1;
      const centroid = dot(r.emb, s) / n;
      const sims = others.map(m => dot(r.emb, m.emb));
      return [l, nearMix(centroid, sims, near)];
    }).sort((a, b) => b[1] - a[1]);
    const pr = per.get(r.label); pr[1]++;
    if (scores[0][0] === r.label) { t1++; pr[0]++; }
    if (scores.slice(0, 2).some(x => x[0] === r.label)) t2++;
  }
  return { top1: t1 / rows.length, top2: t2 / rows.length, n: rows.length, per };
}

const tracks = await trackList();
const emb = await embeddings(tracks);
const base = tracks.filter(t => emb[t.id]);
const pc = x => `${(x * 100).toFixed(1)}%`;
console.log(`${base.length} tracks, ${new Set(base.map(t => t.label)).size} genres, up to ${PER} per genre, one track per artist`);
const grid = [null, { k: 3, mix: 0.5 }, { k: 5, mix: 0.5 }, { k: 3, mix: 0.3 }, { k: 5, mix: 0.3 }, { k: 3, mix: 0.7 }, { k: 1, mix: 0.5 }];
for (const v of Object.keys(VARIANTS)) {
  const rows = base.map(t => ({ label: t.label, emb: emb[t.id][v] }));
  for (const near of grid) {
    const r = loo(rows, near);
    console.log(`${v.padEnd(5)} ${near ? `near k=${near.k} mix=${near.mix}` : 'centroid      '}  top-1 ${pc(r.top1)}  top-2 ${pc(r.top2)}`);
  }
}
// Few-shot, as the owner's smaller playlists are: 9 members per genre, many draws.
const draws = +opt('--draws', 20);
let seed = +opt('--seed', 1); const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
for (const near of [null, { k: 3, mix: 0.5 }, { k: 3, mix: 0.3 }]) {
  for (const v of ['two', 'three']) {
    let a = 0;
    for (let d = 0; d < draws; d++) {
      const by = new Map(); for (const t of base) (by.get(t.label) ?? by.set(t.label, []).get(t.label)).push(t);
      const pick = [...by.values()].flatMap(l => [...l].sort(() => rnd() - 0.5).slice(0, 9));
      a += loo(pick.map(t => ({ label: t.label, emb: emb[t.id][v] })), near).top1;
    }
    console.log(`9 per genre, ${v.padEnd(5)} ${near ? `near k=${near.k} mix=${near.mix}` : 'centroid      '}  top-1 ${pc(a / draws)} (mean of ${draws} draws)`);
  }
}
