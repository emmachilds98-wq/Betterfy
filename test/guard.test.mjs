// These are the checks standing between a hand-curated library and any web
// page that happens to be open in the same browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refuse } from '../guard.mjs';

const PORT = 8787;
const req = (headers = {}, method = 'GET') => ({ method, headers });

test('the app talking to itself is allowed', () => {
  assert.equal(refuse(req({ host: '127.0.0.1:8787', origin: 'http://127.0.0.1:8787', 'sec-fetch-site': 'same-origin' }), PORT), null);
  assert.equal(refuse(req({ host: 'betterfy.localhost:8787', 'sec-fetch-site': 'same-origin' }), PORT), null);
  assert.equal(refuse(req({ host: 'localhost:8787' }), PORT), null);
});

test('a typed-in address with no Origin is allowed', () => {
  assert.equal(refuse(req({ host: '127.0.0.1:8787', 'sec-fetch-site': 'none' }), PORT), null);
});

test('a rebound DNS name pointing at loopback is refused', () => {
  // The whole point of the attack: their domain, our address.
  const r = refuse(req({ host: 'evil.example.com:8787', 'sec-fetch-site': 'same-origin' }), PORT);
  assert.match(r, /Host/);
});

test('the port must match too', () => {
  assert.match(refuse(req({ host: '127.0.0.1:9999' }), PORT), /Host/);
});

test('a request from another site is refused', () => {
  assert.match(refuse(req({ host: '127.0.0.1:8787', origin: 'https://evil.example.com' }), PORT), /cross-origin/);
  assert.match(refuse(req({ host: '127.0.0.1:8787', 'sec-fetch-site': 'cross-site' }), PORT), /cross-site/);
  assert.match(refuse(req({ host: '127.0.0.1:8787', 'sec-fetch-site': 'same-site' }), PORT), /cross-site/);
});

test('a form post cannot reach a write route', () => {
  // This is the actual v1 hole: a simple request, no preflight, tracks gone.
  for (const ct of ['application/x-www-form-urlencoded', 'text/plain', 'multipart/form-data', '']) {
    const r = refuse(req({ host: '127.0.0.1:8787', 'content-type': ct }, 'POST'), PORT);
    assert.match(r, /application\/json/, `content-type ${ct || '(absent)'} must be refused`);
  }
});

test('a genuine JSON write is allowed', () => {
  assert.equal(refuse(req({
    host: '127.0.0.1:8787', origin: 'http://127.0.0.1:8787',
    'sec-fetch-site': 'same-origin', 'content-type': 'application/json',
  }, 'POST'), PORT), null);
  // charset parameters are normal and must not be rejected
  assert.equal(refuse(req({ host: '127.0.0.1:8787', 'content-type': 'application/json; charset=utf-8' }, 'POST'), PORT), null);
});

test('a cross-origin JSON write is still refused', () => {
  assert.match(refuse(req({
    host: '127.0.0.1:8787', origin: 'https://evil.example.com', 'content-type': 'application/json',
  }, 'POST'), PORT), /cross-origin/);
});

test('a missing Host header is refused', () => {
  assert.match(refuse(req({}), PORT), /Host/);
});
