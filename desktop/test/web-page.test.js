'use strict';
// node --test desktop/test/  — the CSP and config.js helpers in web-page.js (shared with web/build-site.mjs).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildCsp, readConfig, supabaseOrigin, isSecretKey } = require('../web-page');

const PAGE = '<title>Deadline</title>\n<script src="config.js"></script>\n<script>window.x = 1;</script>\n';
const cfg = (url, key) => `window.DEADLINE_CONFIG = { supabaseUrl: ${JSON.stringify(url)}, supabaseKey: ${JSON.stringify(key)}, usernameDomain: "users.deadline.invalid" };\n`;
const connectSrc = (policy) => policy.split(';').map((s) => s.trim()).find((s) => s.startsWith('connect-src '));
const jwt = (payload) => `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.c2ln`;

test('empty or missing config.js adds nothing to connect-src', () => {
  const shipped = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'config.js'), 'utf8');
  for (const config of [undefined, '', shipped, cfg('', ''), cfg('https://abc.supabase.co', ''), cfg('', 'sb_publishable_x')]) {
    const r = buildCsp(PAGE, { config });
    assert.equal(connectSrc(r.policy), "connect-src 'self' app://deadline data: blob:");
    assert.equal(r.supabaseOrigin, '');
    assert.deepEqual(r.warnings, []);
  }
});

test('a Supabase project in config.js is allowed in connect-src (origin only), nothing else changes', () => {
  const off = buildCsp(PAGE).policy;
  const r = buildCsp(PAGE, { config: cfg('https://abcd1234.supabase.co/', 'sb_publishable_abc') });
  assert.equal(connectSrc(r.policy), "connect-src 'self' app://deadline data: blob: https://abcd1234.supabase.co");
  assert.equal(r.supabaseOrigin, 'https://abcd1234.supabase.co');
  assert.equal(r.policy.replace(' https://abcd1234.supabase.co', ''), off);
  const local = buildCsp(PAGE, { config: cfg('http://127.0.0.1:54321', 'sb_publishable_abc') });
  assert.equal(local.supabaseOrigin, 'http://127.0.0.1:54321');
});

test('plain http (not this computer), a bad URL or an unreadable config.js stay out, with a warning', () => {
  for (const [config, re] of [[cfg('http://abc.supabase.co', 'k'), /not https/], [cfg('not a url', 'k'), /not a valid URL/], ['window.DEADLINE_CONFIG = {', /could not be read/]]) {
    const r = buildCsp(PAGE, { config });
    assert.equal(connectSrc(r.policy), "connect-src 'self' app://deadline data: blob:");
    assert.match(r.warnings.join(' '), re);
  }
});

test('readConfig runs config.js without Node and returns plain values', () => {
  assert.deepEqual(readConfig(cfg(' https://a.supabase.co ', 'k')).config, { supabaseUrl: 'https://a.supabase.co', supabaseKey: 'k', usernameDomain: 'users.deadline.invalid' });
  assert.match(readConfig('require("fs"); window.DEADLINE_CONFIG = {}').error, /require is not defined/);
  assert.match(readConfig('while (true) {}').error, /timed out/);
  assert.deepEqual(readConfig('self.DEADLINE_CONFIG = { supabaseUrl: "https://b.supabase.co", supabaseKey: "k" }').config.supabaseUrl, 'https://b.supabase.co');
  assert.equal(supabaseOrigin('').origin, '');
});

test('isSecretKey spots secret and service_role keys, not publishable or anon ones', () => {
  assert.equal(isSecretKey('sb_secret_abcdefghijklmnop'), true);
  assert.equal(isSecretKey(jwt({ role: 'service_role', iss: 'supabase' })), true);
  assert.equal(isSecretKey('sb_publishable_abcdefghijklmnop'), false);
  assert.equal(isSecretKey(jwt({ role: 'anon', iss: 'supabase' })), false);
  assert.equal(isSecretKey(''), false);
});
