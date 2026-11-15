// A8 of docs/BUILD-5-PLAN.md: golden HTML compares on normalised whitespace,
// so a new empty slot on its own line (or a re-indented template) no longer
// breaks a byte-for-byte golden. The old "put the slot on the same line" rule
// in docs/HANDOFF.md §4 is retired by this.
//
// The rule is JSX's: whitespace that contains a line break and touches a tag
// is formatting, so it is dropped; any other run of whitespace collapses to
// one space. So `${a}\n${b}` with both slots empty equals `${a}${b}`, and a
// re-indented template still matches, but a real gap between two inline
// tags (`<b>a</b> <i>b</i>`) still counts. Whitespace inside a tag between
// attributes is collapsed too. Every tag, attribute, value and word of text
// still has to match, in order.
import assert from 'node:assert/strict';

export function normHTML(html) {
  return String(html)
    // Inside a tag: collapse the gaps between attributes, drop the one before >.
    .replace(/<[^>]+>/g, tag => tag.replace(/\s+/g, ' ').replace(/\s+(\/?>)$/, '$1'))
    // Line-broken whitespace next to a tag, or at either end, is formatting.
    .replace(/>[^\S\n]*\n\s*/g, '>')
    .replace(/\s*\n[^\S\n]*</g, '<')
    .replace(/\s+/g, ' ')
    .trim();
}

/** assert.equal on normalised markup; the diff shows one tag per line. */
export function assertSameHTML(actual, expected, message) {
  const a = normHTML(actual), e = normHTML(expected);
  if (a === e) return;
  const lines = s => s.replace(/></g, '>\n<');
  assert.equal(lines(a), lines(e), message);
}
