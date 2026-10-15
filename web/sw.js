// Deadline service worker for the iPhone home-screen website (template).
// web/build-site.mjs fills in VERSION (a hash of every file in the site) and PRECACHE (every file the
// site ships, except this one), so each deploy installs as a new version with its own cache.
//  - The app shell (index.html, scripts, pictures, icons) is answered from the cache, so the app opens
//    offline and instantly.
//  - programs.json and config.js are fetched from the network first; the cached copy is the fallback.
//  - Anything that isn't a GET, and every request to another origin (Supabase sign-in and sync,
//    Google Fonts), is never intercepted or cached.
//  - A new version waits until the page asks it to take over (the page does that while it is hidden),
//    so an open screen never mixes files from two versions.
"use strict";

const VERSION = "dev";
const PRECACHE = /* PRECACHE */ [];
const CACHE = `deadline-${VERSION}`;
const NETWORK_FIRST = new Set(["programs.json", "config.js"]);
const NETWORK_TIMEOUT = 5000;
const BASE = new URL("./", self.location.href);
const SHELL = BASE.href;
const PRECACHED = new Set(PRECACHE.map((p) => new URL(p, BASE).href));

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => Promise.all(PRECACHE.map(async (p) => {
    const url = new URL(p, BASE).href;
    // straight from the server, not an older copy from the browser's HTTP cache
    const res = await fetch(url, { cache: "reload" });
    if (!res.ok) throw new Error(`Could not cache ${p}: HTTP ${res.status}`);
    // a redirected response can't answer a page load, so keep a clean copy
    await cache.put(url, res.redirected ? new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers }) : res);
  }))));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith("deadline-") && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || req.headers.has("range")) return;
  const url = new URL(req.url);
  if (url.origin !== BASE.origin || !url.pathname.startsWith(BASE.pathname)) return;
  const rel = url.pathname.slice(BASE.pathname.length);
  const key = rel === "" || rel === "index.html" ? SHELL : url.origin + url.pathname;
  if (NETWORK_FIRST.has(rel)) event.respondWith(networkFirst(event, req, key));
  else if (PRECACHED.has(key)) event.respondWith(cacheFirst(req, key));
  else if (req.mode === "navigate") event.respondWith(fetch(req).catch(() => cached(SHELL).then((r) => r || Response.error())));
});

function cached(key) {
  return caches.open(CACHE).then((cache) => cache.match(key, { ignoreSearch: true }));
}

async function cacheFirst(req, key) {
  // not there only while the first install is still running
  return (await cached(key)) || fetch(req);
}

function networkFirst(event, req, key) {
  let stored = null;
  const network = fetch(req.url, { cache: "no-cache", credentials: "same-origin" }).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      stored = caches.open(CACHE).then((cache) => cache.put(key, copy));
    }
    return res;
  });
  event.waitUntil(network.then(() => stored, () => null).catch(() => null));
  const fallback = cached(key);
  // a very slow connection gets the saved copy after a few seconds (the download still refreshes it)
  const slow = new Promise((resolve) => setTimeout(resolve, NETWORK_TIMEOUT)).then(() => fallback).then((hit) => hit || network);
  return Promise.race([network, slow]).then(
    async (res) => (res.ok ? res : (await fallback) || res),
    async () => (await fallback) || Response.error(),
  );
}
