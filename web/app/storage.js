
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

/* ---------- storage ----------
 * Every browser this runs in has localStorage, and not every one of them lets
 * you touch it. Safari with "Block All Cookies", a locked-down private window,
 * an in-app web view: there, reading the property itself throws a SecurityError
 * — and every unguarded localStorage call in this file was a line that could
 * kill the boot script outright. The page still rendered, because the landing
 * screen is static HTML; it just came up with Connect Spotify wired to nothing,
 * which is indistinguishable from the app being broken and impossible to report
 * usefully. So it all goes through here: real storage when there is any, memory
 * when there is not, and never a throw either way.
 *
 * Memory is always written too, not only as a fallback — a store that accepts
 * a write and then throws on the next one (a full quota, a private window's
 * small allowance) would otherwise lose the value it had already taken. */
const LS = (() => {
  const mem = new Map();
  let real = null;
  try {
    const probe = '__bf_probe';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    real = window.localStorage;
  } catch { real = null; }
  const fallback = k => mem.has(k) ? mem.get(k) : null;
  return {
    /** False when nothing written here outlives the page. */
    durable: !!real,
    // Real store first, memory behind it — not "one or the other". A store that
    // took the first write and refused the second still answers null for the
    // second, and reading null there would quietly undo a value this page is
    // still relying on.
    getItem(k) {
      try { const v = real?.getItem(k); if (v != null) return v; } catch {}
      return fallback(k);
    },
    setItem(k, v) { mem.set(k, String(v)); try { real?.setItem(k, String(v)); } catch {} },
    removeItem(k) { mem.delete(k); try { real?.removeItem(k); } catch {} },
  };
})();
const mmss = ms => ms == null ? '—' : `${Math.floor(ms/60000)}:${String(Math.round(ms%60000/1000)).padStart(2,'0')}`;

