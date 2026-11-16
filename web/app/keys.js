/* Keyboard paths beyond File (BUILD-6 A1 / D7). inbox-actions.js keeps File's own keys and
 * the left/right tab walk; this adds, for anyone not using a pointer:
 *   Up/Down (or k/j)  move between rows on Tidy and Library
 *   1 2 3 / N / B     Discover: file under suggestion 1-3 (best first), next, back
 *   Tab               stays inside an open sheet; Esc closes it (the sheets' own handlers)
 * Rows are native buttons, so Enter and Space act with no code here. After a keyboard
 * action repaints Tidy, focus lands on the neighbouring row instead of falling to <body>. */
(() => {
  const typing = t => t?.matches?.('input,select,textarea,[contenteditable]');
  const sheetOpen = () => document.querySelector('#settingsPanel.open, #plSheet.open, dialog[open]');
  const rowsOf = () => [...document.querySelectorAll('#main .row:not(.done), #main .plrow')].filter(r => r.offsetParent);
  const primary = r => r.matches('.plrow') ? r : r.querySelector('.acts button:not([disabled]), button:not([disabled])');

  document.addEventListener('keydown', e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // Keep Tab inside whichever sheet is open.
    if (e.key === 'Tab') {
      const dlg = document.querySelector('dialog[open]') || document.querySelector('#plSheet.open') || document.querySelector('#settingsPanel.open');
      if (!dlg) return;
      const f = [...dlg.querySelectorAll('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])')].filter(x => !x.disabled && x.offsetParent);
      if (!f.length) return;
      const i = f.indexOf(document.activeElement);
      if (i === -1 || (e.shiftKey && i === 0) || (!e.shiftKey && i === f.length - 1)) { e.preventDefault(); f[e.shiftKey ? f.length - 1 : 0].focus(); }
      return;
    }
    if ($('#app').hidden || typing(e.target) || sheetOpen()) return;
    if (view === 'discover') {
      const k = e.key.toLowerCase();
      const btn = k === 'n' ? document.querySelector('[data-act="dnav"][data-dnav="1"]')
        : k === 'b' ? document.querySelector('[data-act="dnav"][data-dnav="-1"]')
        : ['1', '2', '3'].includes(k) ? [...document.querySelectorAll('#main [data-act="dfile"]')][+k - 1] : null;
      if (btn && !btn.disabled) { e.preventDefault(); btn.click(); return; }
    }
    if (!['ArrowUp', 'ArrowDown', 'j', 'k'].includes(e.key) || (view !== 'tidy' && view !== 'lists')) return;
    const rows = rowsOf(); if (!rows.length) return;
    const dir = e.key === 'ArrowDown' || e.key === 'j' ? 1 : -1;
    const at = rows.findIndex(r => r.contains(document.activeElement));
    if (at === -1 && e.key.startsWith('Arrow')) return; // arrows keep scrolling until focus is in a row
    const next = rows[Math.max(0, Math.min(rows.length - 1, at === -1 ? 0 : at + dir))];
    const b = primary(next); if (!b) return;
    e.preventDefault(); b.focus(); b.scrollIntoView({ block: 'nearest' });
  });

  // A keyboard action on a Tidy row repaints it; hand focus to the row now in its place.
  document.addEventListener('click', e => {
    const btn = e.target.closest?.('#main .row .acts button');
    if (!btn || e.detail !== 0) return;
    const at = rowsOf().indexOf(btn.closest('.row'));
    setTimeout(() => {
      if (document.activeElement && document.activeElement !== document.body) return;
      const after = rowsOf(), n = after[Math.min(at, after.length - 1)];
      if (n) primary(n)?.focus();
    }, 350);
  });
})();
