// Score skey-predict.py output with the same exact / MIREX-weighted rules as
// beatport-eval.mjs.   node score-skey.mjs <preds.json> <keys dir>
import { readFileSync, readdirSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { toCamelot, relation } from '../../core/audio/dsp/key.mjs';
const [predFile, keysDir] = process.argv.slice(2);
const preds = JSON.parse(readFileSync(predFile, 'utf8'));
const keyFiles = new Map(readdirSync(keysDir).filter(f => !f.startsWith('.')).map(f => [basename(f, extname(f)).split(' ')[0], join(keysDir, f)]));
const parse = s => { const m = /^\s*([A-G])([#b]?)\s+(major|minor)\s*$/i.exec(s); return m ? { tonic: m[1].toUpperCase() + m[2], mode: m[3].toLowerCase() } : null; };
let n = 0, same = 0, mirex = 0;
const c = { fifth: 0, relative: 0, parallel: 0, other: 0 };
for (const [id, p] of Object.entries(preds)) {
  const ref = keyFiles.has(id) ? parse(readFileSync(keyFiles.get(id), 'utf8').split('\n')[0]) : null, pk = parse(p);
  if (!ref || !pk) continue;
  const a = toCamelot(pk.tonic, pk.mode), b = toCamelot(ref.tonic, ref.mode);
  n++;
  const rel = a === b ? 'same' : relation(a, b);
  if (rel === 'same') { same++; mirex += 1; }
  else if (/fifth/.test(rel ?? '')) { c.fifth++; mirex += 0.5; }
  else if (rel === 'relative') { c.relative++; mirex += 0.3; }
  else if (rel === 'parallel') { c.parallel++; mirex += 0.2; }
  else c.other++;
}
console.log(`S-KEY n=${n} exact ${(100 * same / n).toFixed(1)}%  MIREX ${(100 * mirex / n).toFixed(1)}%`, c);
