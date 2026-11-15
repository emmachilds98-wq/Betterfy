// Fixture ctx for the Shuffle and Discover screen modules (web/README.md, "Screen modules").
// The names a module destructures are read out of a vm sandbox that holds the page's own
// code, so a test can keep running the shipped helpers while calling the module's view().
import vm from 'node:vm';
import * as Shuffle from '../web/screens/shuffle.mjs';
import * as Discover from '../web/screens/discover.mjs';

const pick = (sandbox, names) => vm.runInContext(
  `({ ${names.map(n => `${n}: typeof ${n} === 'undefined' ? undefined : ${n}`).join(', ')} })`, sandbox);

const SHUFFLE = ['S', 'LIB', 'LS', 'esc', 'emptyState', 'isMirrorPlaylist', 'dedupe', 'spacedShuffle', 'shuffleStats', 'rnd',
  'artistOf', 'mixHeardIn', 'shuffleMix', 'MIX_MODES', 'MIX_PAGE', 'labelsShownNow'];
const DISCOVER = ['S', 'LIB', 'LS', 'CFG', 'esc', 'lfmKey', 'emptyState', 'discListenOn', 'discSoundLine', 'discFitHTML',
  'soundSearchHTML', 'artHTML', 'trackChip', 'trackStrip', 'tagChips', 'pickEvidence', 'pickBand', 'mmss', 'ICON_PLAY',
  'addTracks', 'logAction', 'getLog', 'toast', 'undoAction', 'render'];

export const shuffleCtx = sandbox => {
  const c = pick(sandbox, SHUFFLE);
  c.labelsShownNow ??= () => null;
  return Object.assign(c, { BetterfyOrder: vm.runInContext('globalThis.BetterfyOrder', sandbox),
                            BetterfyAudio: vm.runInContext('globalThis.BetterfyAudio', sandbox) });
};
export const discoverCtx = sandbox => {
  const c = pick(sandbox, DISCOVER);
  c.soundSearchHTML ??= () => '';
  c.discListenOn ??= () => false;
  c.discSoundLine ??= () => '';
  c.discFitHTML ??= () => '';
  return c;
};
/** Put the module's view on the sandbox under the old name, so the existing cases read the same. */
export const bindShuffle = sb => Object.assign(sb, { vShuffle: () => Shuffle.view(shuffleCtx(sb)) });
export const bindDiscover = sb => Object.assign(sb, { vDiscover: () => Discover.view(discoverCtx(sb)) });
export { Shuffle, Discover };
