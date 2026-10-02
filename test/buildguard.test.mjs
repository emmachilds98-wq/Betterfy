import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, cpSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* The build's last line of defence against shipping a credential.
 *
 * It used to match only the *names* SPOTIFY_CLIENT_SECRET, LASTFM_SHARED_SECRET
 * and DISCOGS_TOKEN — which catches a leak that happens to arrive carrying its
 * own label, and nothing else. A value pasted into the template by hand has no
 * name attached to it, which is exactly the shape a real accident takes.
 *
 * These run the real build script in a throwaway copy of the repo, because a
 * guard that is only reasoned about is a guard nobody has seen work. */

const ROOT = new URL('..', import.meta.url).pathname;

/** A disposable copy of the repo with the given .env and template tweak. */
function sandbox({ env = '', poison = null, poisonCore = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bf-build-'));
  // bundler.mjs is a real dependency of the build now — build-web.mjs imports it
  // to resolve core/'s dependency graph, and a sandbox missing it fails at module
  // resolution rather than at anything this file is trying to test.
  for (const f of ['build-web.mjs', 'bundler.mjs', 'norm.mjs', 'credits.mjs', 'profile.mjs'])
    cpSync(join(ROOT, f), join(dir, f));
  // And core/, because the build now emits docs/engine.js from it on every run.
  // The leak guard checks that file too, so a sandbox without core/ would not
  // merely fail — it would quietly stop testing half of what ships.
  cpSync(join(ROOT, 'core'), join(dir, 'core'), { recursive: true });
  cpSync(join(ROOT, 'docs'), join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, '.env'), env);
  if (poisonCore) {
    // Into a module that ends up in docs/engine.js rather than in the page, which
    // is the surface the guard did not cover when that second file was added.
    const f = join(dir, 'core', 'intrinsic', 'features.mjs');
    writeFileSync(f, `// ${poisonCore}\n` + readFileSync(f, 'utf8'));
  }
  if (poison) {
    const t = join(dir, 'docs', 'app.template.html');
    writeFileSync(t, readFileSync(t, 'utf8').replace('<script>', `<script>\n/* ${poison} */`));
  }
  return dir;
}

