/* File's classic glue: the screen is web/screens/inbox.mjs; gestures.js and the
 * keyboard handler below reach it through these. cmpTable stays here for Tidy. */
const FILE_GLUE = {
  track: () => SCREEN_MODS.inbox.inboxTrack(screenCtx('inbox')),
  toggle: id => SCREEN_MODS.inbox.toggleFileSel(screenCtx('inbox'), id),
};
const fileCurrent = (ids, opts) => SCREEN_MODS.inbox.fileCurrent(screenCtx('inbox'), ids, opts);
const inboxAct = a => SCREEN_MODS.inbox.inboxAct(screenCtx('inbox'), a);

// Keyboard parity for the swipe: the same walk through VORDER, for anyone not
// using a touchscreen.
document.addEventListener('keydown', guard(async e => {
  if ($('#app').hidden || e.metaKey || e.ctrlKey || e.altKey) return;
  // Enter in Discover's "sounds like" box searches (WP-C3).
  if (e.key === 'Enter' && e.target.id === 'sndq') { e.preventDefault(); return clapSearch(e.target.value); }
  if (e.target.matches('input,select,textarea')) return;
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const next = VORDER[VORDER.indexOf(view) + (e.key === 'ArrowRight' ? 1 : -1)];
  if (!next) return;
  go(next);
}));

document.addEventListener('keydown', e => {
  if (view !== 'inbox' || e.target.matches('input,select,textarea')) return;
  const t = FILE_GLUE.track(); if (!t) return;
  if (['1','2','3'].includes(e.key)) { const s = filePicks(t)[+e.key-1]; if (s) FILE_GLUE.toggle(s.id); }
  if (e.key === 'Enter' && (S.fileSel.size || filePicks(t)[0])) fire(fileCurrent(S.fileSel.size ? [...S.fileSel] : filePicks(t)[0].id));
  if (e.key.toLowerCase()==='p') inboxAct('play');
  if (e.key.toLowerCase()==='s') inboxAct('skip');
  if (e.key.toLowerCase()==='u') inboxAct('unlike');
});

function cmpTable(o) {
  const d = f => new Set(o.map(x=>x[f])).size > 1;
  const [dD,dT,dR,dI] = ['dur','albumType','released','isrc'].map(d);
  return `<table class="cmp"><thead><tr><th>Length</th><th>Release</th><th>Date</th><th>ISRC</th><th>Album</th></tr></thead><tbody>
    ${o.map(x=>`<tr><td class="mono ${dD?'differs':''}">${esc(x.dur)}</td><td class="${dT?'differs':''}">${esc(x.albumType??'—')}</td>
    <td class="mono ${dR?'differs':''}">${esc((x.released??'').slice(0,10))}</td><td class="mono ${dI?'differs':''}">${esc(x.isrc??'—')}</td>
    <td>${esc(x.album)}</td></tr>`).join('')}</tbody></table>`;
}

