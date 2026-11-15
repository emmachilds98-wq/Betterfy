/* ---------- events ---------- */
/* ---------- nothing fails in silence ----------
 * Every delegated handler below is async, and an async handler that rejects
 * leaves no trace at all: no message, no screen, just a tap that did nothing.
 * That is exactly the failure the Connect button had, and the same one line
 * stops it happening to filing, undo, Tidy, Discover, Shuffle and the rest —
 * most of whose branches never had a catch of their own. Now that a dropped
 * request throws instead of being mistaken for an answer, this matters more:
 * "the network went" has to reach the screen, not vanish. */
function actionFailed(err) {
  console.error(err);
  const m = err?.message ? String(err.message) : 'Something went wrong.';
  // Spotify's own failures arrive as "403 Forbidden" and mean nothing on their
  // own; anything this file raised is already a sentence.
  toast(/^\d{3}\b/.test(m) ? `Spotify refused that — ${m}.` : m);
}

/** Wrap a handler so whatever it throws, sync or async, reaches the screen. */
const guard = fn => (...a) => {
  try { const r = fn(...a); if (r && typeof r.catch === 'function') r.catch(actionFailed); return r; }
  catch (e) { actionFailed(e); }
};

/** Start an async action nobody is awaiting, and put any failure on screen. */
const fire = p => { Promise.resolve(p).catch(actionFailed); };

