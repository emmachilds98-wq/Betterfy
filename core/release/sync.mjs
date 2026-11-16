// The Release Radar sync (docs/RELEASE-RADAR-PLAN.md §3), with no network and
// no storage of its own: `get(path)` is the caller's Spotify GET (the page's
// `sp()`, with its pacing and 429 handling; the CLI's `api()`; a fixture in
// tests) and `store` is `{ get(key), set(key, value), keys?() }` (IndexedDB in
// the page, a JSON file for the CLI, a Map in tests).
//
// Resumable by construction: every artist's state is written as soon as each
// of its groups is read, so a sync stopped at artist 400 starts at 401 next
// time, and the index says how far it got. One artist failing never fails the
// run: it is marked and due again next time. Only a stop that would fail every
// later request too ends the run early (a 429 that `sp()` gave up holding
// through, the app's quota being gone, a dead sign-in, the request budget, the
// caller's abort), and what was read stays usable.
import { parseDate, cutoffTs, inWindow } from './dates.mjs';
import { normaliseItem, mergeRelease, compactTracks, SHAPE } from './normalise.mjs';
import { libraryIndex, verdict, needsDetail, probeIds } from './library.mjs';
import { KEY, MAIN_GROUPS, PAGE_LIMIT, MAX_PAGES, planTasks, newArtistState } from './plan.mjs';

/** Statuses after which no later request in this run would fare better: the
 *  page's sp() throws status 0 once a dropped connection has failed its retries. */
export const FATAL_STATUS = Object.freeze([0, 401, 429]);

export const isFatal = e => e?.name === 'AbortError' || e?.radarStop || FATAL_STATUS.includes(e?.status);

const stopErr = why => Object.assign(new Error(why), { radarStop: why });

/** The list request for one artist and group. */
export const albumsPath = (artistId, group, limit = PAGE_LIMIT) =>
  `/artists/${encodeURIComponent(artistId)}/albums?include_groups=${group}&market=from_token&limit=${limit}`;

/**
 * Run one sync. Returns `{ requests, byKind, done, total, stopped, errors, releases, cold, complete }`.
 *
 * @param o.lib       library.json's shape (or the page's LIB): for ownership and reissues
 * @param o.artists   artistSet()'s output, most listened first
 * @param o.store     key-value store, async or not
 * @param o.get       async Spotify GET; throws errors carrying `.status`
 * @param o.now       the clock, in ms
 * @param o.years     how far back the feed reads (2 by default: BUILD-6-PLAN §2.3)
 * @param o.groups    which `include_groups` to read
 * @param o.deep      `{ ids, years }`: read these artists further back now, due or not ("older on demand")
 * @param o.details   read track lists where §4.4 needs them (default true)
 * @param o.maxRequests stop cleanly after this many requests
 * @param o.signal    an AbortSignal
 * @param o.onProgress called after every artist group: `{ phase, done, total, requests, artist }`
 */
