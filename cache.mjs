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
