import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/* Giving a freshly-fetched tag back to the shared table.
 *
 * CLAUDE.md is explicit about anything outside Spotify: a bonus must be
 * silently absent and zero-cost for anyone who hasn't got it, and the core
 * model must never lean on it. So most of what matters here is what this does
 * *not* do — with no project configured it makes no request at all, and however
 * it fails it is never the reason a listener's own tag fetch went wrong. */

const BUNDLE = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');

/**
 * The contributor, with config injected the way a configured build would have
 * baked it in. The shipped build carries empty strings, which is the off state.
 */
function load({ project = 'betterfy-tags', key = 'AIza' + 'x'.repeat(30), raw = {} } = {}) {
  const from = BUNDLE.indexOf('const TAGS_PROJECT =');
  const to = BUNDLE.indexOf('async function discogsTags');
  assert.ok(from > 0 && to > from, 'contributeTags not found — rebuild with npm run build:web');
  const src = BUNDLE.slice(from, to)
    .replace("const TAGS_PROJECT = '', TAGS_KEY = '';",
      `const TAGS_PROJECT = ${JSON.stringify(project)}, TAGS_KEY = ${JSON.stringify(key)};`);

  const calls = [];
  const sandbox = {
    RAW_TAGS: raw,
    fetchDeadline: async (url, opts, ms) => { calls.push({ url, opts, ms }); return { ok: true }; },
    Date, JSON, encodeURIComponent, console,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return Object.assign(sandbox, { calls });
}

const TAGS = [['jungle', 100], ['breakbeat', 60]];
const ARTIST = '4Z8W4fKeB5YxbusRsdQVPb';

test('the shipped build has sharing off, so a plain fork contributes nothing', () => {
  assert.match(BUNDLE, /const TAGS_PROJECT = '(|[a-z][a-z0-9-]{3,39})', TAGS_KEY = '[^']*';/,
    'the build must carry either a real project or nothing — never a placeholder');
});

test('with no project configured, not a single request goes out', () => {
  const app = load({ project: '', key: '' });
  app.contributeTags(ARTIST, TAGS);
  assert.deepEqual(app.calls, [], 'zero-cost for anyone who has not got it');
});

test('an unreplaced build placeholder counts as off, not as a project name', () => {
  const app = load({ project: '__TAGS_PROJECT__', key: '__TAGS_KEY__' });
  app.contributeTags(ARTIST, TAGS);
  assert.deepEqual(app.calls, []);
});

test('a configured build posts the artist to its own document', () => {
  const app = load();
  app.contributeTags(ARTIST, TAGS);
  assert.equal(app.calls.length, 1);
  const { url, opts } = app.calls[0];
  assert.ok(url.startsWith('https://firestore.googleapis.com/v1/projects/betterfy-tags/'), url);
  assert.match(url, /\/documents\/tagContributions\?documentId=4Z8W4fKeB5YxbusRsdQVPb/,
    'documentId on a create is what makes the first contribution win and later ones bounce');
  assert.match(url, /[?&]key=AIza/);
  assert.equal(opts.method, 'POST');
});

test('what it sends is what merge-tags.mjs expects to read back', () => {
  const app = load();
  app.contributeTags(ARTIST, TAGS);
  const body = JSON.parse(app.calls[0].opts.body);
  assert.deepEqual(JSON.parse(body.fields.tags.stringValue), TAGS,
    'Last.fm’s own 0-100 scale, which the merge converts — not pre-converted here');
  assert.equal(body.fields.source.stringValue, 'lastfm');
  assert.ok(Number(body.fields.at.integerValue) > 0);
});

test('at most ten tags are offered, matching the shipped table', () => {
  const app = load();
  app.contributeTags(ARTIST, Array.from({ length: 18 }, (_, i) => [`t${i}`, 50]));
  assert.equal(JSON.parse(JSON.parse(app.calls[0].opts.body).fields.tags.stringValue).length, 10);
});

test('an artist already in the shipped table is not offered again', () => {
  // Nothing to give, and the create would only bounce.
  const app = load({ raw: { [ARTIST]: { tags: [['electronic', 100]] } } });
  app.contributeTags(ARTIST, TAGS);
  assert.deepEqual(app.calls, []);
});

test('nothing is sent for an artist Last.fm had no tags for', () => {
  const app = load();
  app.contributeTags(ARTIST, []);
  app.contributeTags(ARTIST, null);
  app.contributeTags('', TAGS);
  assert.deepEqual(app.calls, []);
});

test('a request that fails is never the reason a tag fetch failed', () => {
  const app = load();
  app.fetchDeadline = async () => { throw new TypeError('Load failed'); };
  assert.doesNotThrow(() => app.contributeTags(ARTIST, TAGS));
});

test('a contributor that throws outright is still not the caller’s problem', () => {
  // It sits between fetching a listener's own tags and saving them. Nothing
  // optional gets to interrupt that.
  const app = load();
  app.fetchDeadline = () => { throw new Error('boom'); };
  assert.doesNotThrow(() => app.contributeTags(ARTIST, TAGS));
});

test('it never blocks: the caller gets nothing to await', () => {
  const app = load();
  let settled = false;
  app.fetchDeadline = () => new Promise(() => { settled = true; });   // never resolves
  assert.equal(app.contributeTags(ARTIST, TAGS), undefined);
  assert.ok(settled, 'the request did start — it is just not awaited');
});

test('the request carries a deadline, like every other one in the page', () => {
  const app = load();
  app.contributeTags(ARTIST, TAGS);
  const { ms } = app.calls[0];
  assert.ok(ms > 0 && ms <= 20000, `${ms}ms is not a sane deadline for a background gift`);
});
