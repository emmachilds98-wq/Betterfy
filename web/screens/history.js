/**
 * One History row per thing you did: the steps of a group (a move's add and
 * remove) fold into one "Moved A → B" row with one Undo for both, and a row
 * already undone says so instead of offering Undo again — a second tap used
 * to re-add a duplicate.
 */
function vHistory() {
  const h = S.history ?? [];
  const byGroup = new Map();
  for (const x of h) if (x.group && x.op !== 'undo') (byGroup.get(x.group) ?? byGroup.set(x.group, []).get(x.group)).push(x);
  const seen = new Set(), rows = [];
  for (const x of h) {
    const g = x.group && x.op !== 'undo' ? byGroup.get(x.group) : null;
    if (g && g.length > 1) { if (!seen.has(x.group)) { seen.add(x.group); rows.push({ group:g }); } }
    else rows.push({ one:x });
  }
  const undone = `<span class="sub">Undone</span>`;
  const one = x => `<div class="row"><div class="main">
      <div class="ttl">${esc(x.op)} <span class="sub">${esc(x.playlistName ?? '')}</span></div>
      <div class="sub mono">${esc(x.at.replace('T',' ').slice(0,19))} · ${(x.trackIds??[]).length} track(s)${x.reason?' · '+esc(x.reason):''}</div>
    </div><div class="acts">${['remove','add','unlike'].includes(x.op) ? (isUndone(x, h) ? undone : `<button class="b sm" data-undo="${esc(x.at)}">Undo</button>`) : ''}</div></div>`;
  const grouped = g => {
    const newest = g[0], oldest = g[g.length - 1];
    const mv = g.find(x => x.move)?.move;
    const add = g.find(x => x.op === 'add'), rem = g.find(x => x.op === 'remove');
    const title = mv || (add && rem)
      ? `Moved <span class="sub">${esc(mv?.fromName ?? rem?.playlistName ?? '')} → ${esc(mv?.toName ?? add?.playlistName ?? '')}</span>`
      : `${esc(newest.op)} <span class="sub">${esc(g.map(x => x.playlistName).filter(Boolean).join(', '))}</span>`;
    const n = new Set(g.flatMap(x => x.trackIds ?? [])).size;
    return `<div class="row"><div class="main">
      <div class="ttl">${title}</div>
      <div class="sub mono">${esc(oldest.at.replace('T',' ').slice(0,19))} · ${n} track(s)</div>
    </div><div class="acts">${g.every(x => isUndone(x, h)) ? undone : `<button class="b sm" data-undo="${esc(oldest.at)}">Undo</button>`}</div></div>`;
  };
  return `<h1>History</h1>
    <p class="lede">Every change Betterfy made to your Spotify library, newest first. Removals record their position, so undo puts a track back where it was rather than at the end.</p>
    <div class="rows">${rows.map(r => r.group ? grouped(r.group) : one(r.one)).join('')
      || emptyState('Nothing changed yet', 'Every edit Betterfy makes lands here, and can be undone from it.')}</div>`;
}

