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
function sandbox({ env = '', poison = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bf-build-'));
  for (const f of ['build-web.mjs', 'norm.mjs', 'credits.mjs', 'profile.mjs'])
    cpSync(join(ROOT, f), join(dir, f));
  cpSync(join(ROOT, 'docs'), join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, '.env'), env);
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

test('the values that are public by design still ship', t => {
  // A Spotify client ID and a Firebase web key name a thing rather than
  // authorising anything, and the whole PKCE-and-rules design depends on being
  // able to ship them. A guard that blocked those would block every build.
  const dir = sandbox({ env:
    `SPOTIFY_CLIENT_ID=${CLIENT_ID}\n`
    + `SPOTIFY_REDIRECT_URI=https://emmachilds98-wq.github.io/Betterfy/\n`
    + `TAGS_PROJECT=betterfy-1a983\n`
    + `TAGS_KEY=AIzaSyBEom-MoIBCnC9g48dIeQ0MIRPeVptrBLQ\n` });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { ok, out } = build(dir);
  assert.ok(ok, `a build carrying only public values should succeed:\n${out}`);
  const html = readFileSync(join(dir, 'docs', 'index.html'), 'utf8');
  assert.ok(html.includes(CLIENT_ID), 'the client ID is meant to be in there');
  assert.ok(html.includes('betterfy-1a983'));
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
