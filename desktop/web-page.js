'use strict';
// Helpers shared by the build and the main process (and by web/build-site.mjs):
//  - wrapHtml: turns the artifact-form index.html (starts with <title>/<link>/<style>, no
//    <html>/<head>/<body>) into a full document with charset + viewport metas.
//  - buildCsp: Content-Security-Policy for the app, with sha256 hashes of the inline scripts, and
//    the Supabase origin from config.js in connect-src (accounts), when it names one.
//  - readConfig / supabaseOrigin / isSecretKey: what config.js says, and whether it is safe to ship.
const crypto = require('node:crypto');
const vm = require('node:vm');

const ORIGIN = 'app://deadline';
const HEAD_METAS = '<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n';

// The HTML parser turns CRLF / CR into LF before scripts are hashed, so do the same.
function normalizeNewlines(s) {
  return String(s).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

function wrapHtml(source) {
  const html = normalizeNewlines(source);
  const isFullDoc = /^\s*(<!--[\s\S]*?-->\s*)*<!doctype\s/i.test(html) || /^\s*<html[\s>]/i.test(html);
  if (!isFullDoc) {
    // The parser keeps <title>/<link>/<style>/<script> in <head> and opens <body> at the first
    // body element, which is exactly how the artifact host treats this file.
    return `<!doctype html>\n<html lang="en">\n<head>\n${HEAD_METAS}${html.replace(/^\s+/, '')}\n</html>\n`;
  }
  let out = html;
  const missing = [];
  if (!/<meta[^>]+charset\s*=/i.test(out)) missing.push('<meta charset="utf-8">');
  if (!/<meta[^>]+name\s*=\s*["']?viewport/i.test(out)) missing.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
  if (missing.length) {
    const inject = `\n${missing.join('\n')}\n`;
    if (/<head[^>]*>/i.test(out)) out = out.replace(/<head[^>]*>/i, (m) => m + inject);
    else if (/<html[^>]*>/i.test(out)) out = out.replace(/<html[^>]*>/i, (m) => `${m}\n<head>${inject}</head>`);
  }
  return out;
}

function inlineScripts(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (/\bsrc\s*=/i.test(m[1])) continue;
    out.push(m[2]);
  }
  return out;
}

function remoteScripts(html) {
  const out = [];
  const re = /<script\b[^>]*\bsrc\s*=\s*["']?(https?:)?\/\/([^"'\s>]+)/gi;
  let m;
  while ((m = re.exec(html))) out.push(`${m[1] || 'https:'}//${m[2]}`);
  return out;
}

// Inline event-handler attributes (onclick="...") and javascript: URLs cannot be allowed by
// hashes, so if the page uses them we fall back to 'unsafe-inline' for scripts.
function needsUnsafeInline(html) {
  return /<[a-zA-Z][^<>]*?\son[a-z]+\s*=\s*["'`$]/.test(html) || /\bhref\s*=\s*["']\s*javascript:/i.test(html);
}

// config.js is a plain script: window.DEADLINE_CONFIG = { supabaseUrl, supabaseKey, usernameDomain }.
// Run it the way the page does (window/self are the global object) in an empty context, with no access
// to Node. Returns {} when it is missing or can't be read; `error` says why it couldn't be read.
function readConfig(text) {
  if (text == null || text === '') return { config: {} };
  const ctx = vm.createContext({});
  try {
    vm.runInContext('var window = this, self = this;', ctx);
    vm.runInContext(String(text), ctx, { filename: 'config.js', timeout: 1000 });
  } catch (e) { return { config: {}, error: e.message }; }
  const c = ctx.DEADLINE_CONFIG;
  if (!c || typeof c !== 'object') return { config: {} };
  // plain values only, copied out of the sandbox
  return { config: { supabaseUrl: String(c.supabaseUrl || '').trim(), supabaseKey: String(c.supabaseKey || '').trim(), usernameDomain: String(c.usernameDomain || '').trim() } };
}

// The origin the page talks to for accounts: https only, or http on this computer (a local test server).
// '' when config.js names no project; `warning` says why a URL that is there was left out.
function supabaseOrigin(url) {
  url = String(url || '').trim();
  if (!url) return { origin: '' };
  try {
    const u = new URL(url);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if (u.protocol === 'https:' || (u.protocol === 'http:' && local)) return { origin: u.origin };
    return { origin: '', warning: `supabaseUrl ${url} is not https; it is left out of the CSP, so sign-in would be blocked` };
  } catch (e) { return { origin: '', warning: `supabaseUrl "${url}" is not a valid URL; it is left out of the CSP` }; }
}

// A Supabase secret / service_role key must never ship: anyone could read it out of the app.
function isSecretKey(key) {
  key = String(key || '').trim();
  if (/^sb_secret_/.test(key)) return true;
  const part = key.split('.')[1];
  if (!part) return false;
  try { return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')).role === 'service_role'; } catch (e) { return false; }
}

// opts.config: the text of config.js (missing or empty = accounts off, nothing added to connect-src)
function buildCsp(source, opts = {}) {
  const html = normalizeNewlines(source);
  const warnings = [];
  const { config, error } = readConfig(opts.config);
  if (error) warnings.push(`config.js could not be read (${error}); accounts stay off`);
  const supa = config.supabaseUrl && config.supabaseKey ? supabaseOrigin(config.supabaseUrl) : { origin: '' };
  if (supa.warning) warnings.push(supa.warning);
  let scriptSrc = `'self' ${ORIGIN}`;
  if (needsUnsafeInline(html)) {
    scriptSrc += " 'unsafe-inline'";
    warnings.push("index.html uses inline event handlers (on...=) or javascript: links, so script-src falls back to 'unsafe-inline'.");
  } else {
    const hashes = [...new Set(inlineScripts(html).map((s) => `'sha256-${crypto.createHash('sha256').update(s, 'utf8').digest('base64')}'`))];
    if (hashes.length) scriptSrc += ` ${hashes.join(' ')}`;
  }
  for (const r of remoteScripts(html)) warnings.push(`Remote script ${r} will be blocked by the CSP. Copy it into src/ and load it with a relative URL.`);
  const self = `'self' ${ORIGIN}`;
  const policy = [
    `default-src ${self}`,
    `script-src ${scriptSrc}`,
    `style-src ${self} 'unsafe-inline' https://fonts.googleapis.com`,
    `font-src ${self} data: https://fonts.gstatic.com`,
    `img-src ${self} data: blob:`,
    `media-src ${self} data: blob:`,
    `connect-src ${self} data: blob:${supa.origin ? ` ${supa.origin}` : ''}`,
    `worker-src ${self} blob:`,
    `frame-src ${self} blob: data:`,
    "object-src 'none'",
    `base-uri ${self}`,
    `form-action ${self}`,
  ].join('; ');
  return { policy, warnings, supabaseOrigin: supa.origin };
}

module.exports = { ORIGIN, wrapHtml, buildCsp, readConfig, supabaseOrigin, isSecretKey, normalizeNewlines, inlineScripts, remoteScripts, needsUnsafeInline };