export async function syncRadar({ lib, artists, store, get, now = Date.now(), years = 2, groups,
                                  deep = null, details = true, maxRequests = Infinity, signal = null,
                                  onProgress = null } = {}) {
  const idx = libraryIndex(lib);
  const counts = { list: 0, detail: 0, probe: 0 };
  let requests = 0;
  const call = async (kind, path) => {
    if (signal?.aborted) throw stopErr('aborted');
    if (requests >= maxRequests) throw stopErr('budget');
    requests++; counts[kind]++;
    return get(path);
  };

  const prev = await store.get(KEY.index);
  /* Releases whose track list or probes are still owed. Kept in the index, so a
   * stop between an artist's list and its track lists is not forgotten: the
   * artist is not due again for days, but the next sync reads these first. */
  const pending = new Set((prev?.shape === SHAPE && prev.pending) || []);
  const cold = !prev || prev.shape !== SHAPE || !prev.complete && !prev.coldDone;
  const states = new Map();
  for (const a of artists) {
    const s = await store.get(KEY.artist(a.id));
    states.set(a.id, s?.shape === SHAPE ? s : null);
  }

  const deepIds = new Set(deep?.ids ?? []);
  const baseCut = cutoffTs(now, years);
  const deepCut = cutoffTs(now, deep?.years ?? 20);
  const cutFor = id => deepIds.has(id) ? deepCut : baseCut;

  let tasks = planTasks(artists, states, now, { groups });
  if (deepIds.size) {
    const have = new Set(tasks.map(t => t.artistId + '|' + t.group));
    const extra = artists.filter(a => deepIds.has(a.id)).flatMap(a => [...MAIN_GROUPS, 'appears_on']
      .filter(g => (!groups || groups.includes(g)) && !have.has(a.id + '|' + g))
      .map(g => ({ artistId: a.id, name: a.name, group: g })));
    tasks = [...tasks.filter(t => deepIds.has(t.artistId)), ...extra,
             ...tasks.filter(t => !deepIds.has(t.artistId))];
  }
  const total = tasks.length;
  const artistsTotal = new Set(tasks.map(t => t.artistId)).size;
  const artistsSeen = new Set();

  const cache = new Map();
  const touched = new Set();
  const load = async key => {
    if (!cache.has(key)) {
      const r = await store.get(KEY.release(key));
      cache.set(key, r?.shape === SHAPE ? r : null);
    }
    return cache.get(key);
  };
  const save = async rec => {
    const out = { ...rec, ...verdict(rec, idx) };
    cache.set(rec.key, out);
    touched.add(rec.key);
    await store.set(KEY.release(rec.key), out);
    return out;
  };

  let done = 0, errors = 0, stopped = null;
  let lastWrite = 0;
  const writeIndex = async complete => {
    lastWrite = done;
    const n = (await allReleaseKeys(store)).length;
    // The cold sync is over once every artist's own releases have been read
    // once, whatever failed on the way; until then nothing calls the radar complete.
    const coldDone = !!prev?.coldDone || artists.every(a => MAIN_GROUPS.every(g =>
      (groups && !groups.includes(g)) ? true : Number.isFinite(states.get(a.id)?.checked?.[g])));
    await store.set(KEY.index, { shape: SHAPE, at: now, artists: artists.length, releases: n, done, total,
      complete, stopped, cold, coldDone, years, requests, pending: [...pending] });
  };

  /** Read one artist's group, newest first, until the page reaches past its window. */
  const readGroup = async t => {
    const st = states.get(t.artistId) ?? newArtistState({ id: t.artistId, name: t.name });
    const cut = cutFor(t.artistId);
    const keys = [];
    let newest = null;
    try {
      let path = albumsPath(t.artistId, t.group), pages = 0;
      while (path && pages++ < MAX_PAGES) {
        const page = await call('list', path);
        const items = page?.items ?? [];
        let sorted = true, prevTs = Infinity, last = null;
        for (const item of items) {
          const rec = normaliseItem(item, { artistId: t.artistId, at: now });
          if (!rec) continue;
          const d = parseDate(rec.releaseDate, rec.precision);
          if (d.ts > prevTs) sorted = false;
          prevTs = d.ts; last = d;
          if (rec.lane === 'main' && d.ok && (newest == null || d.ts > newest)) newest = d.ts;
          if (!inWindow(d, cut)) continue;
          if (cold) rec.seenCold = true;
          const merged = mergeRelease(await load(rec.key), rec);
          await save(merged);
          keys.push(rec.key);
          // Owed a look at its track list from now on, even if the run stops
          // before this artist's details are read.
          if (details && MAIN_GROUPS.includes(t.group)) pending.add(rec.key);
        }
        // Spotify does not promise the order. Stop early only on a page that
        // was newest first and already reaches past the window; otherwise read on.
        if (!page?.next || !items.length || (sorted && last && last.end < cut)) break;
        path = page.next;
      }
      st.checked = { ...st.checked, [t.group]: now };
      const { [t.group]: _, ...rest } = st.errors ?? {};
      st.errors = rest;
      if (MAIN_GROUPS.includes(t.group) && newest != null) st.lastReleaseTs = Math.max(st.lastReleaseTs ?? -Infinity, newest);
      st.releaseKeys = [...new Set([...(st.releaseKeys ?? []), ...keys])];
    } catch (e) {
      if (isFatal(e)) { states.set(t.artistId, st); await store.set(KEY.artist(t.artistId), st); throw e; }
      errors++;
      st.errors = { ...st.errors, [t.group]: { at: now, status: e?.status ?? 0, message: String(e?.message ?? e).slice(0, 120) } };
    }
    st.shape = SHAPE;
    states.set(t.artistId, st);
    await store.set(KEY.artist(t.artistId), st);
    return keys;
  };

  /** §4.4: track lists (and ISRC probes) for releases that need them. */
  const readDetails = async (keys, cut) => {
    for (const key of keys) pending.add(key);
    for (const key of new Set(keys)) {
      let rec = await load(key);
      const wantList = rec && needsDetail(rec, idx, cut);
      if (!rec || (!wantList && !(rec.tracks && probeIds(rec, idx).length))) { pending.delete(key); continue; }
      try {
        if (wantList) {
          const album = await call('detail', `/albums/${encodeURIComponent(rec.ids[0])}?market=from_token`);
          rec = await save({ ...rec, tracks: compactTracks(album), detailAt: now });
        }
        for (const id of probeIds(rec, idx)) {
          const tr = await call('probe', `/tracks/${encodeURIComponent(id)}?market=from_token`);
          rec = await save({ ...rec, probes: { ...(rec.probes ?? {}), [id]: tr?.external_ids?.isrc ?? null } });
        }
        pending.delete(key);
      } catch (e) {
        if (isFatal(e)) throw e;
        errors++;   // no detailAt: asked again next sync
        pending.delete(key);
      }
    }
  };

  try {
    if (details && pending.size) await readDetails([...pending], baseCut);
    let i = 0;
    while (i < tasks.length) {
      const t = tasks[i];
      const main = MAIN_GROUPS.includes(t.group);
      // One artist's consecutive main-lane groups, then its track lists, so a
      // reissue is recognised before the next artist starts.
      let j = i, keys = [];
      while (j < tasks.length && tasks[j].artistId === t.artistId && MAIN_GROUPS.includes(tasks[j].group) === main) {
        keys.push(...await readGroup(tasks[j]));
        done++; j++;
        if (main) artistsSeen.add(t.artistId);
        onProgress?.({ phase: main ? 'main' : 'features', done, total, requests, artist: t.name,
                       artistsDone: artistsSeen.size, artistsTotal });
      }
      if (main && details && keys.length) await readDetails(keys, cutFor(t.artistId));
      if (j === i) j++;   // cannot happen; never loop forever
      i = j;
      if (done - lastWrite >= 25) await writeIndex(false);
    }
  } catch (e) {
    if (!isFatal(e)) throw e;
    stopped = e.radarStop ?? (e.status === 429 ? 'rate-limit' : e.status === 401 ? 'signed-out'
      : e.status === 0 ? 'offline' : 'aborted');
    stopped = { why: stopped, message: String(e.message ?? '').slice(0, 200) };
  }

  const complete = !stopped && errors === 0 && done === total && !pending.size;
  await writeIndex(complete);
  return { requests, byKind: counts, done, total, stopped, errors, releases: touched.size, cold, complete };
}

