// One-time Spotify OAuth. Run: node auth.mjs
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { env } from './env.mjs';

const SCOPES = [
  'playlist-read-private',
  'playlist-read-collaborative',
  'playlist-modify-private',
  'playlist-modify-public',
  'user-library-read',
  'user-library-modify',
  'user-top-read',
  'user-read-recently-played',
  'user-read-private',
  'user-follow-read',
  'user-read-playback-state',
  'user-modify-playback-state',
].join(' ');

const state = Math.random().toString(36).slice(2);
const authUrl = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
  response_type: 'code',
  client_id: env.SPOTIFY_CLIENT_ID,
  scope: SCOPES,
  redirect_uri: env.SPOTIFY_REDIRECT_URI,
  state,
});

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:8888');
  if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }

  const err = url.searchParams.get('error');
  if (err) {
    res.writeHead(200, { 'content-type': 'text/html' }).end(`<h2>Denied: ${err}</h2>`);
    console.error('Authorization denied:', err);
    server.close();
    process.exit(1);
  }
  // A stale callback tab (from an earlier run) can re-fire on reload. Ignore it
  // and keep waiting for the real one rather than tearing the server down.
  if (url.searchParams.get('state') !== state) {
    res.writeHead(400, { 'content-type': 'text/html' })
       .end('<h2>Stale tab</h2><p>This is an old authorization tab. Close it and use the new link.</p>');
    console.error('  (ignored a stale callback — still waiting for the current one)');
    return;
  }

  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: 'Basic ' + Buffer.from(
        `${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`
      ).toString('base64'),
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: url.searchParams.get('code'),
      redirect_uri: env.SPOTIFY_REDIRECT_URI,
    }),
  });

  const tok = await r.json();
  if (!r.ok) {
    res.writeHead(500, { 'content-type': 'text/html' })
       .end(`<h2>Token exchange failed</h2><pre>${JSON.stringify(tok, null, 2)}</pre>`);
    console.error('Token exchange failed:', tok);
    server.close();
    process.exit(1);
  }

  tok.expires_at = Date.now() + tok.expires_in * 1000;
  writeFileSync(new URL('.tokens.json', import.meta.url), JSON.stringify(tok, null, 2));
  res.writeHead(200, { 'content-type': 'text/html' })
     .end('<h2>Connected.</h2><p>You can close this tab and go back to Claude.</p>');
  console.log('\n  Authorized. Tokens saved to .tokens.json\n');
  res.on('finish', () => server.close(() => process.exit(0)));
});

server.listen(8888, '127.0.0.1', () => {
  console.log('\n  Opening Spotify authorization in your browser...');
  console.log('  If it does not open, paste this URL:\n');
  console.log('  ' + authUrl + '\n');
  spawn('cmd', ['/c', 'start', '""', authUrl.replace(/&/g, '^&')], { shell: true, detached: true });
});
