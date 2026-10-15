'use strict';
// Deadline desktop shell (Electron main process).
// Serves the web app from app://deadline/, keeps it sandboxed, opens outside links in the
// system browser, and bridges Canvas LMS calls (which a web page cannot make because of CORS).
const { app, BrowserWindow, Menu, ipcMain, net, protocol, safeStorage, screen, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { createCanvasService } = require('./canvas-api');
const { ORIGIN, wrapHtml, buildCsp } = require('./web-page');

const SCHEME = 'app';
const HOST = 'deadline';
const START_URL = `${ORIGIN}/index.html`;
const SKY_COLOR = '#6E9BD1'; // matches the painting's sky, so there is no white flash on launch
const SELF_TEST = process.env.DEADLINE_SELF_TEST === '1';
const isDev = !app.isPackaged || process.env.DEADLINE_DEV === '1';

if (process.env.DEADLINE_USER_DATA_DIR) app.setPath('userData', path.resolve(process.env.DEADLINE_USER_DATA_DIR));
app.setName('Deadline');
if (process.platform === 'win32') app.setAppUserModelId('app.deadline.desktop');

// The page only shows our own bundled content, so letting WebGL fall back to the software
// renderer (when a laptop's GPU is blocklisted) is safe and keeps the glass effects working.
app.commandLine.appendSwitch('enable-unsafe-swiftshader');

protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true },
}]);

// ---------- web files ----------

// Packaged: <app>/web (copied there by build.sh). From source: the repo's app/ folder.
const WEB_ROOT = (() => {
  const bundled = path.join(__dirname, 'web');
  if (fs.existsSync(path.join(bundled, 'index.html'))) return bundled;
  return path.resolve(__dirname, '..', 'app');
})();
const FROM_SOURCE = !WEB_ROOT.startsWith(path.join(__dirname, 'web'));
const SOURCE_SKIP = new Set(['desktop', 'dist', 'node_modules', 'uploads']);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.avif': 'image/avif', '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.webm': 'video/webm', '.glsl': 'text/plain; charset=utf-8',
  '.frag': 'text/plain; charset=utf-8', '.vert': 'text/plain; charset=utf-8', '.wasm': 'application/wasm',
};

let indexCache = null;
function loadIndex() {
  if (indexCache && !FROM_SOURCE) return indexCache;
  const html = wrapHtml(fs.readFileSync(path.join(WEB_ROOT, 'index.html'), 'utf8'));
  // config.js names the Supabase project (accounts); the CSP lets the page reach it, and nothing else
  let config = '';
  try { config = fs.readFileSync(path.join(WEB_ROOT, 'config.js'), 'utf8'); } catch { /* no accounts */ }
  const { policy, warnings } = buildCsp(html, { config });
  if (isDev) for (const w of warnings) console.warn(`[deadline] ${w}`);
  indexCache = { body: Buffer.from(html, 'utf8'), csp: policy };
  return indexCache;
}

