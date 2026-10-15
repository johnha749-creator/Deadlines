'use strict';
// Smoke test for the packaged app. Only loaded when DEADLINE_SELF_TEST=1 (build.sh runs it on
// the Linux build under a virtual display). Prints one line: DEADLINE_SELF_TEST_RESULT {json}
const { app, session } = require('electron');
const fs = require('node:fs');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs inside the page (main world) via executeJavaScript.
async function pageChecks(opts) {
  const r = {};
  r.href = location.href;
  r.title = document.title;
  r.doctype = document.doctype ? document.doctype.name : null;
  r.charset = document.characterSet;
  r.viewportMeta = !!document.querySelector('meta[name="viewport"]');
  r.nodeHidden = typeof require === 'undefined' && typeof process === 'undefined' && typeof module === 'undefined';
  const b = window.deadlineDesktop;
  r.bridge = b ? { isDesktop: b.isDesktop, platform: b.platform, version: b.version, canvas: Object.keys(b.canvas || {}).sort() } : null;

  try {
    const res = await fetch('programs.json', { cache: 'no-store' });
    const j = await res.json();
    r.programsFetch = { ok: res.ok, status: res.status, type: res.headers.get('content-type'), programs: Array.isArray(j.programs) ? j.programs.length : null };
  } catch (e) { r.programsFetch = { ok: false, error: String(e) }; }

  r.traversal = {};
  for (const p of ['../main.js', 'desktop/main.js', '/%2e%2e/main.js', '/..%2fmain.js', '/..%5cmain.js', 'app://deadline/../package.json']) {
    try { const res = await fetch(p); r.traversal[p] = res.status; } catch (e) { r.traversal[p] = `error: ${e.message}`; }
  }

  const K = 'deadline-selftest-launches';
  const prev = localStorage.getItem(K);
  localStorage.setItem(K, String((Number(prev) || 0) + 1));
  r.localStorage = { previous: prev, now: localStorage.getItem(K), keys: Object.keys(localStorage).sort() };

  const probe = (kind) => {
    try {
      const c = document.createElement('canvas');
      const g = c.getContext(kind);
      if (!g) return null;
      const ext = g.getExtension('WEBGL_debug_renderer_info');
      return { version: g.getParameter(g.VERSION), renderer: ext ? g.getParameter(ext.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER) };
    } catch (e) { return { error: String(e) }; }
  };
  r.webgl = probe('webgl');
  r.webgl2 = probe('webgl2');

  r.csp = {};
  try {
    const res = await fetch('index.html', { cache: 'no-store' });
    r.csp.header = res.headers.get('content-security-policy') || '';
  } catch (e) { r.csp.header = `error: ${e.message}`; }
  r.csp.remoteScriptBlocked = await new Promise((done) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/left-pad@1.3.0/index.js';
    s.onload = () => done(false);
    s.onerror = () => done(true);
    document.head.appendChild(s);
    setTimeout(() => done('timeout'), 4000);
  });
  window.__deadlineInjected = false;
  const inj = document.createElement('script');
  inj.textContent = 'window.__deadlineInjected = true';
  document.head.appendChild(inj);
  r.csp.injectedInlineBlocked = window.__deadlineInjected === false;
  r.csp.remoteFetchBlocked = await fetch('https://example.com/').then(() => false, () => true);
  r.stylesheets = [...document.styleSheets].map((s) => s.href || 'inline');
  r.fontsReady = await Promise.race([document.fonts.ready.then(() => [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family)), new Promise((d) => setTimeout(() => d('timeout'), 3000))]);

  if (b && opts.canvasUrl) {
    const c = {};
    c.statusBefore = await b.canvas.status();
    c.badUrl = await b.canvas.connect({ baseUrl: 'http://not-local.example.com', token: opts.canvasToken });
    c.badToken = await b.canvas.connect({ baseUrl: opts.canvasUrl, token: 'wrong-token-1234' });
    c.connect = await b.canvas.connect({ baseUrl: opts.canvasUrl, token: opts.canvasToken });
    c.status = await b.canvas.status();
    const s = await b.canvas.sync();
    c.sync = { ok: s.ok, count: s.items ? s.items.length : null, pages: s.pages, sample: s.items ? s.items.slice(0, 2) : null, error: s.error };
    c.statusAfterSync = await b.canvas.status();
    c.disconnect = await b.canvas.disconnect();
    c.statusAfterDisconnect = await b.canvas.status();
    c.tokenNeverReturned = !JSON.stringify(c).includes(opts.canvasToken);
    r.canvas = c;
  }

  // Accounts: when config.js names a Supabase project, the CSP has to let the page reach it (and only
  // it). With opts.account ({ user, pass }) the page also signs in through its own welcome form, adds a
  // deadline and waits until it has synced; a relaunch then has to open still signed in.
  const wait = async (test, ms) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise((d) => setTimeout(d, 100))) { if (test()) return true; } return !!test(); };
  const cfg = window.DEADLINE_CONFIG || {};
  const acct = { configured: !!(String(cfg.supabaseUrl || '').trim() && String(cfg.supabaseKey || '').trim()) };
  r.accounts = acct;
  acct.clientLoaded = acct.configured ? await wait(() => !!window.DeadlineAccount, 5000) : !!window.DeadlineAccount;
  acct.screen = document.querySelector('#authTabs') ? 'sign-in' : document.querySelector('#nameInput') ? 'name prompt' : document.querySelector('#tabbar') ? 'app' : 'other';
  if (acct.configured) {
    const base = String(cfg.supabaseUrl).trim().replace(/\/+$/, '');
    acct.origin = new URL(base).origin;
    const violations = [];
    const onViolation = (e) => violations.push(`${e.violatedDirective} ${e.blockedURI}`);
    document.addEventListener('securitypolicyviolation', onViolation);
    try {
      const res = await fetch(`${base}/auth/v1/health`, { headers: { apikey: String(cfg.supabaseKey).trim() }, cache: 'no-store' });
      acct.health = { status: res.status, body: (await res.text()).slice(0, 200) };
    } catch (e) { acct.health = { error: String(e) }; }
    const session = () => { try { return JSON.parse(localStorage.getItem('deadline.session') || 'null'); } catch (e) { return null; } };
    const record = () => { const s = session(); try { return s ? JSON.parse(localStorage.getItem(`deadline.acct.${s.user.id}`) || 'null') : null; } catch (e) { return null; } };
    const synced = () => { const rec = record(); return !!(rec && rec.rev > 0 && !rec.dirty); };
    const titles = () => [...document.querySelectorAll('#panel .row-title')].map((e) => e.textContent.trim());
    if (opts.account && acct.screen === 'sign-in') {
      const $ = (sel) => document.querySelector(sel);
      const signIn = $('[data-auth="in"]');
      if (signIn && signIn.getAttribute('aria-selected') !== 'true') signIn.click();
      $('#auUser').value = opts.account.user;
      $('#auPass').value = opts.account.pass;
      $('#auGo').click();
      acct.signIn = { shown: await wait(() => !!$('#tabbar'), 20000), error: ($('#auErr') && $('#auErr').textContent.trim()) || '' };
      if (acct.signIn.shown && opts.account.addTitle) {
        await new Promise((d) => setTimeout(d, 800));
        document.querySelectorAll('.toast').forEach((t) => t.remove());
        $('#write').click();
        await wait(() => !!$('#dlForm'), 5000);
        $('#dlTitle').value = opts.account.addTitle;
        $('#dlDate').value = opts.account.addDue;
        $('#dlForm [type="submit"]').click();
        acct.added = await wait(() => titles().includes(opts.account.addTitle), 5000);
      }
    }
    const s = session();
    acct.signedIn = !!(s && s.access_token);
    if (acct.signedIn) {
      acct.user = { username: s.user.username, displayName: s.user.display_name };
      acct.synced = await wait(synced, 20000);
      acct.name = (document.querySelector('.hello h1 .name') || {}).textContent || '';
      acct.titles = titles();
      acct.rev = (record() || {}).rev || 0;
    }
    await new Promise((d) => setTimeout(d, 200));
    document.removeEventListener('securitypolicyviolation', onViolation);
    acct.cspBlocked = violations.filter((v) => v.includes(acct.origin));   // (the checks above block example.com on purpose)
  }

  window.open('https://example.com/from-window-open', '_blank');
  const a = document.createElement('a');
  a.href = 'https://example.com/from-target-blank';
  a.target = '_blank';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // The painting the WebGL scene draws (assets/*) must be readable by canvas/WebGL without tainting.
  // The page has no <img>: the scene loads it with new Image(), so the check does the same.
  const painting = await new Promise((done) => {
    const im = new Image();
    im.onload = () => done(im); im.onerror = () => done(null);
    im.src = 'assets/bg-wide.jpg';
  });
  if (!painting) r.imageUntainted = { ok: false, src: 'assets/bg-wide.jpg', error: 'did not load' };
  else {
    try {
      const c = document.createElement('canvas');
      c.width = 4; c.height = 4;
      const cx = c.getContext('2d');
      cx.drawImage(painting, 0, 0, 4, 4);
      cx.getImageData(0, 0, 1, 1);
      r.imageUntainted = { ok: true, src: painting.src };
    } catch (e) { r.imageUntainted = { ok: false, src: painting.src, error: String(e) }; }
  }
  r.images = [...document.images].map((im) => ({ src: im.src, loaded: im.complete && im.naturalWidth > 0 }));
  r.glassEngine = typeof window.GlassEngine;
  // which look the page chose (scene-live glass-live = WebGL, glass-fallback = CSS), and whether the engine
  // could run here at all: CI has no GPU, so hardware is false and the page falls back; software must be true
  r.htmlClass = document.documentElement.className;
  r.glassSupported = window.GlassEngine ? { hardware: window.GlassEngine.supported(), software: window.GlassEngine.supported({ allowSoftware: true }) } : null;
  r.bodyTextStart = (document.body.innerText || '').trim().slice(0, 160);
  return r;
}

