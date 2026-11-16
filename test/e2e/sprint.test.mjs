// Tidy's keyboard sprint and library health report (BUILD-6 F9, D7), on the fake Spotify.
//
// The number: decisions a minute by keyboard (the sprint: → move, ← keep) against the same
// rows decided by pointer (each row's own Move / Keep here button), on two fresh copies of
// the same account, with the same decision for each track. Both are printed. The bar: the
// sprint is at least as fast, and its moves are kept at least as often as the pointer's,
// read the way Score reads them (core/measure/history.mjs's Tidy tier rates, over the
// History log each run wrote).
//
// What the timing is: from the first decision's input to the screen being ready for the
// next one, so it is the page's own latency (find the control, act, repaint, and for the
// pointer's Move the Spotify writes it waits on), not a human's reading time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { skip, launch, openApp, ready, until } from './harness.mjs';
import { makeAccount } from '../fixtures/accounts.mjs';
import { measureHistory } from '../../core/measure/history.mjs';

let browser, app;
test.before(async () => { if (!skip) browser = await launch(); });
test.after(async () => { await browser?.close(); });
test.afterEach(async () => { if (app) { await app.close(); app = null; } });

/** The typical fixture with tracks filed in the wrong genre playlist: a few from each of three
 *  playlists sit in a fourth, which is what Tidy's Wrong place is there to find. */
function misfiledAccount() {
  const acc = makeAccount('typical');
  const by = n => acc.playlists.find(p => p.name === n);
  const strays = [['Jazz', 'Techno'], ['Classical', 'Drum and bass'], ['Metal', 'House'], ['Folk', 'Hip hop'], ['Reggae', 'Ambient']];
  for (const [from, into] of strays) {
    const a = by(from), b = by(into);
    if (!a || !b) continue;
    b.tracks.push(...a.tracks.splice(0, 4));
  }
  return acc;
}

/** The same decision for a track on both runs: keep about one in three, move the rest. */
const decide = id => ([...id].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % 3 === 0 ? 'keep' : 'move');

