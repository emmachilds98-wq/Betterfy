// Accounts that are not the owner's: the page must load and say something
// sensible for a brand-new library and for one with no genre-named playlists,
// and the fixture generator must stay deterministic and the right shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeAccount, ACCOUNT_KINDS } from '../fixtures/accounts.mjs';
import { skip, launch, openApp, ready } from './harness.mjs';

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
