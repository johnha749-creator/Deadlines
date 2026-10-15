'use strict';
// node --test desktop/test/  — Canvas bridge tests against a local mock Canvas server.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const api = require('../canvas-api');
const { startMockCanvas, SAMPLE_ITEMS } = require('./mock-canvas');

const NOW = Date.parse('2026-10-13T12:00:00Z');

function memoryStore() {
  return {
    data: null, saves: 0,
    async load() { return this.data; },
    async save(s) { this.saves++; this.data = { ...s }; return { persisted: true }; },
    async clear() { this.data = null; },
  };
}

function service(extra = {}) {
  return api.createCanvasService({ fetch: globalThis.fetch, store: memoryStore(), now: () => NOW, timeZone: 'America/Los_Angeles', timeoutMs: 3000, ...extra });
}

test('normalizeBaseUrl accepts bare hosts and strips paths', () => {
  assert.equal(api.normalizeBaseUrl('school.instructure.com'), 'https://school.instructure.com');
  assert.equal(api.normalizeBaseUrl('  https://School.Instructure.com/courses/12/assignments?x=1#y '), 'https://school.instructure.com');
  assert.equal(api.normalizeBaseUrl('https://canvas.district.k12.ca.us/'), 'https://canvas.district.k12.ca.us');
  assert.equal(api.normalizeBaseUrl('canvas.school.edu:8443/login'), 'https://canvas.school.edu:8443');
  assert.equal(api.normalizeBaseUrl('http://localhost:3000/x'), 'http://localhost:3000');
  assert.equal(api.normalizeBaseUrl('http://127.0.0.1:9/'), 'http://127.0.0.1:9');
});

test('normalizeBaseUrl refuses http (non-local), junk and credentials', () => {
  for (const bad of ['http://school.instructure.com', 'ftp://school.edu', '', '   ', 'not a url', 'https://user:pw@school.instructure.com', 'https://intranet', 'javascript:alert(1)', null, 42]) {
    assert.throws(() => api.normalizeBaseUrl(bad), (e) => e instanceof api.CanvasError && /insecure_url|bad_url/.test(e.code), String(bad));
  }
  assert.throws(() => api.normalizeBaseUrl('http://school.instructure.com'), { code: 'insecure_url' });
});

test('normalizeToken trims, strips "Bearer", rejects junk', () => {
  assert.equal(api.normalizeToken('  Bearer 1234~abcdefghijkl  '), '1234~abcdefghijkl');
  for (const bad of ['', 'short', 'has space inside token', 'x'.repeat(2000), 'tab\tinside12345', undefined]) {
    assert.throws(() => api.normalizeToken(bad), { code: 'bad_token' });
  }
});

test('parseLinkHeader handles Canvas-style links', () => {
  const h = '<https://s.instructure.com/api/v1/planner/items?page=2&per_page=100>; rel="next",<https://s.instructure.com/api/v1/planner/items?page=1&per_page=100>; rel="first", <https://s.instructure.com/api/v1/planner/items?page=5>; rel=last';
  const l = api.parseLinkHeader(h);
  assert.equal(l.next, 'https://s.instructure.com/api/v1/planner/items?page=2&per_page=100');
  assert.equal(l.first, 'https://s.instructure.com/api/v1/planner/items?page=1&per_page=100');
  assert.equal(l.last, 'https://s.instructure.com/api/v1/planner/items?page=5');
  assert.deepEqual(api.parseLinkHeader(''), {});
  assert.deepEqual(api.parseLinkHeader(null), {});
});

