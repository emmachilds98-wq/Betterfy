// Accounts that are not the owner's: the page must load and say something
// sensible for a brand-new library and for one with no genre-named playlists,
// and the fixture generator must stay deterministic and the right shape.
//
// BUILD-7 Q1 (docs/BUILD-7-PLAN.md §6): small, moodOnly, typical and large,
// each end to end against the fake Spotify. The first analysis reaches File by
// itself; auto Score runs or says in words why it waits; no Settings row or
// gate claims more than the numbers behind it; every screen opens with no
// page errors and a way forward in every empty state; nothing is written to
// Spotify before a tap. On large, time to first card and long tasks during the
// first analysis are printed (copied into the PR; no budget is set).
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeAccount, ACCOUNT_KINDS } from '../fixtures/accounts.mjs';
import { skip, launch, openApp, ready, until } from './harness.mjs';

const GENRE_WORDS = /house|techno|rock|jazz|ambient|indie|hip hop|garage|jungle|drum|metal|reggae|soul|folk|pop|classical/i;

test('fixtures: deterministic, synthetic and the sizes the plan names', () => {
  const sizes = Object.fromEntries(ACCOUNT_KINDS.map(k => {
    const a = makeAccount(k);
    assert.deepEqual(a, makeAccount(k), k + ' is reproducible');
    const ids = a.playlists.flatMap(p => p.tracks).concat(a.liked).map(t => t.id);
    assert.ok(ids.every(id => /^fx\d{20}$/.test(id)), 'only fabricated track ids');
    assert.equal(new Set(a.playlists.map(p => p.id)).size, a.playlists.length, 'unique playlist ids');
    return [k, { pl: a.playlists.length, tracks: a.playlists.reduce((s, p) => s + p.tracks.length, 0), liked: a.liked.length }];
  }));
  assert.deepEqual(sizes.empty, { pl: 0, tracks: 0, liked: 0 });
  assert.ok(sizes.small.pl === 3 && sizes.small.liked > 20);
  assert.ok(sizes.typical.tracks >= 600 && sizes.typical.tracks <= 900, 'about 800 tracks');
  assert.ok(sizes.large.liked >= 5000 && sizes.large.pl === 60);
  assert.ok(!makeAccount('small').playlists.some(p => /house|techno|rock|jazz|ambient|indie|hip hop/i.test(p.name.replace(/Late Night|Gym|Sunday/, ''))));
  // moodOnly (Q1): 600 liked, 12 playlists, none named after a genre, several after moods.
  assert.deepEqual(sizes.moodOnly.pl, 12);
  assert.equal(sizes.moodOnly.liked, 600);
  const mood = makeAccount('moodOnly').playlists.map(p => p.name);
  assert.ok(!mood.some(n => GENRE_WORDS.test(n)), 'no playlist is named after a genre: ' + mood.join(', '));
  assert.ok(mood.filter(n => /chill|happy|sad|feels|focus|vibes|rainy|late night/i.test(n)).length >= 5, 'several are moods');
});

let browser;
test.before(async () => { if (!skip) browser = await launch(); });
test.after(async () => { await browser?.close(); });

test('an empty account loads with no errors and nothing to file', { skip }, async () => {
  const app = await openApp(browser, { kind: 'empty' });
  try {
    await ready(app.page);
    await app.page.waitForTimeout(800);
    assert.deepEqual(app.errors, []);
    assert.equal(await app.page.locator('#swipeCard').count(), 0, 'no card');
    assert.ok(await app.page.locator('#app').isVisible());
    assert.ok(!app.fake.writes().length, 'nothing written');
  } finally { await app.close(); }
});

test('a small account with no genre playlists loads and offers its liked songs', { skip }, async () => {
  const app = await openApp(browser, { kind: 'small' });
  try {
    await ready(app.page);
    await app.page.waitForSelector('#swipeCard');
    assert.deepEqual(app.errors, []);
    assert.ok(await app.page.evaluate(() => R.backlog.length) > 20);
    // A card with nothing to suggest must still be skippable with the button.
    await app.page.click('#swipeCard [data-act="skip"]');
    await app.page.waitForTimeout(500);
    assert.deepEqual(app.errors, []);
  } finally { await app.close(); }
});

/* ---------- Q1: every shaped library, end to end ---------- */

/** Every empty state on the screen now that leaves no way forward: no button or link in it, and
 *  none enabled anywhere on the screen it sits on. A compact empty state is by design one line
 *  under the control that fills it (Discover's Find button, C5; Tidy's band switch), so a
 *  control on the same screen counts. */
const deadEnds = page => page.evaluate(() => {
  const ACT = 'button:not([disabled]), a[href], select, [data-act], [data-go]';
  const shown = el => el.offsetParent !== null || el.getClientRects().length > 0;
  return [...document.querySelectorAll('.empty-state, .empty')]
    .filter(el => shown(el) && !el.querySelector(ACT))
    .filter(el => { const root = el.closest('[data-uh], #main, .settings-body') ?? document.body;
      return ![...root.querySelectorAll(ACT)].some(b => shown(b) && !b.closest('.nav, nav')); })
    .map(el => el.innerText.replace(/\s+/g, ' ').trim().slice(0, 120));
});

/** Open each screen in turn; returns { screen: [dead-end texts] } for any that have one. */
async function walkScreens(page) {
  const found = {};
  const note = async name => { await page.waitForTimeout(250); const d = await deadEnds(page); if (d.length) found[name] = d; };
  for (const v of ['inbox', 'tidy', 'discover', 'lists', 'new', 'shuffle']) {
    await page.evaluate(v => go(v), v);
    await page.waitForFunction(v => document.querySelector('#main')?.dataset.view === v, v);
    await note(v);
  }
  await page.evaluate(() => { go('inbox'); openSettings(true); });
  await note('settings');
  await page.evaluate(() => openUnderHood('engine'));
  await page.waitForSelector('[data-uh="engine"]');
  await note('engine');
  await page.evaluate(() => { openSettings(false); go('inbox'); });
  return found;
}

