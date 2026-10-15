// Checks the built zips in dist/ (or $DEADLINE_DIST_DIR) and smoke-tests the Linux build.
//   DEADLINE_BUILD_DIR=... node verify-packages.mjs
// - Unzips each package and checks its layout, the web files inside app.asar, icons,
//   Windows version metadata, macOS Info.plist / architecture / signature, and Electron fuses.
// - Launches the Linux app twice under a virtual display (xvfb-run) with DEADLINE_SELF_TEST=1:
//   index.html loads, fetch('programs.json') works, localStorage survives a relaunch, WebGL is
//   available, the CSP is in force, outside links go to the system browser, and the Canvas
//   bridge works end to end against a local mock Canvas server.
// - Accounts: config.js is inside app.asar as built; with a Supabase project in it, connect-src allows
//   that origin (and only it) and the page reaches it; with DEADLINE_SELF_TEST_SIGNIN_USER/_PASS set, the
//   page signs in through its welcome form on launch 1 and opens still signed in on launch 2. With an
//   empty config.js nothing is added to connect-src and there are no account screens.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.dirname(DESKTOP);
const APP_ROOT = path.join(REPO, 'app');
const BUILD = process.env.DEADLINE_BUILD_DIR;
if (!BUILD) { console.error('DEADLINE_BUILD_DIR is not set'); process.exit(1); }
const DIST = process.env.DEADLINE_DIST_DIR || path.join(REPO, 'dist');
const VERIFY = path.join(BUILD, 'verify');
const toolRequire = createRequire(path.join(BUILD, 'tooling', 'package.json'));
const importTool = (name) => import(pathToFileURL(toolRequire.resolve(name)).href);
const cjs = createRequire(import.meta.url);
const { startMockCanvas } = cjs('./mock-canvas.js');

const asar = await importTool('@electron/asar');
const ResEdit = await importTool('resedit');
const { getCurrentFuseWire, FuseV1Options, FuseState } = await importTool('@electron/fuses');
const version = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'package.json'), 'utf8')).version;
// what build.mjs shipped as config.js (app/config.js, or --config)
const builtConfig = (() => { try { return JSON.parse(fs.readFileSync(path.join(BUILD, 'built.json'), 'utf8')).config || null; } catch { return null; } })();
const SIGNIN = process.env.DEADLINE_SELF_TEST_SIGNIN_USER ? { user: process.env.DEADLINE_SELF_TEST_SIGNIN_USER, title: process.env.DEADLINE_SELF_TEST_ADD_TITLE || '' } : null;

