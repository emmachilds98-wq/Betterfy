import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/*
 * Re-syncing a library is one deliberate button, in Settings — a pull-to-refresh
 * gesture used to do it, and a stray downward swipe spending several hundred
 * calls against a shared quota is exactly what that button exists to prevent.
 *
 * Which makes it the one path that must work. It called openSettings(false) to
 * close the panel on its way past, and openSettings was a const inside
 * initSettingsPanel() — never in scope where the button was wired up hundreds
 * of lines later. The handler is async, so the ReferenceError became an
 * unhandled rejection nobody caught: the button disabled itself, said
 * "Re-reading your library…", never re-read anything, and never came back.
 */

const BUNDLE = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');

function slice(from, to, what) {
  const i = BUNDLE.indexOf(from), j = BUNDLE.indexOf(to);
  assert.ok(i > 0 && j > i, `${what} not found — rebuild with npm run build:web`);
  return BUNDLE.slice(i, j);
}

/** Just enough DOM for a panel, a scrim and three buttons. */
function fakeDom() {
  const nodes = new Map();
  const el = id => {
    if (!nodes.has(id)) nodes.set(id, {
      id, focused: 0, attrs: {}, classes: new Set(), disabled: false, textContent: '',
      classList: {
        toggle(c, on) { on ? nodes.get(id).classes.add(c) : nodes.get(id).classes.delete(c); },
        contains: c => nodes.get(id).classes.has(c),
      },
      setAttribute(k, v) { this.attrs[k] = v; },
      focus() { this.focused++; },
    });
    return nodes.get(id);
  };
  return { el, $: s => el(s.replace('#', '')) };
}

test('openSettings is reachable from outside the panel that defines the rest of it', () => {
  const dom = fakeDom();
  const sandbox = { $: dom.$, console };
  vm.createContext(sandbox);
  vm.runInContext(slice('function openSettings(open)', 'function initSettingsPanel()', 'openSettings'), sandbox);

  // Exactly what the re-sync button does, run in a scope that has nothing of
  // initSettingsPanel()'s locals in it.
  vm.runInContext('openSettings(false)', sandbox);
  assert.equal(dom.el('settingsPanel').attrs['aria-hidden'], 'true');
  assert.equal(dom.el('btnSettings').attrs['aria-expanded'], 'false');
  assert.ok(!dom.el('scrim').classList.contains('open'));

  vm.runInContext('openSettings(true)', sandbox);
  assert.equal(dom.el('settingsPanel').attrs['aria-hidden'], 'false');
  assert.ok(dom.el('scrim').classList.contains('open'));
  assert.equal(dom.el('closeSettings').focused, 1, 'opening moves focus into the panel');
});

test('initSettingsPanel does not shadow it with a local of the same name', () => {
  const body = slice('function initSettingsPanel()', 'const DEFAULT_CLIENT_ID', 'initSettingsPanel');
  assert.doesNotMatch(body, /const openSettings\s*=/,
    'a second, function-scoped copy is what put the re-sync button out of scope');
  assert.match(body, /openSettings\(/, 'the panel still drives it');
});

test('the re-sync button closes the panel and re-reads, in that order', () => {
  const body = slice("$('#settingsResync').onclick", "$('#syncSection')", 're-sync wiring');
  assert.match(body, /openSettings\(false\); await start\(true\)/,
    'the panel is out of the way before the progress screen replaces what is under it');
});

test('the two async handlers wired up by hand go through guard() like every other one', () => {
  // An async onclick with no catch is the exact shape of "the button does
  // nothing and says nothing", which is what took the re-sync button out.
  for (const id of ['disconnect', 'settingsResync']) {
    const i = BUNDLE.indexOf(`$('#${id}').onclick`);
    assert.ok(i > 0, `#${id} handler not found — rebuild with npm run build:web`);
    assert.match(BUNDLE.slice(i, i + 60), /onclick = guard\(async/,
      `#${id} must report what it throws`);
  }
});
