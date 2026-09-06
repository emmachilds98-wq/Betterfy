import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// The Discover card drives the listener's own Spotify device over the Connect
// API — the Web Playback SDK does not run on iOS — and mirrors its position
// back into a scrubber. Spotify is polled every few seconds and the bar is
// ticked locally in between, so these tests cover the seam between the two:
// what the tick may do on its own, and what a poll must not undo.

const BUNDLE = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');

function slice() {
  const from = BUNDLE.indexOf('const ICON_PLAY');
  const to = BUNDLE.indexOf('async function playTrack(id)');
  assert.ok(from > 0 && to > from, 'player block not found — rebuild with npm run build:web');
  return BUNDLE.slice(from, to);
}

/** The handful of elements the player paints into. */
function fakeDom() {
  const mk = () => ({ textContent: '', value: '', innerHTML: '', max: '', disabled: false,
    attrs: {}, setAttribute(k, v) { this.attrs[k] = v; },
    // The elapsed fill is painted through a custom property on the element.
    css: {}, style: { setProperty(k, v) { this.owner.css[k] = v; } } });
  const els = { '#seek': mk(), '#pTime': mk(), '#pDur': mk(), '#pToggle': mk(), '#pDev': mk() };
  for (const el of Object.values(els)) el.style.owner = el;
  return { els, $: sel => els[sel] ?? null };
}

function load(answer, card = { id: 't1', dur: 200000 }) {
  const dom = fakeDom();
  const calls = [];
  const sandbox = {
    $: dom.$,
    mmss: ms => ms == null ? '—' : `${Math.floor(ms / 60000)}:${String(Math.round(ms % 60000 / 1000)).padStart(2, '0')}`,
    toast: msg => calls.push({ toast: msg }),
    sp: async (path, opts) => {
      calls.push({ path, method: opts?.method ?? 'GET' });
      if (typeof answer === 'function') return answer(path, opts);
      return path === '/me/player' ? answer : null;
    },
    // The card the transport belongs to; the real one lives further down the
    // bundle, in the Discover view.
    discAt: () => card,
    playTrack: async () => "Emma's iPhone",
    setInterval, clearInterval, setTimeout, console,
  };
  vm.createContext(sandbox);
  vm.runInContext(slice(), sandbox);
  // PLAYER is a const inside the script's own scope, so it is reached through
  // the context rather than as a property of the sandbox.
  return Object.assign(sandbox, { dom, calls, gets: p => calls.filter(c => c.path === p).length,
    state: () => vm.runInContext('PLAYER', sandbox) });
}

const NOW = { item: { id: 't1', duration_ms: 200000 }, progress_ms: 30000,
              is_playing: true, device: { name: "Emma's iPhone" } };

