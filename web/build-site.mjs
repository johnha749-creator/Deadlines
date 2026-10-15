// Builds the Deadline website (the iPhone home-screen version, a PWA) from the web app.
//   node web/build-site.mjs [--src <app dir, default app/>] [--out <dir, default site/>] [--config <config.js>]
//   node web/build-site.mjs --render-icons [--tooling <dir whose node_modules has @resvg/resvg-js>]
// The site uses relative paths only, so it works under https://<user>.github.io/Deadlines/.
// Output:
//  - index.html: the artifact-form index.html as a full document, with the iOS home-screen metas, the
//    manifest + apple-touch-icon links, a Content-Security-Policy meta (inline scripts by sha256 hash,
//    connect-src plus the Supabase origin from config.js), safe-area CSS and the service worker hookup.
//  - config.js: --config, else <src>/config.js, else an empty one (accounts off).
//  - manifest.webmanifest, sw.js (from web/sw.js, versioned by a content hash), icons/ (from web/icons/).
//  - every other file of the app (programs.json, assets/, src/, ...).
// Needs Node 22 and nothing else; --render-icons also needs @resvg/resvg-js (the rendered PNGs are
// committed in web/icons/, so a normal build never does).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const WEB = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(WEB);
const ICONS_DIR = path.join(WEB, 'icons');
const ICON_SVG = path.join(REPO, 'desktop', 'icon.svg');
const SW_TEMPLATE = path.join(WEB, 'sw.js');
const webPage = createRequire(import.meta.url)('../desktop/web-page.js');

const EMPTY_CONFIG = 'window.DEADLINE_CONFIG = { supabaseUrl: "", supabaseKey: "", usernameDomain: "users.deadline.invalid" };\n';
const NAME = 'Deadline';
const SKY = '#7FB2E5';
const SKY_DARK = '#2A3E62';
// The icons the site needs, rendered from desktop/icon.svg: [file, size, variant]
//   tight: the rounded tile edge to edge (transparent corners), as on Windows/Linux
//   bleed: full square, no transparency (iOS rounds the corners itself)
//   maskable: full square with the artwork inside Android's safe circle
const ICONS = [
  ['apple-touch-icon.png', 180, 'bleed'],
  ['icon-192.png', 192, 'tight'],
  ['icon-512.png', 512, 'tight'],
  ['icon-maskable-512.png', 512, 'maskable'],
];
// Top-level folders of the app dir that are never part of the site.
const SKIP_TOP = new Set(['desktop', 'dist', 'node_modules', 'uploads', 'site', 'web', 'tests']);
// Written by the build; the app dir's own copies (if any) are not used.
const GENERATED = new Set(['index.html', 'config.js', 'sw.js', 'manifest.webmanifest', 'icons']);

const log = (...m) => console.log('[site]', ...m);
const warnings = [];
const warn = (m) => { warnings.push(m); console.warn('[site] WARNING:', m); };
const fail = (m) => { console.error(`[site] ERROR: ${m}`); process.exit(1); };

// ---------- arguments ----------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) fail(`Unexpected argument "${a}"`);
    const eq = a.indexOf('=');
    const k = a.slice(2, eq > 0 ? eq : undefined);
    if (['render-icons', 'help'].includes(k)) { out[k] = true; continue; }
    if (!['src', 'out', 'config', 'tooling'].includes(k)) fail(`Unknown option --${k}`);
    const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
    if (!v) fail(`--${k} needs a value`);
    out[k] = v;
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log('node web/build-site.mjs [--src <app dir>] [--out <dir>] [--config <config.js>]\nnode web/build-site.mjs --render-icons [--tooling <dir>]');
  process.exit(0);
}

