/* ---------------- theme (colour, density, remembered filters) ----------------
 * Lives outside #land/#app so it works before Spotify is connected, not just
 * inside the synced app — the trigger button is a fixed element, not part of
 * either screen. */

const THEME_KEY = 'betterfy-theme';

/* The twelve accents, each as a matched pair. A colour that reads well on a
 * near-black ground is washed out on paper and vice versa, so a preset is not
 * one colour — it is the same colour twice, and which half you get follows the
 * theme rather than being something else to choose. */
const ACCENTS = [
  // The light halves of the first six sit a few points darker than they first
  // did, just enough for white text on them (a primary button) to reach 4.5:1.
  ['Ember',  '#FF7A52', '#CD4825'], ['Amber',  '#FFB43F', '#9F6A0F'],
  ['Lime',   '#C3DE55', '#5C801F'], ['Mint',   '#7AE0A6', '#158557'],
  ['Jade',   '#43D2A6', '#0D8469'], ['Teal',   '#4CD0D6', '#118186'],
  ['Sky',    '#63C8FF', '#1F72C0'], ['Blue',   '#8AA6FF', '#3F55C4'],
  ['Lilac',  '#C79BFF', '#6F4FCB'], ['Orchid', '#FF95E4', '#AE3B93'],
  ['Rose',   '#FF8A9E', '#C13A5A'], ['Sand',   '#E4C79B', '#8C6B3C'],
];

/** #rrggbb -> [hue, saturation %, lightness %], to feed the engine below. */
function hexToHsl(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, l = (mx + mn) / 2;
  if (!d) return [0, 0, Math.round(l * 100)];
  const sat = d / (1 - Math.abs(2 * l - 1));
  const h = mx === r ? ((g - b) / d + (g < b ? 6 : 0)) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [Math.round(h * 60), Math.round(sat * 100), Math.round(l * 100)];
}

const DEFAULT_THEME = {
  // Nightshift, not the system: the app is used in the evening more often than
  // not, and a dark first paint is the one the redesign is drawn for.
  mode: 'dark', accent: 'Ember', hue: 14, depth: 72, brightness: 52,
  regions: { nav:true, btn:true, progress:true, hover:true, tag:false },
  compact: false, rememberFilters: false,
};

function loadTheme() {
  try {
    const saved = JSON.parse(LS.getItem(THEME_KEY));
    return { ...DEFAULT_THEME, ...saved, regions: { ...DEFAULT_THEME.regions, ...(saved?.regions ?? {}) } };
  } catch { return { ...DEFAULT_THEME }; }
}
function saveTheme() { try { LS.setItem(THEME_KEY, JSON.stringify(T)); } catch {} }

let T = loadTheme();

/** The pair a named preset resolves to on the theme currently showing. */
const accentPair = name => ACCENTS.find(a => a[0] === name);

const hsl = (h,s,l) => `hsl(${((h%360)+360)%360} ${Math.max(0,Math.min(100,s))}% ${Math.max(0,Math.min(100,l))}%)`;

/**
 * Relative luminance of an HSL colour, and the lightness that lands a given
 * hue on a readable one. Hue matters enormously here: a yellow at 50%
 * lightness is nearly twice as bright as a blue at 50%, so spinning the
 * accent around the wheel at a fixed lightness produces some colours you
 * cannot read. This walks the lightness until the colour is actually dark
 * enough (on a light background) or light enough (on a dark one).
 */
/** Relative luminance of #17100B, the dark ink printed on a bright accent. */
const INK_DARK_L = 0.0058;
function lumOf(h, s, l) {
  h = ((h % 360) + 360) % 360; s /= 100; l /= 100;
  const c = (1 - Math.abs(2*l - 1)) * s, x = c * (1 - Math.abs((h/60) % 2 - 1)), m = l - c/2;
  const [r, g, b] = h < 60 ? [c,x,0] : h < 120 ? [x,c,0] : h < 180 ? [0,c,x]
                  : h < 240 ? [0,x,c] : h < 300 ? [x,0,c] : [c,0,x];
  const lin = v => { v += m; return v <= .03928 ? v/12.92 : Math.pow((v + .055)/1.055, 2.4); };
  return .2126*lin(r) + .7152*lin(g) + .0722*lin(b);
}
function readable(h, s, l, dark) {
  let L = Math.max(8, Math.min(92, l));
  if (dark) while (L < 92 && lumOf(h, s, L) < 0.30) L += 2;
  else      while (L > 10 && lumOf(h, s, L) > 0.24) L -= 2;
  return L;
}

function isDarkNow() {
  const dt = document.documentElement.getAttribute('data-theme');
  if (dt === 'dark') return true;
  if (dt === 'light') return false;
  return matchMedia('(prefers-color-scheme: dark)').matches;
}