test('mapPlannerItem maps fields and converts to local time', () => {
  const base = 'https://school.instructure.com';
  const a = api.mapPlannerItem(SAMPLE_ITEMS[0], base, 'America/Los_Angeles');
  assert.deepEqual(a, {
    uid: 'canvas-api-assignment-101', title: 'Lab report: enzymes', due: '2026-10-14', time: '23:59',
    course: 'AP Biology', link: 'https://school.instructure.com/courses/7/assignments/101', type: 'assignment', submitted: true,
  });
  assert.deepEqual([api.mapPlannerItem(SAMPLE_ITEMS[0], base, 'Asia/Tokyo').due, api.mapPlannerItem(SAMPLE_ITEMS[0], base, 'Asia/Tokyo').time], ['2026-10-15', '15:59']);
  assert.deepEqual([api.mapPlannerItem(SAMPLE_ITEMS[0], base, 'UTC').due, api.mapPlannerItem(SAMPLE_ITEMS[0], base, 'UTC').time], ['2026-10-15', '06:59']);
  assert.equal(api.mapPlannerItem(SAMPLE_ITEMS[0], base, 'Asia/Kolkata').time, '12:29');
  // quiz: submissions === false
  assert.equal(api.mapPlannerItem(SAMPLE_ITEMS[1], base, 'UTC').submitted, false);
  // discussion: no submissions key, and the US DST change night (Nov 1 2026, 08:30Z = 01:30 PDT)
  const d = api.mapPlannerItem(SAMPLE_ITEMS[2], base, 'America/New_York');
  assert.equal(d.submitted, false);
  assert.deepEqual([d.due, d.time], ['2026-11-01', '03:30']);
  assert.deepEqual([api.mapPlannerItem(SAMPLE_ITEMS[2], base, 'America/Los_Angeles').due, api.mapPlannerItem(SAMPLE_ITEMS[2], base, 'America/Los_Angeles').time], ['2026-11-01', '01:30']);
  // planner note: no html_url, no course
  const n = api.mapPlannerItem(SAMPLE_ITEMS[3], base, 'UTC');
  assert.equal(n.link, '');
  assert.equal(n.course, '');
  assert.equal(n.uid, 'canvas-api-planner_note-404');
  // all-day event has no time; absolute html_url is kept
  const e = api.mapPlannerItem(SAMPLE_ITEMS[4], base, 'America/Los_Angeles');
  assert.equal(e.time, '');
  assert.equal(e.due, '2026-10-30');
  assert.equal(e.link, 'https://elsewhere.example.edu/calendar?event_id=505');
  // no date -> skipped
  assert.equal(api.mapPlannerItem(SAMPLE_ITEMS[5], base, 'UTC'), null);
  // date-only strings are taken as-is (no UTC shift)
  assert.deepEqual(api.mapPlannerItem({ plannable_type: 'x', plannable_id: 1, plannable_date: '2026-10-20', plannable: { title: 't' } }, base, 'America/Los_Angeles').due, '2026-10-20');
  // junk
  assert.equal(api.mapPlannerItem(null, base), null);
  assert.equal(api.mapPlannerItem({ plannable_date: '2026-10-20T00:00:00Z' }, base), null);
  assert.equal(api.mapPlannerItem({ plannable_type: 'x', plannable_id: 1, plannable_date: 'not a date' }, base), null);
  assert.equal(api.mapPlannerItem({ plannable_type: 'x', plannable_id: 1, plannable_date: '2026-10-20T00:00:00Z', html_url: 'javascript:alert(1)' }, base).link, '');
});

test('mapPlannerItem uses the system time zone when none is given', () => {
  const script = `const api = require(${JSON.stringify(path.join(__dirname, '..', 'canvas-api.js'))});
    const it = api.mapPlannerItem({ plannable_type: 'assignment', plannable_id: 1, plannable_date: '2026-10-15T06:59:59Z', plannable: { title: 't' } }, 'https://s.instructure.com');
    process.stdout.write(it.due + ' ' + it.time);`;
  const run = (tz) => execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: tz } }).toString();
  assert.equal(run('America/Los_Angeles'), '2026-10-14 23:59');
  assert.equal(run('Asia/Tokyo'), '2026-10-15 15:59');
  assert.equal(run('Europe/London'), '2026-10-15 07:59');
});