// ---------- icons ----------
function iconSvg(svg, variant) {
  const vb = 'viewBox="0 0 1024 1024"';
  const clip = ' clip-path="url(#squircle)"';
  const sky = '<rect x="100" y="100" width="824" height="824" fill="url(#sky)"/>';
  const hill = 'd="M100 840 C260 760 400 790 520 820 C650 852 790 790 924 760 L924 924 L100 924 Z"';
  const need = (s) => { if (!svg.includes(s)) throw new Error(`desktop/icon.svg changed (no ${s}); update iconSvg() in web/build-site.mjs`); };
  need(vb);
  if (variant === 'tight') return svg.replace(vb, 'viewBox="100 100 824 824"');
  need(clip);
  if (variant === 'bleed') return svg.replace(vb, 'viewBox="100 100 824 824"').replace(clip, '');
  // maskable: the sky and hill fill the whole 1024 canvas, so the tile artwork shrinks to ~50% and
  // stays inside the 80% safe circle that Android masks to
  need(sky); need(hill);
  return svg.replace(clip, '').replace(sky, '<rect x="0" y="0" width="1024" height="1024" fill="url(#sky)"/>')
    .replace(hill, 'd="M0 892 C120 832 400 790 520 820 C650 852 860 776 1024 738 L1024 1024 L0 1024 Z"');
}
function findResvg(toolingArg) {
  const candidates = [
    toolingArg,
    process.env.DEADLINE_BUILD_DIR && path.join(process.env.DEADLINE_BUILD_DIR, 'tooling'),
    path.join(REPO, 'desktop'),
    REPO,
    path.join(os.tmpdir(), 'deadline-desktop-build', 'tooling'),
  ].filter(Boolean);
  for (const dir of candidates) {
    try { return createRequire(path.join(path.resolve(dir), 'package.json'))('@resvg/resvg-js').Resvg; } catch (e) { /* next */ }
  }
  return null;
}
function renderIcons(outDir, Resvg) {
  const svg = fs.readFileSync(ICON_SVG, 'utf8');
  fs.mkdirSync(outDir, { recursive: true });
  for (const [file, size, variant] of ICONS) {
    const opts = { fitTo: { mode: 'width', value: size }, background: variant === 'tight' ? 'rgba(0,0,0,0)' : SKY };
    fs.writeFileSync(path.join(outDir, file), Buffer.from(new Resvg(iconSvg(svg, variant), opts).render().asPng()));
  }
}
function pngSize(file) {
  const b = fs.readFileSync(file);
  if (b.length < 24 || b.toString('latin1', 1, 4) !== 'PNG') return null;
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

if (args['render-icons']) {
  const Resvg = findResvg(args.tooling);
  if (!Resvg) fail('@resvg/resvg-js not found. Pass --tooling <dir> (a folder whose node_modules has it, e.g. the desktop build tooling).');
  renderIcons(ICONS_DIR, Resvg);
  for (const [file] of ICONS) log(`icons/${file}`, pngSize(path.join(ICONS_DIR, file)).join('x'));
  process.exit(0);
}

// ---------- paths ----------
const SRC = path.resolve(args.src || path.join(REPO, 'app'));
const OUT = path.resolve(args.out || path.join(REPO, 'site'));
const inside = (child, parent) => { const r = path.relative(parent, child); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
if (!fs.existsSync(path.join(SRC, 'index.html'))) fail(`${SRC}/index.html not found (use --src <app dir>)`);
// the output folder is deleted first: inside the repo only site/ (or dist/) may be used
const repoTop = inside(OUT, REPO) && OUT !== REPO ? path.relative(REPO, OUT).split(path.sep)[0] : '';
if (OUT === path.parse(OUT).root || OUT === os.homedir() || inside(OUT, SRC) || [SRC, REPO, WEB, path.dirname(ICON_SVG)].some((p) => inside(p, OUT))
  || (repoTop && !['site', 'dist'].includes(repoTop) && fs.existsSync(path.join(REPO, repoTop))) || fs.existsSync(path.join(OUT, '.git'))) {
  fail(`Refusing to use ${OUT} as the output folder (it would delete the app or the repo). Pick an empty or build-only folder.`);
}
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// ---------- app files ----------
const junk = (p) => /(^|[\\/])(\.[^\\/]*|Thumbs\.db|desktop\.ini)$/.test(p);
const copied = [];
for (const name of fs.readdirSync(SRC).sort()) {
  if (junk(name) || SKIP_TOP.has(name) || GENERATED.has(name)) continue;
  const from = path.join(SRC, name);
  fs.cpSync(from, path.join(OUT, name), { recursive: true, dereference: true, filter: (p) => !junk(p) });
  copied.push(fs.statSync(from).isDirectory() ? `${name}/` : name);
}
if (!fs.existsSync(path.join(OUT, 'programs.json'))) warn('programs.json is missing');

// ---------- config.js ----------
const configPath = args.config ? path.resolve(args.config) : path.join(SRC, 'config.js');
let configText = EMPTY_CONFIG;
if (fs.existsSync(configPath)) configText = fs.readFileSync(configPath, 'utf8');
else if (args.config) fail(`--config ${configPath} not found`);
else log('no config.js in the app folder: writing an empty one (accounts off)');
// read the same way as the laptop app (desktop/web-page.js), so both allow the same Supabase origin
const { config, error: configError } = webPage.readConfig(configText);
if (configError) warn(`config.js could not be read (${configError}); accounts stay off`);
const supabaseKey = config.supabaseKey || '';
// The site is public: a secret key in config.js would hand the whole database to anyone.
if (webPage.isSecretKey(supabaseKey)) {
  fail('config.js holds a Supabase SECRET (service_role) key. Use the publishable key (sb_publishable_...) or the anon key; the secret one must never be on a website.');
}
const supa = config.supabaseUrl && supabaseKey ? webPage.supabaseOrigin(config.supabaseUrl) : { origin: '' };
if (supa.warning) warn(supa.warning);
const supabaseOrigin = supa.origin;
const accountsOn = !!supabaseOrigin;
fs.writeFileSync(path.join(OUT, 'config.js'), configText);

// ---------- icons + manifest ----------
fs.mkdirSync(path.join(OUT, 'icons'), { recursive: true });
const missingIcons = ICONS.filter(([file]) => !fs.existsSync(path.join(ICONS_DIR, file)));
if (missingIcons.length) {
  const Resvg = findResvg(args.tooling);
  if (!Resvg) fail(`web/icons/ is missing ${missingIcons.map(([f]) => f).join(', ')}. Run: node web/build-site.mjs --render-icons --tooling <dir with @resvg/resvg-js>`);
  warn('web/icons/ is incomplete; rendering the icons for this build only');
  renderIcons(path.join(OUT, 'icons'), Resvg);
} else {
  for (const [file] of ICONS) fs.copyFileSync(path.join(ICONS_DIR, file), path.join(OUT, 'icons', file));
}
for (const [file, size] of ICONS) {
  const got = pngSize(path.join(OUT, 'icons', file));
  if (!got || got[0] !== size || got[1] !== size) fail(`icons/${file} should be ${size}x${size} (is ${got ? got.join('x') : 'not a PNG'})`);
}
const manifest = {
  id: './',
  name: NAME,
  short_name: NAME,
  description: 'Every due date in one place: schoolwork from Canvas, programs worth applying to, and your own reminders.',
  lang: 'en',
  start_url: './',
  scope: './',
  display: 'standalone',
  background_color: SKY,
  theme_color: SKY,
  icons: [
    { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
};
fs.writeFileSync(path.join(OUT, 'manifest.webmanifest'), `${JSON.stringify(manifest, null, 2)}\n`);

// ---------- index.html ----------
const SITE_CSS = `<style id="site-css">
/* Website build only (web/build-site.mjs). On the iPhone home screen the page runs edge to edge
   (viewport-fit=cover, translucent status bar): the painting fills the whole screen, while the content,
   dialogs and the credit keep clear of the notch, the rounded corners and the home bar. */
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; -webkit-tap-highlight-color: transparent; }
body { padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px); }
.welcome { min-height: calc(100vh - 140px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px)); }
.overlay, .overlay-out { padding: max(16px, env(safe-area-inset-top, 0px)) max(16px, env(safe-area-inset-right, 0px)) max(16px, env(safe-area-inset-bottom, 0px)) max(16px, env(safe-area-inset-left, 0px)); }
.modal, .modal-out { max-height: min(92vh, calc(100vh - 32px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px))); }
</style>`;
// Keeps the app working offline from the home screen. A new version installs in the background and
// takes over while the app is out of sight (then the page reloads), so the open screen never mixes
// old and new files.
const SW_HOOKUP = `<script>
(function () {
  "use strict";
  if (!("serviceWorker" in navigator)) return;
  var sw = navigator.serviceWorker, hadController = !!sw.controller, stale = false, checked = Date.now();
  sw.addEventListener("controllerchange", function () {
    if (!hadController) { hadController = true; return; }
    stale = true;
    if (document.visibilityState === "hidden") location.reload();
  });
  window.addEventListener("load", function () {
    sw.register("sw.js").then(function (reg) {
      function swap() { if (document.visibilityState === "hidden" && reg.waiting && sw.controller) reg.waiting.postMessage("skip-waiting"); }
      // an update that finishes downloading after the app went into the background takes over right away
      reg.addEventListener("updatefound", function () {
        var next = reg.installing;
        if (next) next.addEventListener("statechange", function () { if (next.state === "installed") swap(); });
      });
      document.addEventListener("visibilitychange", function () {
        if (document.visibilityState === "visible") {
          if (Date.now() - checked > 1800000) { checked = Date.now(); reg.update().catch(function () {}); }
        } else if (stale) location.reload();
        else swap();
      });
    }, function () {});
  });
})();
</script>`;

// The parser keeps <title>/<link>/<meta>/<style>/<script>/<base>/<noscript> (and comments) in <head>
// and opens <body> at the first other element, which is how the artifact host reads index.html.
function splitHead(html) {
  const re = /\s+|<!--[\s\S]*?-->|<(title|style|script|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>|<(?:link|meta|base)\b[^>]*>/iy;
  let i = 0;
  for (;;) {
    re.lastIndex = i;
    const m = re.exec(html);
    if (!m || !m[0].length) break;
    i = re.lastIndex;
  }
  return [html.slice(0, i), html.slice(i)];
}
const dropMeta = (s) => s.replace(/<meta\b[^>]*\b(?:charset\s*=|name\s*=\s*["']?viewport\b)[^>]*>\s*/gi, '');
const HEAD_TOP = [
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
  '%%CSP%%',
  `<meta name="theme-color" content="${SKY}" media="(prefers-color-scheme: light)">`,
  `<meta name="theme-color" content="${SKY_DARK}" media="(prefers-color-scheme: dark)">`,
  '<meta name="apple-mobile-web-app-capable" content="yes">',
  '<meta name="mobile-web-app-capable" content="yes">',
  '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">',
  `<meta name="apple-mobile-web-app-title" content="${NAME}">`,
  `<meta name="application-name" content="${NAME}">`,
  '<meta name="format-detection" content="telephone=no">',
  '<link rel="manifest" href="manifest.webmanifest">',
  '<link rel="icon" type="image/png" sizes="192x192" href="icons/icon-192.png">',
  '<link rel="apple-touch-icon" sizes="180x180" href="icons/apple-touch-icon.png">',
].join('\n');

const source = webPage.normalizeNewlines(fs.readFileSync(path.join(SRC, 'index.html'), 'utf8'));
let page;
if (/^\s*(<!--[\s\S]*?-->\s*)*<!doctype\s/i.test(source) || /^\s*<html[\s>]/i.test(source)) {
  // already a full document: add to its <head>
  if (!/<head[^>]*>/i.test(source) || !/<\/head\s*>/i.test(source)) fail('index.html is a full document without <head>...</head>');
  page = dropMeta(source).replace(/<head[^>]*>/i, (m) => `${m}\n${HEAD_TOP}\n`).replace(/<\/head\s*>/i, (m) => `${SITE_CSS}\n${SW_HOOKUP}\n${m}`);
} else {
  const [head, body] = splitHead(source);
  page = `<!doctype html>\n<html lang="en">\n<head>\n${HEAD_TOP}\n${dropMeta(head).trim()}\n${SITE_CSS}\n${SW_HOOKUP}\n</head>\n<body>\n${body.replace(/^\s+/, '').replace(/\s+$/, '')}\n</body>\n</html>\n`;
}

// Content-Security-Policy, built like desktop/web-page.js buildCsp: inline scripts are allowed by their
// sha256 hash only, fonts come from Google Fonts, and connect-src adds the Supabase origin.
function siteCsp(html) {
  let scriptSrc = "'self'";
  if (webPage.needsUnsafeInline(html)) {
    scriptSrc += " 'unsafe-inline'";
    warn("index.html uses inline event handlers (on...=) or javascript: links, so script-src falls back to 'unsafe-inline'.");
  } else {
    const hashes = [...new Set(webPage.inlineScripts(html).map((s) => `'sha256-${crypto.createHash('sha256').update(s, 'utf8').digest('base64')}'`))];
    if (hashes.length) scriptSrc += ` ${hashes.join(' ')}`;
  }
  for (const r of webPage.remoteScripts(html)) warn(`Remote script ${r} will be blocked by the CSP. Copy it into src/ and load it with a relative URL.`);
  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    `connect-src 'self' data: blob:${supabaseOrigin ? ` ${supabaseOrigin}` : ''}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "frame-src 'self' blob: data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}
const csp = siteCsp(page.replace('%%CSP%%', ''));
page = page.replace('%%CSP%%', `<meta http-equiv="Content-Security-Policy" content="${csp}">`);
fs.writeFileSync(path.join(OUT, 'index.html'), page);

// Relative references: under /Deadlines/ a root path ("/x") would miss the site.
const REF_RE = /(?:\b(?:src|href|poster|data-src)\s*=\s*["']|\burl\(\s*["']?|\bfetch\(\s*["'`]|\bloadScript\(\s*["'`]|\bloadImg\(\s*["'`]|\bnew URL\(\s*["'])([^"'`)\s]+)/gi;
for (const m of source.matchAll(REF_RE)) {
  const ref = m[1];
  if (/^(?:[a-z][a-z0-9+.-]*:|#|\$\{|\{)/i.test(ref)) continue;
  if (/^\/(?!\/)/.test(ref)) { warn(`index.html uses the root path "${ref}"; on GitHub Pages it must be relative (no leading /)`); continue; }
  if (ref.startsWith('//')) continue;
  const clean = ref.replace(/^\.\//, '').split(/[?#]/)[0];
  if (!clean || clean.startsWith('..') || clean.includes('${')) continue;
  if (!fs.existsSync(path.join(OUT, clean))) warn(`index.html references "${clean}" but the site has no such file`);
}

// ---------- sw.js ----------
const listFiles = (dir) => fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => fs.statSync(path.join(dir, f)).isFile()).map((f) => f.split(path.sep).join('/')).sort();
const files = listFiles(OUT);
const template = fs.readFileSync(SW_TEMPLATE, 'utf8');
const hash = crypto.createHash('sha256').update(template);
for (const f of files) hash.update(`\0${f}\0`).update(fs.readFileSync(path.join(OUT, f)));
const version = hash.digest('hex').slice(0, 12);
const precache = files.map((f) => (f === 'index.html' ? './' : f));
if (!/const VERSION = "dev";/.test(template) || !template.includes('/* PRECACHE */ []')) fail('web/sw.js is missing its VERSION / PRECACHE placeholders');
const sw = template.replace('const VERSION = "dev";', `const VERSION = ${JSON.stringify(version)};`)
  .replace('/* PRECACHE */ []', JSON.stringify(precache, null, 2));
fs.writeFileSync(path.join(OUT, 'sw.js'), sw);

// ---------- summary ----------
const bytes = files.reduce((n, f) => n + fs.statSync(path.join(OUT, f)).size, 0);
log(`built ${OUT}`);
log(`app files: index.html, config.js, ${copied.join(', ')}`);
log(`accounts: ${accountsOn ? `on (${supabaseOrigin})` : 'off (config.js has no Supabase URL and key)'}`);
log(`service worker ${version}: ${precache.length} files precached, ${(bytes / 1048576).toFixed(1)} MB`);
log(`CSP: ${csp}`);
if (warnings.length) log(`${warnings.length} warning(s)`);
