// Builds the Deadline desktop packages. Run it through build.sh, which installs the tooling.
//   node build.mjs [--platforms=linux,win,mac] [--skip-test] [--config=<config.js to ship instead of app/config.js>]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeIcons } from './icons.mjs';

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.dirname(DESKTOP);
const APP_ROOT = path.join(REPO, 'app');   // the web app: index.html, config.js, programs.json, assets/, src/
const BUILD = process.env.DEADLINE_BUILD_DIR;
if (!BUILD) { console.error('DEADLINE_BUILD_DIR is not set; run build.sh instead.'); process.exit(1); }
const TOOLING = path.join(BUILD, 'tooling');
const DIST = process.env.DEADLINE_DIST_DIR || path.join(REPO, 'dist');
const RCODESIGN = process.env.RCODESIGN || '';

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.length ? v.join('=') : true]; }));
const PLATFORMS = String(args.platforms || 'linux,win,mac').split(',').map((s) => s.trim()).filter(Boolean);

const toolRequire = createRequire(path.join(TOOLING, 'package.json'));
const importTool = (name) => import(pathToFileURL(toolRequire.resolve(name)).href);
const cjs = createRequire(import.meta.url);
const webPage = cjs(path.join(DESKTOP, 'web-page.js'));

const pkg = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'package.json'), 'utf8'));
const VERSION = pkg.version;
const ELECTRON_VERSION = JSON.parse(fs.readFileSync(toolRequire.resolve('electron/package.json'), 'utf8')).version;

const log = (...m) => console.log('[build]', ...m);
const warnings = [];
const warn = (m) => { warnings.push(m); console.warn('[build] WARNING:', m); };
const rm = (p) => fs.rmSync(p, { recursive: true, force: true });
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

// ---------- 1. icons ----------
const ICONS = path.join(BUILD, 'icons');
log('rendering icons');
await makeIcons({ toolingDir: TOOLING, svgPath: path.join(DESKTOP, 'icon.svg'), outDir: ICONS });

// ---------- 2. stage the app ----------
const STAGE = path.join(BUILD, 'stage', 'app');
rm(path.join(BUILD, 'stage'));
fs.mkdirSync(path.join(STAGE, 'web'), { recursive: true });

for (const f of ['main.js', 'preload.js', 'canvas-api.js', 'web-page.js', 'self-test.js']) {
  fs.copyFileSync(path.join(DESKTOP, f), path.join(STAGE, f));
}
fs.copyFileSync(path.join(ICONS, 'icon.png'), path.join(STAGE, 'icon.png'));
fs.writeFileSync(path.join(STAGE, 'package.json'), JSON.stringify({
  name: 'deadline',
  productName: 'Deadline',
  version: VERSION,
  description: pkg.description,
  main: 'main.js',
  author: 'Deadline',
  license: pkg.license,
}, null, 2));

