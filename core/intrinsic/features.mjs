// Intrinsic features — properties of the record, not opinions about its artist.
//
// Everything here is read from fields `snapshot.mjs` already captures, so none
// of it costs a request, a key or a second website. That is the point: these
// are the signals whose coverage is 100% by construction, because they are
// facts about the listener's own library rather than somebody's answer about
// somebody's artist.
//
// The deliberate omission is genre. Nothing in this file tries to name what a
// record is. It describes shape — how long, what kind of release, which decade,
// whose label family — and lets the account's own playlists supply the meaning.
import { eraOfYear } from '../ontology/index.mjs';
import { mirrorPredicate } from '../playlists/mirror.mjs';

export const FEATURES_VERSION = '4.0.0';

/**
 * Adds inside this window are treated as one crate. Digging happens in
 * sittings: a run of adds minutes apart is one decision about a group of
 * records, and counting it as forty independent decisions overstates it.
 *
 * A prior, not a measurement — it goes into the fit sweep.
 */
export const SESSION_GAP_MS = 6 * 60 * 60 * 1000;

/* ---------- label family, from the ISRC ---------- */

/**
 * An ISRC is `CC-XXX-YY-NNNNN`: country, registrant, year of reference, and a
 * serial. `CC`+`XXX` identifies the **registrant** — in practice the label, or
 * the distributor a label releases through.
 *
 * This is already in `library.json` and today is used only as an identity key
 * in `core/identity/track-identity.mjs`. As an affinity signal it is unusually
 * good: factual metadata rather than crowd opinion, and sharp in exactly the
 * catalogue this app serves, where a label *is* a genre statement.
 *
 * Returns the registrant key, or null. Deliberately does not attempt to name
 * the label: affinity needs the code to be *the same*, never to be *known*,
 * which is why this needs no lookup and cannot go stale.
 */
export function registrantOf(track) {
  const raw = String(track?.isrc ?? '').replace(/-/g, '').toUpperCase();
  // CC (2 letters) + XXX (3 alphanumeric) + YY (2 digits) + NNNNN (5 digits).
  if (!/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(raw)) return null;
  return raw.slice(0, 5);
}

/**
 * How many distinct playlists each registrant spans, and the playlist count it
 * is measured against.
 *
 * This is the fix for the aggregator problem, and it is self-correcting rather
 * than a maintained blocklist. Plenty of independent releases carry a
 * distributor's registrant instead of a label's, which would otherwise link
 * unrelated records. But a distributor appears *everywhere* in a library and a
 * real label concentrates, so weighting by inverse span costs nothing to
 * maintain and needs no list of who the aggregators are — the same reasoning
 * that made tags IDF-weighted in the first place.
 */
export function registrantIndex(lib, { skip = null, isMirror = null } = {}) {
  const structural = mirrorPredicate(lib, { also: isMirror ?? undefined });
  const span = new Map();
  let playlists = 0;
  for (const p of lib?.playlists ?? []) {
    if (structural(p)) continue;
    playlists++;
    const seen = new Set();
    for (const t of p.tracks ?? []) {
      if (!t?.id || skip?.has(t.id)) continue;
      const r = registrantOf(t);
      if (r) seen.add(r);
    }
    for (const r of seen) span.set(r, (span.get(r) ?? 0) + 1);
  }
  return { span, playlists, version: FEATURES_VERSION };
}

/**
 * The weight a registrant's agreement is worth: `log(N / span)`, floored at
 * zero.
 *
 * A registrant spanning every playlist scores 0 and contributes nothing, which
 * is the correct treatment of a distributor. One appearing in two of forty
 * playlists scores ~3.
 */
export function registrantWeight(registrant, index) {
  if (!registrant) return 0;
  const span = index?.span?.get(registrant) ?? 0;
  const n = index?.playlists ?? 0;
  if (!span || !n) return 0;
  return Math.max(0, Math.log(n / span));
}

/* ---------- format shape ---------- */

/**
 * What kind of *object* this record is, independent of what it sounds like.
 *
 * A seven-minute cut on a two-track release is a club record. A three-minute
 * cut at track four of twelve is an album song. That distinction is enormous
 * in a DJ's library, it is invisible to every tag source, and it costs nothing
 * — which also makes it the only signal here that works on an account with
 * nothing filed yet.
 */
export function formatOf(track) {
  const ms = Number(track?.duration_ms) || 0;
  const albumTracks = Number(track?.albumTracks) || 0;
  return {
    minutes: ms > 0 ? ms / 60000 : null,
    albumType: track?.albumType ?? null,        // single | album | compilation
    albumTracks: albumTracks || null,
    trackNo: Number(track?.trackNo) || null,
    explicit: !!track?.explicit,
  };
}

/** Era of the *pressing*, with the caveat the Spotify adapter already carries:
 *  a 1994 record reissued in 2019 reads 2019, and a listener filing by era
 *  means 1994. Evidence, not fact. */
export function eraOf(track) {
  const s = String(track?.released ?? '');
  const year = /^\d{4}/.test(s) ? Number(s.slice(0, 4)) : null;
  return eraOfYear(year) ?? null;
}

/* ---------- add sessions ---------- */