test('connect validates the token with /users/self', async (t) => {
  const mock = await startMockCanvas();
  t.after(() => mock.close());
  const store = memoryStore();
  const svc = api.createCanvasService({ fetch: globalThis.fetch, store, now: () => NOW, timeoutMs: 3000 });
  assert.deepEqual(await svc.status(), { connected: false });

  const bad = await svc.connect({ baseUrl: mock.url, token: 'wrong-token-123456' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'unauthorized');
  assert.match(bad.error, /did not accept that access token/);
  assert.equal(store.data, null);

  const ok = await svc.connect({ baseUrl: `${mock.url}/courses/1`, token: ` ${mock.token} ` });
  assert.equal(ok.ok, true);
  assert.equal(ok.userName, 'Alex');
  const req = mock.requests.at(-1);
  assert.equal(req.path, '/api/v1/users/self');
  assert.equal(req.auth, `Bearer ${mock.token}`);
  assert.match(req.accept, /application\/json/);

  const st = await svc.status();
  assert.deepEqual(st, { connected: true, baseUrl: mock.url, userName: 'Alex', lastSync: null, remembered: true });
  assert.ok(!JSON.stringify(st).includes(mock.token), 'status never includes the token');
  assert.ok(!JSON.stringify(ok).includes(mock.token), 'connect result never includes the token');
  assert.equal(store.data.token, mock.token, 'token is handed to the store (main.js encrypts it)');
});

test('sync follows Link rel="next" pagination and maps items', async (t) => {
  const mock = await startMockCanvas({ pageSize: 3 });
  t.after(() => mock.close());
  const svc = service();
  assert.equal((await svc.connect({ baseUrl: mock.url, token: mock.token })).ok, true);
  const r = await svc.sync();
  assert.equal(r.ok, true, r.error);
  assert.equal(r.pages, 3);
  assert.equal(r.items.length, 6, 'the dateless item is skipped');
  assert.deepEqual(r.items.map((i) => i.uid), [
    'canvas-api-assignment-101', 'canvas-api-quiz-202', 'canvas-api-planner_note-404',
    'canvas-api-calendar_event-505', 'canvas-api-discussion_topic-303', 'canvas-api-wiki_page-707',
  ]);
  const planner = mock.requests.filter((q) => q.path === '/api/v1/planner/items');
  assert.equal(planner.length, 3);
  assert.deepEqual(planner.map((q) => q.query.page || '1'), ['1', '2', '3']);
  for (const q of planner) assert.equal(q.auth, `Bearer ${mock.token}`);
  assert.equal(planner[0].query.per_page, '100');
  assert.equal(planner[0].query.start_date, '2026-09-29T12:00:00.000Z');
  assert.equal(planner[0].query.end_date, '2027-04-11T12:00:00.000Z');
  const quiz = r.items.find((i) => i.type === 'quiz');
  assert.deepEqual(quiz, { uid: 'canvas-api-quiz-202', title: 'Quiz 4: logarithms', due: '2026-10-20', time: '08:30', course: 'Algebra II', link: `${mock.url}/courses/8/quizzes/202`, type: 'quiz', submitted: false });
  assert.equal(r.lastSync, '2026-10-13T12:00:00.000Z');
  assert.equal((await svc.status()).lastSync, '2026-10-13T12:00:00.000Z');
});

test('sync caps pagination and never follows a next link to another host', async (t) => {
  const loop = await startMockCanvas({ infiniteNext: true });
  t.after(() => loop.close());
  const svc = service({ maxPages: 4 });
  await svc.connect({ baseUrl: loop.url, token: loop.token });
  const r = await svc.sync();
  assert.equal(r.ok, true);
  assert.equal(r.pages, 4);
  assert.equal(r.truncated, true);

  const evil = await startMockCanvas({ crossOriginNext: true });
  t.after(() => evil.close());
  const svc2 = service();
  await svc2.connect({ baseUrl: evil.url, token: evil.token });
  const r2 = await svc2.sync();
  assert.equal(r2.ok, true);
  assert.equal(r2.pages, 1, 'stopped instead of sending the token to evil.example.com');
});

test('a 401 during sync reports an expired token and disconnects', async (t) => {
  const mock = await startMockCanvas({ revokeAfterSyncCalls: 1 });
  t.after(() => mock.close());
  const store = memoryStore();
  const svc = api.createCanvasService({ fetch: globalThis.fetch, store, now: () => NOW, timeoutMs: 3000 });
  await svc.connect({ baseUrl: mock.url, token: mock.token });
  assert.equal((await svc.sync()).ok, true);
  const r = await svc.sync();
  assert.equal(r.ok, false);
  assert.equal(r.code, 'unauthorized');
  assert.match(r.error, /expired/);
  assert.deepEqual(await svc.status(), { connected: false });
  assert.equal(store.data, null, 'stored token removed');
  const again = await svc.sync();
  assert.equal(again.code, 'not_connected');
});

test('clear errors for non-Canvas sites, redirects, network failures and bad input', async (t) => {
  const html = await startMockCanvas({ htmlEverywhere: true });
  const redir = await startMockCanvas({ redirectTo: 'https://sso.example.edu' });
  t.after(() => Promise.all([html.close(), redir.close()]));
  const svc = service();

  const a = await svc.connect({ baseUrl: html.url, token: html.token });
  assert.equal(a.code, 'not_canvas');
  assert.match(a.error, /does not look like a Canvas site/);

  const b = await svc.connect({ baseUrl: redir.url, token: redir.token });
  assert.equal(b.code, 'redirect');
  assert.match(b.error, /sso\.example\.edu/);

  // A port nothing listens on.
  const closed = await startMockCanvas();
  const deadUrl = closed.url;
  await closed.close();
  const c = await svc.connect({ baseUrl: deadUrl, token: 'good-token-1234567890' });
  assert.equal(c.code, 'network');
  assert.match(c.error, /Could not reach 127\.0\.0\.1/);

  const d = await svc.connect({ baseUrl: 'http://school.instructure.com', token: 'good-token-1234567890' });
  assert.equal(d.code, 'insecure_url');
  const e = await svc.connect({ baseUrl: 'school.instructure.com', token: '' });
  assert.equal(e.code, 'bad_token');
  const f = await svc.connect(undefined);
  assert.equal(f.ok, false);
  assert.deepEqual(await svc.status(), { connected: false });
});

test('timeouts are reported', async () => {
  const hanging = (url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })));
  });
  const svc = api.createCanvasService({ fetch: hanging, now: () => NOW, timeoutMs: 50 });
  const r = await svc.connect({ baseUrl: 'school.instructure.com', token: 'good-token-1234567890' });
  assert.equal(r.code, 'timeout');
});

