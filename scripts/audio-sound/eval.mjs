// Sound-engine review measurements (docs/SOUND-ENGINE-PLAN.md §2).
//
// Three questions the plan needed numbers for, on public, genre-labelled
// Deezer playlists heard exactly the way the page hears a track (two ~10 s
// windows of the 30 s preview, Discogs-EffNet, core/audio/dsp/combine.mjs):
//
//   1. placing by sound: does centring the embeddings on the set's own mean
//      (a per-account "library mean", no training, nothing pooled) or scoring
//      each window on its own lift nearest-centroid top-1 over today's
//      joined-window centroid?
//   2. how well does the ear separate genres outside electronic music
//      (`--set broad`: hip-hop, rock, indie, jazz, reggae, dancehall...)?
//   3. tempo: where Deezer itself states a BPM for the track, how often does
//      the page's DSP agree, and how often is it half or double, per genre?
//
// Measurement only: nothing here ships or is called by the page. Previews
// are cached in a scratch directory you name and never committed.
//
//   node scripts/audio-sound/eval.mjs <cacheDir> --ort <dir with onnxruntime-node@1.20.1>
//        [--set scene|broad] [--per 25] [--draws 20]
//
// Needs ffmpeg on PATH and network access to api.deezer.com and its preview CDN.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { melFrames, melPatches, SAMPLE_RATE } from '../../core/audio/mel.mjs';
import { createEar } from '../../core/audio/infer.mjs';
import { EMB_DIM } from '../../core/audio/record.mjs';
import { measureWindows } from '../../core/audio/dsp/combine.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const CACHE = args[0];
if (!CACHE) { console.error('usage: eval.mjs <cacheDir> --ort <dir> [--set scene|broad] [--per 25]'); process.exit(1); }
const PER = +opt('--per', 25);
const ORT = opt('--ort', null);
const SET = opt('--set', 'scene');
mkdirSync(join(CACHE, 'mp3'), { recursive: true });

// scene: the same 15 genres as scripts/audio-near/eval.mjs (and phase 0's ref.py).
// broad: genres outside electronic music, which the owner's library does not test.
const SETS = {
  scene: {
    donk: ['donk bounce', /\bdonk/i], bassline: ['bassline', /\bbassline/i],
    'speed garage': ['speed garage', /speed garage|speed house/i], 'uk garage': ['uk garage', /garage|ukg/i],
    jungle: ['jungle', /\bjungle/i], 'drum and bass': ['drum and bass', /dnb|drum ?(&|and|n) ?bass/i],
    grime: ['grime', /\bgrime\b/i], 'hard house': ['hard house', /hard house/i],
    'deep house': ['deep house', /deep house/i], techno: ['techno', /\btechno/i], trance: ['trance', /\btrance/i],
    'uk rap': ['uk rap', /uk rap/i], phonk: ['phonk', /\bphonk/i], 'jersey club': ['jersey club', /jersey/i],
    footwork: ['footwork juke', /footwork|juke/i],
  },
  broad: {
    'hip-hop': ['hip hop classics', /hip ?hop|rap/i], trap: ['trap hits', /\btrap\b/i],
    rnb: ['r&b', /r&b|rnb|r'n'b/i], 'indie rock': ['indie rock', /indie/i], metal: ['metal', /\bmetal\b/i],
    punk: ['punk rock', /\bpunk/i], jazz: ['jazz classics', /\bjazz/i], reggae: ['roots reggae', /reggae/i],
    dancehall: ['dancehall', /dancehall/i], afrobeats: ['afrobeats', /afro ?beats?|afrobeat/i],
    country: ['country hits', /country/i], folk: ['folk acoustic', /\bfolk/i], soul: ['soul classics', /\bsoul/i],
    pop: ['pop hits', /\bpop\b/i], latin: ['reggaeton', /reggaeton|latin/i],
    classical: ['classical piano', /classical|piano/i], house: ['house music', /\bhouse\b/i],
    'drum and bass': ['drum and bass', /dnb|drum ?(&|and|n) ?bass/i],
  },
};
const QUERY = SETS[SET];
if (!QUERY) { console.error(`unknown --set ${SET}`); process.exit(1); }
const get = async u => { for (let i = 0; i < 5; i++) { try { const r = await fetch(u); if (r.ok) return r; } catch { /* retry */ } await new Promise(r => setTimeout(r, 800 * (i + 1))); } throw new Error(`fetch failed: ${u}`); };

