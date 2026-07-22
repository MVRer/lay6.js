/* Service worker: network-first with a cache fallback, so the viewer always
 * picks up new code when online yet still works fully offline. Bump CACHE on
 * every asset change to evict the previous generation. */
"use strict";

var CACHE = "lay6js-v2";
var ASSETS = [
  "./",
  "index.html",
  "css/style.css",
  "js/lay6.js",
  "js/render.js",
  "js/app.js",
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return c.addAll(ASSETS);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) {
        return k !== CACHE;
      }).map(function (k) {
        return caches.delete(k);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener("fetch", function (e) {
  if (e.request.method !== "GET") return;
  // Network-first: serve fresh assets when online, refresh the cache, and
  // fall back to the cached copy only when the network is unavailable.
  e.respondWith(
    fetch(e.request).then(function (res) {
      if (res && res.ok && res.type === "basic") {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(e.request, { ignoreSearch: true });
    })
  );
});