/**
 * Split a playlist's adds into sittings, newest-agnostic.
 *
 * Returns one entry per track id with its session index, plus the session
 * bounds. Used for cohesion: two tracks added in one sitting were one decision.
 *
 * **Not used when scoring a held-out track against the playlist it was held
 * out of.** A track's `added_at` *is* part of the membership record being
 * predicted, so feeding it back in is leakage wearing a different hat. It is
 * legitimate for placing an unfiled liked song, where the timestamp comes from
 * the like rather than from the placement under test — see
 * `core/validate/loo.mjs`, which excludes it by construction.
 */
export function sessionsOf(playlist, { gap = SESSION_GAP_MS } = {}) {
  const rows = (playlist?.tracks ?? [])
    .filter(t => t?.id && t.added_at)
    .map(t => ({ id: t.id, at: Date.parse(t.added_at) }))
    .filter(r => Number.isFinite(r.at))
    .sort((a, b) => a.at - b.at);

  const session = new Map();
  const bounds = [];
  let idx = -1, prev = null;
  for (const r of rows) {
    if (prev === null || r.at - prev > gap) { idx++; bounds.push({ from: r.at, to: r.at, n: 0 }); }
    session.set(r.id, idx);
    bounds[idx].to = r.at;
    bounds[idx].n++;
    prev = r.at;
  }
  return { session, bounds, sessions: bounds.length };
}

/* ---------- a playlist's intrinsic profile ---------- */

const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

function sd(xs, m) {
  if (xs.length < 2 || m === null) return null;
  const v = xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

function shares(values) {
  const out = new Map();
  let n = 0;
  for (const v of values) { if (v === null || v === undefined) continue; n++; out.set(v, (out.get(v) ?? 0) + 1); }
  if (n) for (const [k, c] of out) out.set(k, c / n);
  return out;
}

/**
 * Describe a playlist by the shape of its members, with `skip` honoured so the
 * validation harness can ask what this bucket looked like before a given track
 * joined it.
 */
export function profileOf(playlist, { skip = null } = {}) {
  const tracks = (playlist?.tracks ?? []).filter(t => t?.id && !skip?.has(t.id));
  const mins = tracks.map(t => formatOf(t).minutes).filter(x => x !== null);
  const pops = tracks.map(t => Number(t?.popularity)).filter(Number.isFinite);
  const tot  = tracks.map(t => formatOf(t).albumTracks).filter(x => x !== null);
  const m = mean(mins), p = mean(pops), tt = mean(tot);

  return {
    id: playlist?.id ?? null,
    n: tracks.length,
    minutes:     { mean: m,  sd: sd(mins, m) },
    albumTracks: { mean: tt, sd: sd(tot, tt) },
    popularity:  { mean: p,  sd: sd(pops, p) },
    albumType:   shares(tracks.map(t => formatOf(t).albumType)),
    era:         shares(tracks.map(t => eraOf(t))),
    registrant:  shares(tracks.map(t => registrantOf(t))),
    version: FEATURES_VERSION,
  };
}

/* ---------- scoring a track against a profile ---------- */

/**
 * Closeness of a number to a distribution, on 0..1.
 *
 * A z-score run through a decay rather than a hard band, because a bucket with
 * a wide spread should not reject a track for being 30 seconds long — it
 * should say "this bucket does not care about length", which a large sd does
 * automatically. With too few members to have a spread, fall back to a
 * proportional comparison rather than inventing a confident answer.
 */
export function numericCloseness(x, { mean: m, sd: s }) {
  if (x === null || x === undefined || m === null || m === undefined) return null;
  if (s === null || !(s > 0)) {
    if (!(m > 0)) return null;
    return Math.max(0, 1 - Math.abs(x - m) / m);
  }
  const z = Math.abs(x - m) / s;
  return Math.exp(-0.5 * z * z);       // 1 at the mean, ~0.6 at 1σ, ~0.14 at 2σ
}

/**
 * The non-graph part of the score: how much this record's *shape* looks like
 * this bucket's shape.
 *
 * Every component may be null, which means "this cannot be judged" rather than
 * "this scores zero" — a track with no ISRC should not be penalised for a
 * missing field, and a bucket of four tracks has no spread to compare against.
 * Combining happens in `space.mjs`, which weights only what is present.
 */
export function shapeScores(track, profile, { registrants = null } = {}) {
  const f = formatOf(track);
  const era = eraOf(track);
  const reg = registrantOf(track);
  const pop = Number(track?.popularity);

  // Registrant agreement is the share of the bucket on the same registrant,
  // scaled by how informative that registrant is at all (§ registrantWeight).
  // Normalising by log(playlists) keeps the product on a 0..1-ish scale
  // without pretending the ceiling is exact.
  let registrant = null;
  if (reg && registrants) {
    const w = registrantWeight(reg, registrants);
    if (w > 0) {
      const share = profile?.registrant?.get(reg) ?? 0;
      const ceiling = Math.log(Math.max(2, registrants.playlists));
      registrant = Math.min(1, share * (w / ceiling));
    } else {
      registrant = 0;     // a distributor code: judged, and judged worthless
    }
  }

  return {
    minutes:     numericCloseness(f.minutes, profile?.minutes ?? {}),
    albumTracks: numericCloseness(f.albumTracks, profile?.albumTracks ?? {}),
    popularity:  numericCloseness(Number.isFinite(pop) ? pop : null, profile?.popularity ?? {}),
    albumType:   f.albumType ? (profile?.albumType?.get(f.albumType) ?? 0) : null,
    era:         era ? (profile?.era?.get(era) ?? 0) : null,
    registrant,
  };
}
