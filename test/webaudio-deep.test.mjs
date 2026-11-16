import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readDeepSettings, writeDeepSettings, deepListenAllowed, DEFAULT_DEEP_SETTINGS,
         DEEP_SETTINGS_KEY, DEEP_TEXT, MAEST_MIN_MEMORY_GB } from '../web/audio/deep-settings.mjs';

const mem = (init = null) => { const m = new Map(init ? [[DEEP_SETTINGS_KEY, init]] : []); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), m }; };
const WIFI = { type: 'wifi' };

test('every deep ear is off by default, and junk reads as the defaults', () => {
  assert.deepEqual(DEFAULT_DEEP_SETTINGS, { maest: false, clap: false, beats: false, memoryOverride: false });
  assert.deepEqual(readDeepSettings(mem()), DEFAULT_DEEP_SETTINGS);
  assert.deepEqual(readDeepSettings(null), DEFAULT_DEEP_SETTINGS);
  assert.deepEqual(readDeepSettings(mem('{nope')), DEFAULT_DEEP_SETTINGS);
  assert.deepEqual(readDeepSettings(mem(JSON.stringify({ maest: 'yes', clap: 1, memoryOverride: null }))), DEFAULT_DEEP_SETTINGS);
  for (const ear of ['maest', 'clap'])
    assert.equal(deepListenAllowed(ear, { connection: WIFI, deviceMemory: 8 }), 'off', `${ear} needs its own switch`);
});

test('writing merges one change, drops unknown keys, and survives a throwing store', () => {
  const ls = mem();
  assert.deepEqual(writeDeepSettings(ls, { maest: true }), { maest: true, clap: false, beats: false, memoryOverride: false });
  assert.deepEqual(writeDeepSettings(ls, { clap: true, extra: 1 }), { maest: true, clap: true, beats: false, memoryOverride: false });
  assert.deepEqual(JSON.parse(ls.m.get(DEEP_SETTINGS_KEY)), { maest: true, clap: true, beats: false, memoryOverride: false });
  const bad = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
  assert.deepEqual(writeDeepSettings(bad, { clap: true }), { maest: false, clap: true, beats: false, memoryOverride: false });
});

test('MAEST: the device gate needs deviceMemory >= 8 or the override', () => {
  const on = { maest: true, clap: false, beats: false, memoryOverride: false };
  assert.equal(MAEST_MIN_MEMORY_GB, 8);
  assert.equal(deepListenAllowed('maest', { settings: on, connection: WIFI, deviceMemory: 8 }), 'ok');
  assert.equal(deepListenAllowed('maest', { settings: on, connection: WIFI, deviceMemory: 4 }), 'low-memory');
  assert.equal(deepListenAllowed('maest', { settings: on, connection: WIFI }), 'memory-unknown', 'Safari/Firefox say nothing');
  assert.equal(deepListenAllowed('maest', { settings: on, connection: WIFI, deviceMemory: NaN }), 'memory-unknown');
  const over = { ...on, memoryOverride: true };
  assert.equal(deepListenAllowed('maest', { settings: over, connection: WIFI, deviceMemory: 2 }), 'ok');
  assert.equal(deepListenAllowed('maest', { settings: over, connection: WIFI }), 'ok');
});

test('CLAP has no memory rule', () => {
  const on = { maest: false, clap: true, beats: false, memoryOverride: false };
  assert.equal(deepListenAllowed('clap', { settings: on, connection: WIFI, deviceMemory: 2 }), 'ok');
  assert.equal(deepListenAllowed('clap', { settings: on, connection: WIFI }), 'ok');
});

test('both ears are Wi-Fi only, always', () => {
  const s = { maest: true, clap: true, memoryOverride: true };
  for (const ear of ['maest', 'clap']) {
    assert.equal(deepListenAllowed(ear, { settings: s, connection: { type: 'cellular' } }), 'metered');
    assert.equal(deepListenAllowed(ear, { settings: s, connection: { type: 'wifi', saveData: true } }), 'metered');
    assert.equal(deepListenAllowed(ear, { settings: s, connection: { type: 'none' } }), 'offline');
    assert.equal(deepListenAllowed(ear, { settings: s }), 'unknown', 'no navigator.connection: ask');
    assert.equal(deepListenAllowed(ear, { settings: s, confirmed: true }), 'ok');
    assert.equal(deepListenAllowed(ear, { settings: s, connection: { type: 'ethernet' } }), 'ok');
  }
  assert.equal(deepListenAllowed('vggish', { settings: { ...s, vggish: true }, connection: WIFI }), 'off');
  assert.equal(deepListenAllowed('maest', { settings: { maest: true }, connection: { type: 'none' }, deviceMemory: 1 }), 'offline',
    'offline is said before memory');
});

test('every non-ok answer has text', () => {
  for (const k of ['off', 'offline', 'low-memory', 'memory-unknown', 'metered', 'unknown']) assert.ok(DEEP_TEXT[k], k);
});
