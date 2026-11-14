// The page's audio record store (WP-B2): IndexedDB `audio_v1`, keyed by Spotify id.
//
// One record or cacheable miss per track (core/audio/record.mjs). Everything
// read back goes through validRecord(): a record from an older shape, a
// half-written one, or anything a browser extension left in there reads as
// "not heard", so the queue simply asks again. Nothing here stores audio or a
// preview URL; record.mjs never puts either in a record.
//
// Its own database rather than a new object store in the page's `betterfy`
// one: that database is opened at version 1 by the page's kv helper, and
// adding a store means a version bump every open() in the page would have to
// agree on. A second database costs nothing and can be dropped on its own.
//
// Like the page's kv helper, a browser that refuses IndexedDB (private
// window, blocked site data, quota) gets a memory store for the session
// instead of an error: listening still works, it just is not remembered.
import { validRecord } from '../../core/audio/record.mjs';

export const AUDIO_DB = 'betterfy-audio';
export const AUDIO_DB_VERSION = 1;
export const AUDIO_STORE = 'audio_v1';

/**
 * @param {{ indexedDB?: IDBFactory }} [o]
 * @returns {{ durable: boolean, get(id: string): Promise<object|null>, getAll(): Promise<Map<string, object>>,
 *             put(rec: object): Promise<boolean>, count(): Promise<number>, clear(): Promise<void> }}
 */
export function openAudioStore({ indexedDB = globalThis.indexedDB } = {}) {
  const mem = new Map();
  let usable = !!indexedDB, opening = null;

  const open = () => {
    if (!usable) return Promise.resolve(null);
    return opening ??= new Promise((ok, bad) => {
      const r = indexedDB.open(AUDIO_DB, AUDIO_DB_VERSION);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains(AUDIO_STORE)) db.createObjectStore(AUDIO_STORE, { keyPath: 'id' });
      };
      r.onsuccess = () => ok(r.result);
      r.onerror = () => bad(r.error);
      r.onblocked = () => bad(new Error('blocked'));
    }).catch(() => { usable = false; return null; });
  };

  const run = async (mode, fn, fallback) => {
    const db = await open();
    if (!db) return fallback();
    try {
      return await new Promise((ok, bad) => {
        const tx = db.transaction(AUDIO_STORE, mode);
        tx.onabort = () => bad(tx.error ?? new Error('aborted'));
        tx.onerror = () => bad(tx.error ?? new Error('failed'));
        fn(tx.objectStore(AUDIO_STORE), ok, tx);
      });
    } catch {
      // A store that starts refusing mid-session is not coming back: carry on in memory.
      usable = false; opening = null;
      return fallback();
    }
  };

  const valid = rec => (validRecord(rec) ? rec : null);

  return {
    get durable() { return usable; },
    get: id => run('readonly', (st, ok) => {
      const r = st.get(id); r.onsuccess = () => ok(valid(r.result)); r.onerror = () => ok(null);
    }, () => valid(mem.get(id))),
    /** Every valid entry, id → record or miss. Invalid ones are left out. */
    getAll: () => run('readonly', (st, ok) => {
      const r = st.getAll();
      r.onsuccess = () => ok(new Map((r.result ?? []).filter(validRecord).map(x => [x.id, x])));
      r.onerror = () => ok(new Map());
    }, () => new Map([...mem.values()].filter(validRecord).map(x => [x.id, x]))),
    /** Refuses (returns false) anything validRecord would not read back, FAILED included. */
    put: async rec => {
      if (!validRecord(rec)) return false;
      await run('readwrite', (st, ok, tx) => { st.put(rec); tx.oncomplete = () => ok(); }, () => { mem.set(rec.id, rec); });
      return true;
    },
    count: () => run('readonly', (st, ok) => {
      const r = st.count(); r.onsuccess = () => ok(r.result ?? 0); r.onerror = () => ok(0);
    }, () => mem.size),
    clear: () => run('readwrite', (st, ok, tx) => { st.clear(); tx.oncomplete = () => ok(); }, () => { mem.clear(); }),
  };
}
