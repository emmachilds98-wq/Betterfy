// Test helper: run Tidy's classic parts (state, paging, emptyState, the sound-misfit job)
// from the built page inside a vm sandbox, and call the real web/screens/tidy.mjs view on
// a ctx built the same way app/screens.js builds it. Adds vTidy / secMisfile / secDupes /
// secCross / secSound to the sandbox so tests can keep calling them by name.
import vm from 'node:vm';
import * as TIDY from '../web/screens/tidy.mjs';

export function installTidy(sandbox, slice) {
  vm.runInContext(slice('const S = {', '// Bar order', 'Tidy state')
    + slice('function emptyState(', '/* ---------- Playlists: mixes', 'Tidy jobs'), sandbox);
  const jobs = vm.runInContext(`({ TSOUND, moreButton, shownOf, emptyState, tidySoundOn, tidySoundRows, tidySoundCount, tidySoundWarm })`, sandbox);
  const ctx = () => ({ tagEditorHTML: () => '', tagChips: () => '', store: { touch() {} }, ...sandbox,
    S: vm.runInContext('S', sandbox), ...jobs });
  sandbox.TIDYCTX = ctx;
  sandbox.vTidy = () => TIDY.view(ctx());
  for (const f of ['secMisfile', 'secDupes', 'secCross', 'secSound']) sandbox[f] = () => TIDY[f](ctx());
  return sandbox;
}
