/* sw.js — service worker: lets the pages open without internet (the POS data itself is kept by offline.js in IndexedDB).
   Every page / css / js / image is saved when the worker installs, so every tab opens offline — even ones never visited online.
   Pages / css / js / images: network first, falls back to the saved copy. The API is never cached here. */
const CACHE = "mmsu-pos-v23";
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
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request).then((hit) => hit || caches.match(e.request, { ignoreSearch: true }))));
});