/** @returns {{ok: boolean, out: string}} */
function build(dir, args = []) {
  try {
    return { ok: true, out: execFileSync('node', ['build-web.mjs', ...args],
      { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    return { ok: false, out: String(e.stderr ?? '') + String(e.stdout ?? '') };
  }
}

const CLIENT_ID = '7e79f50acaf24fb6ae40cb339bdde382';
const SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

test('an ordinary build succeeds, so the tests below mean something', t => {
  const dir = sandbox({ env: `SPOTIFY_CLIENT_ID=${CLIENT_ID}\n` });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { ok, out } = build(dir);
  assert.ok(ok, `a clean build should not have failed:\n${out}`);
});

test('a secret value baked into the page stops the build, even unlabelled', t => {
  // The case the old guard missed entirely: the value is there, the variable
  // name that would have identified it is not.
  const dir = sandbox({
    env: `SPOTIFY_CLIENT_ID=${CLIENT_ID}\nSPOTIFY_CLIENT_SECRET=${SECRET}\n`,
    poison: SECRET,
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { ok, out } = build(dir);
  assert.equal(ok, false, 'the build shipped a client secret');
  assert.match(out, /SPOTIFY_CLIENT_SECRET/, 'and it should name which one');
});

test('a Last.fm key is caught too — the web build asks each listener for their own', t => {
  const dir = sandbox({
    env: `SPOTIFY_CLIENT_ID=${CLIENT_ID}\nLASTFM_API_KEY=${SECRET}\n`,
    poison: SECRET,
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { ok, out } = build(dir);
  assert.equal(ok, false);
  assert.match(out, /LASTFM_API_KEY/);
});

test('a Discogs token is caught', t => {
  const dir = sandbox({
    env: `SPOTIFY_CLIENT_ID=${CLIENT_ID}\nDISCOGS_TOKEN=${SECRET}\n`,
    poison: SECRET,
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { ok } = build(dir);
  assert.equal(ok, false);
});

test('a secret reaching the engine bundle stops the build too, not just the page', t => {
  // docs/engine.js is a second shipped file. The guard originally ran over the
  // page alone, so a credential that reached only the engine bundle would have
  // been published by a build that reported success.
  const dir = sandbox({
    env: `SPOTIFY_CLIENT_ID=${CLIENT_ID}\nSPOTIFY_CLIENT_SECRET=${SECRET}\n`,
    poisonCore: SECRET,
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { ok, out } = build(dir);
  assert.equal(ok, false, 'the build shipped a secret inside engine.js');
  assert.match(out, /engine\.js/, 'and it should say which file');
});

test('the engine bundle is emitted on an ordinary build, so the guard above has something to guard', t => {
  const dir = sandbox({ env: `SPOTIFY_CLIENT_ID=${CLIENT_ID}\n` });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { ok } = build(dir);
  assert.ok(ok);
  const js = readFileSync(join(dir, 'docs', 'engine.js'), 'utf8');
  assert.match(js, /BetterfyIntrinsic/, 'the page looks this global up by name');
  assert.match(js, /BetterfyValidate/);
  // And it must stay out of the page, or the lazy load saved nobody anything.
  const html = readFileSync(join(dir, 'docs', 'index.html'), 'utf8');
  assert.ok(!html.includes('COOCCURRENCE_VERSION'),
    'the engine must not also be inlined into the page');
  assert.match(html, /engine\.js\?v=/, 'but the page must know how to fetch it');
});

test('every inline script in the built page actually parses', t => {
  // A duplicate top-level declaration, or one stray backtick in a template
  // string, is a SyntaxError that kills the whole script — so the page loads,
  // renders nothing, and every other test here still passes because they only
  // ever run slices of it. Cheap to check, and the failure it catches is total.
  const dir = sandbox({ env: `SPOTIFY_CLIENT_ID=${CLIENT_ID}\n` });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.ok(build(dir).ok);
  const html = readFileSync(join(dir, 'docs', 'index.html'), 'utf8');

  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m, checked = 0;
  while ((m = re.exec(html))) {
    const body = m[1];
    if (body.trim().length < 40) continue;
    checked++;
    // new Function parses without running: no DOM needed, no side effects.
    assert.doesNotThrow(() => new Function(body),
      `inline script ${checked} (${body.length} chars) does not parse`);
  }
  assert.ok(checked >= 1, 'the page should carry at least one substantial inline script');

  // And the engine bundle, which is a script the page loads by URL.
  assert.doesNotThrow(() => new Function(readFileSync(join(dir, 'docs', 'engine.js'), 'utf8')),
    'docs/engine.js does not parse');
});

test('the values that are public by design still ship', t => {
  // A Spotify client ID and a Firebase web key name a thing rather than
  // authorising anything, and the whole PKCE-and-rules design depends on being
  // able to ship them. A guard that blocked those would block every build.
  const dir = sandbox({ env:
    `SPOTIFY_CLIENT_ID=${CLIENT_ID}\n`
    + `SPOTIFY_REDIRECT_URI=https://emmachilds98-wq.github.io/Betterfy/\n`
    + `TAGS_PROJECT=betterfy-1a983\n`
    + `TAGS_KEY=AIzaSyBEom-MoIBCnC9g48dIeQ0MIRPeVptrBLQ\n`
    + `CONTACT_EMAIL=access@example.test\n`
    + `APPCHECK_SITE_KEY=6Le-example-site-key\n`
    + `APPCHECK_APP_ID=1:940770314231:web:f3579103449980316b90f2\n` });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { ok, out } = build(dir);
  assert.ok(ok, `a build carrying only public values should succeed:\n${out}`);
  const html = readFileSync(join(dir, 'docs', 'index.html'), 'utf8');
  assert.ok(html.includes(CLIENT_ID), 'the client ID is meant to be in there');
  assert.ok(html.includes('betterfy-1a983'));
  assert.ok(html.includes('access@example.test'), 'an explicitly configured contact email is meant to ship too');
  assert.ok(html.includes('6Le-example-site-key'), 'a configured App Check site key is meant to ship too');
  assert.ok(html.includes('1:940770314231:web:f3579103449980316b90f2'));
});

test('with no CONTACT_EMAIL set and no prior build to inherit from, none is baked in', t => {
  // sandbox() copies this repo's own already-built docs/index.html too, and
  // the fallback chain deliberately carries a value forward from it (the same
  // as CLIENT_ID/TAGS_PROJECT) — so proving "blank by default" means removing
  // that prior build first, or this repo's own configured contact email would
  // carry over and the assertion below would fail for the wrong reason.
  const dir = sandbox({ env: `SPOTIFY_CLIENT_ID=${CLIENT_ID}\n` });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  rmSync(join(dir, 'docs', 'index.html'), { force: true });
  const { ok, out } = build(dir);
  assert.ok(ok, out);
  const html = readFileSync(join(dir, 'docs', 'index.html'), 'utf8');
  assert.match(html, /const CONTACT_EMAIL = '';/);
  assert.match(html, /const APPCHECK_SITE_KEY = '', APPCHECK_APP_ID = '';/);
});

test('a short or empty .env value never cries wolf', t => {
  // ".env" is full of blanks and placeholders; matching on those would fail
  // every build for nothing.
  const dir = sandbox({ env:
    `SPOTIFY_CLIENT_ID=${CLIENT_ID}\nLASTFM_SHARED_SECRET=\nDISCOGS_TOKEN=x\nMUSICBRAINZ_CONTACT=\n` });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { ok, out } = build(dir);
  assert.ok(ok, `blank and one-character values must not trip the guard:\n${out}`);
});

test('no .env at all is fine — CI builds that way', t => {
  const dir = sandbox({ env: '' });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // No client ID anywhere, so the build refuses for that reason and not a crash
  // inside the guard reading a file that is not there.
  const { out } = build(dir, ['--allow-missing-id']);
  assert.doesNotMatch(out, /ENOENT|Cannot read/, out);
});
