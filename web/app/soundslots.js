/* ---------- the sound layer's slots on the File and Discover cards ----------
 * docs/UI-BUILD-PLAN.md, UI-4. A track may carry `sound` (a SoundVM) and a
 * suggestion `band` (a BandVM) and `evidence` (an EvidenceVM); the renderers are
 * web/ui/sound.mjs's. Each slot reads its field and draws nothing at all without
 * it — not an empty wrapper, not a space — so a card with no such data is byte
 * for byte the card it was before the slots existed (test/fixtures/ui4/). */
const soundSlot = (cls, html) => html ? `<div class="${cls}">${html}</div>` : '';
// Where a track's SoundVM comes from: one set on the track itself, else what
// listening heard, through the audio side's adapters (WP-D4's dspSoundVM, and
// the mood/voice/energy labels once checked). Both stay null until their flags
// are on. No records or no adapter means no sound.
const soundOf = t => t?.sound ?? (t?.id && typeof AUDIO !== 'undefined' && AUDIO.records
  && globalThis.BetterfyAudio?.dspSoundVM ? audioSoundVM(AUDIO.records.get(t.id)) : null);
const audioSoundVM = r => {
  const A = BetterfyAudio, d = A.dspSoundVM(r) ?? null;
  return A.mergeSoundVM && typeof labelsShownNow === 'function' ? A.mergeSoundVM(d, A.labelSoundVM(r, labelsShownNow())) : d;
};
const trackChip = t => { const vm = soundOf(t); return vm ? soundSlot('sndchip', soundChip(vm)) : ''; };
const trackStrip = t => { const vm = soundOf(t); return vm ? soundSlot('sndstrip', sectionStrip(vm)) : ''; };
const pickBand = sg => sg?.band ? bandChip(sg.band) : '';
const pickEvidence = sg => sg?.evidence ? evidenceBadges(sg.evidence) : '';

/* Sound-first filing: the File screen's picks for one track. Heard, the
 * engine's sound-led picks lead (soundPicks, in the engine section) and the tag
 * engine's best stays one key away as a second opinion; not heard, the tag
 * engine's, exactly as before. Guarded, so the card still draws where the
 * engine section isn't present. Where this account's Score says tags blended
 * with the engine and similar artists beat tags alone, the blend stands in for
 * the tag engine's picks (blendPicks, app/blend.js); anywhere else it returns
 * them untouched. */
function filePicks(t) {
  const tags = typeof blendPicks === 'function' ? blendPicks(t, t?.suggest ?? []) : t?.suggest ?? [];
  const sound = typeof soundPicks === 'function' ? soundPicks(t) : [];
  if (!sound.length) return tags;
  const out = sound.slice(0, 2);
  for (const sg of [...tags, ...sound.slice(2)]) {
    if (out.length >= 3) break;
    if (!out.some(o => o.id === sg.id)) out.push(sg);
  }
  return out;
}
/* The band the File card shows for its leading pick: the Engine's calibrated
 * verdict on this track when it has judged it, else the pick's own band. */
const fileBand = (t, picks) => typeof cardBand === 'function' && typeof engineDecisionOf === 'function' ? cardBand(picks, engineDecisionOf(t?.id)) : picks?.[0]?.band ?? null;
/* The cards that are sure, with where each goes: "File the N sure ones". */
const fileSure = () => typeof sureOnes !== 'function' ? [] : sureOnes(R.backlog, { picksOf: filePicks, bandOf: (t, picks) => fileBand(t, picks) });
/* The sound ID's most specific genre for a track, only when it is a sure reading
 * (the same 0.7 the band uses), else null. File's roll-forward matches on it. */
function fileRollSound(t) {
  const id = typeof soundIdOf === 'function' ? soundIdOf(t)?.id : null;
  return id?.genre && id.genre.conf >= 0.7 ? id.path?.at?.(-1)?.name ?? null : null;
}
let LIKED_ISRC = null, LIKED_ISRC_FOR = null;
/** A liked track's ISRC by id (backlog rows do not carry it). */
function likedIsrc(id) {
  if (LIKED_ISRC_FOR !== LIB) { LIKED_ISRC = new Map((LIB.liked ?? []).map(x => [x.id, x.isrc])); LIKED_ISRC_FOR = LIB; }
  return LIKED_ISRC.get(id);
}
/* What the track sounds like: "Drum & Bass › Jungle · 172 BPM", with why, the
 * filed tracks it sounds most like and the heard tracks it mixes with behind a
 * tap. Nothing at all until it has been heard and the sound space is ready. */
