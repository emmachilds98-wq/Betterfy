/* ---------------- staying on the current version ----------------
 * GitHub Pages serves this HTML with a ~10 minute cache, and a browser that
 * already has the page keeps what it loaded until something forces a
 * revalidation — so "am I looking at the current Betterfy?" is a real question,
 * and it is asked from the very first screen rather than only once you are
 * signed in. The build stamp is baked into a meta tag at build time; the check
 * re-fetches the page over the network and compares the two stamps. */

const BUILD = '__BUILD__';

async function publishedBuild() {
  // Cache-busted *and* no-store: this has to be what the server holds right
  // now, not what this browser happens to be keeping.
  // With a deadline, like everything else here: a hung check left the button
  // saying "Checking…" and disabled, on the landing page, for good.
  const r = await fetchDeadline(REDIRECT + '?_=' + Date.now(), { cache: 'no-store' }, 10000);
  if (!r.ok) throw new Error(`the server answered ${r.status}`);
  const m = (await r.text()).match(/name="bf-build"\s+content="([^"]*)"/);
  if (!m) throw new Error('the published page carries no version stamp');
  return m[1];
}

/** @param {boolean} quiet — say nothing when already current (the startup check). */
async function checkForUpdate(quiet) {
  const fab = $('#btnUpdate'), inline = $('#landUpdate');
  fab.disabled = true; fab.classList.add('busy');
  if (inline) { inline.disabled = true; inline.textContent = 'Checking…'; }
  try {
    const latest = await publishedBuild();
    if (latest === BUILD) { if (!quiet) toast(`You have the latest version (build ${BUILD}).`); return false; }
    $('#updateFrom').textContent = `build ${latest}`;
    $('#updateBar').hidden = false;
    fab.classList.add('hasUpdate');
    return true;
  } catch (e) {
    if (!quiet) toast(`Could not check for updates — ${e.message}.`);
    return false;
  } finally {
    fab.disabled = false; fab.classList.remove('busy');
    if (inline) { inline.disabled = false; inline.textContent = 'Check for updates'; }
  }
}

/** Offered, never forced: a reload mid-way through filing would lose your place. */
async function installUpdate() {
  // Drop anything cached for this origin, pull a fresh copy into the HTTP
  // cache, then navigate to a URL no cache can answer from. Nothing here
  // touches the saved token or library, so you land back where you were.
  try { if (window.caches) for (const k of await caches.keys()) await caches.delete(k); } catch {}
  try { await fetchDeadline(REDIRECT, { cache: 'reload' }, 15000); } catch {}
  location.replace(REDIRECT + '?v=' + Date.now());
}

