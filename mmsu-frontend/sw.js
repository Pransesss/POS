/* sw.js — service worker: lets the pages open without internet (the POS data itself is kept by offline.js in IndexedDB).
   Every page / css / js / image is saved when the worker installs, so every tab opens offline — even ones never visited online.
   Pages / css / js / images: network first, falls back to the saved copy. The API is never cached here.
   Wi-Fi or data with no real internet does not fail, it HANGS. So a request that takes longer than WAIT is cancelled
   (stuck requests would block the browser's few connections) and the saved copy is used; after that, saved copies
   are served straight away for a while instead of waiting again on every file. */
const CACHE = "mmsu-pos-v25";
const WAIT = 2500, SLOW_FOR = 20000;
let slowUntil = 0;
const FILES = [
  "login.html",
  "staff/dashboard.html", "staff/pos.html", "staff/pos-meal.html", "staff/pos-meat.html", "staff/inventory.html",
  "staff/receiving.html", "staff/transactions.html", "staff/prediction.html",
  "admin/dashboard.html", "admin/deliveries.html", "admin/events.html", "admin/inventory.html",
  "admin/prediction.html", "admin/settings.html", "admin/transactions.html",
  "css/base.css", "css/components.css", "css/icons.css", "css/layout.css", "css/pages.css", "css/print.css",
  "js/api.js", "js/common.js", "js/dashboard.js", "js/deliveries.js", "js/events.js", "js/inventory.js", "js/login.js",
  "js/offline.js", "js/pos.js", "js/prediction.js", "js/receiving.js", "js/settings.js", "js/transactions.js",
  "logos/mamasu.png",
];
self.addEventListener("install", (e) => {
  self.skipWaiting();
  // one missing file must not stop the rest from being saved
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(FILES.map((f) => c.add(new URL(f, self.registration.scope)).catch(() => {})))));
});
self.addEventListener("activate", (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.pathname.startsWith("/api/") || url.origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const saved = (await cache.match(e.request)) || (await cache.match(e.request, { ignoreSearch: true }));
    if (saved && Date.now() < slowUntil) return saved;                  // the network just hung: do not wait on it again
    const ctrl = new AbortController();
    const net = fetch(e.request.url, { signal: ctrl.signal, credentials: "same-origin" }).then((res) => {   // by URL: a page-navigation request cannot be re-sent with a signal
      if (res.ok) cache.put(e.request, res.clone());
      slowUntil = 0;
      return res;
    });
    if (!saved) return net;                                             // nothing saved: the network is the only option
    let timer;
    const late = new Promise((resolve) => { timer = setTimeout(() => { slowUntil = Date.now() + SLOW_FOR; ctrl.abort(); resolve(saved); }, WAIT); });
    try { return await Promise.race([net, late]); }
    catch { return saved; }                                             // truly offline: fails at once
    finally { clearTimeout(timer); }
  })());
});
