// Test helper: run the New playlists screen's classic parts (emptyState, the GAPS state and
// its jobs) from the built page inside a vm sandbox, and call the real web/screens/new.mjs on
// a ctx built the way app/screens.js builds it. Adds vNew / gapsSections-free wrappers and
// `act(name, el)` to the sandbox so tests keep their shape.
import vm from 'node:vm';
import * as NEW from '../web/screens/new.mjs';

export function installNew(sandbox, slice) {
  // gapsCreate logs to History (DESIGN-PLAN F3); the log itself is app/actionlog.js, not under test here.
  sandbox.logs ??= [];
  sandbox.logAction ??= async e => { sandbox.logs.push(e); return 'at' + sandbox.logs.length; };
  sandbox.newGroup ??= () => 'g1';
  sandbox.undoAction ??= async () => {};
  vm.runInContext(slice('function emptyState(', '/* ---------- Tidy by sound')
    + slice('/* ======================= gaps: docs/SMARTER-GENRES-PLAN.md, phase 3', '/* ---------- shuffle: spacing'), sandbox);
  const jobs = vm.runInContext('({ emptyState, GAPS, gapsCompute, gapsCreate, gapsFile })', sandbox);
  const ctx = () => ({ store: { touch() {} }, ...sandbox, ...jobs });
  sandbox.NEWCTX = ctx;
  sandbox.vNew = () => NEW.view(ctx());
  sandbox.proposalCard = p => NEW.proposalCard(ctx(), p);
  sandbox.act = (name, el) => NEW.actions[name](ctx(), el);
  return sandbox;
}
