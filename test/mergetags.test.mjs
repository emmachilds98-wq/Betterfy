import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { normaliseContribution, mergeContributions, serviceAccountAssertion, pruneContributions }
  from '../merge-tags.mjs';

/* Contributions arrive from unauthenticated browsers, so this validation is the
 * whole security boundary — nothing else stands between a stranger's POST and a
 * file every listener downloads. It is also where two scales meet: Last.fm
 * counts run 0-100 and that is what the browser sends; docs/tags.json stores
 * 0-10 and the page multiplies by ten on load. Getting that backwards would not
 * fail loudly, it would quietly make every contributed artist ten times more or
 * less confident than the shipped ones. */

test('a Last.fm contribution comes back on the shipped 0-10 scale', () => {
  assert.deepEqual(
    normaliseContribution(JSON.stringify([['jungle', 100], ['breakbeat', 80], ['drum and bass', 45]])),
    [['jungle', 10], ['breakbeat', 8], ['drum and bass', 5]]);
});

test('a tag the browser would send at its lowest count still survives as 1', () => {
  // The browser filters at count >= 10, so 10/10 = 1 is the floor it can produce.
  // Rounding that away to 0 would silently drop the tag.
  assert.deepEqual(normaliseContribution(JSON.stringify([['ambient', 10]])), [['ambient', 1]]);
  assert.deepEqual(normaliseContribution(JSON.stringify([['ambient', 4]])), [['ambient', 1]]);
});

test('tags come back strongest first, capped at ten', () => {
  const many = Array.from({ length: 18 }, (_, i) => [`tag${i}`, i + 20]);
  const out = normaliseContribution(JSON.stringify(many));
  assert.equal(out.length, 10);
  assert.equal(out[0][0], 'tag17', 'the highest count leads');
  assert.ok(out.every((t, i) => i === 0 || t[1] <= out[i - 1][1]), 'descending');
});

test('names are trimmed and folded to lower case, duplicates collapsed', () => {
  assert.deepEqual(
    normaliseContribution(JSON.stringify([['  Jungle ', 90], ['JUNGLE', 40]])),
    [['jungle', 9]]);
});

test('anything that is not a usable tag list is refused outright', () => {
  const bad = [
    'not json',
    '{}',                                            // not an array
    '[]',                                            // empty
    JSON.stringify([['ok', 50], 'loose']),           // not all pairs
    JSON.stringify([['ok', 50, 'extra']]),           // wrong arity
    JSON.stringify([[42, 50]]),                      // name not a string
    JSON.stringify([['ok', '50']]),                  // count not a number
    JSON.stringify([['ok', 0]]),                     // no confidence at all
    JSON.stringify([['ok', -5]]),
    JSON.stringify([['ok', 101]]),                   // off Last.fm's scale
    JSON.stringify([['ok', Number.NaN]]),
    JSON.stringify([['', 50]]),                      // empty name
    JSON.stringify([['   ', 50]]),
    JSON.stringify([['!!!', 50]]),                   // punctuation only
    JSON.stringify([['x'.repeat(41), 50]]),          // oversized
    JSON.stringify(Array.from({ length: 21 }, (_, i) => [`t${i}`, 50])),  // too many
  ];
  for (const b of bad) assert.equal(normaliseContribution(b), null, `should have refused: ${b.slice(0, 40)}`);
});

/* ---------- merging ---------- */

const SHIPPED = { '1P6U1dCeHxPui5pIrGmndZ': [['electronic', 10]] };
const NEW_ID = '4Z8W4fKeB5YxbusRsdQVPb';
const contribution = (id, tags) => ({ id, tags: JSON.stringify(tags) });

test('a genuine gap is filled', () => {
  const { merged, added } = mergeContributions(SHIPPED, [contribution(NEW_ID, [['jungle', 90]])]);
  assert.deepEqual(added, [NEW_ID]);
  assert.deepEqual(merged[NEW_ID], [['jungle', 9]]);
});

test('an artist already in the table is never overwritten', () => {
  // This is what makes an unauthenticated write safe: the worst a bad
  // contribution can do is add an artist nobody had.
  const { merged, added, covered } = mergeContributions(SHIPPED,
    [contribution('1P6U1dCeHxPui5pIrGmndZ', [['polka', 100]])]);
  assert.deepEqual(added, []);
  assert.deepEqual(covered, ['1P6U1dCeHxPui5pIrGmndZ']);
  assert.deepEqual(merged['1P6U1dCeHxPui5pIrGmndZ'], [['electronic', 10]], 'the shipped answer stands');
});

test('the input table is not mutated', () => {
  const before = JSON.stringify(SHIPPED);
  mergeContributions(SHIPPED, [contribution(NEW_ID, [['jungle', 90]])]);
  assert.equal(JSON.stringify(SHIPPED), before);
});

test('a document id that is not a Spotify artist id is rejected', () => {
  for (const id of ['', 'short', '../../etc/passwd', 'x'.repeat(23), 'has-a-dash-in-it-here!!']) {
    const { added, rejected } = mergeContributions(SHIPPED, [contribution(id, [['jungle', 90]])]);
    assert.deepEqual(added, [], `should have rejected id: ${id}`);
    assert.equal(rejected[0].why, 'not a Spotify artist id');
  }
});

test('one bad contribution does not stop the good ones in the same batch', () => {
  const other = '0OdUWJ0sBjDrqHygGUXeCF';
  const { added, rejected } = mergeContributions(SHIPPED, [
    contribution(NEW_ID, [['jungle', 90]]),
    { id: other, tags: 'garbage' },
    contribution('3TVXtAsR1Inumwj472S9r4', [['hip hop', 70]]),
  ]);
  assert.deepEqual(added, [NEW_ID, '3TVXtAsR1Inumwj472S9r4']);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].id, other);
});

