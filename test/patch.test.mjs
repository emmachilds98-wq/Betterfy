import { test } from 'node:test';
import assert from 'node:assert/strict';
import { patch } from '../web/app/patch.mjs';
import { mount } from './fixtures/minidom.mjs';

// A5 of docs/BUILD-5-PLAN.md: the keyed patcher, run against a small fake DOM
// that blurs and un-scrolls a node when it moves, as browsers do.

const li = (k, txt = k) => `<li data-key="${k}">${txt}</li>`;
const list = keys => `<ul>${keys.map(k => li(k)).join('')}</ul>`;
const byKey = el => Object.fromEntries(el.querySelectorAll('[data-key]').map(n => [n.getAttribute('data-key'), n]));
const keys = ul => ul.childNodes.map(n => n.getAttribute('data-key'));

test('the result matches the new markup', () => {
  const { el } = mount('<p class="a">old</p><span>x</span>');
  patch(el, '<p class="b" title="t">new</p><em>y</em>');
  assert.equal(el.innerHTML, '<p class="b" title="t">new</p><em>y</em>');
});

test('insert: existing keyed nodes are kept, the new one is added in place', () => {
  const { el } = mount(list(['a', 'b', 'c']));
  const before = byKey(el);
  patch(el, list(['a', 'x', 'b', 'c']));
  const after = byKey(el);
  assert.deepEqual(keys(el.firstChild), ['a', 'x', 'b', 'c']);
  for (const k of ['a', 'b', 'c']) assert.equal(after[k], before[k], `${k} kept`);
});

test('remove: the dropped node goes, the rest are the same nodes', () => {
  const { el } = mount(list(['a', 'b', 'c']));
  const before = byKey(el);
  patch(el, list(['a', 'c']));
  assert.deepEqual(keys(el.firstChild), ['a', 'c']);
  assert.equal(byKey(el).a, before.a);
  assert.equal(byKey(el).c, before.c);
  assert.equal(before.b.parentNode, null);
});

test('reorder: every node is reused and ends up in the new order', () => {
  const { el } = mount(list(['a', 'b', 'c', 'd']));
  const before = byKey(el);
  patch(el, list(['d', 'b', 'a', 'c']));
  assert.deepEqual(keys(el.firstChild), ['d', 'b', 'a', 'c']);
  for (const [k, n] of Object.entries(byKey(el))) assert.equal(n, before[k]);
});

test('reorder with text changes updates the text inside the kept nodes', () => {
  const { el } = mount(list(['a', 'b']));
  const before = byKey(el);
  patch(el, `<ul>${li('b', 'B!')}${li('a', 'A!')}</ul>`);
  assert.equal(el.innerHTML, '<ul><li data-key="b">B!</li><li data-key="a">A!</li></ul>');
  assert.equal(byKey(el).a, before.a);
});

test('a focused input keeps focus, caret and typed value when its row moves', () => {
  const row = (k, v) => `<div data-key="${k}"><input name="${k}" value="${v}"></div>`;
  const { doc, el } = mount(row('a', '') + row('b', ''));
  const input = byKey(el).b.firstChild;
  input.focus();
  input.value = 'jungl';
  input.setSelectionRange(2, 4, 'forward');
  // The screen re-renders with the rows swapped and a stale value attribute.
  patch(el, row('b', 'stale') + row('a', ''));
  assert.equal(el.firstChild.firstChild, input, 'same input node');
  assert.equal(doc.activeElement, input, 'still focused');
  assert.equal(input.value, 'jungl', 'typed value not overwritten');
  assert.deepEqual([input.selectionStart, input.selectionEnd, input.selectionDirection], [2, 4, 'forward']);
  assert.equal(input.getAttribute('value'), 'stale', 'attribute still follows the markup');
});

test('an unfocused input takes the value from the new markup', () => {
  const { el } = mount('<input value="a">');
  const input = el.firstChild;
  input.value = 'typed';
  patch(el, '<input value="b">');
  assert.equal(el.firstChild, input);
  assert.equal(input.value, 'b');
});

test('checkboxes and options follow the markup', () => {
  const { el } = mount('<input type="checkbox"><select><option>a</option><option selected>b</option></select>');
  patch(el, '<input type="checkbox" checked><select><option selected>a</option><option>b</option></select>');
  const [box, sel] = el.childNodes;
  assert.equal(box.checked, true);
  assert.deepEqual(sel.childNodes.map(o => o.selected), [true, false]);
});

test('scroll is kept on the root and on a keyed list that moves', () => {
  const { el } = mount(`<div data-key="x"></div><div data-key="list">${list(['a', 'b'])}</div>`);
  el.scrollTop = 120;
  const scroller = byKey(el).list;
  scroller.scrollTop = 340;
  patch(el, `<div data-key="list">${list(['a', 'b', 'c'])}</div><div data-key="x"></div>`);
  assert.equal(el.firstChild, scroller);
  assert.equal(scroller.scrollTop, 340);
  assert.equal(el.scrollTop, 120);
});