async function openTidy(page) {
  await ready(page);
  await page.evaluate(() => go('tidy'));
  await page.waitForSelector('#main [data-act="section"][data-tidy="misfile"]');
  // Wait for the reports to settle (the listening fetch repaints once).
  await page.waitForFunction(() => typeof LISTENING_CACHE !== 'undefined' && !!LISTENING_CACHE?.weights, null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(600);
  await page.evaluate(() => { S.tidySec = 'misfile'; S.mfBand = 'high'; render(); });
  await page.waitForSelector('#main [data-act="spstart"]', { timeout: 15000 });
}

const rowsNow = page => page.evaluate(() => SCREEN_MODS.tidy.sprintRows(screenCtx('tidy'), 'misfile').map(r => ({ id: r.id, from: r.from, to: r.to })));
const logOf = page => page.evaluate(async () => (await idb.get('actions')) ?? []);

/** Wait for the Spotify writes behind the decisions to land in History (the sprint's run behind it). */
async function settle(page, moves) {
  await until(async () => (await logOf(page)).filter(e => e.op === 'remove' && e.move).length >= moves, `${moves} moves in History`, 30000);
}

test('a keyboard sprint through Tidy is at least as fast as the pointer on the same rows, and keeps as many moves', { skip, timeout: 240000 }, async () => {
  const N = 9;
  // --- pointer: each row's own buttons, in list order ---
  app = await openApp(browser, { account: misfiledAccount(), phone: false });
  let { page } = app;
  await openTidy(page);
  const rows = (await rowsNow(page)).slice(0, N);
  assert.ok(rows.length >= 6, `the fixture gives Tidy at least 6 sure rows (got ${rows.length})`);
  const plan = rows.map(r => ({ ...r, d: decide(r.id) }));
  const t0 = Date.now();
  for (const r of plan) {
    if (r.d === 'move') {
      await page.click(`#main .row [data-act="move"][data-mvtr="${r.id}"][data-mvto="${r.to}"]`);
      await page.waitForSelector(`#main .row.done [data-mvtr="${r.id}"]`);
    } else {
      await page.click(`#main .row [data-act="mfkeep"][data-mfkeep="${r.id}"]`);
      await page.waitForSelector(`#main [data-mfkeep="${r.id}"]`, { state: 'detached' });
    }
  }
  const pointerMs = Date.now() - t0;
  const moves = plan.filter(r => r.d === 'move').length;
  await settle(page, moves);
  const pointerLog = await logOf(page);
  const pointerFiles = Object.fromEntries(plan.map(r => [r.id, app.fake.playlist(r.d === 'move' ? r.to : r.from).includes(r.id)]));
  assert.equal(app.errors.length, 0, app.errors.join('\n'));
  await app.close(); app = null;

  // --- keyboard: the sprint, on a fresh copy of the same account ---
  app = await openApp(browser, { account: misfiledAccount(), phone: false });
  ({ page } = app);
  await openTidy(page);
  const again = (await rowsNow(page)).slice(0, N);
  assert.deepEqual(again.map(r => r.id), plan.map(r => r.id), 'the same rows in the same order');
  await page.focus('#sprintGo');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#sprintCard[data-sptr]');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'sprintCard', 'focus is on the track being decided');
  const t1 = Date.now();
  for (const r of plan) {
    await page.waitForSelector(`#sprintCard[data-sptr="${r.id}"]`);
    await page.keyboard.press(r.d === 'move' ? 'ArrowRight' : 'ArrowLeft');
    await page.waitForSelector(`#sprintCard:not([data-sptr="${r.id}"])`);
  }
  const keyMs = Date.now() - t1;
  assert.equal(await page.evaluate(() => view), 'tidy', '←/→ decided, and did not walk the tabs');
  assert.match(await page.locator('#tidyLive').innerText(), /^(Moved|Kept) /, 'each decision is said in the live region');
  // The sprint moves on before Spotify answers; this is the time until every write has landed too.
  await settle(page, moves);
  const keyAllMs = Date.now() - t1;
  const keyLog = await logOf(page);
  for (const r of plan) assert.equal(app.fake.playlist(r.d === 'move' ? r.to : r.from).includes(r.id), pointerFiles[r.id], `${r.id} ends where the pointer put it`);
  for (const r of plan.filter(x => x.d === 'move')) assert.ok(!app.fake.playlist(r.from).includes(r.id), `${r.id} left ${r.from}`);
  await page.keyboard.press('Escape');
  await page.waitForSelector('#sprint', { state: 'detached' });
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('bf_tidy_sprint') ?? '[]'));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].decisions, plan.length);
  assert.equal(app.errors.length, 0, app.errors.join('\n'));

  const per = ms => +(plan.length / (ms / 60000)).toFixed(1);
  const tierP = measureHistory(pointerLog).tidy, tierK = measureHistory(keyLog).tidy;
  const fmt = t => Object.entries(t).filter(([, x]) => x.n).map(([k, x]) => `${k} ${x.kept}/${x.n}`).join(', ');
  console.log(`# F9 sprint: ${plan.length} decisions (${moves} moves, ${plan.length - moves} keeps) on the same rows`);
  console.log(`#   pointer  ${per(pointerMs)} decisions/min (${pointerMs} ms)   Tidy tier kept: ${fmt(tierP)}`);
  console.log(`#   keyboard ${per(keyMs)} decisions/min (${keyMs} ms)   Tidy tier kept: ${fmt(tierK)}   (page's own count: ${saved[0].perMin}/min, kept ${saved[0].kept})`);
  console.log(`#   keyboard, counting until every Spotify write landed: ${per(keyAllMs)} decisions/min (${keyAllMs} ms)`);
  assert.ok(per(keyMs) >= per(pointerMs), 'the sprint is at least as fast as the pointer');
  assert.ok(per(keyAllMs) >= per(pointerMs), 'and still is when its writes are waited for');
  for (const t of ['sure', 'likely', 'unsure']) {
    if (!tierP[t].n) continue;
    assert.ok(tierK[t].rate >= tierP[t].rate, `${t}: kept rate ${tierK[t].rate} >= ${tierP[t].rate}`);
    assert.equal(tierK[t].n, tierP[t].n);
  }
});