test('two contributions for the same new artist take the first, not the last', () => {
  const { merged, added, covered } = mergeContributions(SHIPPED, [
    contribution(NEW_ID, [['jungle', 90]]),
    contribution(NEW_ID, [['polka', 100]]),
  ]);
  assert.deepEqual(added, [NEW_ID]);
  assert.deepEqual(covered, [NEW_ID], 'the second is treated as already covered');
  assert.deepEqual(merged[NEW_ID], [['jungle', 9]]);
});

test('an empty batch changes nothing', () => {
  const { merged, added, covered, rejected } = mergeContributions(SHIPPED, []);
  assert.deepEqual(merged, SHIPPED);
  assert.deepEqual([added, covered, rejected], [[], [], []]);
});

test('what merges is exactly the shape the page expects to load', () => {
  // docs/tags.json is id -> [[tag, 0-10]], expanded by ten on load. A contributed
  // artist has to be indistinguishable from a shipped one.
  const { merged } = mergeContributions({}, [contribution(NEW_ID, [['jungle', 100], ['ragga', 30]])]);
  const entry = merged[NEW_ID];
  assert.ok(Array.isArray(entry));
  for (const pair of entry) {
    assert.equal(pair.length, 2);
    assert.equal(typeof pair[0], 'string');
    assert.equal(typeof pair[1], 'number');
    assert.ok(pair[1] >= 1 && pair[1] <= 10, `${pair[1]} is off the 0-10 scale`);
  }
});

/* ---------- pruning: deleting contributions this run already accounted for ----------
 * Firestore's rules deny delete to everyone, including this script's own
 * unauthenticated key — the whole point of the shared table's security model
 * is that nobody, this script included, can rewrite or erase a contribution
 * just by asking. Pruning therefore needs real service-account credentials,
 * exchanged for an access token the same way any Google Cloud client would. */

const { publicKey: TEST_PUBLIC, privateKey: TEST_PRIVATE } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});
const ACCOUNT = { client_email: 'bot@betterfy-1a983.iam.gserviceaccount.com', private_key: TEST_PRIVATE };

const decodePart = b64url => JSON.parse(Buffer.from(b64url, 'base64url').toString('utf8'));

test('the assertion is a JWT signed with the service account\'s own key', () => {
  const jwt = serviceAccountAssertion(ACCOUNT, Date.parse('2026-01-01T00:00:00Z'));
  const [header, claim, signature] = jwt.split('.');
  assert.deepEqual(decodePart(header), { alg: 'RS256', typ: 'JWT' });
  assert.deepEqual(decodePart(claim), {
    iss: ACCOUNT.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: 1767225600, exp: 1767229200,
  });
  const verified = createVerify('RSA-SHA256').update(`${header}.${claim}`)
    .verify(TEST_PUBLIC, Buffer.from(signature, 'base64url'));
  assert.ok(verified, 'must verify against the key that supposedly signed it');
});

test('the assertion is scoped to Firestore only, not the whole Google Cloud project', () => {
  // A leaked prune credential must not be a blank cheque against the project.
  const { scope } = decodePart(serviceAccountAssertion(ACCOUNT).split('.')[1]);
  assert.equal(scope, 'https://www.googleapis.com/auth/datastore');
});

test('a tampered claim no longer verifies against the same signature', () => {
  const jwt = serviceAccountAssertion(ACCOUNT);
  const [header, claim, signature] = jwt.split('.');
  const forged = Buffer.from(JSON.stringify({ ...decodePart(claim), scope: 'https://www.googleapis.com/auth/cloud-platform' }))
    .toString('base64url');
  const verified = createVerify('RSA-SHA256').update(`${header}.${forged}`)
    .verify(TEST_PUBLIC, Buffer.from(signature, 'base64url'));
  assert.equal(verified, false, 'widening the scope after signing must invalidate the signature');
});

test('pruning fetches a token once, then deletes each id with it', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), method: opts?.method, auth: opts?.headers?.authorization });
    if (String(url).includes('oauth2.googleapis.com')) return { ok: true, json: async () => ({ access_token: 'tok-123' }) };
    return { ok: true, json: async () => ({}) };
  };
  try {
    const { deleted, failed } = await pruneContributions('betterfy-1a983', ACCOUNT, ['a1', 'a2']);
    assert.equal(deleted, 2);
    assert.deepEqual(failed, []);
    const deletes = calls.filter(c => c.method === 'DELETE');
    assert.equal(deletes.length, 2);
    assert.ok(deletes.every(c => c.auth === 'Bearer tok-123'), 'every delete carries the fetched token');
    assert.ok(deletes[0].url.endsWith('/tagContributions/a1'));
    assert.ok(deletes[1].url.endsWith('/tagContributions/a2'));
  } finally { globalThis.fetch = realFetch; }
});

test('one failed delete does not stop the rest, and is reported rather than lost', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    if (String(url).includes('oauth2.googleapis.com')) return { ok: true, json: async () => ({ access_token: 'tok' }) };
    return { ok: !String(url).endsWith('/bad'), json: async () => ({}) };
  };
  try {
    const { deleted, failed } = await pruneContributions('p', ACCOUNT, ['good1', 'bad', 'good2']);
    assert.equal(deleted, 2);
    assert.deepEqual(failed, ['bad']);
  } finally { globalThis.fetch = realFetch; }
});

test('an empty id list never spends a token exchange', async () => {
  const realFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; return { ok: true, json: async () => ({}) }; };
  try {
    const result = await pruneContributions('p', ACCOUNT, []);
    assert.deepEqual(result, { deleted: 0, failed: [] });
    assert.equal(called, false);
  } finally { globalThis.fetch = realFetch; }
});