/** Every stored release key, from the store's `keys()` (the CLI's and the page's stores have it). */
export async function allReleaseKeys(store) {
  const ks = (await store.keys?.()) ?? [];
  return ks.filter(k => typeof k === 'string' && k.startsWith(KEY.releasePrefix));
}

/** Every stored release record of the current shape. */
export async function loadReleases(store) {
  const out = [];
  for (const k of await allReleaseKeys(store)) {
    const r = await store.get(k);
    if (r?.shape === SHAPE) out.push(r);
  }
  return out;
}

/**
 * Re-judge ownership and reissues for every stored release against a library
 * that has changed since. No requests: the verdicts are pure (library.mjs).
 */
export async function rescore(store, lib) {
  const idx = libraryIndex(lib);
  let changed = 0;
  for (const k of await allReleaseKeys(store)) {
    const r = await store.get(k);
    if (r?.shape !== SHAPE) continue;
    const v = verdict(r, idx);
    if (v.owned !== r.owned || v.reissue !== r.reissue || v.reissueBasis !== r.reissueBasis) {
      await store.set(k, { ...r, ...v }); changed++;
    }
  }
  return changed;
}

/** A Map-backed store with the same interface, for tests, the CLI and the simulator. */
export function memoryStore(init = null) {
  const m = new Map(init ? Object.entries(init) : []);
  return {
    map: m,
    get: async k => m.get(k) ?? null,
    set: async (k, v) => { m.set(k, v); },
    del: async k => { m.delete(k); },
    keys: async () => [...m.keys()],
    toJSON: () => Object.fromEntries(m),
  };
}
