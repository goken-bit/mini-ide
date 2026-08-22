const CACHE = "miniide-v1";
const ASSETS = ["/", "/index.html", "/app.js", "/style.css"];
self.addEventListener("install", function(e) {
  e.waitUntil(caches.open(CACHE).then(function(c) { return c.addAll(ASSETS); }));
  self.skipWaiting();
});
self.addEventListener("activate", function(e) {
  e.waitUntil(caches.keys().then(function(keys) {
    return Promise.all(keys.filter(function(k){ return k!==CACHE; }).map(function(k){ return caches.delete(k); }));
  }));
  self.clients.claim();
});
self.addEventListener("fetch", function(e) {
  if (e.request.method !== "GET") return;
  e.respondWith(caches.match(e.request).then(function(r) {
    return r || fetch(e.request).then(function(resp){
      if (ASSETS.indexOf(new URL(e.request.url).pathname) >= 0) {
        caches.open(CACHE).then(function(c){ c.put(e.request, resp.clone()); });
      }
      return resp;
    });
  }));
});