function applyTheme() {
  if (T.mode === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', T.mode);

  const dark = isDarkNow();
  const root = document.documentElement.style;

  // A named preset is two colours; pick the one this theme wants and drive
  // everything below from it, so the spun hues and the soft tints follow a
  // preset exactly as they follow the sliders.
  const pair = T.accent && accentPair(T.accent);
  const exact = pair ? pair[dark ? 1 : 2] : null;
  if (exact) [T.hue, T.depth, T.brightness] = hexToHsl(exact);
  const { hue, depth, brightness } = T;

  root.setProperty('--accent', exact ?? hsl(hue, depth, brightness));
  root.setProperty('--accent-soft', dark
    ? hsl(hue, Math.min(depth,80), Math.max(brightness-38,12))
    : hsl(hue, Math.min(depth,85), Math.min(brightness+40,95)));
  // The top stop of the logo tile's gradient — a lift rather than a second hue,
  // so the mark stays one colour however far the sliders are pushed.
  root.setProperty('--accent-lift', hsl(hue, Math.min(depth+6,100), Math.min(brightness+9,92)));
  // Which of the two inks to print on the accent: whichever has the higher
  // contrast with it, measured on how bright the colour actually is rather
  // than its lightness number (a 55% yellow and a 55% blue are nowhere near as
  // bright as each other). The old fixed cut-off at 0.42 put white on the
  // dark theme's Ember, Blue and Rose at under 2.6:1.
  const accL = lumOf(hue, depth, brightness);
  root.setProperty('--accent-ink', 1.05 / (accL + .05) >= (accL + .05) / (INK_DARK_L + .05) ? '#FFFFFF' : '#17100B');

  // Eight hues spun off the chosen accent. Everything on screen that isn't a
  // control — stat tiles, screen headers, the tab bar, the landing cards —
  // takes one of these, so the app is colourful without wandering away from
  // the colour the viewer actually picked.
  const SPIN = [0, 38, 76, 130, 172, 208, 258, 308];
  SPIN.forEach((off, i) => {
    const h = hue + off, sat = dark ? Math.min(depth + 12, 82) : Math.min(depth + 4, 86);
    const base = dark ? Math.max(brightness + 16, 64) : Math.min(brightness, 50);
    root.setProperty(`--c${i}`, hsl(h, sat, readable(h, sat, base, dark)));
    root.setProperty(`--c${i}-soft`, dark
      ? hsl(h, Math.min(depth, 55), 13)
      : hsl(h, Math.min(depth + 12, 92), 95));
  });
  // What to print on top of one of those hues.
  root.setProperty('--c-ink', dark ? '#12161C' : '#FFFFFF');

  // The iOS status bar picks this up, so it blends with the page instead of
  // sitting on a coloured strip above it. The two media-scoped tags in the
  // head are the pre-script default; from here on there is exactly one, which
  // also has to follow an explicit light/dark choice rather than the OS.
  let tc = document.querySelector('meta[name="theme-color"][data-live]');
  if (!tc) {
    document.querySelectorAll('meta[name="theme-color"]').forEach(m => m.remove());
    tc = Object.assign(document.createElement('meta'), { name:'theme-color' });
    tc.dataset.live = '';
    document.head.appendChild(tc);
  }
  tc.content = dark ? '#12100D' : '#FBF7F1';

  const r = T.regions;
  root.setProperty('--nav-accent',      r.nav      ? 'var(--accent)' : 'var(--line-2)');
  root.setProperty('--btn-accent',      r.btn      ? 'var(--accent)' : 'var(--ink)');
  root.setProperty('--btn-ink',         r.btn      ? 'var(--accent-ink)' : 'var(--ground)');
  root.setProperty('--progress-accent', r.progress ? 'var(--accent)' : 'var(--ink-3)');
  root.setProperty('--hover-accent',    r.hover    ? 'var(--accent)' : 'var(--line-2)');
  root.setProperty('--tag-bg',          r.tag      ? 'var(--accent-soft)' : 'var(--surface-3)');
  root.setProperty('--tag-ink',         r.tag      ? 'var(--accent)' : 'var(--ink-2)');

  document.body.classList.toggle('compact', !!T.compact);
}

function buildSwatches() {
  const wrap = $('#swatches'); wrap.innerHTML = '';
  for (const [name] of ACCENTS) {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'swatch'; btn.title = name;
    btn.dataset.accent = name;
    btn.setAttribute('aria-label', name);
    btn.onclick = () => { T.accent = name; applyTheme(); syncSettingsUI(); saveTheme(); };
    wrap.appendChild(btn);
  }
}

function syncSettingsUI() {
  const dark = isDarkNow();
  document.querySelectorAll('#modeGroup button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === T.mode)));
  $('#hue').value = T.hue; $('#hueVal').textContent = T.hue + '°';
  $('#depth').value = T.depth; $('#depthVal').textContent = T.depth + '%';
  $('#bright').value = T.brightness; $('#brightVal').textContent = T.brightness + '%';
  document.querySelectorAll('#settingsPanel [data-region]').forEach(cb => { cb.checked = !!T.regions[cb.dataset.region]; });
  $('#compactToggle').checked = !!T.compact;
  $('#rememberToggle').checked = !!T.rememberFilters;
  // Each swatch shows the half of its pair that this theme would actually use.
  document.querySelectorAll('#swatches .swatch').forEach(el => {
    const pair = accentPair(el.dataset.accent);
    el.style.background = pair[dark ? 1 : 2];
    el.setAttribute('aria-pressed', String(T.accent === el.dataset.accent));
  });
  const cur = T.accent && accentPair(T.accent);
  $('#accentName').textContent = cur ? cur[0] : 'Custom';
  $('#accentHex').textContent = (cur ? cur[dark ? 1 : 2] : hsl(T.hue, T.depth, T.brightness)).toUpperCase();
  // Open on a colour that isn't one of the twelve, so it is visible that the
  // swatch row is showing nothing selected on purpose.
  if (!cur) $('#customAccent').open = true;
}

/**
 * Show or hide the settings panel. Top-level on purpose: the "Re-sync library
 * from Spotify" button is wired up hundreds of lines further down and calls
 * this by name. As a const inside initSettingsPanel() it was never in scope
 * there, so the one deliberate way to re-read a library threw a ReferenceError
 * out of an unguarded async onclick — no message, no re-read, and a button
 * left disabled reading "Re-reading your library…" forever.
 */
function openSettings(open) {
  const panel = $('#settingsPanel'), scrim = $('#scrim'), trigger = $('#btnSettings');
  panel.classList.toggle('open', open); scrim.classList.toggle('open', open);
  panel.setAttribute('aria-hidden', String(!open)); trigger.setAttribute('aria-expanded', String(open));
  if (open) $('#closeSettings').focus(); else trigger.focus();
}

function initSettingsPanel() {
  buildSwatches();
  syncSettingsUI();

  document.querySelectorAll('#modeGroup button').forEach(b => b.onclick = () => {
    T.mode = b.dataset.mode; applyTheme(); syncSettingsUI(); saveTheme();
  });
  // Moving a slider means this is no longer one of the twelve: drop the name,
  // or applyTheme would snap the colour straight back on the next repaint.
  for (const [id, key] of [['hue','hue'], ['depth','depth'], ['bright','brightness']]) {
    $('#' + id).oninput = e => { T.accent = null; T[key] = +e.target.value; applyTheme(); syncSettingsUI(); saveTheme(); };
  }
  document.querySelectorAll('#settingsPanel [data-region]').forEach(cb => cb.onchange = () => {
    T.regions[cb.dataset.region] = cb.checked; applyTheme(); saveTheme();
  });
  $('#compactToggle').onchange = e => { T.compact = e.target.checked; applyTheme(); saveTheme(); };
  $('#rememberToggle').onchange = e => {
    T.rememberFilters = e.target.checked;
    if (T.rememberFilters) { T.crossMin = S.crossMin; T.mfBand = S.mfBand; }
    saveTheme();
  };
  $('#resetTheme').onclick = () => { T = JSON.parse(JSON.stringify(DEFAULT_THEME)); applyTheme(); syncSettingsUI(); saveTheme(); };

  const panel = $('#settingsPanel'), scrim = $('#scrim'), trigger = $('#btnSettings');
  trigger.onclick = () => openSettings(!panel.classList.contains('open'));
  $('#closeSettings').onclick = () => openSettings(false);
  scrim.onclick = () => { openSettings(false); openSheet(false); };
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (panel.classList.contains('open')) openSettings(false);
    closeSheet();
  });

  // On System, the accent has to swap to its other twin when the phone does.
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (T.mode === 'system') { applyTheme(); syncSettingsUI(); }
  });
}

