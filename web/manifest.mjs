// The page's own script, in the order it runs (docs/BUILD-5-PLAN.md A1).
//
// These are classic scripts, not modules: they share one top-level scope, as
// the single inline script they were cut from did, so the order below is load
// order and a file may use anything a file above it declared. build-web.mjs
// concatenates them, verbatim and in this order, where the template says
// __APP__. web/README.md says which file owns what.
//
// Screens migrated to ES modules (web/screens/*.mjs, A4) are not listed here:
// their `// @bundle screens` header registers them, and app/screens.js is
// their glue.
//
// To add a file, put it in this list where its code has to run. Nothing is
// picked up from the folders on its own (A7 may replace this list with a
// convention).
import { readFileSync } from 'node:fs';

export const APP_FILES = [
  'app/storage.js',
  'app/store.js',
  'app/theme.js',
  'app/version.js',
  'app/auth.js',
  'app/cache.js',
  'app/feedback.js',
  'app/classify.js',
  'app/reports.js',
  'app/ui.js',
  'app/actionlog.js',
  'app/player.js',
  'screens/home.js',
  'app/listening.js',
  'app/soundslots.js',
  'screens/inbox.js',
  'app/screenjobs.js',
  'screens/shuffle.js',
  'screens/discover.js',
  'app/tagshare.js',
  'app/sync.js',
  'app/sync-tags.js',
  'app/keyless.js',
  'app/tagfix.js',
  'app/motion.js',
  'app/render.js',
  'app/gestures.js',
  'app/more.js',
  'app/router.js',
  'app/errors.js',
  'app/engine.js',
  'app/audio.js',
  'app/soundfirst.js',
  'app/blend.js',
  'app/clap.js',
  'app/audio-panel.js',
  'app/analyse.js',
  'app/screens.js',
  'app/events.js',
  'screens/inbox-actions.js',
  'app/boot.js',
];

const WEB = new URL('./', import.meta.url);

/** The page's script, every file joined in order. */
export function appSource() {
  return APP_FILES.map(f => readFileSync(new URL(f, WEB), 'utf8')).join('');
}

/** docs/app.template.html with the script put back where it was cut from:
 *  the same text the template held before the split, placeholders and all. */
export function assembledTemplate() {
  const tpl = readFileSync(new URL('../docs/app.template.html', WEB), 'utf8');
  if (!tpl.includes('__APP__\n')) throw new Error('docs/app.template.html has no __APP__ line');
  // A function, not a string: the script is free to contain `$&` and friends.
  return tpl.replace('__APP__\n', () => appSource());
}
