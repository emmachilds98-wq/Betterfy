// Spotify API client: auto-refreshing token + paginated GET helper.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { env } from './env.mjs';

const TOKENS = new URL('.tokens.json', import.meta.url);

function load() {
  if (!existsSync(TOKENS)) {
    throw new Error('Not authorized yet — run: node auth.mjs');
  }
  return JSON.parse(readFileSync(TOKENS, 'utf8'));
}

async function accessToken() {
  const tok = load();
  if (tok.expires_at && Date.now() < tok.expires_at - 60_000) return tok.access_token;

  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: 'Basic ' + Buffer.from(
        `${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`
      ).toString('base64'),
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tok.refresh_token }),
  });
  const fresh = await r.json();
  if (!r.ok) throw new Error('Refresh failed: ' + JSON.stringify(fresh));

  const merged = { ...tok, ...fresh, expires_at: Date.now() + fresh.expires_in * 1000 };
  writeFileSync(TOKENS, JSON.stringify(merged, null, 2));
  return merged.access_token;
}

// Single request, with retry on 429 (Spotify sends Retry-After in seconds).
export async function api(path, opts = {}) {
  const url = path.startsWith('http') ? path : `https://api.spotify.com/v1${path}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      ...opts,
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'content-type': 'application/json',
        ...opts.headers,
      },
    });

    if (res.status === 429 && attempt < 5) {
      const wait = (Number(res.headers.get('retry-after')) || 2) * 1000;
      console.error(`  rate limited, waiting ${wait / 1000}s`);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    if (res.status === 204) return null;
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${res.status} ${url}\n${JSON.stringify(body)}`);
    return body;
  }
}

// Follow `next` links until exhausted.
export async function paged(path, key = null) {
  const out = [];
  let page = await api(path);
  while (page) {
    const box = key ? page[key] : page;
    out.push(...(box.items ?? []));
    if (!box.next) break;
    page = await api(box.next);
  }
  return out;
}
