/* ---------- the listening indicator (docs/UI-BUILD-PLAN.md §2.5) ----------
 * The chrome owns the slot; listenPill() (web/ui/sound.mjs) owns what is in it;
 * the audio build owns the state and hands it over as a plain ListenVM through
 * setListen(). Nothing here reads an AudioRecord or knows how listening works.
 * With no ListenVM the slot stays empty and Home keeps its four cards. */
let LISTEN = null;
const HEARD_HUE = 'm2';
/** Where a tap on the indicator or the Heard card goes: Sources → Listening once
 *  that screen exists (UI-3), Playlists until then. */
const listenTarget = () => (typeof VIEWS !== 'undefined' && VIEWS.sources) ? 'sources' : 'lists';
/** Tracks heard so far, all runs together: B2's ListenVM counts them as `heard`
 *  (`done` restarts with every run), and a bare ListenVM falls back to `done`. */
const listenHeard = () => LISTEN ? (LISTEN.heard ?? LISTEN.done ?? 0) : 0;
/** Ever run: something heard, or a run going or finished. Switched on but
 *  paused before the first track (no Wi-Fi yet) is not "ran". */
const listenEverRan = () => !!LISTEN && (listenHeard() > 0 || LISTEN.state === 'running' || LISTEN.state === 'done');

/** The one entry point for the audio side: call with a ListenVM, or null to clear. */
function setListen(vm) {
  const had = listenEverRan();
  LISTEN = vm ?? null;
  paintListen();
  if (typeof view === 'undefined' || view !== 'home' || !$('#main')) return;
  // Only a card appearing or going re-draws Home; a count ticking up while
  // listening runs updates in place, so the cards don't replay their entrance.
  if (had !== listenEverRan()) return render();
  const n = $('#main .act[data-heard] .n');
  if (n) n.textContent = listenHeard().toLocaleString();
}

function paintListen() {
  const slot = $('#listenSlot');
  if (!slot) return;
  const html = LISTEN ? listenPill(LISTEN) : '';
  slot.innerHTML = html;
  if (html) {
    slot.setAttribute('role', 'button'); slot.tabIndex = 0;
    slot.setAttribute('aria-label', 'Listening status — open Listening settings');
  } else {
    slot.removeAttribute('role'); slot.removeAttribute('tabindex'); slot.removeAttribute('aria-label');
  }
}
{
  const slot = document.getElementById('listenSlot');
  const open = () => { if (slot.childElementCount || slot.textContent.trim()) go(listenTarget()); };
  slot?.addEventListener('click', open);
  slot?.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
}

/** A stable hue per track, for the tile shown when there's no artwork. */
const hueOf = id => { let h = 0; for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };

/** A row-sized cover. Same fallback as the cards, so a library synced before
 *  artwork was stored still reads as a list of distinct things. */
function thumbHTML(t) {
  if (t.art) return `<img class="thumb" src="${esc(t.art)}" alt="" loading="lazy" decoding="async">`;
  const h = hueOf(t.id ?? t.title ?? '');
  return `<div class="thumb ph" aria-hidden="true" style="background:linear-gradient(150deg,hsl(${h} 62% 56%),hsl(${(h+48)%360} 58% 44%))">${esc((t.title||'?').trim()[0]??'?')}</div>`;
}

function artHTML(t, hook = 'data-act="play"') {
  if (t.art) return `<img class="art" src="${esc(t.art)}" alt="" ${hook} title="Play" loading="lazy" decoding="async">`;
  const h = hueOf(t.id);
  return `<div class="art ph" ${hook} title="Play" style="background:linear-gradient(150deg,hsl(${h} 62% 56%),hsl(${(h+48)%360} 58% 44%))">${esc((t.title||'?').trim()[0]??'?')}</div>`;
}