test('data-keep-scroll keeps the offset on an unkeyed scroller', () => {
  const { el } = mount('<div data-keep-scroll><p>1</p></div>');
  const box = el.firstChild;
  box.scrollLeft = 50;
  patch(el, '<div data-keep-scroll><p>1</p><p>2</p></div>');
  assert.equal(el.firstChild, box);
  assert.equal(box.scrollLeft, 50);
});

test('nested keys: inner nodes are kept across an outer reorder', () => {
  const group = (g, items) => `<section data-key="${g}"><h2>${g}</h2>${list(items)}</section>`;
  const { el } = mount(group('g1', ['a', 'b']) + group('g2', ['c', 'd']));
  const before = byKey(el);
  patch(el, group('g2', ['d', 'c', 'e']) + group('g1', ['b']));
  const after = byKey(el);
  assert.deepEqual(el.childNodes.map(n => n.getAttribute('data-key')), ['g2', 'g1']);
  assert.deepEqual(keys(after.g2.childNodes[1]), ['d', 'c', 'e']);
  assert.deepEqual(keys(after.g1.childNodes[1]), ['b']);
  for (const k of ['g1', 'g2', 'b', 'c', 'd']) assert.equal(after[k], before[k], `${k} kept`);
  assert.equal(before.a.parentNode, null);
});

test('the same key under two parents does not jump between them', () => {
  const { el } = mount(`<div data-key="p">${li('k', 'one')}</div><div data-key="q">${li('k', 'two')}</div>`);
  const pk = byKey(el).p.firstChild;
  patch(el, `<div data-key="p">${li('k', 'one!')}</div><div data-key="q">${li('k', 'two!')}</div>`);
  assert.equal(byKey(el).p.firstChild, pk);
  assert.equal(el.innerHTML, `<div data-key="p">${li('k', 'one!')}</div><div data-key="q">${li('k', 'two!')}</div>`);
});

test('a key whose tag changed gets a fresh node', () => {
  const { el } = mount('<p data-key="a">x</p>');
  const old = el.firstChild;
  patch(el, '<div data-key="a">x</div>');
  assert.notEqual(el.firstChild, old);
  assert.equal(el.innerHTML, '<div data-key="a">x</div>');
});

test('duplicate keys do not lose a node', () => {
  const { el } = mount(list(['a']));
  patch(el, list(['a', 'a']));
  assert.deepEqual(keys(el.firstChild), ['a', 'a']);
});

test('unkeyed siblings match by position and tag, and keyed ones are not stolen', () => {
  const { el } = mount(`<p>1</p>${li('k')}<p>2</p>`);
  const [p1, k] = el.childNodes;
  patch(el, `<p>one</p><p>two</p>${li('k')}`);
  assert.equal(el.childNodes[0], p1);
  assert.equal(el.childNodes[2], k);
  assert.equal(el.innerHTML, `<p>one</p><p>two</p>${li('k')}`);
});

test('removed attributes go; untouched nodes see no attribute writes', () => {
  const { doc, el } = mount('<a href="/x" class="on" data-key="l">x</a><b>y</b>');
  patch(el, '<a href="/x" data-key="l">x</a><b>y</b>');
  assert.equal(el.firstChild.hasAttribute('class'), false);
  assert.deepEqual(doc.ops.filter(o => o[0] === 'attr'), []);
});

test('an identical re-render moves nothing', () => {
  const html = list(['a', 'b', 'c']) + '<p>t</p>';
  const { doc, el } = mount(html);
  const before = [...el.querySelectorAll('[data-key]')];
  doc.ops.length = 0;
  patch(el, html);
  const moved = doc.ops.filter(o => o[0] === 'detach' && before.includes(o[1]));
  assert.deepEqual(moved, []);
  assert.equal(el.innerHTML, html);
});

test('data-patch="skip" leaves the existing element alone', () => {
  const { el } = mount('<div data-patch="skip" data-key="w"><audio src="a.mp3"></audio></div>');
  const w = el.firstChild;
  patch(el, '<div data-patch="skip" data-key="w"></div>');
  assert.equal(el.firstChild, w);
  assert.equal(w.innerHTML, '<audio src="a.mp3"></audio>');
});

test('focus outside the patched element is not touched', () => {
  const { doc, el } = mount('<p>x</p>');
  const outside = doc.body.appendChild(doc.createElement('input'));
  outside.focus();
  patch(el, '<p>y</p>');
  assert.equal(doc.activeElement, outside);
});

test('a removed focused input is not refocused', () => {
  const { doc, el } = mount('<input data-key="q">');
  el.firstChild.focus();
  patch(el, '<p>gone</p>');
  assert.equal(doc.activeElement, doc.body);
});

test('the fake DOM blurs and un-scrolls on move, so the tests above mean something', () => {
  const { doc, el } = mount('<div><input></div><p></p>');
  const [box, p] = el.childNodes;
  box.firstChild.focus();
  box.scrollTop = 9;
  el.insertBefore(p, box);
  assert.equal(doc.activeElement, box.firstChild, 'moving a sibling does not blur');
  el.insertBefore(box, p);
  assert.equal(doc.activeElement, doc.body);
  assert.equal(box.scrollTop, 0);
});
