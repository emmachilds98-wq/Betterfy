// Tiny resumable JSON cache with atomic writes.
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';

export class Cache {
  constructor(file) {
    this.file = file;
    this.data = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    this.dirty = 0;
  }
  has(k) { return Object.prototype.hasOwnProperty.call(this.data, k); }
  get(k) { return this.data[k]; }
  set(k, v) { this.data[k] = v; if (++this.dirty >= 50) this.flush(); }
  flush() {
    if (!this.dirty) return;
    writeFileSync(this.file + '.tmp', JSON.stringify(this.data));
    renameSync(this.file + '.tmp', this.file);
    this.dirty = 0;
  }
  get size() { return Object.keys(this.data).length; }
}

// An empty or thin Last.fm/Discogs answer used to be permanent — the only way
// back was a manual "Wrong tags?" edit or the explicit refetch button. Real
// gaps are not permanent, though: Last.fm's crowd tags and Discogs' catalogue
// both grow over time, so an artist who genuinely had nothing six months ago
// may not still have nothing. A real, well-tagged answer is never re-asked —
// there is no upside, only a wasted request — but a thin or errored one is
// worth trying again once enough time has passed.
export const REASK_TAG_FLOOR = 3;
export const REASK_AFTER_MS = 1000 * 60 * 60 * 24 * 180; // ~6 months

/**
 * Whether a cached `{tags, checkedAt, error?}` entry is worth fetching again.
 * A transient failure (`error`) is always retried — the whole point of a
 * fetch failing is that it was never really answered — but a genuine "nothing
 * here" answer only gets a second look after REASK_AFTER_MS, and only if it
 * was thin to begin with; a well-tagged artist has no reason to be re-asked.
 */
export function worthReasking(entry, { floor = REASK_TAG_FLOOR, staleMs = REASK_AFTER_MS, now = Date.now() } = {}) {
  if (!entry) return true;
  if (entry.error) return true;
  if ((entry.tags?.length ?? 0) >= floor) return false;
  return now - (entry.checkedAt ?? 0) > staleMs;
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));

// Retry wrapper for flaky network / soft rate limits.
export async function retry(fn, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) { last = e; await sleep(500 * 2 ** i); }
  }
  throw last;
}
