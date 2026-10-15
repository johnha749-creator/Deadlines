'use strict';
// Canvas LMS client for the Electron main process.
// Plain Node (no Electron imports) so it can be tested against a mock server:
// the caller injects `fetch` (Electron's net.fetch in the app, Node's fetch in tests)
// and a `store` that persists the connection (main.js encrypts the token there).

const PAST_DAYS = 14;
const FUTURE_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_MAX_PAGES = 20;
const MAX_BODY_BYTES = 10 * 1024 * 1024;

class CanvasError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = 'CanvasError';
    this.code = code;
    if (status) this.status = status;
  }
}

const MSG = {
  badUrl: 'Enter your Canvas address, like school.instructure.com.',
  insecure: 'Use the https:// address of your Canvas site. Plain http:// is not allowed because it would expose your token.',
  badToken: 'Paste the access token you made in Canvas (Account, then Settings, then New Access Token).',
  unauthorized: 'Canvas did not accept that access token. It may be mistyped, expired or deleted. Make a new one in Canvas (Account, then Settings, then New Access Token) and connect again.',
  forbidden: 'Canvas refused the request (403). If you synced a moment ago, wait a minute and try again. Otherwise your school may not allow access tokens.',
  notCanvas: 'That address does not look like a Canvas site. Use the address you see in your browser when Canvas is open, like school.instructure.com.',
  redirect: (where) => `Canvas sent the request to a different address${where ? ` (${where})` : ''}. Open Canvas in your browser and use the address you end up on.`,
  server: (status) => `Canvas had a problem on its side (HTTP ${status}). Try again in a few minutes.`,
  http: (status) => `Canvas answered with an unexpected error (HTTP ${status}).`,
  timeout: 'Canvas did not answer in time. Check your internet connection and try again.',
  network: (host) => `Could not reach ${host}. Check the address and your internet connection.`,
  notConnected: 'Not connected to Canvas yet.',
};

// ---------- input normalization ----------

function isLocalHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return h === 'localhost' || h === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

// "school.instructure.com", "https://school.instructure.com/courses/12/" -> "https://school.instructure.com"
function normalizeBaseUrl(input) {
  let s = typeof input === 'string' ? input.trim() : '';
  if (!s || s.length > 400 || /\s/.test(s)) throw new CanvasError(MSG.badUrl, 'bad_url');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s.replace(/^\/+/, '')}`;
  let u;
  try { u = new URL(s); } catch { throw new CanvasError(MSG.badUrl, 'bad_url'); }
  if (u.username || u.password) throw new CanvasError(MSG.badUrl, 'bad_url');
  const local = isLocalHost(u.hostname);
  if (u.protocol === 'http:' && !local) throw new CanvasError(MSG.insecure, 'insecure_url');
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new CanvasError(MSG.badUrl, 'bad_url');
  if (!local && !/^[a-z0-9.-]+\.[a-z0-9-]{2,}$/i.test(u.hostname)) throw new CanvasError(MSG.badUrl, 'bad_url');
  return u.origin;
}

function normalizeToken(input) {
  let t = typeof input === 'string' ? input.trim() : '';
  t = t.replace(/^bearer\s+/i, '');
  if (t.length < 8 || t.length > 1024 || !/^[\x21-\x7e]+$/.test(t)) throw new CanvasError(MSG.badToken, 'bad_token');
  return t;
}

// ---------- HTTP ----------

// RFC 5988 / 8288 Link header -> { next: url, last: url, ... }
function parseLinkHeader(header) {
  const out = {};
  if (!header || typeof header !== 'string') return out;
  const re = /<([^>]*)>((?:\s*;\s*[^;,]+(?:=\s*(?:"[^"]*"|[^;,]*))?)*)/g;
  let m;
  while ((m = re.exec(header))) {
    const relM = /;\s*rel\s*=\s*(?:"([^"]*)"|([^;,\s]+))/i.exec(m[2]);
    if (!relM) continue;
    for (const rel of (relM[1] || relM[2] || '').toLowerCase().split(/\s+/)) {
      if (rel && !(rel in out)) out[rel] = m[1];
    }
  }
  return out;
}

function describeNetworkError(err) {
  const parts = [];
  for (let e = err, i = 0; e && i < 4; e = e.cause, i++) parts.push(String(e.code || ''), String(e.message || ''));
  return parts.join(' ');
}

async function canvasGet(fetchImpl, url, token, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const host = new URL(url).host;
  try {
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json+canvas-string-ids, application/json;q=0.9',
        },
        redirect: 'manual',
        signal: ctrl.signal,
      });
    } catch (err) {
      const detail = describeNetworkError(err);
      if (ctrl.signal.aborted || /abort|timed? ?out/i.test(detail)) throw new CanvasError(MSG.timeout, 'timeout');
      throw new CanvasError(MSG.network(host), 'network');
    }
    const status = res.status;
    if (res.type === 'opaqueredirect' || status === 0 || (status >= 300 && status < 400)) {
      let where = '';
      try { where = new URL(res.headers.get('location'), url).host; } catch { /* no usable location */ }
      throw new CanvasError(MSG.redirect(where), 'redirect', status || undefined);
    }
    if (status === 401) throw new CanvasError(MSG.unauthorized, 'unauthorized', 401);
    if (status === 403) throw new CanvasError(MSG.forbidden, 'forbidden', 403);
    if (status === 404) throw new CanvasError(MSG.notCanvas, 'not_canvas', 404);
    if (status >= 500) throw new CanvasError(MSG.server(status), 'server', status);
    if (status < 200 || status >= 300) throw new CanvasError(MSG.http(status), 'http', status);
    const type = res.headers.get('content-type') || '';
    if (!/json/i.test(type)) throw new CanvasError(MSG.notCanvas, 'not_canvas', status);
    let text;
    try { text = await res.text(); } catch (err) {
      if (ctrl.signal.aborted) throw new CanvasError(MSG.timeout, 'timeout');
      throw new CanvasError(MSG.network(host), 'network');
    }
    if (text.length > MAX_BODY_BYTES) throw new CanvasError(MSG.notCanvas, 'not_canvas', status);
    let data;
    try { data = JSON.parse(text.replace(/^\s*while\(1\);/, '')); } catch { throw new CanvasError(MSG.notCanvas, 'not_canvas', status); }
    return { data, link: res.headers.get('link') };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- mapping ----------

const fmtCache = new Map();
function localParts(date, timeZone) {
  const key = timeZone || '';
  let fmt = fmtCache.get(key);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || undefined,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    fmtCache.set(key, fmt);
  }
  const p = {};
  for (const { type, value } of fmt.formatToParts(date)) p[type] = value;
  const hour = p.hour === '24' ? '00' : p.hour;
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${hour}:${p.minute}` };
}

