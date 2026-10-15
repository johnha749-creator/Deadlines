'use strict';
// A tiny fake Canvas LMS API for tests: /api/v1/users/self and paginated /api/v1/planner/items.
const http = require('node:http');

const SAMPLE_ITEMS = [
  { plannable_type: 'assignment', plannable_id: '101', context_name: 'AP Biology', html_url: '/courses/7/assignments/101',
    plannable_date: '2026-10-15T06:59:59Z', plannable: { id: '101', title: 'Lab report: enzymes', due_at: '2026-10-15T06:59:59Z' },
    submissions: { submitted: true, graded: false } },
  { plannable_type: 'quiz', plannable_id: '202', context_name: 'Algebra II', html_url: '/courses/8/quizzes/202',
    plannable_date: '2026-10-20T15:30:00Z', plannable: { id: '202', title: 'Quiz 4: logarithms' }, submissions: false },
  { plannable_type: 'discussion_topic', plannable_id: '303', context_name: 'English 11', html_url: '/courses/9/discussion_topics/303',
    plannable_date: '2026-11-01T08:30:00Z', plannable: { id: '303', title: 'Gatsby reading response' } },
  { plannable_type: 'planner_note', plannable_id: '404', context_name: null,
    plannable_date: '2026-10-22T18:00:00Z', plannable: { id: '404', title: 'Ask about the field trip form', todo_date: '2026-10-22T18:00:00Z' } },
  { plannable_type: 'calendar_event', plannable_id: '505', context_name: 'AP Biology', html_url: 'https://elsewhere.example.edu/calendar?event_id=505',
    plannable_date: '2026-10-30T07:00:00Z', plannable: { id: '505', title: 'Unit test', all_day: true } },
  { plannable_type: 'assignment', plannable_id: '606', context_name: 'Art', html_url: '/courses/10/assignments/606',
    plannable_date: null, plannable: { id: '606', title: 'No due date sketchbook' } },
  { plannable_type: 'wiki_page', plannable_id: '707', context_name: 'Chemistry', html_url: '/courses/11/pages/safety',
    plannable_date: '2026-12-01T16:00:00Z', plannable: { id: '707', title: 'Read: lab safety' }, submissions: { submitted: false } },
];

function startMockCanvas(opts = {}) {
  const token = opts.token || 'good-token-1234567890';
  const items = opts.items || SAMPLE_ITEMS;
  const pageSize = opts.pageSize || 3;
  const requests = [];
  let syncCalls = 0;
  let revoked = false;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://placeholder');
    const auth = req.headers.authorization || '';
    requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), auth, accept: req.headers.accept || '' });
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    if (opts.htmlEverywhere) {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<!doctype html><title>Welcome</title><p>Just a website</p>');
    }
    if (opts.redirectTo) {
      res.writeHead(302, { location: `${opts.redirectTo}${url.pathname}` });
      return res.end();
    }
    // revokeAfterSyncCalls: N complete syncs succeed, then the token stops working.
    if (opts.revokeAfterSyncCalls != null && url.pathname === '/api/v1/planner/items' && !url.searchParams.get('page') && syncCalls >= opts.revokeAfterSyncCalls) revoked = true;
    const authorized = auth === `Bearer ${token}` && !revoked;
    if (url.pathname === '/api/v1/users/self') {
      if (!authorized) return send(401, { errors: [{ message: 'Invalid access token.' }] }, { 'www-authenticate': 'Bearer realm="canvas-lms"' });
      return send(200, { id: '42', name: 'Alex Rivera', short_name: 'Alex', sortable_name: 'Rivera, Alex' });
    }
    if (url.pathname === '/api/v1/planner/items') {
      if (!authorized) return send(401, { errors: [{ message: 'Invalid access token.' }] });
      const page = Number(url.searchParams.get('page') || '1');
      if (page === 1) syncCalls++;
      const host = `http://${req.headers.host}`;
      const start = (page - 1) * pageSize;
      const slice = items.slice(start, start + pageSize);
      const links = [];
      const keep = new URLSearchParams(url.searchParams);
      const linkFor = (p, base = host) => { keep.set('page', String(p)); return `${base}/api/v1/planner/items?${keep.toString()}`; };
      if (opts.infiniteNext) links.push(`<${linkFor(page + 1)}>; rel="next"`);
      else if (opts.crossOriginNext && page === 1) links.push(`<${linkFor(2, 'http://evil.example.com')}>; rel="next"`);
      else if (start + pageSize < items.length) links.push(`<${linkFor(page + 1)}>; rel="next"`);
      links.push(`<${linkFor(1)}>; rel="first"`);
      links.push(`<${linkFor(Math.max(1, Math.ceil(items.length / pageSize)))}>; rel="last"`);
      return send(200, opts.infiniteNext ? items.slice(0, 1) : slice, { link: links.join(',') });
    }
    return send(404, { errors: [{ message: 'The specified resource does not exist.' }] });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        token,
        requests,
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
      });
    });
  });
}

module.exports = { startMockCanvas, SAMPLE_ITEMS };

// `node mock-canvas.js` runs a server until killed (used by the packaged-app smoke test).
if (require.main === module) {
  startMockCanvas({ token: process.env.MOCK_CANVAS_TOKEN || undefined }).then((s) => {
    process.stdout.write(`${JSON.stringify({ url: s.url, token: s.token })}\n`);
  });
}