const results = [];
const check = (target, name, pass, detail = '') => {
  results.push({ target, name, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  [${target}] ${name}${detail ? ` - ${detail}` : ''}`);
};
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const rm = (p) => fs.rmSync(p, { recursive: true, force: true });

// Files that must be inside app.asar.
function expectedWebFiles() {
  const out = ['/main.js', '/preload.js', '/canvas-api.js', '/web-page.js', '/package.json', '/icon.png', '/web/index.html', '/web/config.js', '/web/programs.json'];
  for (const dir of ['assets', 'src']) {
    const abs = path.join(APP_ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs, { recursive: true })) {
      const full = path.join(abs, f);
      if (fs.statSync(full).isFile() && !path.basename(f).startsWith('.')) out.push(`/web/${dir}/${f.split(path.sep).join('/')}`);
    }
  }
  return out;
}

function checkAsar(target, asarPath) {
  if (!fs.existsSync(asarPath)) return check(target, 'resources/app.asar present', false, asarPath);
  const list = new Set(asar.listPackage(asarPath, { isPack: false }).map((p) => p.split(path.sep).join('/')));
  const want = expectedWebFiles();
  const missing = want.filter((f) => !list.has(f));
  check(target, `app.asar has the app + web files (${want.length} checked)`, missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : '');
  const html = asar.extractFile(asarPath, 'web/index.html').toString('utf8');
  check(target, 'index.html is wrapped (doctype, charset, viewport)', /^<!doctype html>/i.test(html) && /<meta charset="utf-8">/.test(html) && /name="viewport"/.test(html));
  const prog = asar.extractFile(asarPath, 'web/programs.json');
  check(target, 'programs.json matches the source', sha(prog) === sha(fs.readFileSync(path.join(APP_ROOT, 'programs.json'))));
  let cfg = null;
  try { cfg = asar.extractFile(asarPath, 'web/config.js'); } catch { /* reported below */ }
  check(target, 'config.js is the one the build shipped', !!builtConfig && !!cfg && sha(cfg) === builtConfig.sha256,
    builtConfig ? `${builtConfig.from || 'empty default'}; accounts ${builtConfig.supabaseOrigin ? `on (${builtConfig.supabaseOrigin})` : 'off'}` : 'no built.json');
  const leaked = [...list].filter((f) => /node_modules|\/desktop\/|\/dist\/|\.map$|\/test\//.test(f));
  check(target, 'no build/test files inside app.asar', leaked.length === 0, leaked.slice(0, 5).join(', '));
}

async function checkFuses(target, binary) {
  try {
    const wire = await getCurrentFuseWire(binary);
    const off = (k) => wire[k] === FuseState.DISABLE;
    const on = (k) => wire[k] === FuseState.ENABLE;
    check(target, 'fuses: RunAsNode, NODE_OPTIONS, --inspect off; app.asar only', off(FuseV1Options.RunAsNode) && off(FuseV1Options.EnableNodeOptionsEnvironmentVariable)
      && off(FuseV1Options.EnableNodeCliInspectArguments) && on(FuseV1Options.OnlyLoadAppFromAsar) && off(FuseV1Options.GrantFileProtocolExtraPrivileges));
  } catch (e) { check(target, 'fuses readable', false, e.message); }
}

function unzip(zip, dest) {
  rm(dest);
  fs.mkdirSync(dest, { recursive: true });
  execFileSync('unzip', ['-q', zip, '-d', dest]);
}

const zips = Object.fromEntries(['win-x64', 'mac-arm64', 'mac-x64', 'linux-x64'].map((l) => [l, path.join(DIST, `Deadline-${version}-${l}.zip`)]).filter(([, z]) => fs.existsSync(z)));
rm(VERIFY);
fs.mkdirSync(VERIFY, { recursive: true });

// ---------- Windows ----------
if (zips['win-x64']) {
  const t = 'win-x64';
  const root = path.join(VERIFY, t);
  unzip(zips[t], root);
  const dir = path.join(root, 'Deadline');
  const exe = path.join(dir, 'Deadline.exe');
  check(t, 'Deadline/Deadline.exe present', fs.existsSync(exe));
  check(t, 'How to open Deadline.txt present', fs.existsSync(path.join(root, 'How to open Deadline.txt')));
  checkAsar(t, path.join(dir, 'resources', 'app.asar'));
  const pe = ResEdit.NtExecutable.from(fs.readFileSync(exe), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(pe);
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const sizes = groups.length ? groups[0].icons.map((i) => i.width || 256).sort((a, b) => a - b) : [];
  check(t, 'exe icon group has 16-256px images', groups.length > 0 && [16, 32, 48, 256].every((s) => sizes.includes(s)), `sizes ${sizes.join(',')}`);
  const items = groups.length ? groups[0].getIconItemsFromEntries(res.entries) : [];
  const ours = sha(fs.readFileSync(path.join(BUILD, 'icons', 'icon-256.png')));
  const has256 = items.some((it) => it.bin && sha(Buffer.from(it.bin)) === ours);
  check(t, 'exe icon is the Deadline icon (256px PNG matches)', has256);
  const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0];
  const lang = vi.getAllLanguagesForStringValues()[0];
  const strings = vi.getStringValues(lang);
  check(t, 'exe version info', strings.ProductName === 'Deadline' && strings.FileDescription === 'Deadline' && String(strings.ProductVersion).startsWith(version) && strings.OriginalFilename === 'Deadline.exe',
    JSON.stringify({ ProductName: strings.ProductName, FileDescription: strings.FileDescription, ProductVersion: strings.ProductVersion, FileVersion: strings.FileVersion, CompanyName: strings.CompanyName, OriginalFilename: strings.OriginalFilename, LegalCopyright: strings.LegalCopyright }));
  await checkFuses(t, exe);
}

// ---------- macOS ----------
const RCODESIGN = process.env.RCODESIGN || (fs.existsSync(path.join(BUILD, 'tools', 'rcodesign')) ? path.join(BUILD, 'tools', 'rcodesign') : '');
for (const t of ['mac-arm64', 'mac-x64']) {
  if (!zips[t]) continue;
  const root = path.join(VERIFY, t);
  unzip(zips[t], root);
  const app = path.join(root, 'Deadline.app');
  const exe = path.join(app, 'Contents', 'MacOS', 'Deadline');
  check(t, 'Deadline.app/Contents/MacOS/Deadline present and executable', fs.existsSync(exe) && (fs.statSync(exe).mode & 0o111) !== 0);
  const plist = fs.readFileSync(path.join(app, 'Contents', 'Info.plist'), 'utf8');
  const key = (k) => { const m = new RegExp(`<key>${k}</key>\\s*<string>([^<]*)</string>`).exec(plist); return m ? m[1] : null; };
  check(t, 'Info.plist name/id/version', key('CFBundleName') === 'Deadline' && key('CFBundleIdentifier') === 'app.deadline.desktop' && key('CFBundleShortVersionString') === version,
    `${key('CFBundleName')} ${key('CFBundleIdentifier')} ${key('CFBundleShortVersionString')} ${key('LSApplicationCategoryType')}`);
  const iconFile = key('CFBundleIconFile') || '';
  const icnsPath = path.join(app, 'Contents', 'Resources', iconFile.endsWith('.icns') ? iconFile : `${iconFile}.icns`);
  check(t, 'app icon (.icns) is the Deadline icon', fs.existsSync(icnsPath) && sha(fs.readFileSync(icnsPath)) === sha(fs.readFileSync(path.join(BUILD, 'icons', 'icon.icns'))), path.basename(icnsPath));
  const helpers = ['Deadline Helper.app', 'Deadline Helper (Renderer).app', 'Deadline Helper (GPU).app', 'Deadline Helper (Plugin).app'];
  const fw = path.join(app, 'Contents', 'Frameworks');
  check(t, 'helper apps present', helpers.every((h) => fs.existsSync(path.join(fw, h))));
  const cur = path.join(fw, 'Electron Framework.framework', 'Versions', 'Current');
  check(t, 'framework symlinks preserved', fs.existsSync(cur) && fs.lstatSync(cur).isSymbolicLink());
  const head = Buffer.alloc(8);
  const fd = fs.openSync(exe, 'r'); fs.readSync(fd, head, 0, 8, 0); fs.closeSync(fd);
  const cpu = head.readUInt32LE(4);
  const wantCpu = t === 'mac-arm64' ? 0x0100000c : 0x01000007;
  check(t, `main binary is ${t === 'mac-arm64' ? 'arm64' : 'x86_64'} Mach-O`, head.readUInt32LE(0) === 0xfeedfacf && cpu === wantCpu, `cputype 0x${cpu.toString(16)}`);
  checkAsar(t, path.join(app, 'Contents', 'Resources', 'app.asar'));
  await checkFuses(t, app);
  if (RCODESIGN) {
    const info = spawnSync(RCODESIGN, ['print-signature-info', exe], { encoding: 'utf8' });
    const txt = `${info.stdout}${info.stderr}`;
    const adhoc = /adhoc/i.test(txt);
    check(t, 'main binary carries an ad-hoc signature', info.status === 0 && adhoc, adhoc ? 'flags include adhoc' : txt.slice(0, 200));
    const runtime = /flags:.*runtime/i.test(txt) || /RUNTIME/.test(txt);
    check(t, 'no hardened runtime flag (needed for an ad-hoc Electron app)', !runtime);
    // `rcodesign verify` cannot check ad-hoc signatures (it expects a CMS blob), so check the
    // bindings directly: the code directory's Info.plist and CodeResources slots must match the
    // files on disk, and the resource seal must cover the final app.asar.
    const slot = (n) => { const m = new RegExp(`'${n} \\(\\d+\\): ([0-9a-f]{64})'`).exec(txt); return m ? m[1] : null; };
    const seal = path.join(app, 'Contents', '_CodeSignature', 'CodeResources');
    const sealOk = fs.existsSync(seal);
    check(t, 'signature binds Info.plist and the resource seal', sealOk && slot('Info') === sha(fs.readFileSync(path.join(app, 'Contents', 'Info.plist'))) && slot('Resources') === sha(fs.readFileSync(seal)));
    if (sealOk) {
      const cr = fs.readFileSync(seal, 'utf8');
      const m = /<key>Resources\/app\.asar<\/key>\s*<dict>[\s\S]*?<key>hash2<\/key>\s*<data>\s*([A-Za-z0-9+/=\s]+?)\s*<\/data>/.exec(cr);
      const asarHash = sha(fs.readFileSync(path.join(app, 'Contents', 'Resources', 'app.asar')));
      check(t, 'resource seal covers the final app.asar', !!m && Buffer.from(m[1].replace(/\s+/g, ''), 'base64').toString('hex') === asarHash);
    }
    const nested = ['Electron Framework.framework/Versions/A/Electron Framework', ...helpers.map((h) => `${h}/Contents/MacOS/${h.replace(/\.app$/, '')}`)];
    const nestedOk = nested.every((n) => /ADHOC/.test(spawnSync(RCODESIGN, ['print-signature-info', path.join(fw, n)], { encoding: 'utf8' }).stdout || ''));
    check(t, 'framework and helper apps are ad-hoc signed too', nestedOk);
  } else {
    check(t, 'signature check skipped (no rcodesign)', true);
  }
}

// ---------- Linux ----------
async function launch(binary, env, label) {
  const args = ['-a', '-s', '-screen 0 1440x900x24', binary];
  if (process.getuid && process.getuid() === 0) args.push('--no-sandbox');
  return new Promise((resolve) => {
    const child = spawn('xvfb-run', args, { env: { ...process.env, ...env, DEADLINE_SELF_TEST: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
    child.on('close', (code) => {
      clearTimeout(timer);
      fs.writeFileSync(path.join(VERIFY, `${label}.stderr.txt`), err);
      const line = out.split('\n').find((l) => l.startsWith('DEADLINE_SELF_TEST_RESULT '));
      let json = null;
      try { json = line ? JSON.parse(line.slice('DEADLINE_SELF_TEST_RESULT '.length)) : null; } catch { /* reported below */ }
      resolve({ code, json, err });
    });
  });
}

if (zips['linux-x64']) {
  const t = 'linux-x64';
  const root = path.join(VERIFY, t);
  unzip(zips[t], root);
  const bin = path.join(root, 'Deadline', 'deadline');
  check(t, 'Deadline/deadline present and executable', fs.existsSync(bin) && (fs.statSync(bin).mode & 0o111) !== 0);
  checkAsar(t, path.join(root, 'Deadline', 'resources', 'app.asar'));
  await checkFuses(t, bin);
  const hasXvfb = spawnSync('sh', ['-c', 'command -v xvfb-run'], { encoding: 'utf8' }).status === 0;
  if (!hasXvfb) {
    check(t, 'smoke test skipped: xvfb-run not installed', true);
  } else {
    const mock = await startMockCanvas();
    const userData = path.join(VERIFY, 'linux-userdata');
    rm(userData);
    const env = {
      DEADLINE_USER_DATA_DIR: userData,
      DEADLINE_SELF_TEST_CANVAS_URL: mock.url,
      DEADLINE_SELF_TEST_CANVAS_TOKEN: mock.token,
    };
    const r1 = await launch(bin, { ...env, DEADLINE_SELF_TEST_SHOT: path.join(VERIFY, 'linux-launch1.png') }, 'linux-launch1');
    const r2 = await launch(bin, { ...env, DEADLINE_SELF_TEST_SHOT: path.join(VERIFY, 'linux-launch2.png') }, 'linux-launch2');
    await mock.close();
    fs.writeFileSync(path.join(VERIFY, 'linux-selftest.json'), JSON.stringify({ launch1: r1.json, launch2: r2.json }, null, 2));
    const p1 = r1.json && r1.json.page;
    const p2 = r2.json && r2.json.page;
    check(t, 'launch 1 ran the self-test', !!p1, r1.json ? '' : `exit ${r1.code}: ${r1.err.slice(-400)}`);
    if (p1) {
      check(t, 'window loads app://deadline/index.html', p1.href === 'app://deadline/index.html' && p1.title === 'Deadline' && r1.json.loadErrors.length === 0, `${p1.href} "${p1.title}"`);
      check(t, 'window 1280x820, min 420x560, sky background, shown', r1.json.window.width === 1280 && r1.json.window.height === 820 && r1.json.window.visible, JSON.stringify(r1.json.window));
      check(t, "fetch('programs.json')", p1.programsFetch.ok, JSON.stringify(p1.programsFetch));
      check(t, 'path traversal blocked', Object.values(p1.traversal).every((s) => s === 404 || String(s).startsWith('error')), JSON.stringify(p1.traversal));
      check(t, 'WebGL available', !!(p1.webgl || p1.webgl2), (p1.webgl2 || p1.webgl || {}).renderer);
      check(t, 'Node hidden from the page; bridge exposed', p1.nodeHidden && p1.bridge && p1.bridge.isDesktop && p1.bridge.version === version, JSON.stringify(p1.bridge));
      check(t, 'CSP header in force (inline injection + remote script blocked)', /script-src/.test(p1.csp.header) && p1.csp.injectedInlineBlocked && p1.csp.remoteScriptBlocked === true && p1.csp.remoteFetchBlocked);
      check(t, 'no CSP violations from the page itself', r1.json.pageCspViolations.length === 0, r1.json.pageCspViolations.slice(0, 3).join(' | '));
      check(t, 'outside links open in the system browser; navigation away blocked',
        r1.json.urlAfterNavigateAway === 'app://deadline/index.html' && ['from-window-open', 'from-target-blank', 'navigate-away'].every((s) => r1.json.externalOpens.some((u) => u.includes(s))), JSON.stringify(r1.json.externalOpens));
      check(t, 'background painting usable by canvas/WebGL (not tainted)', !!(p1.imageUntainted && p1.imageUntainted.ok), JSON.stringify(p1.imageUntainted));
      check(t, 'glass engine loaded; WebGL usable by it (software GL here)', p1.glassEngine === 'object' && !!(p1.glassSupported && p1.glassSupported.software) && /\b(scene-live|glass-fallback)\b/.test(p1.htmlClass || ''), `engine ${p1.glassEngine}; supported ${JSON.stringify(p1.glassSupported)}; html class "${p1.htmlClass}"`);
      const broken = (p1.images || []).filter((i) => !i.loaded);
      check(t, 'all <img> elements loaded', broken.length === 0, `${(p1.images || []).length} images${broken.length ? `; not loaded: ${broken.map((i) => i.src).join(', ')}` : ''}`);
      console.log(`INFO  [${t}] timings ms ${JSON.stringify(r1.json.timings)}; GlassEngine: ${p1.glassEngine}; console errors from the page: ${JSON.stringify((r1.json.pageErrors || []).slice(0, 5))}`);
      const c = p1.canvas || {};
      check(t, 'Canvas bridge: http non-localhost refused', c.badUrl && c.badUrl.ok === false && c.badUrl.code === 'insecure_url');
      check(t, 'Canvas bridge: bad token -> 401 message', c.badToken && c.badToken.ok === false && c.badToken.code === 'unauthorized', c.badToken && c.badToken.error);
      check(t, 'Canvas bridge: connect', c.connect && c.connect.ok && c.connect.userName === 'Alex', JSON.stringify(c.connect));
      check(t, 'Canvas bridge: sync (3 pages, 6 items)', c.sync && c.sync.ok && c.sync.count === 6 && c.sync.pages === 3, JSON.stringify(c.sync && { count: c.sync.count, pages: c.sync.pages, first: c.sync.sample && c.sync.sample[0] }));
      check(t, 'Canvas bridge: disconnect', c.disconnect && c.disconnect.ok && c.statusAfterDisconnect && c.statusAfterDisconnect.connected === false);
      check(t, 'Canvas bridge: token never returned to the page', c.tokenNeverReturned === true);
      check(t, 'Canvas token storage', true, c.connect && c.connect.remembered ? 'encrypted with OS keychain' : 'no OS keychain here, so the token was kept in memory only (expected on a headless Linux box)');
    }
    check(t, 'launch 2 ran the self-test', !!p2, r2.json ? '' : `exit ${r2.code}: ${r2.err.slice(-400)}`);
    if (p1 && p2) check(t, 'localStorage persists across launches', p1.localStorage.previous === null && p2.localStorage.previous === '1' && p2.localStorage.now === '2', `launch1 saw ${p1.localStorage.previous}, launch2 saw ${p2.localStorage.previous}`);
    // ---- accounts ----
    if (p1) {
      const a1 = p1.accounts || {};
      const connect = (/(?:^|;)\s*connect-src ([^;]*)/.exec(p1.csp.header) || [])[1] || '';
      const others = connect.split(/\s+/).filter((x) => /^https?:/.test(x));
      if (builtConfig && builtConfig.supabaseOrigin) {
        const origin = builtConfig.supabaseOrigin;
        check(t, 'accounts on: connect-src allows the Supabase origin from config.js, and no other web origin', others.length === 1 && others[0] === origin, `connect-src ${connect}`);
        check(t, 'accounts on: the page loads config.js and the account client', a1.configured && a1.origin === origin && a1.clientLoaded, JSON.stringify({ configured: a1.configured, origin: a1.origin, client: a1.clientLoaded, screen: a1.screen }));
        const strict = !!SIGNIN;
        check(t, `accounts on: the page reaches Supabase (auth/v1/health${strict ? ' = 200' : ''}) without a CSP violation`,
          (a1.cspBlocked || []).length === 0 && (a1.health && a1.health.status === 200 || (!strict && !!a1.health)), `${JSON.stringify(a1.health)}${(a1.cspBlocked || []).length ? `; blocked: ${a1.cspBlocked.join(', ')}` : ''}`);
        if (SIGNIN) {
          check(t, 'accounts on, launch 1: signs in through the welcome form', a1.screen === 'sign-in' && a1.signIn && a1.signIn.shown && a1.signedIn && a1.user && a1.user.username.toLowerCase() === SIGNIN.user.toLowerCase(),
            JSON.stringify({ screen: a1.screen, signIn: a1.signIn, user: a1.user, name: a1.name }));
          check(t, 'accounts on, launch 1: a deadline added in the app syncs to the account', a1.synced && a1.rev >= 1 && (!SIGNIN.title || (a1.added && a1.titles.includes(SIGNIN.title))), JSON.stringify({ synced: a1.synced, rev: a1.rev, titles: a1.titles }));
          const a2 = (p2 && p2.accounts) || {};
          check(t, 'accounts on, launch 2: opens still signed in, with the account\'s list, and syncs', a2.screen === 'app' && a2.signedIn && a2.synced && a2.name === a1.name && (!SIGNIN.title || a2.titles.includes(SIGNIN.title)) && (a2.cspBlocked || []).length === 0,
            JSON.stringify({ screen: a2.screen, signedIn: a2.signedIn, synced: a2.synced, name: a2.name, titles: a2.titles }));
        }
      } else {
        check(t, 'accounts off (empty config.js): nothing added to connect-src; no account screens or client', others.length === 0 && !a1.configured && !a1.clientLoaded && a1.screen !== 'sign-in',
          `connect-src ${connect}; screen ${a1.screen}`);
      }
    }
  }
}

const failed = results.filter((r) => !r.pass);
fs.writeFileSync(path.join(VERIFY, 'report.json'), JSON.stringify(results, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Report: ${path.join(VERIFY, 'report.json')}`);
process.exit(failed.length ? 1 : 0);
