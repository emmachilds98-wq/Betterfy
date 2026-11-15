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
