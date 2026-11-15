/* ---------- discovery: new by construction ----------
 *
 * What you listen to is not the same as what you own. A playlist filed two
 * years ago and never played since should not steer a discovery run as hard as
 * an artist you had on all last month — so the seeds are weighted by Spotify's
 * three listening windows and your recent plays, with the filed library behind
 * them as a floor rather than as the whole story. Seeding from one playlist
 * instead gives you that playlist's radio.
 */
async function listeningSeeds() {
  const { topWindows, recentArtists } = await fetchListeningRaw();
  // The library as a floor, scaled by the biggest count so that one enormous
  // playlist cannot outvote a month of actually playing something.
  const libraryArtists = [];
  for (const p of LIB.playlists) { if (isMirrorPlaylist(p)) continue;
    for (const t of p.tracks) for (const a of t.artists ?? []) libraryArtists.push(a.name); }
  // Liked songs count towards the floor too — the Node side (listening.mjs)
  // has always included them, and leaving them out here meant the two builds
  // weighted the same library differently.
  for (const t of LIB.liked ?? []) for (const a of t.artists ?? []) libraryArtists.push(a.name);
  const weights = listeningWeights({ topWindows, recentArtists, libraryArtists });

  // Stashed for getListening() — Discovery, the tag-gap fetch and the Tidy
  // screen's "you play this a lot" note all read the same one fetch.
  const shortTerm = topWindows.find(w => w.range === 'short_term')?.items ?? [];
  LISTENING_CACHE = { weights, recentlyActive: new Set([...shortTerm, ...recentArtists]) };
  return weights;
}

// Most recent window counts for most, but the long one still counts: taste
// is not only what happened this month. Kept aside so getListening() below
// can reuse the same raw fetch for the recently-active set, rather than
// hitting Spotify a second time for it.
//
// This costs four calls (three top-artists windows plus recently-played), and
// LISTENING_CACHE above only saves the second and third caller *within one
// page session* — every fresh load spent all four again, even one minute
// later, for a signal that barely moves within a few hours. Cached in
// IndexedDB with a TTL for exactly that reason.
const LISTENING_TTL = 4 * 60 * 60 * 1000;
async function fetchListeningRaw() {
  const cached = await idb.get('listening_raw');
  if (cached && Date.now() - cached.at < LISTENING_TTL) return cached.data;

  const topWindows = [];
  let anyFailure = false;
  for (const [range, weight] of [['short_term', 3], ['medium_term', 2], ['long_term', 1.5]]) {
    try {
      const r = await sp(`/me/top/artists?limit=50&time_range=${range}`);
      topWindows.push({ range, weight, items: (r?.items ?? []).map(a => a.name) });
    } catch { anyFailure = true; }
  }
  let recentArtists = [];
  try {
    const r = await sp('/me/player/recently-played?limit=50');
    recentArtists = (r?.items ?? []).flatMap(p => (p.track?.artists ?? []).map(a => a.name));
  } catch { anyFailure = true; }

  const data = { topWindows, recentArtists };
  // A genuine failure keeps no cache, so the next call asks Spotify again
  // rather than freezing a partial or empty answer for the whole TTL — the
  // same principle syncLibrary already applies to a playlist Spotify refused.
  if (!anyFailure) await idb.set('listening_raw', { at: Date.now(), data });
  return data;
}

// Memoized for the session: whichever feature asks first (Discovery, the
// Playlists tag-gap fetch, or opening Tidy) pays for the fetch; everyone
// else reads the cache instead of hitting Spotify again. LISTENING_PENDING
// collapses two callers racing to be first into one fetch, not two.
let LISTENING_CACHE = null, LISTENING_PENDING = null;
async function getListening() {
  if (LISTENING_CACHE) return LISTENING_CACHE;
  LISTENING_PENDING ??= listeningSeeds();
  await LISTENING_PENDING;
  LISTENING_PENDING = null;
  return LISTENING_CACHE;
}

