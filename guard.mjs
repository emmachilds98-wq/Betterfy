// Who is allowed to talk to the local server.
//
// The server holds live Spotify credentials on a predictable loopback port, so
// without these checks any page open in the browser could drive it: a plain
// form post to /api/remove is a "simple request", which browsers send
// cross-origin with no preflight and no way for the page to read the reply —
// but the tracks are gone all the same.
//
// Kept separate from server.mjs so it can be tested without binding a port.

export const allowedHosts = port =>
  ['127.0.0.1', 'localhost', 'betterfy.localhost'].map(h => `${h}:${port}`);

/**
 * Returns a reason to refuse the request, or null to allow it.
 *
 * Host: closes DNS rebinding, where a name the attacker controls resolves to
 *   127.0.0.1 so their page counts as same-origin.
 * Origin / Sec-Fetch-Site: refuse anything a browser tells us came from
 *   elsewhere. Both are set by the browser and cannot be forged by script.
 * Content type on writes: application/json cannot be sent by a form post, so
 *   a cross-site write has to preflight — which the checks above then fail.
 */
export function refuse(req, port) {
  const hosts = allowedHosts(port);
  if (!hosts.includes(req.headers.host ?? '')) return 'unrecognised Host header';

  const origin = req.headers.origin;
  if (origin && !hosts.some(h => origin === `http://${h}`)) return 'cross-origin request';

  // "none" is a direct navigation; absent means a non-browser client such as curl.
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return 'cross-site request';

  if (req.method !== 'GET' && !/^application\/json\b/.test(req.headers['content-type'] ?? ''))
    return 'writes must be application/json';

  return null;
}
