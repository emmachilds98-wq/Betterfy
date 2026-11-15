/* ---------- the "More" sheet ---------- */
function openSheet(open) {
  const sheet = $('#moreSheet');
  sheet.classList.toggle('open', open);
  sheet.setAttribute('aria-hidden', String(!open));
  $('#scrim').classList.toggle('open', open);
  $('#tabMore').setAttribute('aria-expanded', String(open));
  routeNote();
}
const closeSheet = () => { if ($('#moreSheet').classList.contains('open')) openSheet(false); };

function initSheet() {
  // Cloned from the rail so the two lists can never disagree.
  const list = $('#sheetList');
  document.querySelectorAll('aside .nav[data-sec]').forEach(n => {
    const c = n.cloneNode(true);
    c.removeAttribute('data-sec');
    list.appendChild(c);
  });
  $('#tabMore').onclick = () => openSheet(!$('#moreSheet').classList.contains('open'));
  $('#sheetSettings').onclick = () => { closeSheet(); $('#btnSettings').click(); };
  $('#sheetDisconnect').onclick = () => { closeSheet(); $('#disconnect').click(); };

  // Drag either sheet down by its handle to dismiss it, the way every other
  // sheet on the phone behaves.
  for (const [el, close] of [[$('#moreSheet'), () => openSheet(false)],
                             [$('#settingsPanel'), () => $('#closeSettings').click()]]) {
    let y0 = 0, d = 0, on = false;
    const grab = el.querySelector('.grabber') ?? el;
    // Phone only: above the breakpoint the More sheet is centred with its own
    // translate, and writing a bare translateY here would throw it off-centre.
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
}

/* A hairline under the phone header once the content has scrolled beneath it. */
addEventListener('scroll', () => {
  const top = $('#mtop');
  if (top) top.classList.toggle('stuck', scrollY > 4);
}, { passive: true });

