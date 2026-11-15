/* ---------- library cache (IndexedDB) ---------- */
/* This one store holds the library cache, the action log, your skips and
 * rejections, your tag corrections and the banked pieces of an interrupted
 * read. So a browser that will not hand over IndexedDB did not cost one
 * feature, it cost all of them at once: open() rejected, and every await above
 * it rejected with it — filing, undo, history, Tidy, the lot, each one failing
 * in whatever way its own caller happened to fail.
 *
 * A private window, blocked site data, a partitioned origin, a device out of
 * space: all real, none of them a reason for the app to stop working. Memory is
 * a poor cache and a perfectly good one for a single session, which is the
 * difference between "this does not work here" and "this re-reads next time". */
const idb = (() => {
  const mem = new Map();
  let opening = null, usable = true;

  const open = () => {
    if (!usable) return Promise.resolve(null);
    return opening ??= new Promise((ok, bad) => {
      const r = indexedDB.open('betterfy', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => ok(r.result);
      r.onerror = () => bad(r.error);
    }).catch(() => { usable = false; return null; });
  };

  /**
   * @param fn (store, resolve, tx) => void — resolve with the result.
   * @param fallback what to do instead when there is no usable store.
   */
  const run = async (mode, fn, fallback) => {
    let d = null;
    try { d = await open(); } catch { d = null; }
    if (!d) return fallback();
    try {
      return await new Promise((ok, bad) => {
        const tx = d.transaction('kv', mode);
        tx.onabort = () => bad(tx.error ?? new Error('aborted'));
        tx.onerror = () => bad(tx.error ?? new Error('failed'));
        fn(tx.objectStore('kv'), ok, tx);
      });
    } catch {
      // A store that has started refusing mid-session — quota, or the browser
      // reclaiming it — is not coming back. Stop asking and carry on in memory
      // rather than failing every call from here on.
      usable = false; opening = null;
      return fallback();
    }
  };

  return {
    /** False once nothing stored here will outlive the session. */
    get durable() { return usable; },
    get: k => run('readonly', (st, ok) => { const r = st.get(k);
      r.onsuccess = () => ok(r.result); r.onerror = () => ok(null); }, () => mem.get(k)),
    set: (k, v) => run('readwrite', (st, ok, tx) => { st.put(v, k); tx.oncomplete = () => ok(); },
      () => { mem.set(k, v); }),
    del: k => run('readwrite', (st, ok, tx) => { st.delete(k); tx.oncomplete = () => ok(); },
      () => { mem.delete(k); }),
    keys: () => run('readonly', (st, ok) => { const r = st.getAllKeys();
      r.onsuccess = () => ok(r.result ?? []); r.onerror = () => ok([]); }, () => [...mem.keys()]),
    clear: () => run('readwrite', (st, ok, tx) => { st.clear(); tx.oncomplete = () => ok(); },
      () => { mem.clear(); }),
  };
})();