function absoluteLink(htmlUrl, baseUrl) {
  if (typeof htmlUrl !== 'string' || !htmlUrl.trim()) return '';
  try {
    const u = new URL(htmlUrl.trim(), `${baseUrl}/`);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : '';
  } catch { return ''; }
}

function mapPlannerItem(item, baseUrl, timeZone) {
  if (!item || typeof item !== 'object') return null;
  const p = item.plannable && typeof item.plannable === 'object' ? item.plannable : {};
  const type = String(item.plannable_type || '').trim() || 'item';
  const id = item.plannable_id != null && item.plannable_id !== '' ? item.plannable_id : p.id;
  if (id == null || id === '') return null;
  const when = item.plannable_date || p.due_at || p.todo_date || p.start_at;
  if (!when || typeof when !== 'string') return null;
  let due, time;
  if (/^\d{4}-\d{2}-\d{2}$/.test(when)) {
    due = when; time = '';
  } else {
    const d = new Date(when);
    if (Number.isNaN(d.getTime())) return null;
    const lp = localParts(d, timeZone);
    due = lp.date;
    time = p.all_day === true ? '' : lp.time;
  }
  const title = String(p.title || p.name || item.title || 'Untitled').replace(/\s+/g, ' ').trim().slice(0, 300) || 'Untitled';
  const subs = item.submissions;
  return {
    uid: `canvas-api-${type}-${id}`,
    title,
    due,
    time,
    course: typeof item.context_name === 'string' ? item.context_name.trim() : '',
    link: absoluteLink(item.html_url, baseUrl),
    type,
    submitted: !!(subs && typeof subs === 'object' && subs.submitted === true),
  };
}

// ---------- API calls ----------

async function fetchSelf(fetchImpl, baseUrl, token, timeoutMs) {
  const { data } = await canvasGet(fetchImpl, `${baseUrl}/api/v1/users/self`, token, timeoutMs);
  const name = data && typeof data === 'object' && !Array.isArray(data) ? (data.short_name || data.name) : null;
  if (data == null || data.id == null || typeof name !== 'string') throw new CanvasError(MSG.notCanvas, 'not_canvas');
  return { id: String(data.id), name: name.trim() };
}