async function trackList() {
  const f = join(CACHE, `tracks-${SET}.json`);
  if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'));
  const out = [], seen = new Set();
  for (const [label, [q, rx]] of Object.entries(QUERY)) {
    const pls = ((await (await get(`https://api.deezer.com/search/playlist?q=${encodeURIComponent(q)}&limit=25`)).json()).data ?? [])
      .filter(p => rx.test(p.title) && (p.nb_tracks ?? 0) >= 10);
    let n = 0;
    for (const pl of pls.slice(0, 6)) {
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

// One window is WINDOW_BYTES (165,000) of a 128 kbps MP3: about 10.3 s (core/audio/fetch.mjs).
const WIN = Math.round(10.3125 * SAMPLE_RATE);
const cut = (s, a) => s.subarray(Math.max(0, a), Math.min(s.length, a + WIN));
const twoWindows = s => [cut(s, 0), cut(s, Math.floor(s.length / 2 - WIN / 2))];
const join_ = parts => { const o = new Float32Array(parts.reduce((n, p) => n + p.length, 0)); let i = 0; for (const p of parts) { o.set(p, i); i += p.length; } return o; };
const unit = m => { let ss = 0; for (const v of m) ss += v * v; const n = Math.sqrt(ss) || 1; return Array.from(m, v => +(v / n).toFixed(5)); };

async function embed(ear, samples) {
  const p = melPatches(melFrames(samples));
  const { embeddings } = await ear.run(p.data, p.patches);
  const m = new Float32Array(EMB_DIM);
  for (let q = 0; q < p.patches; q++) for (let k = 0; k < EMB_DIM; k++) m[k] += embeddings[q * EMB_DIM + k] / p.patches;
  return unit(m);
}

async function deezerBpm(id) {
  try { const j = await (await get(`https://api.deezer.com/track/${id}`)).json(); return Number(j?.bpm) > 0 ? Number(j.bpm) : null; }
  catch { return null; }
}

async function analyse(tracks) {
  const f = join(CACHE, `rows-${SET}.json`);
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
    const w = twoWindows(s);
    const dsp = measureWindows(w);
    have[t.id] = {
      joined: await embed(ear, join_(w)), w0: await embed(ear, w[0]), w1: await embed(ear, w[1]),
      dsp: dsp ? { bpm: dsp.bpm, bpmConf: dsp.bpmConf, octaveAmbiguous: dsp.octaveAmbiguous, bpmAlt: dsp.bpmAlt ?? null } : null,
      deezerBpm: await deezerBpm(t.id),
    };
    if (++done % 25 === 0) { writeFileSync(f, JSON.stringify(have)); console.error(`analysed ${Object.keys(have).length}`); }
  }
  writeFileSync(f, JSON.stringify(have));
  return have;
}

const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const norm = v => { let ss = 0; for (const x of v) ss += x * x; const n = Math.sqrt(ss) || 1; return v.map(x => x / n); };

/** Subtract the set's mean embedding and renormalise: what a per-account library mean would do. */
function centred(rows, key) {
  const d = rows[0][key].length, mu = new Float64Array(d);
  for (const r of rows) for (let i = 0; i < d; i++) mu[i] += r[key][i] / rows.length;
  return rows.map(r => norm(Array.from(r[key], (x, i) => x - mu[i])));
}

/**
 * Leave-one-out nearest-centroid top-1/top-2. `views[i]` is the list of unit
 * vectors standing for row i (one for a joined embedding, two for per-window);
 * a centroid is the mean of every member view, and a row's score against it is
 * the mean of its views' cosines.
 */
function loo(labels, views) {
  const L = [...new Set(labels)], d = views[0][0].length;
  const sums = new Map(L.map(l => [l, new Float64Array(d)]));
  labels.forEach((l, i) => { for (const v of views[i]) { const s = sums.get(l); for (let k = 0; k < d; k++) s[k] += v[k]; } });
  let t1 = 0, t2 = 0;
  const per = new Map(L.map(l => [l, [0, 0]]));
  labels.forEach((truth, i) => {
    const scores = L.map(l => {
      const s = Float64Array.from(sums.get(l));
      if (l === truth) for (const v of views[i]) for (let k = 0; k < d; k++) s[k] -= v[k];
      let ss = 0; for (const x of s) ss += x * x; const n = Math.sqrt(ss) || 1;
      return [l, views[i].reduce((a, v) => a + dot(v, s) / n, 0) / views[i].length];
    }).sort((a, b) => b[1] - a[1]);
    const pr = per.get(truth); pr[1]++;
    if (scores[0][0] === truth) { t1++; pr[0]++; }
    if (scores.slice(0, 2).some(x => x[0] === truth)) t2++;
  });
  return { top1: t1 / labels.length, top2: t2 / labels.length, per };
}

const tracks = await trackList();
const data = await analyse(tracks);
const base = tracks.filter(t => data[t.id]);
const pc = x => `${(x * 100).toFixed(1)}%`;
console.log(`set ${SET}: ${base.length} tracks, ${new Set(base.map(t => t.label)).size} genres, up to ${PER} per genre, one track per artist`);

const rows = base.map(t => ({ label: t.label, ...data[t.id] }));
const variants = rows => {
  const labels = rows.map(r => r.label);
  const cj = centred(rows, 'joined'), c0 = centred(rows, 'w0'), c1 = centred(rows, 'w1');
  return {
    'joined, centroid (today)': loo(labels, rows.map(r => [r.joined])),
    'joined, centred': loo(labels, cj.map(v => [v])),
    'per window, centroid': loo(labels, rows.map(r => [r.w0, r.w1])),
    'per window, centred': loo(labels, rows.map((_, i) => [c0[i], c1[i]])),
    'middle window only': loo(labels, rows.map(r => [r.w1])),
  };
};
const all = variants(rows);
for (const [k, r] of Object.entries(all)) console.log(`${k.padEnd(26)} top-1 ${pc(r.top1)}  top-2 ${pc(r.top2)}`);
console.log('per genre, today -> centred:');
for (const [l, [a, n]] of all['joined, centroid (today)'].per) {
  const [b] = all['joined, centred'].per.get(l);
  console.log(`  ${l.padEnd(16)} ${a}/${n} -> ${b}/${n}`);
}

// Few-shot, as small playlists are: 9 members per genre, many draws.
const draws = +opt('--draws', 20);
let seed = +opt('--seed', 1); const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const acc = {};
for (let d = 0; d < draws; d++) {
  const by = new Map(); for (const r of rows) (by.get(r.label) ?? by.set(r.label, []).get(r.label)).push(r);
  const pick = [...by.values()].flatMap(l => [...l].sort(() => rnd() - 0.5).slice(0, 9));
  for (const [k, r] of Object.entries(variants(pick))) acc[k] = (acc[k] ?? 0) + r.top1 / draws;
}
for (const [k, v] of Object.entries(acc)) console.log(`9 per genre, ${k.padEnd(26)} top-1 ${pc(v)} (mean of ${draws} draws)`);

// Tempo against Deezer's own BPM, where Deezer states one.
const rel = (a, b) => {
  const r = a / b;
  if (Math.abs(a - b) <= Math.max(2, 0.03 * b)) return 'same';
  if (Math.abs(r - 2) <= 0.06) return 'double';
  if (Math.abs(r - 0.5) <= 0.03) return 'half';
  if (Math.abs(r - 1.5) <= 0.05 || Math.abs(r - 2 / 3) <= 0.03) return '3:2';
  return 'other';
};
const tempo = new Map();
for (const r of rows) {
  if (!r.dsp?.bpm || !r.deezerBpm) continue;
  const t = tempo.get(r.label) ?? { n: 0, same: 0, double: 0, half: 0, '3:2': 0, other: 0, sure: 0, sureSame: 0, flagged: 0 };
  const k = rel(r.dsp.bpm, r.deezerBpm); t.n++; t[k]++;
  if (r.dsp.bpmConf >= 0.3) { t.sure++; if (k === 'same') t.sureSame++; }
  if (r.dsp.octaveAmbiguous) t.flagged++;
  tempo.set(r.label, t);
}
console.log('tempo vs Deezer BPM (where Deezer has one): genre  n  same  DSP double  DSP half  3:2  other | conf>=0.3: n same | flagged unsure');
let T = { n: 0, same: 0, double: 0, half: 0, '3:2': 0, other: 0, sure: 0, sureSame: 0, flagged: 0 };
for (const [l, t] of tempo) {
  for (const k of Object.keys(T)) T[k] += t[k];
  console.log(`  ${l.padEnd(16)} ${String(t.n).padStart(3)} ${String(t.same).padStart(4)} ${String(t.double).padStart(6)} ${String(t.half).padStart(8)} ${String(t['3:2']).padStart(4)} ${String(t.other).padStart(5)} | ${t.sure} ${t.sureSame} | ${t.flagged}`);
}
console.log(`  ${'all'.padEnd(16)} ${String(T.n).padStart(3)} ${String(T.same).padStart(4)} ${String(T.double).padStart(6)} ${String(T.half).padStart(8)} ${String(T['3:2']).padStart(4)} ${String(T.other).padStart(5)} | ${T.sure} ${T.sureSame} | ${T.flagged}`);
const withBpm = rows.filter(r => r.deezerBpm).length;
console.log(`Deezer states a BPM for ${withBpm} of ${rows.length} tracks.`);