/** What the Settings rows and the Engine screen claim, against the numbers behind them. */
async function claims(page) {
  return page.evaluate(() => {
    const rows = helperRowsNow();
    const eng = document.querySelector('[data-uh="engine"]')?.innerText ?? '';
    return { rows: rows.map(r => ({ id: r.id, on: r.on, kind: r.kind, status: r.status, did: r.did })),
      filed: autoScoreFiled(), targets: engineTargets().length, scored: !!localStorage.getItem('bf_autoscore'),
      autoLine: document.querySelector('#autoScore')?.innerText ?? '', eng,
      // A verdict shown as on: the gate tags the Engine screen draws ("passed", "used on File").
      onTags: [...document.querySelectorAll('[data-uh="engine"] .tag')].map(t => t.innerText.trim())
        .filter(t => /^(passed|used on File|on)$/i.test(t)) };
  });
}

const KINDS = { small: 120000, moodOnly: 150000, typical: 200000, large: 420000 };

for (const [kind, ms] of Object.entries(KINDS)) {
  test(`${kind}: first analysis, auto Score, honest rows, every screen, nothing written`, { skip, timeout: ms + 60000 }, async () => {
    const acc = makeAccount(kind);
    const app = await openApp(browser, { account: acc, phone: kind !== 'large' });
    const { page } = app;
    try {
      // Long tasks since the page opened (buffered), kept for the large run's report.
      await page.evaluate(() => {
        globalThis.__long = [];
        try { new PerformanceObserver(l => { for (const e of l.getEntries()) globalThis.__long.push([Math.round(e.startTime), Math.round(e.duration)]); })
          .observe({ type: 'longtask', buffered: true }); } catch { /* no long-task timing */ }
      });
      const t0 = Date.now() - await page.evaluate(() => performance.now());
      await ready(page, ms);
      assert.equal(await page.locator('#analyseGo').count(), 0, 'no "Analyse my library" button to press');

      // File shows a card by itself; the first analysis (if it has anything to do) starts and ends by itself.
      await page.waitForSelector('#swipeCard', { timeout: ms });
      const firstCard = await page.evaluate(() => Math.round(performance.now()));
      await until(() => page.evaluate(() => typeof ANALYSE === 'undefined' || (!ANALYSE.running && !ANALYSE.pending)),
        'the first analysis to finish by itself', ms);
      const analysedMs = Date.now() - t0;
      assert.equal(app.fake.writes().length, 0, 'nothing written to Spotify before a tap');

      const dead = await walkScreens(page);
      assert.deepEqual(dead, {}, 'every empty state offers a way forward');

      // Auto Score: either it can run here, or the Engine screen and the Settings row both say why it waits.
      await page.evaluate(() => { openSettings(true); openUnderHood('engine'); });
      await page.waitForSelector('[data-uh="engine"]');
      const c = await claims(page);
      const auto = c.rows.find(r => r.id === 'autoscore');
      if (!c.targets) {
        assert.match(c.eng, /No genre playlists yet[\s\S]*Open Library/, 'the Engine screen says there is nothing to file into, and where to fix it');
        assert.doesNotMatch(auto.status, /soon|ran|scor/i, 'the Settings row does not promise a run that cannot happen');
        assert.match(auto.did, /genre playlist/i, 'the Settings row says why');
      } else if (c.filed < 60) {
        assert.match(c.autoLine, new RegExp(`once 60 tracks are filed .*\\(${c.filed} so far\\)`), 'the Engine line says why it waits');
        assert.doesNotMatch(auto.status, /soon|ran|scor/i, 'the Settings row does not promise a run that cannot happen');
        assert.match(auto.did, new RegExp(`${c.filed} so far`), 'the Settings row says why, with its number');
      } else {
        assert.match(c.autoLine, /Runs by itself|Scoring|Last scored/, 'the Engine line says when it runs');
      }
      // Nothing has been scored on a fresh account, so no gate may show as passed or used.
      if (!c.scored) assert.deepEqual(c.onTags, [], 'no gate shows as on before any Score run');
      // A row that says it is working (kind ok) and claims learning or tags carries a number or says it waits.
      for (const r of c.rows) {
        if (r.status === 'On · learnt') assert.ok(c.targets > 0, 'learnt needs genre playlists to learn from');
        if (r.id === 'shared' && c.rows.find(x => x.id === 'spotify').status === 'Read') assert.match(r.did, /\d/, 'tag coverage has its numbers');
        if (r.id === 'spotify') assert.match(r.did, new RegExp(`${acc.playlists.length} playlists`), 'the library row counts the playlists');
      }
      await page.evaluate(() => openSettings(false));
      // Mood chips need heard tracks and a mood playlist that passed its gate; no sound is heard here.
      assert.equal(await page.locator('#swipeCard .chip.mood').count(), 0, 'no mood chip without a gate passed');

      assert.equal(app.fake.writes().length, 0, 'still nothing written after opening every screen');
      assert.deepEqual(app.errors, []);

      if (kind === 'large') {
        const long = await page.evaluate(() => globalThis.__long ?? []);
        const during = long.filter(([at]) => at <= firstCard + analysedMs);
        const total = during.reduce((s, [, d]) => s + d, 0), worst = Math.max(0, ...during.map(([, d]) => d));
        console.log(`# large: first card at ${firstCard} ms; first analysis done ${analysedMs} ms after load; `
          + `${during.length} long tasks, ${total} ms in all, longest ${worst} ms`);
      }
    } finally { await app.close(); }
  });
}
