/* ---------- player: Spotify Connect ----------
 * The Web Playback SDK does not run on iOS, so the card drives whatever device
 * the listener already has open — their phone's Spotify app, usually — and
 * mirrors its position back. Spotify is asked where it is every few seconds
 * and the bar is ticked locally in between, so the scrubber moves smoothly
 * without spending a request a second to do it.
 */
const ICON_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5h3.4v14H7zm6.6 0H17v14h-3.4z"/></svg>';
const PLAYER = { id:null, name:'', pos:0, dur:0, playing:false, device:'', scrub:false,
                 timer:null, lastPoll:0, busy:false };

/**
 * The bar belongs to the track on the card. After Next the card shows a new
 * track while the device carries on with the old one, so the bar shows that
 * card's track not started (▶, 0:00, its length) and one quiet line says what
 * is still playing. Then ▶ plays the card, and the line clears.
 */
function playerPaint() {
  const seek = $('#seek'); if (!seek) return;
  const card = typeof discAt === 'function' ? discAt() : null;
  const mine = !card || !PLAYER.id || PLAYER.id === card.id;
  const playing = mine && PLAYER.playing;
  const dur = (mine ? PLAYER.dur : 0) || card?.dur || 0;
  const pos = mine ? PLAYER.pos : 0;
  seek.max = String(dur);
  seek.disabled = !PLAYER.id || !mine;
  if (!PLAYER.scrub || !mine) seek.value = String(Math.min(pos, dur));
  seek.style.setProperty('--p', (dur ? Math.min(100, +seek.value / dur * 100) : 0).toFixed(2) + '%');
  $('#pTime').textContent = mmss(pos);
  $('#pDur').textContent = mmss(dur || null);
  const btn = $('#pToggle');
  btn.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
  btn.setAttribute('aria-label', playing ? 'Pause' : mine ? 'Play' : 'Play this track');
  $('#pDev').textContent = !PLAYER.device ? ''
    : mine ? (PLAYER.playing ? 'playing on ' : 'paused on ') + PLAYER.device
    : PLAYER.playing ? `still playing ${PLAYER.name || 'the last track'} on ${PLAYER.device} · ▶ plays this one` : '';
}

async function playerPoll() {
  if (PLAYER.busy) return;
  PLAYER.busy = true;
  PLAYER.lastPoll = Date.now();
  try {
    const p = await sp('/me/player');
    if (p?.item) {
      PLAYER.id = p.item.id;
      PLAYER.name = p.item.name ?? '';
      PLAYER.dur = p.item.duration_ms ?? 0;
      if (!PLAYER.scrub) PLAYER.pos = p.progress_ms ?? 0;
      PLAYER.playing = !!p.is_playing;
      PLAYER.device = p.device?.name ?? '';
    } else PLAYER.playing = false;   // 204: nothing is playing anywhere
  } catch {} finally { PLAYER.busy = false; }
  playerPaint();
}

function playerStop() { clearInterval(PLAYER.timer); PLAYER.timer = null; }

/** Tick the bar locally, and ask Spotify where it really is every four seconds. */
function playerRun() {
  playerStop();
  PLAYER.timer = setInterval(() => {
    if (!$('#seek')) return playerStop();          // the card is off screen
    if (PLAYER.playing && !PLAYER.scrub) {
      PLAYER.pos = PLAYER.dur ? Math.min(PLAYER.pos + 250, PLAYER.dur) : PLAYER.pos + 250;
      playerPaint();
    }
    // Four seconds while something is moving; a slow heartbeat when it is not,
    // so a card left open on screen does not quietly spend the rate budget.
    if (Date.now() - PLAYER.lastPoll > (PLAYER.playing ? 4000 : 15000)) playerPoll();
  }, 250);
  if (Date.now() - PLAYER.lastPoll > 4000) playerPoll(); else playerPaint();
}

async function playerToggle() {
  // Play on a card the device is not already on means "play this", not
  // "resume whatever was last playing" — which is what Spotify would do.
  const t = typeof discAt === 'function' ? discAt() : null;
  if (t && PLAYER.id !== t.id) return playFrom(t.id, t.dur ?? 0);
  try {
    await sp('/me/player/' + (PLAYER.playing ? 'pause' : 'play'), { method:'PUT' });
    PLAYER.playing = !PLAYER.playing;
    playerPaint();
    PLAYER.lastPoll = 0;                            // confirm it on the next tick
  } catch (e) { toast(e.message); }
}

async function playerSeek(ms) {
  try {
    await sp(`/me/player/seek?position_ms=${Math.round(ms)}`, { method:'PUT' });
    PLAYER.pos = ms;
    playerPaint();
    PLAYER.lastPoll = 0;
  } catch (e) { toast(e.message); }
}

/**
 * Start a track on the listener's device and follow it from there. Called from
 * the Discover card, which knows the length up front, and from the plain rows
 * on Misfiles, which do not — there the first poll fills it in. Screens with no
 * player on them say where it went instead, since nothing on screen would.
 */
async function playFrom(id, dur = 0) {
  try {
    const device = await playTrack(id);
    const card = typeof discAt === 'function' ? discAt() : null;
    const name = card?.id === id ? card.track ?? '' : '';
    Object.assign(PLAYER, { id, name, device, dur, pos:0, playing:true, lastPoll:Date.now() });
    if ($('#seek')) {
      playerPaint();
      playerRun();
      setTimeout(() => { PLAYER.lastPoll = 0; }, 800);   // let Spotify settle, then confirm
    } else toast('Playing on ' + device);
  } catch (e) { toast(e.message); }
}

async function playTrack(id) {
  const d = await sp('/me/player/devices');
  const dev = (d.devices??[]).find(x=>x.is_active) ?? (d.devices??[])[0];
  if (!dev) throw new Error('No open Spotify device — open Spotify and try again.');
  await sp(`/me/player/play?device_id=${dev.id}`, { method:'PUT', body:JSON.stringify({ uris:['spotify:track:'+id] }) });
  return dev.name;
}


