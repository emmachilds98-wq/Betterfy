const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const root = process.argv[2];
const srv = http.createServer((q, r) => { const f = path.join(root, decodeURIComponent(q.url.split('?')[0]));
  const t = f.endsWith('.js') || f.endsWith('.mjs') ? 'text/javascript' : f.endsWith('.wasm') ? 'application/wasm' : f.endsWith('.html') ? 'text/html' : 'application/octet-stream';
  fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); return r.end(); }
    r.writeHead(200, { 'content-type': t, 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' }); r.end(d); }); }).listen(8765);
(async () => { const b = await chromium.launch(); const p = await b.newPage();
  await p.goto('http://localhost:8765/time-web.html');
  for (const th of [1, 4]) console.log(JSON.stringify(await p.evaluate(t => window.run(t), th)));
  await b.close(); srv.close(); })().catch(e => { console.error(e); process.exit(1); });