test('a poll paints the position, the length and the device', async () => {
  const app = load(NOW);
  await app.playerPoll();
  assert.equal(app.dom.els['#pTime'].textContent, '0:30');
  assert.equal(app.dom.els['#pDur'].textContent, '3:20');
  assert.equal(app.dom.els['#seek'].value, '30000');
  assert.equal(app.dom.els['#seek'].max, '200000');
  assert.match(app.dom.els['#pDev'].textContent, /playing on Emma's iPhone/);
  assert.equal(app.dom.els['#seek'].disabled, false);
});

test('the scrubber fills in as far as the track has played', async () => {
  // Otherwise how far in you are is readable only from where the thumb sits.
  const app = load(NOW);          // 30s into 200s
  await app.playerPoll();
  assert.equal(app.dom.els['#seek'].css['--p'], '15.00%');
});

test('a track of unknown length fills nothing rather than dividing by zero', async () => {
  const app = load({ ...NOW, item: { id: 't1', duration_ms: 0 }, progress_ms: 0 });
  await app.playerPoll();
  assert.equal(app.dom.els['#seek'].css['--p'], '0.00%');
});

test('nothing playing anywhere is a quiet not-playing, not an error', async () => {
  const app = load(null);   // sp() returns null for a 204
  await app.playerPoll();
  assert.equal(app.state().playing, false);
  assert.equal(app.dom.els['#pDev'].textContent, '');
});

test('the button shows pause while playing and play while paused', async () => {
  const app = load(NOW);
  await app.playerPoll();
  assert.match(app.dom.els['#pToggle'].innerHTML, /M7 5h3.4v14H7/, 'a playing track offers pause');
  assert.equal(app.dom.els['#pToggle'].attrs['aria-label'], 'Pause');

  const paused = load({ ...NOW, is_playing: false });
  await paused.playerPoll();
  assert.equal(paused.dom.els['#pToggle'].attrs['aria-label'], 'Play');
});

test('the toggle pauses a playing track and resumes a paused one', async () => {
  const app = load(NOW);
  await app.playerPoll();
  await app.playerToggle();
  assert.deepEqual(app.calls.at(-1), { path: '/me/player/pause', method: 'PUT' });
  assert.equal(app.state().playing, false);

  await app.playerToggle();
  assert.deepEqual(app.calls.at(-1), { path: '/me/player/play', method: 'PUT' });
  assert.equal(app.state().playing, true);
});

test('seeking asks Spotify for that exact position', async () => {
  const app = load(NOW);
  await app.playerPoll();
  await app.playerSeek(95500);
  assert.deepEqual(app.calls.at(-1), { path: '/me/player/seek?position_ms=95500', method: 'PUT' });
  assert.equal(app.state().pos, 95500);
  assert.equal(app.dom.els['#pTime'].textContent, '1:36');
});

test('a poll landing mid-drag does not yank the thumb out of your hand', async () => {
  const app = load(NOW);
  await app.playerPoll();
  app.state().scrub = true;
  app.dom.els['#seek'].value = '150000';       // the thumb, held by the listener
  await app.playerPoll();                      // Spotify still reports 30s
  assert.equal(app.dom.els['#seek'].value, '150000', 'the held thumb stays put');
  assert.equal(app.state().pos, 30000, 'and the real position is still tracked underneath');
});

test('the bar ticks along on its own, without asking Spotify every second', async () => {
  const app = load(NOW);
  await app.playerPoll();
  const before = app.gets('/me/player');
  app.playerRun();
  await new Promise(r => setTimeout(r, 1100));
  app.playerStop();
  assert.ok(app.state().pos > 30000, `position advanced (${app.state().pos}ms)`);
  assert.equal(app.gets('/me/player'), before, 'a second of ticking costs no requests');
});

test('the tick stops at the end of the track rather than running past it', async () => {
  const app = load({ ...NOW, progress_ms: 199800 });
  await app.playerPoll();
  app.playerRun();
  await new Promise(r => setTimeout(r, 800));
  app.playerStop();
  assert.equal(app.state().pos, 200000, 'clamped to the duration');
});

test('the ticker gives up once the card is off screen', async () => {
  const app = load(NOW);
  await app.playerPoll();
  app.playerRun();
  assert.ok(app.state().timer, 'running while the card is up');
  delete app.dom.els['#seek'];                 // navigated away
  await new Promise(r => setTimeout(r, 400));
  assert.equal(app.state().timer, null, 'no timer left polling Spotify in the background');
});

test('play on a card the device is not on starts that track', async () => {
  // Otherwise Spotify resumes whatever was last playing, which is not the
  // track whose cover you are looking at.
  const app = load({ ...NOW, item: { id: 'something-else', duration_ms: 100000 }, is_playing: false },
                   { id: 't2', dur: 181000 });
  await app.playerPoll();
  await app.playerToggle();
  assert.equal(app.state().id, 't2', 'the card track is what plays');
  assert.equal(app.state().dur, 181000);
  assert.equal(app.state().playing, true);
  assert.ok(!app.calls.some(c => c.path === '/me/player/play'), 'no blind resume');
  app.playerStop();
});

test('a failed transport call says so instead of lying about the state', async () => {
  const app = load((path) => { if (path.startsWith('/me/player/')) throw new Error('No active device'); return NOW; });
  await app.playerPoll();
  app.state().id = 't1';
  await app.playerToggle();
  assert.deepEqual(app.calls.at(-1), { toast: 'No active device' });
  assert.equal(app.state().playing, true, 'still playing — the pause never landed');
});

/* ---------- playing from a screen that has no player on it ---------- */

// Misfiles and the other list screens have a plain Play button and nowhere to
// show a transport. That path used to read the Discover card's track to find a
// duration, so on any other screen it silently did nothing at all.

test('Play works on a screen with no player, and says where it went', async () => {
  const app = load(NOW);
  delete app.dom.els['#seek'];                 // a list screen: no transport
  vm.runInContext('discAt = () => null', app);  // and no discovery loaded
  await app.playFrom('t7', 181000);
  assert.equal(app.state().id, 't7');
  assert.equal(app.state().dur, 181000, 'the row passes the length it knows');
  assert.equal(app.state().playing, true);
  assert.deepEqual(app.calls.at(-1), { toast: "Playing on Emma's iPhone" });
  app.playerStop();
});

test('a row that does not know the length still plays, and the poll fills it in', async () => {
  const app = load(NOW);
  await app.playFrom('t1');
  assert.equal(app.state().dur, 0, 'nothing claimed up front');
  await app.playerPoll();
  assert.equal(app.state().dur, 200000, 'and Spotify supplies it');
  app.playerStop();
});

test('a device that refuses is reported, not swallowed', async () => {
  const app = load(NOW);
  vm.runInContext('playTrack = async () => { throw new Error("No open Spotify device"); }', app);
  await app.playFrom('t1', 1000);
  assert.deepEqual(app.calls.at(-1), { toast: 'No open Spotify device' });
});