test('U undoes the newest sprint decision in Spotify too, Esc leaves, and the health report opens Tidy at a playlist', { skip, timeout: 120000 }, async () => {
  app = await openApp(browser, { account: misfiledAccount(), phone: true });
  const { page, fake, ctx } = app;
  // Undo puts a track back at its old position with a reorder (PUT), which the fake Spotify
  // has no route for: answer it here, so the undo runs to the end. Membership is what is checked.
  await ctx.route(/^https:\/\/api\.spotify\.com\/v1\/playlists\/[^/]+\/(items|tracks)$/, r => r.request().method() === 'PUT'
    ? r.fulfill({ status: 200, contentType: 'application/json', body: '{"snapshot_id":"s2"}' }) : r.fallback());
  await openTidy(page);

  // The report: worst first, each with why and a way in.
  await page.click('#main [data-act="section"][data-tidy="health"]');
  await page.waitForSelector('#main .hrep .hrow');
  const rep = await page.evaluate(() => [...document.querySelectorAll('#main .hrow')].map(li => ({
    pl: li.querySelector('[data-hpl]').dataset.hpl, score: +li.querySelector('.plhealth .mono').textContent, why: li.querySelectorAll('.plnotes li').length })));
  assert.ok(rep.length >= 1 && rep.length <= 5);
  assert.deepEqual(rep.map(r => r.score), [...rep.map(r => r.score)].sort((a, b) => a - b), 'worst first');
  assert.ok(rep.every(r => r.score < 85 && r.why >= 1));
  const target = await page.evaluate(() => document.querySelector('#main [data-act="hgo"]')?.dataset.hpl);
  assert.ok(target, 'at least one report row opens Tidy');
  await page.click(`#main [data-act="hgo"][data-hpl="${target}"]`);
  await page.waitForSelector('#main .tidypl');
  const froms = await page.evaluate(() => [...document.querySelectorAll('#main .row [data-act="move"]')].map(b => b.dataset.mvfrom));
  assert.ok(froms.length && froms.every(f => f === target), 'only that playlist\'s rows');

  // A sprint on that playlist: move one, undo it, and it is back in Spotify where it was.
  await page.focus('#sprintGo');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#sprintCard[data-sptr]');
  const first = await page.evaluate(() => SCREEN_MODS.tidy.sprintRows(screenCtx('tidy'), 'misfile')[0]);
  await page.keyboard.press('ArrowRight');
  await until(() => fake.playlist(first.to).includes(first.id) && !fake.playlist(first.from).includes(first.id), 'the move to land');
  await page.keyboard.press('u');
  await page.waitForSelector(`#sprintCard[data-sptr="${first.id}"]`);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'sprintCard');
  await until(() => !fake.playlist(first.to).includes(first.id) && fake.playlist(first.from).includes(first.id), 'the undo to land');
  assert.match(await page.locator('#tidyLive').innerText(), /Move undone/);
  await page.keyboard.press('Escape');
  await page.waitForSelector('#sprint', { state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'sprintGo', 'focus returns to the button that started it');
  // With the sprint gone, ←/→ are the tab walk again.
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('ArrowRight');
  await until(async () => (await page.evaluate(() => view)) !== 'tidy', 'the tab walk');
  assert.equal(app.errors.length, 0, app.errors.join('\n'));
});

// axe-core on Tidy's new states, when it is installed (npm i --no-save axe-core); `npm run a11y` covers the rest.
let axeSrc = null;
try { axeSrc = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8'); } catch { /* not installed */ }
test('axe: Tidy\'s health report and sprint have no critical or serious violations', { skip: skip || (!axeSrc && 'axe-core not installed'), timeout: 120000 }, async () => {
  app = await openApp(browser, { account: misfiledAccount(), phone: false });
  const { page } = app;
  await openTidy(page);
  await page.evaluate(axeSrc);
  // Tidy's own screen (#main), once its entrance has finished, as scripts/a11y.mjs waits too.
  const scan = () => page.waitForTimeout(700).then(() => page.evaluate(() => axe.run({ include: [['#main']] }, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] } }))
    .then(r => r.violations.filter(v => v.impact === 'critical' || v.impact === 'serious').map(v => `${v.id}: ${v.nodes.slice(0, 3).map(n => n.target.join(' ')).join(' | ')}`)));
  const bad = [];
  bad.push(...await scan());
  await page.click('#main [data-act="section"][data-tidy="health"]');
  await page.waitForSelector('#main .hrep');
  bad.push(...await scan());
  await page.evaluate(() => { S.tidySec = 'misfile'; render(); });
  await page.click('#sprintGo');
  await page.waitForSelector('#sprintCard[data-sptr]');
  bad.push(...await scan());
  console.log(`# axe on Tidy (list, health, sprint): ${bad.length} critical/serious`);
  assert.deepEqual(bad, []);
});
