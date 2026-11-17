// End-to-end check of key v4 through the page's own code path.
//
//   node scripts/audio-dsp/keynet-eval.mjs <mp3 dir> <keys dir> <keynet-v4.onnx> --ort <dir with onnxruntime-node> [--half B]
//
// Same tracks, windows and split as beatport-eval.mjs (middle 30 s as two
// 10 s windows; --half B is the held-out half). Runs measureWindows (v3) and
// withKeyNet(measureWindows, createKeyNet(...)) (v4) and reports exact and
// MIREX for each, over every track and over the tracks shown as sure
// (keyConf >= 0.65, match.mjs KEY_MIN_CONF).
import { readdirSync, readFileSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { measureWindows } from '../../core/audio/dsp/combine.mjs';
import { toCamelot, relation } from '../../core/audio/dsp/key.mjs';
import { createKeyNet, withKeyNet } from '../../core/audio/dsp/keynet.mjs';

const SR = 16000;
const [mp3Dir, keysDir, model] = process.argv.slice(2);
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const ortDir = arg('--ort', null), half = arg('--half', 'B'), limit = Number(arg('--limit', Infinity));
const ort = (await import(ortDir ? join(ortDir, 'node_modules', 'onnxruntime-node', 'dist', 'index.js') : 'onnxruntime-node')).default;
const net = await createKeyNet({ ort, modelUrl: model, sessionOptions: {} });
const v4 = withKeyNet(measureWindows, net);

function parseKey(s) {
  const m = /^\s*([A-G])([#b]?)\s+(major|minor)\s*$/i.exec(String(s ?? ''));
  return m ? { tonic: m[1].toUpperCase() + m[2], mode: m[3].toLowerCase() } : null;
}
function halfOf(id, seed = 1) {
  let h = 2166136261 ^ seed;
  for (const ch of String(id)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  return (h >>> 0) % 2 === 0 ? 'A' : 'B';
}
const idOf = f => basename(f, extname(f)).split(' ')[0];
const keys = new Map(readdirSync(keysDir).filter(f => !f.startsWith('.')).map(f => [idOf(f), join(keysDir, f)]));
const decode = p => { const r = spawnSync('ffmpeg', ['-v', 'quiet', '-i', p, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 64 << 20 });
  return r.status === 0 && r.stdout?.length ? new Float32Array(r.stdout.buffer.slice(r.stdout.byteOffset, r.stdout.byteOffset + r.stdout.byteLength)) : null; };
const pts = (a, b) => { if (a === b) return 1; const r = relation(a, b); return /fifth/.test(r ?? '') ? 0.5 : r === 'relative' ? 0.3 : r === 'parallel' ? 0.2 : 0; };

const S = { v3: [], v4: [] };
let ms = 0;
for (const f of readdirSync(mp3Dir).filter(f => f.endsWith('.mp3')).sort().filter(f => halfOf(idOf(f)) === half).slice(0, limit)) {
  const ref = keys.has(idOf(f)) ? parseKey(readFileSync(keys.get(idOf(f)), 'utf8').split('\n')[0]) : null;
  if (!ref) continue;
  const x = decode(join(mp3Dir, f)); if (!x || x.length < 30 * SR) continue;
  const t0 = Math.floor(x.length / 2 - 15 * SR), w = [x.slice(t0, t0 + 10 * SR), x.slice(t0 + 10 * SR, t0 + 20 * SR)];
  const refCam = toCamelot(ref.tonic, ref.mode);
  const a = measureWindows(w); const t = Date.now(); const b = await v4(w); ms += Date.now() - t;
  for (const [k, d] of [['v3', a], ['v4', b]]) S[k].push({ pts: d?.camelot ? pts(d.camelot, refCam) : 0, sure: (d?.keyConf ?? 0) >= 0.65 });
}
const pc = x => (100 * x).toFixed(1);
for (const [k, rows] of Object.entries(S)) {
  const sum = rs => [rs.filter(r => r.pts === 1).length / rs.length, rs.reduce((s, r) => s + r.pts, 0) / rs.length];
  const all = sum(rows), sure = rows.filter(r => r.sure), s = sum(sure);
  console.log(`${k}: all n=${rows.length} exact ${pc(all[0])}% MIREX ${pc(all[1])}% | sure (keyConf>=0.65) ${pc(sure.length / rows.length)}% of tracks: exact ${pc(s[0])}% MIREX ${pc(s[1])}%`);
}
console.log(`v4 time per track (spectrogram + model + blend): ${(ms / S.v4.length).toFixed(0)} ms`);
