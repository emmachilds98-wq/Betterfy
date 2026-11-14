// Generate test/fixtures/synth-stereo-44k.mp3, the MP3 core/audio/decode.mjs
// is checked against in test/audiodecode.test.mjs.
//
//   node scripts/audio-dsp/make-decode-fixture.mjs        (needs ffmpeg with libmp3lame)
//
// The signal is test/mel.test.mjs's synth() — sweep plus LCG noise — but
// sampled at 44.1 kHz, which is what Deezer previews are, so the browser has
// to do a real 44.1 → 16 kHz resample with anti-aliasing (the noise runs to
// 22 kHz, and the sweep crosses 8 kHz). Stereo, with a different noise seed
// per channel, so a decoder that kept one channel instead of averaging both
// shows up. LAME at 64 kbps keeps it to ~32 KB; nothing recorded is committed.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const FIXTURE_RATE = 44100;
export const FIXTURE_SECONDS = 4;

/** synth() from test/mel.test.mjs, with the sample rate and LCG seed as parameters. */
export function synth(n, rate = 16000, seed = 12345n) {
  const out = new Float32Array(n);
  let state = seed;
  for (let i = 0; i < n; i++) {
    state = (state * 1664525n + 1013904223n) % 4294967296n;
    const u = Number(state) / 4294967296 - 0.5;
    const t = i / rate;
    out[i] = 0.5 * Math.sin(2 * Math.PI * (100 + 1500 * t) * t) + 0.2 * u;
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const n = FIXTURE_RATE * FIXTURE_SECONDS;
  const l = synth(n, FIXTURE_RATE, 12345n), r = synth(n, FIXTURE_RATE, 54321n);
  const pcm = new Float32Array(2 * n);
  for (let i = 0; i < n; i++) { pcm[2 * i] = l[i]; pcm[2 * i + 1] = r[i]; }
  const out = fileURLToPath(new URL('../../test/fixtures/synth-stereo-44k.mp3', import.meta.url));
  const res = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'f32le', '-ar', String(FIXTURE_RATE), '-ac', '2', '-i', 'pipe:0',
    '-c:a', 'libmp3lame', '-b:a', '64k', '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact', out],
  { input: Buffer.from(pcm.buffer) });
  if (res.status !== 0) { console.error(String(res.stderr)); process.exit(1); }
  console.log('wrote', out);
}