/** Artist weights for one playlist — its own radio, ignoring everything else. */
function playlistSeeds(pl) {
  const w = new Map();
  for (const t of pl.tracks) for (const a of t.artists ?? []) w.set(a.name, (w.get(a.name) ?? 0) + 1);
  return w;
}

/** The top artists to ask Last.fm about, scaled so none is worth nothing. */
function rankSeeds(weights, n = 40) {
  const top = [...weights].sort((a, b) => b[1] - a[1]).slice(0, n);
  const most = top[0]?.[1] || 1;
  return top.map(([name, x]) => ({ name, w: 0.35 + 0.65 * (x / most) }));
}

async function runDiscovery(seedPlaylistId) {
  // No key is not a dead end any more (CLAUDE.md: every account, Spotify
  // library alone): without one, the candidates come from Deezer's and
  // ListenBrainz's "fans also like" for the artists you play.
  const key = lfmKey();

  const ownedArtist = new Set(), ownedTrack = new Set();
  const own = t => { for (const a of t?.artists ?? []) ownedArtist.add(norm(a.name));
                     if (t?.name) ownedTrack.add(norm(t.artists?.[0]?.name ?? '') + '|' + norm(t.name)); };
  for (const p of LIB.playlists) p.tracks.forEach(own);
  LIB.liked.forEach(own);

  const src = seedPlaylistId ? LIB.playlists.find(p => p.id === seedPlaylistId) : null;
  if (!src) stage('Reading what you have been playing…', 0.02);
  const weights = src ? playlistSeeds(src) : await listeningSeeds();
  const seeds = rankSeeds(weights);
  if (!seeds.length) { toast('Nothing to seed from.'); return; }

  let out;
  try {
    out = key ? await discoverLastfm(key, seeds, ownedArtist, ownedTrack)
              : await discoverKeyless(src, weights, ownedArtist, ownedTrack);
  } catch (e) {
    $('#land').hidden = true; $('#app').hidden = false;
    toast('Couldn’t find new music: ' + (e?.message ?? e));
    return go('discover');
  }

  stage('Finding them on Spotify…', 0.95);
  for (const o of out) {
    try {
      // The keyless path found its track on Spotify already.
      const hit = o.hit ?? (await sp(`/search?q=${encodeURIComponent(`artist:${o.artist} track:${o.track}`)}&type=track&limit=1`)).tracks?.items?.[0];
      delete o.hit;
      if (hit) {
        o.id = hit.id; o.album = hit.album?.name; o.released = hit.album?.release_date;
        o.art = artOf(hit); o.dur = hit.duration_ms;
        o.artists = (hit.artists ?? []).map(a => ({ id:a.id, name:a.name }));
        // What a pick is heard by: the same ISRC route as every library track.
        o.isrc = hit.external_ids?.isrc ?? null;
        const lead = o.artists[0];
        if (lead && o.lfmTags?.length && !TAGS[lead.id]) TAGS[lead.id] = { tags:o.lfmTags };
      }
    } catch {}
  }
  // Score against the same gate-passed tags R.profiles/R.idf were built from
  // — a track's own vector carrying a tag the model doesn't trust would only
  // dilute its own magnitude against every centroid, never help it.
  const discTags = gateTags(TAGS, tagGate(TAGS));
  for (const o of out) {
    if (!o.id) continue;
    o.suggest = rank(o, discTags, R.profiles, R.idf, { top:3 }).map(b => ({ ...b, axis:CFG[b.id]?.axis ?? null }));
    o.tags = topTags(o, discTags, R.idf);
    o.thinData = isThinSignal(o, discTags);
  }
  S.discover = out.filter(o => o.id);
  S.discAt = 0;
  S.discoverFrom = src?.name ?? 'everything you listen to';
  S.discSound = null;
  $('#land').hidden = true; $('#app').hidden = false;
  go('discover');
  // Then listen to the picks, if listening is on, and re-rank the cards still
  // to come by how they sound. Nothing at all happens here otherwise.
  fire(discListen(src, weights));
}

