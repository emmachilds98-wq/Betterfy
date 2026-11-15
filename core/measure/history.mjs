// @bundle engine BetterfyMeasure 190
// Measurement from History (BUILD-5-PLAN §7): pure counts over the account's
// own action log (web/app/actionlog.js), nothing fitted, nothing leaves the
// device. Four numbers, each with its own minimum sample before it is shown:
//
//   queue    share of filings that came from the first QUEUE_HEAD cards of the
//            File queue (is the queue's order worth anything?). Needs the
//            `queuePos` the File screen now writes on each filing; entries
//            from before that carry none and are left out.
//   batch    share of filings made in the "sure" band (`band: 'sure'`) that
//            were later moved away or undone.
//   tidy     per tier (`move.tier`: sure / likely / unsure), the share of Tidy
//            moves that were not undone. History holds only what was done, not
//            what was offered, so this is "kept after you made it".
//   discover share of tracks added from Discovery that were not undone.
//
// An entry is `{ at, op, playlistId, trackIds, reason?, group?, move?,
// undoneAt?, queuePos?, band? }`; an `undo` entry (`of`) marks older logs.

export const QUEUE_HEAD = 20;
/** Fewest counted entries before a number is worth showing. */
export const MIN_N = Object.freeze({ queue: 10, batch: 10, tidy: 5, discover: 10 });
export const TIERS = Object.freeze(['sure', 'likely', 'unsure']);

const ids = e => (Array.isArray(e?.trackIds) ? e.trackIds : []);
const rate = (k, n) => (n > 0 ? k / n : null);
const isFiling = e => e.op === 'add' && !e.group && /^filed (from inbox|with the rest of)/.test(e.reason ?? '');
const isDiscover = e => (e.op === 'add' || e.op === 'add-liked') && /discovery/.test(e.reason ?? '');

/** Everything in `log` (any order), oldest first, without malformed entries. */
const clean = log => (Array.isArray(log) ? log : []).filter(e => e && typeof e.at === 'string' && e.op)
  .slice().sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

function undoneSet(log) {
  const s = new Set();
  for (const e of log) if (e.op === 'undo' && e.of) s.add(e.of);
  return s;
}

/** Was this entry undone, or its track later taken out of the same playlist? */
function reversed(e, log, undone) {
  if (e.undoneAt || undone.has(e.at)) return true;
  if (!e.playlistId) return false;
  const mine = new Set(ids(e));
  return log.some(x => x.op === 'remove' && x.at > e.at && x.playlistId === e.playlistId
    && !(x.group && x.group === e.group) && ids(x).some(t => mine.has(t)));
}

export function measureHistory(rawLog) {
  const log = clean(rawLog), undone = undoneSet(log);
  const filings = log.filter(isFiling);

  const queued = filings.filter(e => Number.isFinite(e.queuePos));
  const head = queued.filter(e => e.queuePos < QUEUE_HEAD).length;

  const sure = filings.filter(e => e.band === 'sure');
  const sureBack = sure.filter(e => reversed(e, log, undone)).length;

  const tidy = {};
  for (const t of TIERS) tidy[t] = { n: 0, kept: 0, rate: null };
  for (const e of log) {
    const tier = e.op === 'remove' && e.move?.tier;
    if (!TIERS.includes(tier)) continue;
    const grp = e.group ? log.filter(x => x.group === e.group && x.op !== 'undo') : [e];
    const back = grp.some(x => x.undoneAt || undone.has(x.at));
    tidy[tier].n++;
    if (!back) tidy[tier].kept++;
  }
  for (const t of TIERS) tidy[t].rate = rate(tidy[t].kept, tidy[t].n);

  const disc = log.filter(isDiscover);
  const discKept = disc.filter(e => !(e.undoneAt || undone.has(e.at))).length;

  return {
    queue: { n: queued.length, head, share: rate(head, queued.length), of: filings.length },
    batch: { n: sure.length, back: sureBack, precision: sure.length ? 1 - sureBack / sure.length : null,
             movedShare: rate(sureBack, sure.length) },
    tidy,
    discover: { n: disc.length, kept: discKept, rate: rate(discKept, disc.length) },
  };
}

/** The summary lines. `pc` formats a 0..1 share. */
export function measureLines(m, pc = x => Math.round(x * 100) + '%') {
  const few = (label, n, min) => `${label}: not enough data yet (${n} of ${min})`;
  const out = [];
  out.push(m.queue.n >= MIN_N.queue
    ? `Queue order: ${pc(m.queue.share)} of ${m.queue.n} filings came from the first ${QUEUE_HEAD} cards`
    : few('Queue order', m.queue.n, MIN_N.queue));
  out.push(m.batch.n >= MIN_N.batch
    ? `Batch filing: ${pc(m.batch.movedShare)} of ${m.batch.n} sure-band filings later moved or undone`
    : few('Batch filing', m.batch.n, MIN_N.batch));
  for (const t of TIERS) {
    const x = m.tidy[t];
    out.push(x.n >= MIN_N.tidy ? `Tidy ${t}: ${pc(x.rate)} of ${x.n} moves kept`
                               : few(`Tidy ${t}`, x.n, MIN_N.tidy));
  }
  out.push(m.discover.n >= MIN_N.discover
    ? `Discover: ${pc(m.discover.rate)} of ${m.discover.n} added tracks kept`
    : few('Discover keep rate', m.discover.n, MIN_N.discover));
  return out;
}
