// Screenshots the component galleries: every HTML fragment in
// scripts/ui-shots/gallery/*.html, wrapped in the built page's stylesheet,
// desktop and phone, dark and light. Packages that add components drop a
// fragment here rather than editing shots.cjs (docs/UI-BUILD-PLAN.md §6).
//
//   node scripts/ui-shots/gallery.cjs            all fragments, all four forms
//   node scripts/ui-shots/gallery.cjs --only=components
//
// It also measures text contrast on every fragment and lists anything under
// 4.5:1 (the §6 UI-1 bar). Disabled controls and aria-hidden marks are
// skipped, as WCAG skips them. --strict makes a failure exit non-zero.
let chromium;
try { ({ chromium } = require('playwright')); }
catch { console.error('Playwright is not installed. npm i -g playwright && npx playwright install chromium'); process.exit(1); }
const fs = require('fs'), path = require('path');
const DIR = path.join(__dirname, 'gallery'), OUT = path.join(__dirname, 'out');
const only = process.argv.find(a => a.startsWith('--only='))?.slice(7);
const strict = process.argv.includes('--strict');
const bundle = fs.readFileSync(path.join(__dirname, '../../docs/index.html'), 'utf8');
const css = bundle.match(/<style>([\s\S]*?)<\/style>/)[1];
const frags = fs.readdirSync(DIR).filter(f => f.endsWith('.html')).sort()
  .filter(f => !only || f === only + '.html');

const page = (body, theme) => `<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}
.gal{max-width:980px; margin:0 auto; padding:28px 20px 48px}
.gal h2{font-family:var(--display); font-size:13px; letter-spacing:.1em; text-transform:uppercase; color:var(--ink-3); margin:30px 0 12px}
.gal .rowx{display:flex; flex-wrap:wrap; gap:12px; align-items:center}
</style></head><body><div class="gal">${body}</div></body></html>`;

// Runs in the page: every element with its own text, its colour against the
// first opaque background behind it (alpha-blended up the tree).
function audit() {
  const cv = document.createElement('canvas').getContext('2d');
  const rgba = c => { cv.clearRect(0, 0, 1, 1); cv.fillStyle = '#000'; cv.fillStyle = c; cv.fillRect(0, 0, 1, 1);
    const d = cv.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
  const over = (a, b) => [0, 1, 2].map(i => a[i] * a[3] + b[i] * (1 - a[3])).concat(1);
  const lum = c => { const v = c.slice(0, 3).map(x => { x /= 255; return x <= .03928 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; });
    return .2126 * v[0] + .7152 * v[1] + .0722 * v[2]; };
  const bgOf = el => { const layers = [];
    for (let e = el; e; e = e.parentElement) { const c = rgba(getComputedStyle(e).backgroundColor); if (c[3] > 0) layers.push(c); if (c[3] >= 1) break; }
    let b = [255, 255, 255, 1]; if (!layers.length || layers[layers.length - 1][3] < 1) b = rgba(getComputedStyle(document.body).backgroundColor);
    for (const l of layers.reverse()) b = over(l, b); return b; };
  const bad = [];
  for (const el of document.querySelectorAll('.gal *')) {
    if (el.closest('[aria-hidden="true"],[data-skip-contrast]') || el.closest(':disabled') || el.matches('h2')) continue;
    const own = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    if (!own || !el.getClientRects().length) continue;
    const s = getComputedStyle(el); let op = 1; for (let e = el; e; e = e.parentElement) op *= +getComputedStyle(e).opacity;
    const bg = bgOf(el), fg = over([...rgba(s.color).slice(0, 3), rgba(s.color)[3] * op], bg);
    const a = lum(fg), b = lum(bg), r = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
    if (r < 4.5) bad.push(`${r.toFixed(2)}  ${el.tagName.toLowerCase()}.${[...el.classList].join('.')}  "${el.textContent.trim().slice(0, 30)}"`);
  }
  return bad;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const b = await chromium.launch();
  let fails = 0;
  for (const f of frags) {
    const body = fs.readFileSync(path.join(DIR, f), 'utf8'), name = f.replace(/\.html$/, '');
    for (const FORM of ['desk', 'phone']) for (const THEME of ['dark', 'light']) {
      const vp = FORM === 'phone' ? { viewport:{ width:390, height:844 }, deviceScaleFactor:1, isMobile:true, hasTouch:true } : { viewport:{ width:1280, height:860 } };
      const ctx = await b.newContext({ ...vp, colorScheme: THEME });
      await ctx.route(/^https?:\/\//, r => r.fulfill({ status: 404, body: '' }));
      const pg = await ctx.newPage();
      await pg.setContent(page(body, THEME));
      await pg.waitForTimeout(150);
      await pg.screenshot({ path: path.join(OUT, `gallery-${name}-${FORM}-${THEME}.png`), fullPage: true });
      const bad = await pg.evaluate(audit);
      if (bad.length) { fails += bad.length; console.log(`${name} ${FORM}-${THEME}: ${bad.length} under 4.5:1\n  ` + bad.join('\n  ')); }
      await ctx.close();
    }
    console.log(`gallery ${name}: done`);
  }
  await b.close();
  if (strict && fails) process.exit(1);
}
main().catch(e => { console.error(e); process.exit(1); });
