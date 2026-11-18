// Every relative link in the repo's Markdown points at a file that exists
// (docs/BUILD-7-PLAN.md H1). Plans get archived and renamed; a link that
// quietly 404s on GitHub is how a newcomer ends up reading the wrong plan.
// Only the target file is checked, not a #heading inside it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SKIP = new Set(['node_modules', '.git', 'models']);

function mdFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) mdFiles(p, out);
    else if (name.endsWith('.md')) out.push(p);
  }
  return out;
}

/** The relative targets of [text](target) links, outside fenced and inline code. */
export function relativeLinks(md) {
  const text = md.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  const out = [];
  for (const m of text.matchAll(/\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g)) {
    const href = m[1];
    if (/^([a-z][a-z0-9+.-]*:|#|\/)/i.test(href)) continue; // http:, mailto:, anchors, site-absolute
    out.push(decodeURIComponent(href.split('#')[0].split('?')[0]));
  }
  return out.filter(Boolean);
}

test('relativeLinks finds file links and skips urls, anchors and code', () => {
  const md = '[a](docs/A.md#x) [b](https://x.y) [c](#top) `[d](no.md)`\n```\n[e](no2.md)\n```\n[f](sp%20ace.md "t")';
  assert.deepEqual(relativeLinks(md), ['docs/A.md', 'sp ace.md']);
});

test('no relative link in any .md file is broken', () => {
  const broken = [];
  for (const file of mdFiles(ROOT)) {
    for (const href of relativeLinks(readFileSync(file, 'utf8'))) {
      if (!existsSync(join(dirname(file), href))) broken.push(`${relative(ROOT, file)} → ${href}`);
    }
  }
  assert.deepEqual(broken, [], `broken links:\n${broken.join('\n')}`);
});
