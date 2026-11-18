/* ---------- sheet dragging ----------
 * The Settings sheet is the only sheet now (the More sheet went with the fifth
 * and later tabs, docs/archive/BUILD-5-PLAN.md UI-D). On a phone it can be dragged down
 * by its handle to dismiss it, the way every other sheet on the phone behaves. */
function initSheet() {
  const el = $('#settingsPanel'), close = () => $('#closeSettings').click();
  let y0 = 0, d = 0, on = false;
  const grab = el.querySelector('.grabber') ?? el;
  grab.addEventListener('touchstart', e => {
    if (!isPhone()) return;
    on = true; d = 0; y0 = e.touches[0].clientY; el.style.transition = 'none';
  }, { passive: true });
  grab.addEventListener('touchmove', e => {
    if (!on) return;
    d = Math.max(0, e.touches[0].clientY - y0);
    el.style.transform = `translateY(${d}px)`;
  }, { passive: true });
  grab.addEventListener('touchend', () => {
    if (!on) return;
    on = false; el.style.transition = ''; el.style.transform = '';
    if (d > 70) close();
  });
}

/* A hairline under the phone header once the content has scrolled beneath it. */
addEventListener('scroll', () => {
  const top = $('#mtop');
  if (top) top.classList.toggle('stuck', scrollY > 4);
}, { passive: true });

/* ---------- the small info sheet and the one Last.fm connect sheet (UI-F) ----------
 * Both are a native <dialog>, made on first use: ⓘ opens "how this works" for
 * the screen it sits on, and a [data-lfmconnect] button opens the single place
 * a Last.fm key is pasted (Sources and Discover used to have a box each). */
function infoDialog(title, html) {
  let d = $('#infoSheet');
  if (!d) {
    d = document.createElement('dialog');
    d.id = 'infoSheet'; d.className = 'infosheet';
    d.addEventListener('click', e => { if (e.target === d || e.target.closest('[data-infoclose]')) d.close(); });
    document.body.appendChild(d);
  }
  d.setAttribute('aria-label', title);
  d.innerHTML = `<h2>${esc(title)}</h2><div class="infobody">${html}</div>
    <div class="rowbtns"><button class="b sm" type="button" data-infoclose>Close</button></div>`;
  if (!d.open) d.showModal();
  return d;
}

/** Save (or clear) the Last.fm key from the connect sheet, then carry on where the person was. */
function lfmSaveKey(v) {
  v = (v ?? '').trim();
  if (v) LS.setItem('bf_lfm', v); else LS.removeItem('bf_lfm');
  $('#infoSheet')?.close();
  if (v && view === 'discover') { toast('Key saved — finding new music…'); return runDiscovery(S.discSeed || null); }
  toast(v ? 'Key saved.' : 'Key cleared.');
  render(); if (typeof underHoodRefresh === 'function') underHoodRefresh();
}
function lfmConnect() {
  const own = LS.getItem('bf_lfm') || '';
  const d = infoDialog('Connect Last.fm', `<p>A free Last.fm key adds crowd genre tags and similar artists. It is saved on this device only${
      !own && lfmKey() ? ', and replaces Betterfy’s shared key' : ''}.</p>
    <div class="rowbtns"><input id="lfmKey" placeholder="Last.fm API key" size="30" value="${esc(own)}" aria-label="Last.fm API key" autocomplete="off">
      <button class="b p" id="saveLfm" type="button">Save key</button>
      <a class="b sm" href="https://www.last.fm/api/account/create" target="_blank" rel="noopener">Get a key</a></div>`);
  d.querySelector('#saveLfm').onclick = () => lfmSaveKey(d.querySelector('#lfmKey').value);
  d.querySelector('#lfmKey').addEventListener('keydown', e => { if (e.key === 'Enter') lfmSaveKey(e.target.value); });
}

addEventListener('click', e => {
  const i = e.target.closest?.('[data-info]');
  if (i) { e.preventDefault(); e.stopPropagation(); const n = INFO[i.dataset.info]; if (n) infoDialog(n.title, n.html); return; }
  if (e.target.closest?.('[data-lfmconnect]')) lfmConnect();
}, true);

/* `?` shows the keyboard hint on File, on a desktop with a real pointer only; it never exists on touch. */
document.addEventListener('keydown', e => {
  if (e.key !== '?' || e.target.matches?.('input,select,textarea') || !matchMedia('(hover:hover) and (pointer:fine)').matches) return;
  document.body.classList.toggle('showkeys');
});
