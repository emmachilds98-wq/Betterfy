// BUILD-7 U3: the sound-label check asked on File, one question at most a
// session, feeding the same gate as Sources' "Check sound labels".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as A from '../web/audio/labels-view.mjs';
import { view as inboxView, labelAskSlot } from '../web/screens/inbox.mjs';

const { askFor, askText, askHTML, withVerdict, checksFor, agreement, REVIEW_MIN, AGREE_MIN } = A;

const BUNDLE = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
const between = (from, to) => {
  const i = BUNDLE.indexOf(from), j = BUNDLE.indexOf(to, i);
  assert.ok(i > 0 && j > i, `${from} not found — rebuild with node build-web.mjs`);
  return BUNDLE.slice(i, j);
};
const rec = (id, { moods = [['dark', 0.6], ['energetic', 0.4]], voice = 0.8, energy = 0.7 } = {}) =>
  ({ v: 1, id, heads: { v: '1.0.0', ...(moods ? { moods } : {}), ...(voice != null ? { voice } : {}) },
     dsp: energy != null ? { energy } : null });

test('the question words: energy only when clearly high or low, voice either way, moods joined', () => {
  assert.equal(askText('energy', 0.7), 'Does this sound energetic?');
  assert.equal(askText('energy', 0.2), 'Does this sound calm, low in energy?');
  assert.equal(askText('energy', 0.5), null);
  assert.equal(askText('voice', 'vocal'), 'Does this have vocals?');
  assert.equal(askText('voice', 'instrumental'), 'Is this instrumental, with no vocals?');
  assert.equal(askText('mood', ['dark']), 'Does this sound dark?');
  assert.equal(askText('mood', ['dark', 'energetic', 'uplifting']), 'Does this sound dark, energetic and uplifting?');
  assert.equal(askText('mood', null), null);
});

test('askFor: first candidate with an open type, fewest answers first, decided types never asked', () => {
  const records = new Map([['a', rec('a')], ['b', rec('b', { energy: 0.5 })]]);
  assert.equal(askFor([], records, {}), null);
  assert.equal(askFor(['zz'], records, {}), null);
  // Nothing answered yet: the first label type in order.
  assert.equal(askFor(['a'], records, {}).type, 'mood');
  // a's mood answered: the next type on a.
  let checks = { a: { mood: true, at: 1, seen: {} } };
  assert.equal(askFor(['a'], records, checks).type, 'voice');
  // Every type on a answered: on to b, whose middling energy is not asked; mood has the most answers, so voice first.
  checks = { a: { mood: true, voice: true, energy: true, at: 1, seen: {} }, x: { mood: true, at: 1, seen: {} } };
  const b = askFor(['a', 'b'], records, checks);
  assert.equal(b.id, 'b'); assert.equal(b.type, 'voice'); assert.equal(b.seen, 'vocal');
  // A type that has already decided (on) is never asked.
  const on = {};
  for (let i = 0; i < REVIEW_MIN; i++) on['t' + i] = { mood: true, voice: true, energy: true, at: 1, seen: {} };
  assert.equal(askFor(['a', 'b'], records, on), null);
});

test('answers from File and Sources count once each: one track is one verdict wherever it came from', () => {
  const me = 'u1';
  let all = {};
  // File says yes to energy on track a...
  all = withVerdict(all, me, 'a', 'energy', true, 0.7, 1, 'file');
  assert.deepEqual(agreement(checksFor(all, me)).energy, { reviewed: 1, right: 1, rate: 1, on: false });
  // ...and Sources answers the same track and type: still one, the later answer wins.
  all = withVerdict(all, me, 'a', 'energy', false, 0.7, 2, 'sources');
  assert.deepEqual(agreement(checksFor(all, me)).energy, { reviewed: 1, right: 0, rate: 0, on: false });
  assert.equal(checksFor(all, me).a.from.energy, 'sources');
  // A different track answered on File counts as its own.
  all = withVerdict(all, me, 'b', 'energy', true, 0.8, 3, 'file');
  assert.equal(agreement(checksFor(all, me)).energy.reviewed, 2);
  // Clearing a verdict clears where it came from.
  all = withVerdict(all, me, 'b', 'energy', null, 0.8, 4, 'file');
  assert.equal(checksFor(all, me).b.from, undefined);
  // Answers from File alone open the gate like Sources' do.
  let gate = {};
  for (let i = 0; i < REVIEW_MIN; i++) gate = withVerdict(gate, me, 't' + i, 'voice', i < Math.ceil(REVIEW_MIN * AGREE_MIN), 'vocal', i, 'file');
  assert.equal(agreement(checksFor(gate, me)).voice.on, true);
  // Old verdicts without a source still read the same.
  assert.equal(agreement({ q: { mood: true, at: 1, seen: {} } }).mood.reviewed, 1);
});

test('askHTML: the question with Yes/No/Not sure, then a thank-you that says how far the gate is', () => {
  assert.equal(askHTML(null), '');
  const ask = { id: 'a"<', type: 'energy', text: 'Does this sound energetic?' };
  const q = askHTML(ask, { title: 'Song <1>' });
  assert.match(q, /id="labelAsk"/);
  assert.match(q, /Quick check on <b>Song &lt;1&gt;<\/b>:<\/span> Does this sound energetic\?/);
  assert.match(q, /data-ask="a&quot;&lt;"/);
  for (const v of ['1', '0', 'pass']) assert.match(q, new RegExp(`data-act="lblask" data-lok="${v}"`));
  const done = askHTML({ ...ask, answered: true }, { checks: { a: { energy: true } } });
  assert.match(done, /Thanks\. That counts toward showing energy labels\. 1 of 20 answers needed\./);
  assert.doesNotMatch(done, /data-act/);
  assert.match(askHTML({ ...ask, answered: 'pass' }), /No problem\./);
});

