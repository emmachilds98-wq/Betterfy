// Release dates at the precision Spotify gave them (docs/RELEASE-RADAR-PLAN.md §4.1).
//
// `release_date_precision` is `day`, `month` or `year`. The rule: keep the raw
// string and the precision, sort by a resolved timestamp, and never display a
// day (or a month) nobody told us. A year-only release is not "1 January".
//
// Sorting: an imprecise date never sorts above a precise one from the same
// period. A month-only release sorts just below every dated day of that month,
// a year-only release just below every dated release of that year, so neither
// jumps to the top of the feed by accident. Grouping follows the same rule: a
// month-only release sits under its month's header, a year-only one under its
// own "2026, month not given" header after that year's months.

export const PRECISIONS = Object.freeze(['day', 'month', 'year']);
export const DAY_MS = 864e5;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

const pad = n => String(n).padStart(2, '0');

/**
 * Read a release date. `raw` is Spotify's string ("2026-03-12", "2026-03",
 * "2026"), `precision` its claimed precision. When they disagree the coarser
 * one wins: Spotify's own reference sample pairs "1981-12" with `year`, and a
 * string too short for its precision cannot be read finer than it is.
 * Returns `{ raw, precision, y, m, d, ts, end, ok }`; `ok: false` (no usable
 * year, or "0000") sorts last and is never in a time window.
 */
export function parseDate(raw, precision) {
  const s = String(raw ?? '').trim();
  const mt = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(s);
  const y = mt ? +mt[1] : 0;
  if (!mt || !y) return { raw: s, precision: 'unknown', y: 0, m: 0, d: 0, ts: -Infinity, end: -Infinity, ok: false };
  const given = mt[3] ? 'day' : mt[2] ? 'month' : 'year';
  const claimed = PRECISIONS.includes(precision) ? precision : given;
  const p = PRECISIONS[Math.max(PRECISIONS.indexOf(claimed), PRECISIONS.indexOf(given))];
  const m = p === 'year' ? 0 : +mt[2];
  const d = p === 'day' ? +mt[3] : 0;
  if ((p !== 'year' && (m < 1 || m > 12)) || (p === 'day' && (d < 1 || d > 31))) return parseDate(String(y), 'year');
  let ts, end;
  if (p === 'day') { ts = Date.UTC(y, m - 1, d); end = ts + DAY_MS - 1; }
  else if (p === 'month') { ts = Date.UTC(y, m - 1, 1) - 1; end = Date.UTC(y, m, 1) - 1; }
  else { ts = Date.UTC(y, 0, 1) - 2; end = Date.UTC(y + 1, 0, 1) - 1; }
  return { raw: s, precision: p, y, m, d, ts, end, ok: true };
}

/** Long form, exactly as precise as given: "12 March 2026", "March 2026", "2026". */
export function dateLabel(p) {
  if (!p?.ok) return 'date unknown';
  if (p.precision === 'day') return `${p.d} ${MONTHS[p.m - 1]} ${p.y}`;
  if (p.precision === 'month') return `${MONTHS[p.m - 1]} ${p.y}`;
  return String(p.y);
}

/** Short form for a row under its month header: "12 Mar", "Mar 2026", "2026". */
export function shortLabel(p) {
  if (!p?.ok) return 'date unknown';
  if (p.precision === 'day') return `${p.d} ${MONTHS[p.m - 1].slice(0, 3)}`;
  if (p.precision === 'month') return `${MONTHS[p.m - 1].slice(0, 3)} ${p.y}`;
  return String(p.y);
}

/** The feed's group: "2026-03" for day and month precision, "2026" for year, "unknown" otherwise. */
export const groupKey = p => !p?.ok ? 'unknown' : p.precision === 'year' ? String(p.y) : `${p.y}-${pad(p.m)}`;

/** The header for a group key: "March 2026", "2026, month not given", "Date not given". */
export function groupLabel(key) {
  const mt = /^(\d{4})(?:-(\d{2}))?$/.exec(key ?? '');
  if (!mt) return 'Date not given';
  return mt[2] ? `${MONTHS[+mt[2] - 1]} ${mt[1]}` : `${mt[1]}, month not given`;
}

/** The oldest moment the default feed shows: `years` back from `now` (UTC midnight). */
export function cutoffTs(now, years = 2) {
  const t = new Date(now);
  return Date.UTC(t.getUTCFullYear() - years, t.getUTCMonth(), t.getUTCDate());
}

/** Could this release fall on or after `cutoff`? Judged on the period's end, so a
 *  year-only "2024" is still in a window that starts in November 2024. */
export const inWindow = (p, cutoff) => !!p?.ok && p.end >= cutoff;