function respond(status, text) {
  return new Response(text, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

async function serveAppFile(request) {
  let url;
  try { url = new URL(request.url); } catch { return respond(400, 'Bad request'); }
  if (url.host !== HOST) return respond(404, 'Not found');
  if (request.method !== 'GET' && request.method !== 'HEAD') return respond(405, 'Method not allowed');
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { return respond(400, 'Bad request'); }
  if (rel.includes('\0')) return respond(400, 'Bad request');
  if (rel === '/' || rel.endsWith('/')) rel += 'index.html';
  const filePath = path.resolve(WEB_ROOT, `.${rel}`);
  if (!filePath.startsWith(WEB_ROOT + path.sep)) return respond(404, 'Not found');
  const top = path.relative(WEB_ROOT, filePath).split(path.sep)[0];
  if (FROM_SOURCE && (SOURCE_SKIP.has(top) || top.startsWith('.'))) return respond(404, 'Not found');

  const { csp } = loadIndex();
  const headers = {
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-cache',
    'cross-origin-opener-policy': 'same-origin',
  };
  let body;
  if (filePath === path.join(WEB_ROOT, 'index.html')) {
    body = loadIndex().body;
  } else {
    try {
      const st = await fs.promises.stat(filePath);
      if (!st.isFile()) return respond(404, 'Not found');
      body = await fs.promises.readFile(filePath);
    } catch { return respond(404, 'Not found'); }
  }
  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  headers['content-type'] = type;
  if (type.startsWith('text/html') || type.startsWith('text/javascript')) headers['content-security-policy'] = csp;

  // Byte ranges, so <audio>/<video> can seek.
  const range = request.headers.get('range');
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (m && (m[1] || m[2])) {
    const size = body.length;
    let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    let end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start >= size || start > end) {
      return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${size}` } });
    }
    headers['content-range'] = `bytes ${start}-${end}/${size}`;
    headers['accept-ranges'] = 'bytes';
    headers['content-length'] = String(end - start + 1);
    return new Response(request.method === 'HEAD' ? null : body.subarray(start, end + 1), { status: 206, headers });
  }
  headers['accept-ranges'] = 'bytes';
  headers['content-length'] = String(body.length);
  return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers });
}

// ---------- Canvas bridge ----------

function canvasStore() {
  const file = () => path.join(app.getPath('userData'), 'canvas-connection.json');
  // Only trust storage that is backed by the OS keychain (Keychain, DPAPI, libsecret/kwallet).
  const secure = () => {
    try {
      if (!safeStorage.isEncryptionAvailable()) return false;
      if (process.platform === 'linux') {
        const backend = safeStorage.getSelectedStorageBackend();
        return backend !== 'basic_text' && backend !== 'unknown';
      }
      return true;
    } catch { return false; }
  };
  const write = async (obj) => {
    const target = file();
    const tmp = `${target}.tmp`;
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
    await fs.promises.rename(tmp, target);
  };
  return {
    async load() {
      let saved;
      try { saved = JSON.parse(await fs.promises.readFile(file(), 'utf8')); } catch { return null; }
      if (!saved || typeof saved.tokenEnc !== 'string' || !secure()) return null;
      try {
        const token = safeStorage.decryptString(Buffer.from(saved.tokenEnc, 'base64'));
        return { baseUrl: saved.baseUrl, userName: saved.userName, lastSync: saved.lastSync, token };
      } catch { return null; }
    },
    async save(state) {
      if (!secure()) {
        // Keep the token in memory for this session only; never write it in plain text.
        await this.clear();
        return { persisted: false };
      }
      const tokenEnc = safeStorage.encryptString(state.token).toString('base64');
      await write({ v: 1, baseUrl: state.baseUrl, userName: state.userName, lastSync: state.lastSync, tokenEnc });
      return { persisted: true };
    },
    async clear() {
      await fs.promises.rm(file(), { force: true });
    },
  };
}

let canvas = null;

function isTrustedSender(event) {
  const url = (event.senderFrame && event.senderFrame.url) || '';
  return url.startsWith(`${ORIGIN}/`);
}

function registerIpc() {
  canvas = createCanvasService({ fetch: (url, init) => net.fetch(url, init), store: canvasStore() });
  const guard = (fn) => async (event, arg) => {
    if (!isTrustedSender(event)) return { ok: false, error: 'Not allowed.', code: 'forbidden_sender' };
    return fn(arg && typeof arg === 'object' ? arg : {});
  };
  ipcMain.handle('canvas:connect', guard((a) => canvas.connect({
    baseUrl: typeof a.baseUrl === 'string' ? a.baseUrl : '',
    token: typeof a.token === 'string' ? a.token : '',
  })));
  ipcMain.handle('canvas:status', guard(() => canvas.status()));
  ipcMain.handle('canvas:sync', guard(() => canvas.sync()));
  ipcMain.handle('canvas:disconnect', guard(() => canvas.disconnect()));
}

// ---------- navigation and permissions ----------

const externalOpens = [];
function openExternal(url) {
  if (SELF_TEST) { externalOpens.push(url); return; }
  shell.openExternal(url).catch(() => {});
}
function isExternalUrl(url) {
  try { return ['https:', 'http:', 'mailto:'].includes(new URL(url).protocol); } catch { return false; }
}
function isAppUrl(url) {
  return typeof url === 'string' && url.startsWith(`${ORIGIN}/`);
}

app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) openExternal(url);
    return { action: 'deny' };
  });
  const block = (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    if (isExternalUrl(url)) openExternal(url);
  };
  contents.on('will-navigate', block);
  contents.on('will-redirect', block);
  contents.on('will-attach-webview', (event) => event.preventDefault());
});

function lockDownSession() {
  const allowed = new Set(['clipboard-sanitized-write', 'fullscreen', 'notifications']);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(allowed.has(permission) && isAppUrl(details.requestingUrl || ''));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    return allowed.has(permission) && requestingOrigin === ORIGIN;
  });
}

// ---------- menu ----------

function buildMenu() {
  const mac = process.platform === 'darwin';
  if (!mac && !isDev) { Menu.setApplicationMenu(null); return; }
  const template = [];
  if (mac) template.push({ role: 'appMenu' });
  template.push({ role: 'editMenu' });
  const view = [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }];
  if (isDev) view.unshift({ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' });
  template.push({ label: 'View', submenu: view });
  if (mac) template.push({ role: 'windowMenu' });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- window ----------

const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');
function loadBounds() {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    if (!(s.width >= 400 && s.height >= 300)) return null;
    if (Number.isFinite(s.x) && Number.isFinite(s.y)) {
      const area = screen.getDisplayMatching({ x: s.x, y: s.y, width: s.width, height: s.height }).workArea;
      const visible = s.x < area.x + area.width - 80 && s.x + s.width > area.x + 80 && s.y >= area.y - 10 && s.y < area.y + area.height - 80;
      if (!visible) { delete s.x; delete s.y; }
    }
    return s;
  } catch { return null; }
}
function saveBounds(win) {
  try {
    const b = win.getNormalBounds();
    fs.writeFileSync(stateFile(), JSON.stringify({ ...b, maximized: win.isMaximized() }));
  } catch { /* not important */ }
}

let mainWindow = null;

function createWindow() {
  const saved = SELF_TEST ? null : loadBounds();
  const win = new BrowserWindow({
    width: saved ? saved.width : 1280,
    height: saved ? saved.height : 820,
    x: saved && Number.isFinite(saved.x) ? saved.x : undefined,
    y: saved && Number.isFinite(saved.y) ? saved.y : undefined,
    minWidth: 420,
    minHeight: 560,
    show: false,
    title: 'Deadline',
    backgroundColor: SKY_COLOR,
    autoHideMenuBar: true,
    icon: process.platform === 'darwin' ? undefined : path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      devTools: isDev,
      spellcheck: true,
      additionalArguments: [`--deadline-version=${app.getVersion()}`],
    },
  });
  mainWindow = win;
  let shown = false;
  const show = () => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    if (saved && saved.maximized) win.maximize();
    win.show();
  };
  win.once('ready-to-show', show);
  setTimeout(show, 2500); // never stay invisible for long if a stylesheet (e.g. Google Fonts) is slow
  win.on('close', () => { saveBounds(win); session.defaultSession.flushStorageData(); });
  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });
  // If the page's renderer crashes (e.g. a GPU driver problem), reload once instead of leaving a blank window.
  let crashReloads = 0;
  win.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit' || win.isDestroyed() || crashReloads >= 2) return;
    crashReloads++;
    setTimeout(() => { if (!win.isDestroyed()) win.loadURL(START_URL); }, 500);
  });
  win.loadURL(START_URL);
  if (SELF_TEST) require('./self-test').run(win, { externalOpens, START_URL });
  return win;
}

// ---------- app lifecycle ----------

if (!SELF_TEST && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    protocol.handle(SCHEME, serveAppFile);
    lockDownSession();
    registerIpc();
    buildMenu();
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });

  app.on('before-quit', () => { try { session.defaultSession.flushStorageData(); } catch { /* quitting */ } });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin' || SELF_TEST) app.quit(); });
}
