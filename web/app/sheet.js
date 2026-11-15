/* ---------- sheet dragging ----------
 * The Settings sheet is the only sheet now (the More sheet went with the fifth
 * and later tabs, docs/BUILD-5-PLAN.md UI-D). On a phone it can be dragged down
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
