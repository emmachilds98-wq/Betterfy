// A screen module's ctx made from a vm sandbox: anything the sandbox does not
// hold as a property (a top-level const of the page code run in it, say) is read
// from the sandbox's own scope, so fixtures and sliced page code mix freely.
import vm from 'node:vm';

export function ctxOf(sandbox) {
  return new Proxy(sandbox, {
    get(t, k) {
      if (k in t) return t[k];
      if (typeof k !== 'string' || !/^[A-Za-z_$][\w$]*$/.test(k)) return undefined;
      try { return vm.runInContext(`typeof ${k} === 'undefined' ? undefined : ${k}`, t); } catch { return undefined; }
    },
  });
}

import * as INBOX from '../web/screens/inbox.mjs';

/** The File screen's old page-global names, bound to the module and this sandbox. */
export function withInbox(sandbox) {
  const c = ctxOf(sandbox);
  return Object.assign(sandbox, {
    vInbox: () => INBOX.view(c),
    fileCurrent: ids => INBOX.fileCurrent(c, ids),
    inboxAct: a => INBOX.inboxAct(c, a),
    toggleFileSel: id => INBOX.toggleFileSel(c, id),
    rollForwardHTML: () => INBOX.rollForwardHTML(c),
    rollForwardGo: () => INBOX.rollForwardGo(c),
    inboxTrack: () => INBOX.inboxTrack(c),
  });
}

// Fixture ctx for the Shuffle and Discover screen modules (web/README.md, "Screen modules").
// The names a module destructures are read out of a vm sandbox that holds the page's own
// code, so a test can keep running the shipped helpers while calling the module's view().
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