applyTheme();
initSettingsPanel();
initSheet();
bindAppGestures();

const DEFAULT_CLIENT_ID = '__CLIENT_ID__';
// Blank unless whoever built this page opted in: no stranger's inbox is baked
// into a fork of this repo by default. Shown as a "Request access" mailto
// alongside "use your own Spotify app" wherever that hint appears.
const CONTACT_EMAIL = '__CONTACT_EMAIL__';
// Always the directory form with a trailing slash. Spotify matches the redirect
// URI byte-for-byte, so visiting /Betterfy and /Betterfy/ must not send two
// different values — only one of them could ever be registered.
const REDIRECT = (() => {
  const p = location.pathname.replace(/\/index\.html$/, '/');
  return location.origin + (p.endsWith('/') ? p : p + '/');
})();
const SCOPES = ['playlist-read-private','playlist-read-collaborative','playlist-modify-private',
  'playlist-modify-public','user-library-read','user-library-modify','user-top-read',
  'user-read-recently-played','user-read-private','user-read-playback-state','user-modify-playback-state'].join(' ');

const clientId = () => LS.getItem('bf_client_id') || DEFAULT_CLIENT_ID;

/** Running from the Home Screen rather than in a browser tab. */
const standalone = () => window.navigator.standalone === true
  || matchMedia('(display-mode: standalone)').matches;

/**
 * Whether to go to Spotify without being asked. Only from the Home Screen,
 * only with no sign-in already, and only once ever — a second automatic
 * attempt after a refusal is a redirect loop, not a retry.
 */
const autoConnectDue = () => standalone()
  && !LS.getItem('bf_tok')
  && !LS.getItem('bf_autoconnect');