test('Electron-style network errors (net::ERR_*) map to a network message', async () => {
  const failing = async () => { throw new Error('net::ERR_NAME_NOT_RESOLVED'); };
  const svc = api.createCanvasService({ fetch: failing, now: () => NOW });
  const r = await svc.connect({ baseUrl: 'no-such-school.instructure.com', token: 'good-token-1234567890' });
  assert.equal(r.code, 'network');
  assert.match(r.error, /Could not reach no-such-school\.instructure\.com/);
});

test('a saved connection is restored from the store; disconnect clears it', async (t) => {
  const mock = await startMockCanvas();
  t.after(() => mock.close());
  const store = memoryStore();
  store.data = { baseUrl: mock.url, token: mock.token, userName: 'Alex', lastSync: '2026-10-12T00:00:00.000Z' };
  const svc = api.createCanvasService({ fetch: globalThis.fetch, store, now: () => NOW, timeoutMs: 3000 });
  assert.equal((await svc.status()).connected, true);
  assert.equal((await svc.sync()).ok, true);
  assert.deepEqual(await svc.disconnect(), { ok: true });
  assert.deepEqual(await svc.status(), { connected: false });
  assert.equal(store.data, null);
});

test('concurrent sync calls share one request chain', async (t) => {
  const mock = await startMockCanvas({ pageSize: 10 });
  t.after(() => mock.close());
  const svc = service();
  await svc.connect({ baseUrl: mock.url, token: mock.token });
  const [a, b] = await Promise.all([svc.sync(), svc.sync()]);
  assert.equal(a, b);
  assert.equal(mock.requests.filter((q) => q.path === '/api/v1/planner/items').length, 1);
});