/** Candidates from Last.fm's similar artists and their top tracks: the path a key buys. */
async function discoverLastfm(key, seeds, ownedArtist, ownedTrack) {
  const lfm = p => fetch('https://ws.audioscrobbler.com/2.0/?' + new URLSearchParams({ ...p, api_key:key, format:'json' })).then(r => r.json());
  const cand = new Map();
  for (const [i, s] of seeds.entries()) {
    stage(`Finding artists like ${s.name}…`, i / (seeds.length + 8));
    try {
      const r = await lfm({ method:'artist.getsimilar', artist:s.name, autocorrect:'1', limit:'50' });
      for (const a of r.similarartists?.artist ?? []) {
        if (ownsAnyOf(a.name, ownedArtist)) continue;          // the hard filter
        const c = cand.get(a.name) ?? { name:a.name, score:0, via:[] };
        c.score += (+a.match || 0) * s.w;
        if (c.via.length < 3) c.via.push(s.name);
        cand.set(a.name, c);
      }
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }

  const ranked = [...cand.values()].sort((a,b) => b.score - a.score);
  const out = [];
  for (const c of ranked) {
    if (out.length >= 30) break;
    stage(`Checking ${c.name}…`, 0.8 + out.length/40);
    let top;
    try { top = await lfm({ method:'artist.gettoptracks', artist:c.name, limit:'4' }); } catch { continue; }
    await new Promise(r => setTimeout(r, 200));
    // The artist's own tags, so a track you do not own yet can still be ranked
    // against your playlists by the same model the inbox uses.
    let lfmTags = [];
    try {
      const tg = await lfm({ method:'artist.gettoptags', artist:c.name, autocorrect:'1' });
      lfmTags = (tg.toptags?.tag ?? []).slice(0, 20)
        .map(x => [String(x.name).toLowerCase(), +x.count || 0]).filter(([, n]) => n > 0);
    } catch {}
    await new Promise(r => setTimeout(r, 200));
    for (const t of top.toptracks?.track ?? []) {
      if (ownedTrack.has(norm(c.name) + '|' + norm(t.name))) continue;
      out.push({ artist:c.name, track:t.name, via:c.via, lfmTags }); break;
    }
  }
  return out;
}

/* ---------- Discover without a key (core/audio/discover.mjs) ----------
 * Deezer's "fans also like" and ListenBrainz's listening-session neighbours
 * for the artists you play most (or the seed playlist's), reached through the
 * ISRC and Wikidata exactly as the Engine screen's neighbour bridge is, and
 * cached under the same key, so either screen's lookups save the other's.
 * The neighbours you don't own are the candidates; Spotify search finds one
 * track by each. Keyless, and nothing to install. */
const discTracks = () => [...(LIB.liked ?? []),
  ...LIB.playlists.filter(p => !isMirrorPlaylist(p)).flatMap(p => p.tracks ?? [])];
const discWeightOf = weights => t => Math.max(0, ...(t?.artists ?? []).map(a => weights.get(a?.name) ?? 0));

async function discoverKeyless(src, weights, ownedArtist, ownedTrack) {
  stage('Getting ready to ask who sits near your artists…', 0.03);
  await engineLoad();
  const D = BetterfyDiscover;
  const { artists, seeds } = D.seedArtists(src ? src.tracks : discTracks(), { weightOf: discWeightOf(weights), limit: 25 });
  if (!seeds.length) return [];
  let cache = null;
  try { cache = (await idb.get(BRIDGE_KEY))?.raw ?? null; } catch { /* no cache: ask everything */ }
  let last = 0;
  const { raw } = await BetterfyBridgeFetch.gatherBridge(artists, {
    deezer: deezerJsonp, json: corsJson, cache,
    onProgress: p => {
      const now = performance.now();
      if (now - last < 300) return;
      last = now;
      const name = { deezer: 'Deezer', listenbrainz: 'ListenBrainz', wikidata: 'Wikidata' }[p.stage] ?? p.stage;
      stage(`Asking ${name} who sits near your artists… ${Math.min(p.done, p.total)} of ${p.total}`,
            0.05 + 0.6 * (p.total ? p.done / p.total : 1));
    },
  });
  try { await idb.set(BRIDGE_KEY, { at: Date.now(), raw }); } catch { /* the next run asks again */ }

  const cands = D.bridgeCandidates(raw, seeds, { isOwned: n => ownsAnyOf(n, ownedArtist), limit: 60 });
  const out = [];
  for (const c of cands) {
    if (out.length >= 30) break;
    stage(`Finding ${c.name} on Spotify…`, 0.7 + out.length / 120);
    let r;
    try { r = await sp(`/search?q=${encodeURIComponent(`artist:${c.name}`)}&type=track&limit=10`); } catch { continue; }
    const hit = D.pickTrack(r?.tracks?.items ?? [], c.name,
      { isOwnedTrack: h => ownedTrack.has(norm(h.artists?.[0]?.name ?? '') + '|' + norm(h.name)) });
    if (hit) out.push({ artist: c.name, track: hit.name, via: c.via, hit });
  }
  return out;
}

/* ---------- Discover by sound (core/audio/discover.mjs) ----------
 * With listening on, the picks are heard like library tracks (ISRC → Deezer
 * preview → the model) and the cards still to come are re-ranked by how close
 * each sounds to the seed: the seed playlist's heard tracks, or the heard
 * tracks of the artists you play. A heard pick also gets sound-led playlist
 * picks (the filed tracks it sounds like vote), so a pick with no tags can
 * still be offered somewhere.
 *
 * Picks' records stay in memory, never in the library's store: they are not
 * your tracks, and the File screen's "mixes with" must not offer them. The
 * library queue pauses while picks are heard (one model, one Worker) and
 * carries on afterwards. Off, or nothing heard to compare against, and
 * Discover is exactly what it was. */
const DISC = { run: 0, ctrl: null, store: null, seed: null, index: null, memb: null, done: 0, missed: 0, busy: false, again: false };

async function discListen(src, weights) {
  const run = ++DISC.run;
  if (DISC.ctrl?.running) await DISC.ctrl.stop('a new run');
  if (typeof audioSettings !== 'function' || !audioSettings().on) return;
  const picks = (S.discover ?? []).filter(o => o.isrc);
  if (!picks.length) return;
  const ahead = (S.discover ?? []).slice(S.discAt ?? 0).filter(o => o.isrc);
  try { await audioInit(); await engineLoad(); } catch { return; }
  if (run !== DISC.run || audioConnection() !== 'ok') return;
  await audioRefresh();
  const A = BetterfyAudio, D = BetterfyDiscover;
  const index = SOUND.space?.audio?.index ?? D.candidateIndex(AUDIO.records);
  const name = src?.name ?? 'what you play';
  const seed = D.seedSound(src ? src.tracks : D.weightedSeedIds(discTracks(), discWeightOf(weights), index), index);
  if (!seed.ok) {
    S.discSound = { state: 'thin', n: seed.n, need: D.DISCOVER_SOUND.minSeed, name };
    return discSoundRedraw();
  }
  Object.assign(DISC, { seed, index, memb: soundMembership() });

  DISC.store ??= A.openAudioStore({ indexedDB: null });
  DISC.ctrl ??= A.createAudioController({
    store: DISC.store,
    lookup: (isrc, o) => A.lookup(isrc, { jsonp: deezerJsonp, ...o }),
    fetchPreview: url => A.fetchPreview(url, { fetch: (u, init) => fetch(u, init) }),
    decode: buf => A.decodeTo16k(buf),
    loadEar: audioEars,
    dspFillPerRun: 0,
    onChange: vm => { if (vm.done > DISC.done) { DISC.done = vm.done; fire(discApply()); } },
  });
  const have = await DISC.store.getAll();
  const todo = ahead.filter(o => !have.has(o.id))
    .map(o => ({ id: o.id, isrc: o.isrc, durationMs: o.dur }));
  S.discSound = { state: 'listening', heard: 0, total: picks.length, name, n: seed.n };
  DISC.done = 0;
  await discApply();

  const resume = !!AUDIO.ctrl?.running;
  if (resume) await AUDIO.ctrl.stop('hearing Discover picks');
  try { if (todo.length) await DISC.ctrl.start(todo); }
  finally {
    if (resume && audioSettings().on) fire(audioStart({ quiet: true }));
  }
  if (run !== DISC.run) return;
  await discApply();
  if (S.discSound) S.discSound.state = 'done';
  discSoundRedraw();
}

/** Score what has been heard so far, and re-rank the cards after this one. */
async function discApply() {
  if (DISC.busy) { DISC.again = true; return; }
  DISC.busy = true;
  try {
    do {
      DISC.again = false;
      const D = BetterfyDiscover, recs = await DISC.store.getAll();
      const cand = D.candidateIndex(recs);
      const fits = D.soundFits(cand, DISC.seed);
      let heard = 0, missed = 0;
      for (const o of S.discover ?? []) {
        if (!o.isrc) continue;
        const rec = recs.get(o.id);
        if (rec?.miss) { missed++; continue; }
        const row = cand.get(o.id);
        if (!row) continue;
        heard++;
        o.fit = fits.get(o.id) ?? null;
        o.tagSuggest ??= o.suggest ?? [];
        o.suggest = discPicks(D.soundPlace(row.emb, DISC.index, DISC.memb), o.tagSuggest);
        if (globalThis.BetterfyAudio?.dspSoundVM) o.sound = audioSoundVM(rec) ?? undefined;
      }
      S.discover = D.rerank(S.discover ?? [], fits, { from: (S.discAt ?? 0) + 1 });
      if (S.discSound) Object.assign(S.discSound, { heard, missed });
    } while (DISC.again);
  } finally { DISC.busy = false; }
  discSoundRedraw();
}

/** Sound picks lead and the tag engine's best stays one key away, as on the File card. */
function discPicks(sound, tags) {
  if (!sound.length) return tags;
  const out = sound.slice(0, 2).map(sg => ({ ...sg, axis: CFG[sg.id]?.axis ?? null, evidence: { sound: sg.score } }));
  for (const sg of [...tags, ...sound.slice(2)]) {
    if (out.length >= 3) break;
    if (!out.some(o => o.id === sg.id)) out.push(sg);
  }
  return out;
}

/** Redraw the "by sound" line in place: the card under it may be playing. */
function discSoundRedraw() {
  if (view !== 'discover') return;
  const el = document.getElementById('discSnd');
  if (el) el.outerHTML = discSoundLine();
  else store.touch('ui.discover');
}

/** The discovery currently on the card. */
function discAt() {
  const d = S.discover ?? [];
  return d.length ? d[Math.min(S.discAt ?? 0, d.length - 1)] : null;
}

/* The "by sound" pieces of the Discover screen. Each draws nothing at all
 * without sound data, so the card is byte for byte what it was before
 * (test/fixtures/ui4/discover-*.html). */
const discListenOn = () => typeof audioSettings === 'function' && audioSettings().on === true;
function discSoundLine() {
  const s = S.discSound;
  if (!s) return '';
  const name = esc(s.name);
  if (s.state === 'thin') return `<p class="why discsnd" id="discSnd">Not ranked by sound yet: ${s.n} of ${name}’s tracks ${s.n === 1 ? 'has' : 'have'} been heard, and it takes ${s.need} to compare against. Listening carries on in the background.</p>`;
  const missed = s.missed ? ` ${s.missed} had no preview to hear.` : '';
  if (s.state === 'listening') return `<p class="why discsnd" id="discSnd"><span class="tag snd">by sound</span> Listening to the picks: ${s.heard} of ${s.total} heard so far.${missed} The cards after this one move up or down by how close they sound to ${name}.</p>`;
  return `<p class="why discsnd" id="discSnd"><span class="tag snd">by sound</span> Ranked by how close they sound to ${name}: ${s.heard} of ${s.total} picks heard.${missed}</p>`;
}
/** How close the pick on the card sounds to the seed, in words. '' until it has been heard. */
function discFitHTML(t) {
  const f = t?.fit?.fit;
  if (!Number.isFinite(f)) return '';
  const name = esc(S.discSound?.name ?? S.discoverFrom ?? 'the seed');
  const [cls, say] = f >= 0.75 ? ['hi', `Sounds right at home in ${name}`]
    : f >= 0.45 ? ['mid', `Close to ${name}’s sound`]
    : f >= 0.2 ? ['lo', `On the edge of ${name}’s sound`]
    : ['out', `Doesn’t sound much like ${name}`];
  const near = (t.fit.near ?? []).slice(0, 2).map(id => typeof soundTrackName === 'function' ? soundTrackName(id) : null)
    .filter(x => x?.title).map(x => `${esc(x.title)} — ${esc(x.artist)}`);
  return `<div class="discfit ${cls}" title="${(f * 100).toFixed(0)}% — 100% is as close as ${name}’s own tracks are to each other"><span class="tag snd">by sound</span> ${say}${near.length ? `<span class="sub">closest: ${near.join('; ')}</span>` : ''}</div>`;
}

function vDiscover() {
  const d = S.discover ?? [];
  const pls = LIB.playlists.filter(p => p.tracks.length >= 10).sort((a,b) => b.tracks.length - a.tracks.length);
  const hasKey = !!lfmKey();
  const head = `<h1>Discover</h1>
    <p class="lede">Every artist and track you already own is subtracted before ranking — including each artist named inside a collaboration — so nothing here recycles your library.
      <b>Everything I listen to</b> weights your top artists and recent plays above what is merely filed; pick a playlist instead for that playlist's radio.</p>
    ${hasKey ? '' : `<div class="note discnokey">
      <b>No key needed.</b> Picks come from Deezer's and ListenBrainz's “fans also like” for the artists you play${discListenOn() ? ', then ranked by how they sound' : ''}.
      A free Last.fm key adds its own similar artists and genre tags; it's saved on this device.
      <div class="rowbtns" style="margin-top:8px">
        <input id="lfmKeyDisc" placeholder="Last.fm API key (optional)" size="34">
        <button class="b" id="saveLfmDiscover">Save key &amp; find new music</button>
        <a class="b sm" href="https://www.last.fm/api/account/create" target="_blank" rel="noopener">Get a key</a>
      </div>
    </div>`}
    <div class="rowbtns" style="margin-bottom:16px">
      <select id="discPl">
        <option value="">Everything I listen to</option>
        <optgroup label="Playlist radio">
          ${pls.map(p => `<option value="${esc(p.id)}" ${S.discSeed===p.id?'selected':''}>${esc(p.name)}</option>`).join('')}
        </optgroup>
      </select>
      <button class="b p" id="discRun" >Find new music</button>
    </div>`;

  // WP-C3: "find tracks that sound like ___". '' without CLAP records.
  const sounds = typeof soundSearchHTML === 'function' ? soundSearchHTML() : '';
  if (!d.length) return head + sounds + emptyState('Nothing found yet', 'Pick what to seed from above, then hit Find new music. A run takes a minute or two.');

  const i = Math.min(S.discAt ?? 0, d.length - 1), t = d[i];
  const opts = Object.entries(CFG).filter(([,v])=>v.target).map(([id,v])=>({id,...v})).sort((a,b)=>a.name.localeCompare(b.name));
  const art = artHTML({ art:t.art, id:t.id, title:t.track },
                      `data-dplay="${esc(t.id)}" data-ddur="${t.dur ?? 0}"`);

  const best = (t.suggest ?? [])[0];
  return head + sounds + discSoundLine() + `<div class="counter" style="margin:0 0 14px">
      <span style="font-family:var(--mono); font-size:11.5px; letter-spacing:.12em; text-transform:uppercase; color:var(--accent)">via ${esc((t.via??[]).join(', '))} · ${i+1} of ${d.length}</span>
      <span>from ${esc(S.discoverFrom)}</span>
    </div>
    <div class="deck">
      <div class="card disc">
        <div class="prog"><i style="width:${((i+1)/d.length*100).toFixed(2)}%"></i></div>
        <div class="now">
          <div class="artwrap">${art}</div>
          <div class="txt">
            <p class="t">${esc(t.track)}</p><p class="a">${esc(t.artist)}</p>
            <div class="m"><span>${esc(t.album??'')}</span><span>${esc((t.released??'').slice(0,4))}</span><span>${mmss(t.dur)}</span></div>${trackChip(t)}${discFitHTML(t)}
          </div>
        </div>${trackStrip(t)}

        <div class="player">
          <button class="tbtn" id="pToggle" aria-label="Play">${ICON_PLAY}</button>
          <input class="seek" id="seek" type="range" min="0" max="${t.dur ?? 0}" step="1000" value="0"
                 aria-label="Playing position" disabled>
          <span class="tm"><span id="pTime">0:00</span> / <span id="pDur">${mmss(t.dur)}</span></span>
        </div>
        <p class="pdev" id="pDev"></p>

        ${(t.tags??[]).length ? tagChips(t.tags, t.thinData) : ''}
        ${best ? `<button class="fitcall" data-dfile="${esc(best.id)}">
            <span class="mid"><span class="nm">Would sit well in ${esc(best.name)}</span>
              <span class="ax"><b>${esc(best.axis??'')}</b> playlist · ${best.via === 'sound' ? 'by how it sounds next to what you filed there' : 'ranked by the same model the file queue uses'}</span>${pickEvidence(best)}</span>
            ${pickBand(best)}<span class="sc">${(best.score*100).toFixed(0)}% fit</span>
          </button>` : ''}
        ${(t.suggest??[]).length > 1 ? `<div class="picks">${t.suggest.slice(1,3).map((sg,n)=>
          `<button class="pick" data-dfile="${esc(sg.id)}"><span class="k">${n+2}</span>
           <span class="mid"><span class="nm">${esc(sg.name)}</span><span class="ax">${esc(sg.axis??'')} playlist</span>${pickEvidence(sg)}</span>
           <span class="rt">${pickBand(sg)}<span class="sc">${(sg.score*100).toFixed(0)}%</span>
             <span class="bar"><i style="width:${(sg.score*100).toFixed(0)}%"></i></span></span></button>`).join('')}</div>` : ''}
        ${(t.suggest??[]).length ? '' : `<p class="why" style="margin-top:20px">No confident suggestion — ${hasKey ? 'Last.fm has no tags for this artist' : 'nothing says what this artist is yet'}, or it fits nothing you have. Pick a playlist below.</p>`}

        <div class="rowbtns" style="margin-top:20px">
          ${best ? `<button class="b big go grow" data-dfile="${esc(best.id)}">Add to ${esc(best.name)}</button>` : ''}
          <button class="b big" data-dnav="1" ${i>=d.length-1?'disabled':''}>Next →</button>
        </div>
        <div class="rowbtns" style="margin-top:10px">
          <button class="b sm" data-dnav="-1" ${i===0?'disabled':''}>← Back</button>
          <button class="b sm" data-like="${esc(t.id)}">Like</button>
          <a class="b sm" href="https://open.spotify.com/track/${esc(t.id)}" target="_blank" rel="noopener">Open</a>
          <select id="discAnyPl"><option value="">Add to another playlist…</option>${opts.map(o=>`<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('')}</select>
        </div>
      </div>
    </div>`;
}

/** Add the track on the card to a playlist, and take it off the pile. */
async function discAdd(playlistId) {
  const d = S.discover ?? [], at = Math.min(S.discAt ?? 0, d.length - 1), t = d[at];
  if (!t) return;
  const name = CFG[playlistId]?.name ?? playlistId;
  try {
    await addTracks(playlistId, [t.id]);
    await logAction({ op:'add', playlistId, playlistName:name, trackIds:[t.id], reason:'added from discovery' });
    const when = (await getLog())[0]?.at;
    toast(`Added “${t.track}” to ${name}.`, () => undoAction(when));
    d.splice(at, 1);
    S.discAt = Math.max(0, Math.min(at, d.length - 1));
    render();
  } catch (e) { toast('Failed: ' + e.message); }
}