// Web files: index.html (wrapped), config.js, programs.json, assets/, src/ (src/account.js is the
// accounts client), plus any other top-level folder or file that the page or its scripts reference
// with a relative URL.
const SKIP_TOP = new Set(['desktop', 'dist', 'node_modules', 'uploads', 'config.js']);
const REF_RE = /(?:\b(?:src|href|poster|data-src)\s*=\s*["']|\burl\(\s*["']?|\bfetch\(\s*["'`]|\bimport\s*(?:[\w*{}\s,]+from\s*)?["']|\bnew URL\(\s*["'])([^"'`)\s]+)/gi;
function relativeRefs(text) {
  const out = new Set();
  for (const m of text.matchAll(REF_RE)) {
    const ref = m[1];
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\$\{|\{)/i.test(ref)) continue;
    const clean = ref.replace(/^\.\//, '').replace(/^\/+/, '').split(/[?#]/)[0];
    if (!clean || clean.startsWith('..') || clean.includes('${')) continue;
    out.add(clean);
  }
  return out;
}
if (!fs.existsSync(path.join(APP_ROOT, 'index.html'))) { console.error(`${APP_ROOT}/index.html not found`); process.exit(1); }
const indexSrc = fs.readFileSync(path.join(APP_ROOT, 'index.html'), 'utf8');
const wrapped = webPage.wrapHtml(indexSrc);
const refs = relativeRefs(indexSrc);
const listFiles = (dir) => fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map((f) => path.join(dir, f)).filter((f) => fs.statSync(f).isFile()) : [];
for (const f of listFiles(path.join(APP_ROOT, 'src'))) if (/\.(m?js|css)$/i.test(f)) for (const r of relativeRefs(fs.readFileSync(f, 'utf8'))) refs.add(r);
const tops = new Set(['programs.json', 'assets', 'src']);
for (const r of refs) tops.add(r.split('/')[0]);
fs.writeFileSync(path.join(STAGE, 'web', 'index.html'), wrapped);
// config.js (accounts): --config, else app/config.js, else an empty one (accounts off, as before)
const EMPTY_CONFIG = 'window.DEADLINE_CONFIG = { supabaseUrl: "", supabaseKey: "", usernameDomain: "users.deadline.invalid" };\n';
const configPath = args.config ? path.resolve(String(args.config)) : path.join(APP_ROOT, 'config.js');
if (args.config && !fs.existsSync(configPath)) { console.error(`--config ${configPath} not found`); process.exit(1); }
const configText = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : EMPTY_CONFIG;
const { config } = webPage.readConfig(configText);
if (webPage.isSecretKey(config.supabaseKey)) {
  console.error('[build] ERROR: config.js holds a Supabase SECRET (service_role) key. Use the publishable key (sb_publishable_...); the secret one must never ship inside an app.');
  process.exit(1);
}
fs.writeFileSync(path.join(STAGE, 'web', 'config.js'), configText);
const copied = ['index.html (wrapped)', `config.js${args.config ? ` (from ${configPath})` : ''}`];
for (const top of [...tops].sort()) {
  if (top === 'index.html' || SKIP_TOP.has(top) || top.startsWith('.')) continue;
  const from = path.join(APP_ROOT, top);
  if (!fs.existsSync(from)) { if (['programs.json'].includes(top)) warn(`${top} is missing`); continue; }
  fs.cpSync(from, path.join(STAGE, 'web', top), {
    recursive: true,
    dereference: true,
    filter: (src) => !/(^|[\\/])(\.[^\\/]*|Thumbs\.db|desktop\.ini)$/.test(src),
  });
  copied.push(fs.statSync(from).isDirectory() ? `${top}/ (${listFiles(from).length} files)` : top);
}
for (const r of refs) {
  if (!fs.existsSync(path.join(STAGE, 'web', r)) && !SKIP_TOP.has(r.split('/')[0])) warn(`the page references "${r}" but it is not in app/`);
}
const { policy, warnings: cspWarnings, supabaseOrigin } = webPage.buildCsp(wrapped, { config: configText });
cspWarnings.forEach(warn);
log('web files:', copied.join(', '));
log(`accounts: ${supabaseOrigin ? `on (${supabaseOrigin} is allowed in connect-src)` : 'off (config.js has no Supabase URL and key)'}`);
fs.writeFileSync(path.join(BUILD, 'csp.txt'), `${policy}\n`);

// ---------- 3. package ----------
const { packager } = await importTool('@electron/packager');
const { flipFuses, FuseVersion, FuseV1Options } = await importTool('@electron/fuses');
const OUT = path.join(BUILD, 'out');
const TARGETS = [
  ...(PLATFORMS.includes('win') ? [{ platform: 'win32', arch: 'x64', label: 'win-x64' }] : []),
  ...(PLATFORMS.includes('mac') ? [{ platform: 'darwin', arch: 'arm64', label: 'mac-arm64' }, { platform: 'darwin', arch: 'x64', label: 'mac-x64' }] : []),
  ...(PLATFORMS.includes('linux') ? [{ platform: 'linux', arch: 'x64', label: 'linux-x64' }] : []),
];
fs.mkdirSync(DIST, { recursive: true });
fs.mkdirSync(path.join(BUILD, 'tmp'), { recursive: true });
const built = [];

// Electron zips: fetched with curl (it follows HTTPS_PROXY reliably) and checked against the
// sha256 list that ships inside the electron npm package, then handed to packager.
const ZIPS = path.join(BUILD, 'cache', 'electron-zips');
fs.mkdirSync(ZIPS, { recursive: true });
const CHECKSUMS = JSON.parse(fs.readFileSync(toolRequire.resolve('electron/checksums.json'), 'utf8'));
function ensureElectronZip(platform, arch) {
  const name = `electron-v${ELECTRON_VERSION}-${platform}-${arch}.zip`;
  const file = path.join(ZIPS, name);
  const expected = CHECKSUMS[name];
  if (!expected) throw new Error(`No checksum for ${name} in electron/checksums.json`);
  const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  if (fs.existsSync(file) && sha(file) === expected) return;
  const url = `https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/${name}`;
  log(`downloading ${name}`);
  execFileSync('curl', ['-sSfL', '--retry', '3', '-o', `${file}.part`, url], { stdio: 'inherit' });
  if (sha(`${file}.part`) !== expected) { rm(`${file}.part`); throw new Error(`Checksum mismatch for ${name}`); }
  fs.renameSync(`${file}.part`, file);
}

for (const t of TARGETS) {
  log(`packaging ${t.label} (Electron ${ELECTRON_VERSION})`);
  ensureElectronZip(t.platform, t.arch);
  const [appDir] = await packager({
    dir: STAGE,
    out: OUT,
    overwrite: true,
    platform: t.platform,
    arch: t.arch,
    electronVersion: ELECTRON_VERSION,
    electronZipDir: ZIPS,
    tmpdir: path.join(BUILD, 'tmp'),
    name: 'Deadline',
    executableName: t.platform === 'linux' ? 'deadline' : 'Deadline',
    appVersion: VERSION,
    buildVersion: VERSION,
    appCopyright: `Copyright ${new Date().getFullYear()} Deadline`,
    icon: path.join(ICONS, 'icon'),
    asar: true,
    prune: false,
    junk: true,
    quiet: true,
    appBundleId: 'app.deadline.desktop',
    appCategoryType: 'public.app-category.education',
    darwinDarkModeSupport: true,
    win32metadata: {
      CompanyName: 'Deadline',
      FileDescription: 'Deadline',
      ProductName: 'Deadline',
      InternalName: 'Deadline',
      OriginalFilename: 'Deadline.exe',
    },
  });

  const willSign = t.platform === 'darwin' && RCODESIGN;
  const binary = t.platform === 'win32' ? path.join(appDir, 'Deadline.exe')
    : t.platform === 'linux' ? path.join(appDir, 'deadline')
    : path.join(appDir, 'Deadline.app');
  if (t.platform !== 'darwin' || willSign) {
    await flipFuses(binary, {
      version: FuseVersion.V1,
      resetAdHocDarwinSignature: false,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    });
  } else {
    warn(`${t.label}: no signing tool, so Electron fuses were left at their defaults (changing them would break the signature).`);
  }

  if (t.platform === 'darwin') {
    if (willSign) {
      log(`ad-hoc signing ${t.label} with rcodesign`);
      const r = spawnSync(RCODESIGN, ['sign', binary], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`rcodesign failed for ${t.label}:\n${r.stdout}\n${r.stderr}`);
    } else {
      warn(`${t.label}: not signed (rcodesign unavailable). On Apple Silicon this app will be reported as damaged.`);
    }
  }

  // Zip: Windows/Linux get a "Deadline" folder, macOS gets Deadline.app at the root.
  const zipName = `Deadline-${VERSION}-${t.label}.zip`;
  const zipPath = path.join(DIST, zipName);
  const zipRoot = path.join(BUILD, 'zip', t.label);
  rm(zipRoot);
  fs.mkdirSync(zipRoot, { recursive: true });
  const howTo = {
    win32: 'Deadline for Windows\r\n\r\n1. Right-click the zip and choose "Extract All".\r\n2. Open the Deadline folder and double-click Deadline.exe.\r\n3. If Windows shows "Windows protected your PC", click "More info", then "Run anyway".\r\n   (The app is not signed with a paid certificate, so Windows does not recognize it yet.)\r\n4. Optional: right-click Deadline.exe > Send to > Desktop (create shortcut).\r\n',
    darwin: 'Deadline for macOS\n\n1. Double-click the zip to unzip it, then drag Deadline.app into Applications.\n2. The first time, right-click (or Control-click) Deadline.app and choose Open, then click Open.\n   On macOS 15 (Sequoia) or newer: double-click it once, click Done, then go to\n   System Settings > Privacy & Security, scroll down and click "Open Anyway".\n3. After that it opens normally.\n',
    linux: 'Deadline for Linux\n\nUnzip, then run ./Deadline/deadline\nIf it exits with a sandbox error, run once:\n  sudo chown root Deadline/chrome-sandbox && sudo chmod 4755 Deadline/chrome-sandbox\n',
  }[t.platform];
  let entry;
  if (t.platform === 'darwin') {
    fs.renameSync(binary, path.join(zipRoot, 'Deadline.app'));
    entry = ['Deadline.app', 'How to open Deadline.txt'];
  } else {
    fs.renameSync(appDir, path.join(zipRoot, 'Deadline'));
    entry = ['Deadline', 'How to open Deadline.txt'];
  }
  fs.writeFileSync(path.join(zipRoot, 'How to open Deadline.txt'), howTo);
  rm(zipPath);
  execFileSync('zip', ['-r', '-y', '-q', '-X', zipPath, ...entry], { cwd: zipRoot });
  built.push({ label: t.label, zip: zipPath, size: fs.statSync(zipPath).size, unpacked: zipRoot });
  log(`wrote ${zipName} (${mb(fs.statSync(zipPath).size)})`);
}

// ---------- 4. checksums ----------
const sums = fs.readdirSync(DIST).filter((f) => /^Deadline-.*\.zip$/.test(f)).sort().map((f) => {
  const h = crypto.createHash('sha256').update(fs.readFileSync(path.join(DIST, f))).digest('hex');
  return `${h}  ${f}`;
});
fs.writeFileSync(path.join(DIST, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`);
fs.writeFileSync(path.join(BUILD, 'built.json'), JSON.stringify({ version: VERSION, electron: ELECTRON_VERSION, built, warnings, config: { sha256: crypto.createHash('sha256').update(configText).digest('hex'), from: fs.existsSync(configPath) ? configPath : null, supabaseOrigin } }, null, 2));

log('done.');
for (const b of built) log(`  ${path.basename(b.zip)}  ${mb(b.size)}`);
if (warnings.length) { log(`${warnings.length} warning(s):`); warnings.forEach((w) => log(`  - ${w}`)); }