/** The page's code, lifted from the bundle, with a fake session and store. */
function page({ records, checks = {}, session = new Map() } = {}) {
  const kv = new Map([['labelchecks', { u1: checks }]]);
  const sb = {
    AUDIO: { records }, LIB: { user: { id: 'u1' }, playlists: [], liked: [] }, LS: { getItem: () => null },
    isMirrorPlaylist: () => false, BetterfyAudio: { ...A }, fire: p => p,
    sessionStorage: { getItem: k => session.get(k) ?? null, setItem: (k, v) => session.set(k, String(v)) },
    idb: { get: async k => kv.get(k) ?? null, set: async (k, v) => { kv.set(k, structuredClone(v)); } },
    document: { getElementById: () => null },
  };
  vm.createContext(sb);
  vm.runInContext(between('let LABELCHECKS = null;', '/** The heard tracks for the engine')
    + ';LABELCHECKS = { u1: ' + JSON.stringify(checks) + ' }; globalThis.api = { labelAskHTML, labelAskAct, get all() { return LABELCHECKS; } };', sb);
  return { api: sb.api, kv, session };
}

test('the page asks once a session: answered or not, a later filing gets no second question', async () => {
  const records = new Map([['a', rec('a')], ['b', rec('b')]]);
  const p = page({ records });
  const h1 = p.api.labelAskHTML([{ id: 'a', title: 'Alpha' }]);
  assert.match(h1, /Quick check on <b>Alpha<\/b>/);
  // The same question stays through repaints while its track is in view.
  assert.equal(p.api.labelAskHTML([{ id: 'a', title: 'Alpha' }]), h1);
  await p.api.labelAskAct({ dataset: { lok: '1' } });
  assert.equal(p.kv.get('labelchecks').u1.a.mood, true);
  assert.equal(p.kv.get('labelchecks').u1.a.from.mood, 'file');
  assert.match(p.api.labelAskHTML([{ id: 'a' }]), /Thanks/);
  // A second tap does not answer again.
  await p.api.labelAskAct({ dataset: { lok: '0' } });
  assert.equal(p.kv.get('labelchecks').u1.a.mood, true);
  // The next track filed: nothing more this session.
  assert.equal(p.api.labelAskHTML([{ id: 'b' }]), '');
  // A reload in the same tab (same sessionStorage) does not ask either.
  const again = page({ records, session: p.session });
  assert.equal(again.api.labelAskHTML([{ id: 'b' }]), '');
  // A new session asks again, about what is still open.
  assert.match(page({ records }).api.labelAskHTML([{ id: 'b' }]), /Does this sound dark and energetic\?/);
});

test('the page draws nothing with no records, no account, or a candidate with nothing to ask', () => {
  assert.equal(page({ records: new Map() }).api.labelAskHTML([{ id: 'a' }]), '');
  const p = page({ records: new Map([['a', rec('a', { moods: null, voice: null, energy: 0.5 })]]) });
  assert.equal(p.api.labelAskHTML([{ id: 'a' }]), '');
  // Nothing asked means the session is not spent.
  assert.equal(p.session.size, 0);
});

test('File: the question sits after the card, never inside it, and only with a candidate', () => {
  assert.equal(labelAskSlot({ S: {} , labelAskHTML: () => 'X' }), '');
  assert.equal(labelAskSlot({ S: { labelFiled: { id: 'a' } } }), '');
  let got = null;
  assert.equal(labelAskSlot({ S: { labelPlaying: { id: 'p' }, labelFiled: { id: 'a' } }, labelAskHTML: c => { got = c; return 'Q'; } }), 'Q');
  assert.deepEqual(got.map(c => c.id), ['p', 'a']);

  const t = { id: 't1', title: 'One', artist: 'Ar', artists: [{ id: 'ar', name: 'Ar' }], tags: [], added: 'today', dur: 1000,
              suggest: [{ id: 'P1', name: 'Jungle', score: 0.9, band: 'HIGH', via: 'history', count: 3, total: 4 }] };
  const S = { inboxAt: 0, fileSel: new Set(), labelFiled: { id: 'a', title: 'Alpha' } };
  const html = inboxView({ S, R: { backlog: [t] }, CFG: { P1: { name: 'Jungle', target: true } }, LIB: { liked: [t] },
    esc: s => String(s ?? ''), filePicks: x => x.suggest, artHTML: () => '', ICON_PLAY: '', mmss: () => '', trackChip: () => '',
    tagChips: () => '', trackStrip: () => '', soundIdHTML: () => '', soundNote: () => '', pickEvidence: () => '', pickBand: () => '',
    matchMedia: () => ({ matches: false }), labelAskHTML: () => '<div class="lblask" id="labelAsk">Q</div>' });
  const card = html.indexOf('id="swipeCard"'), ask = html.indexOf('id="labelAsk"'), deckEnd = html.indexOf('<div class="prog fileprog">');
  assert.ok(card > 0 && ask > card && ask < deckEnd, 'between the deck and the progress bar');
  // Still a Sure card with its filled File button.
  assert.match(html, /data-state="sure"/);
  assert.match(html, /class="b big go grow" data-act="filesel"/);
  // The card's markup closes before the question starts.
  const cardHTML = html.slice(card, ask);
  assert.ok(cardHTML.includes('</details>'), 'the card ends before the question');
});
