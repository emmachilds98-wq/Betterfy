// WP-C2, step 3: pack text-embeddings.json into the table the page reads,
// docs/models/clap-text-table.json, with record.mjs's packEmbedding (int8),
// in the exact shape core/audio/clap-search.mjs's readTable() expects.
//
//   node scripts/audio-clap/pack-table.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { packEmbedding, CLAP_DIM } from '../../core/audio/record.mjs';

const src = JSON.parse(readFileSync(new URL('./text-embeddings.json', import.meta.url), 'utf8'));
if (src.dim !== CLAP_DIM) throw new Error(`text embeddings are ${src.dim}-d, the record contract says ${CLAP_DIM}`);
const unit = v => { const n = Math.hypot(...v); return Float32Array.from(v, x => x / n); };
const table = {
  v: 1, model: src.model, revision: src.revision, dim: src.dim, template: src.template,
  prompts: src.prompts.map(({ text, kind, concept, emb }) =>
    ({ text, kind, ...(concept ? { concept } : {}), emb: packEmbedding(unit(emb)) })),
};
const out = new URL('../../docs/models/clap-text-table.json', import.meta.url);
writeFileSync(out, JSON.stringify(table) + '\n');
console.log(`${table.prompts.length} prompts → docs/models/clap-text-table.json (${(JSON.stringify(table).length / 1024).toFixed(0)} KB)`);