function run(win, { externalOpens, START_URL }) {
  const t0 = Date.now();
  const result = { ok: false, startUrl: START_URL, console: [], loadErrors: [] };
  const wc = win.webContents;
  result.timings = {};
  const mark = (k) => { if (result.timings[k] == null) result.timings[k] = Date.now() - t0; };
  win.once('show', () => mark('shown'));
  win.once('ready-to-show', () => mark('readyToShow'));
  wc.once('dom-ready', () => mark('domReady'));
  wc.once('did-finish-load', () => mark('finishLoad'));
  wc.on('console-message', (e, level, message, line, sourceId) => {
    const msg = e && e.message !== undefined ? e.message : message;
    const lvl = e && e.level !== undefined ? e.level : level;
    const src = e && e.sourceId !== undefined ? e.sourceId : sourceId;
    const ln = e && e.lineNumber !== undefined ? e.lineNumber : line;
    if (result.console.length < 60) result.console.push({ level: lvl, message: String(msg).slice(0, 400), source: `${src || ''}:${ln || ''}` });
  });
  wc.on('did-fail-load', (_e, code, desc, url) => result.loadErrors.push({ code, desc, url }));
  wc.on('render-process-gone', (_e, d) => result.loadErrors.push({ renderProcessGone: d.reason }));

  wc.once('did-finish-load', async () => {
    try {
      await delay(Number(process.env.DEADLINE_SELF_TEST_WAIT_MS || 2500));
      const cspRe = /Content.Security.Policy|Refused to/i;
      result.pageCspViolations = result.console.filter((m) => cspRe.test(m.message)).map((m) => m.message);
      result.pageErrors = result.console.filter((m) => m.level === 'error' || m.level === 3).map((m) => m.message);
      const opts = { canvasUrl: process.env.DEADLINE_SELF_TEST_CANVAS_URL || '', canvasToken: process.env.DEADLINE_SELF_TEST_CANVAS_TOKEN || '' };
      if (process.env.DEADLINE_SELF_TEST_SIGNIN_USER) {
        opts.account = { user: process.env.DEADLINE_SELF_TEST_SIGNIN_USER, pass: process.env.DEADLINE_SELF_TEST_SIGNIN_PASS || '',
          addTitle: process.env.DEADLINE_SELF_TEST_ADD_TITLE || '', addDue: process.env.DEADLINE_SELF_TEST_ADD_DUE || '' };
      }
      result.page = await wc.executeJavaScript(`(${pageChecks.toString()})(${JSON.stringify(opts)})`, true);
      await delay(500);
      await wc.executeJavaScript("location.href = 'https://example.com/navigate-away'; true", true);
      await delay(1000);
      result.urlAfterNavigateAway = wc.getURL();
      result.externalOpens = externalOpens.slice();
      const bounds = win.getBounds();
      result.window = { title: win.getTitle(), width: bounds.width, height: bounds.height, visible: win.isVisible(), background: win.getBackgroundColor(), minimumSize: win.getMinimumSize() };
      if (process.env.DEADLINE_SELF_TEST_SHOT) {
        const img = await wc.capturePage();
        fs.writeFileSync(process.env.DEADLINE_SELF_TEST_SHOT, img.toPNG());
      }
      const p = result.page;
      result.ok = !!(p && p.programsFetch && p.programsFetch.ok && p.bridge && p.bridge.isDesktop && p.nodeHidden
        && (p.webgl || p.webgl2) && result.urlAfterNavigateAway === START_URL && result.loadErrors.length === 0
        && /script-src/.test(p.csp.header) && p.csp.injectedInlineBlocked === true && p.csp.remoteScriptBlocked === true
        && result.pageCspViolations.length === 0);
    } catch (err) {
      result.error = String(err && err.stack || err);
    }
    try { session.defaultSession.flushStorageData(); } catch { /* ignore */ }
    process.stdout.write(`DEADLINE_SELF_TEST_RESULT ${JSON.stringify(result)}\n`);
    await delay(800);
    app.quit();
  });
  setTimeout(() => {
    process.stdout.write(`DEADLINE_SELF_TEST_RESULT ${JSON.stringify({ ...result, error: 'timeout waiting for the page' })}\n`);
    app.exit(2);
  }, Number(process.env.DEADLINE_SELF_TEST_TIMEOUT_MS || 60000)).unref();
}

module.exports = { run };