async function fetchPlannerItems(fetchImpl, baseUrl, token, opts = {}) {
  const now = opts.now != null ? opts.now : Date.now();
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const maxPages = opts.maxPages || DEFAULT_MAX_PAGES;
  const start = new Date(now - PAST_DAYS * DAY_MS).toISOString();
  const end = new Date(now + FUTURE_DAYS * DAY_MS).toISOString();
  const origin = new URL(baseUrl).origin;
  let url = `${baseUrl}/api/v1/planner/items?start_date=${encodeURIComponent(start)}&end_date=${encodeURIComponent(end)}&per_page=100`;
  const byUid = new Map();
  let pages = 0;
  let truncated = false;
  let skipped = 0;
  const seen = new Set();
  while (url) {
    if (seen.has(url)) break;
    seen.add(url);
    if (pages >= maxPages) { truncated = true; break; }
    const { data, link } = await canvasGet(fetchImpl, url, token, timeoutMs);
    pages++;
    if (!Array.isArray(data)) throw new CanvasError(MSG.notCanvas, 'not_canvas');
    for (const raw of data) {
      const it = mapPlannerItem(raw, baseUrl, opts.timeZone);
      if (it) byUid.set(it.uid, it); else skipped++;
    }
    const next = parseLinkHeader(link).next;
    const current = url;
    url = null;
    if (next) {
      try {
        const n = new URL(next, current);
        // Never send the token to another host, even if a Link header says so.
        if (n.origin === origin) url = n.href;
      } catch { /* malformed next link: stop paging */ }
    }
  }
  const items = [...byUid.values()].sort((a, b) => (a.due + a.time).localeCompare(b.due + b.time));
  return { items, pages, truncated, skipped };
}

// ---------- service (state + persistence) ----------

function createCanvasService({ fetch: fetchImpl, store, now = () => Date.now(), timeZone, timeoutMs = DEFAULT_TIMEOUT_MS, maxPages = DEFAULT_MAX_PAGES } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('createCanvasService needs a fetch function');
  const memStore = { data: null, async load() { return this.data; }, async save(s) { this.data = { ...s }; return { persisted: false }; }, async clear() { this.data = null; } };
  const st = store || memStore;
  let state = null;          // { baseUrl, token, userName, lastSync }
  let persisted = false;
  let loaded = null;
  let inflightSync = null;

  function ensureLoaded() {
    if (!loaded) {
      loaded = Promise.resolve()
        .then(() => st.load())
        .then((s) => {
          if (s && typeof s.baseUrl === 'string' && typeof s.token === 'string' && s.token) {
            state = { baseUrl: s.baseUrl, token: s.token, userName: s.userName || '', lastSync: s.lastSync || null };
            persisted = true;
          }
        })
        .catch(() => { state = null; });
    }
    return loaded;
  }

  async function save() {
    try { const r = await st.save({ ...state }); persisted = !!(r && r.persisted); } catch { persisted = false; }
  }

  async function forget() {
    state = null;
    persisted = false;
    try { await st.clear(); } catch { /* nothing stored */ }
  }

  function fail(err) {
    if (err instanceof CanvasError) return { ok: false, error: err.message, code: err.code };
    return { ok: false, error: 'Something went wrong talking to Canvas.', code: 'unknown' };
  }

  async function connect(input) {
    await ensureLoaded();
    try {
      const baseUrl = normalizeBaseUrl(input && input.baseUrl);
      const token = normalizeToken(input && input.token);
      const me = await fetchSelf(fetchImpl, baseUrl, token, timeoutMs);
      state = { baseUrl, token, userName: me.name, lastSync: null };
      await save();
      return { ok: true, userName: me.name, baseUrl, remembered: persisted };
    } catch (err) {
      return fail(err);
    }
  }

  async function status() {
    await ensureLoaded();
    if (!state) return { connected: false };
    return { connected: true, baseUrl: state.baseUrl, userName: state.userName, lastSync: state.lastSync, remembered: persisted };
  }

  async function runSync() {
    await ensureLoaded();
    if (!state) return { ok: false, error: MSG.notConnected, code: 'not_connected' };
    const conn = state;
    try {
      const r = await fetchPlannerItems(fetchImpl, conn.baseUrl, conn.token, { now: now(), timeZone, timeoutMs, maxPages });
      if (state !== conn) return { ok: false, error: MSG.notConnected, code: 'not_connected' };
      state.lastSync = new Date(now()).toISOString();
      await save();
      return { ok: true, items: r.items, lastSync: state.lastSync, pages: r.pages, truncated: r.truncated };
    } catch (err) {
      if (err instanceof CanvasError && err.code === 'unauthorized' && state === conn) await forget();
      return fail(err);
    }
  }

  function sync() {
    if (!inflightSync) inflightSync = runSync().finally(() => { inflightSync = null; });
    return inflightSync;
  }

  async function disconnect() {
    await ensureLoaded();
    await forget();
    return { ok: true };
  }

  return { connect, status, sync, disconnect };
}

module.exports = {
  CanvasError,
  createCanvasService,
  normalizeBaseUrl,
  normalizeToken,
  parseLinkHeader,
  mapPlannerItem,
  fetchPlannerItems,
  fetchSelf,
  localParts,
  PAST_DAYS,
  FUTURE_DAYS,
  DEFAULT_MAX_PAGES,
};