function soundIdHTML(t) {
  const s = typeof soundIdOf === 'function' ? soundIdOf(t) : null;
  const id = s?.id;
  if (!id || (!id.genre && !id.bpm)) return '';
  const band = id.genre ? (id.genre.conf >= 0.7 ? 'HIGH' : id.genre.conf >= 0.45 ? 'LIKELY' : 'AMBIGUOUS') : null;
  const path = id.genre ? id.path.map(p => esc(p.name)).join('<span class="sep">›</span>') : 'No clear genre';
  const bpm = id.bpm ? `<span class="bpm" title="${id.bpm.from === 'genre' ? 'Half or double time settled by the genre it sounds like' : 'Measured from the preview'}">${Math.round(id.bpm.value)} BPM</span>` : '';
  const blend = id.blend ? `<span class="tag" title="Two genres in one clip">${esc(id.blend[0])} + ${esc(id.blend[1])}</span>` : '';
  const who = n => { const x = soundTrackName(n.id); return `${esc(x.title)}<span class="sub"> — ${esc(x.artist)}</span>`; };
  const where = n => (n.playlists ?? []).map(p => CFG[p]?.name ?? p).slice(0, 2).map(esc).join(', ');
  const rel = { double: ' · double time', half: ' · half time', same: '' };
  return `<div class="sndid"><div class="sndid-h"><span>Sounds like</span> <b class="sndid-path">${path}</b>${bpm}${blend}${band ? pickBand({ band }) : ''}</div>
    ${s.neighbours.length || s.mix.length || id.why.length ? `<details><summary>Why, and what it sounds like and mixes with</summary>
      ${id.why.length ? `<span class="why">${esc(id.why.join('; '))}.</span>` : ''}
      <div class="sndcols">
        ${s.neighbours.length ? `<div><h4>Sounds like</h4><ol>${s.neighbours.map(n => `<li>${who(n)}${where(n) ? ` <span class="sub">in ${where(n)}</span>` : ''}</li>`).join('')}</ol></div>` : ''}
        ${s.mix.length ? `<div><h4>Mixes with</h4><ol>${s.mix.map(m => `<li>${who(m)} <span class="sub mono">${Math.round(m.bpm)} BPM${rel[m.rel] ?? ''}</span></li>`).join('')}</ol></div>` : ''}
      </div></details>` : ''}</div>`;
}
/* One line under the picks saying where they came from when it isn't sound,
 * and how to make it sound. Nothing at all where listening can't be asked about. */
function soundNote(t, picks) {
  if (typeof audioSettings !== 'function' || typeof SOUND === 'undefined') return '';
  if (picks[0]?.via === 'sound') return '';
  const set = audioSettings();
  if (!set.on) return LS.getItem('bf_sound_nudge') === 'no' ? ''
    : `<div class="sndnote" style="margin-top:12px"><p class="why" style="margin:0 0 8px">These picks come from artist tags.
       Switch on listening to file by how each track sounds instead.</p>
       <div class="rowbtns"><button class="b sm" data-soundon>Listen to my music</button><button class="b sm" data-soundno>Not now</button></div></div>`;
  if (SOUND.status === 'working') return `<p class="why sndnote" style="margin-top:12px">Learning how your playlists sound…</p>`;
  if (SOUND.status === 'error') return `<p class="why sndnote" style="margin-top:12px">Couldn’t learn how your playlists sound: ${esc(SOUND.err)}. Picks are from tags.</p>`;
  const rec = AUDIO.records?.get(t.id);
  if (!rec) return `<p class="why sndnote" style="margin-top:12px">Not heard yet. Picks are from tags until it is.</p>`;
  if (rec.miss) return `<p class="why sndnote" style="margin-top:12px">Couldn’t be heard (no preview), so picks are from tags.</p>`;
  if (SOUND.status === 'ready' && !SOUND.space) return `<p class="why sndnote" style="margin-top:12px">Not enough of your genre playlists heard yet to compare against. Picks are from tags.</p>`;
  return '';
}

