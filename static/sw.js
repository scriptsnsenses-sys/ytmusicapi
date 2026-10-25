/* WebTube service worker — app-shell caching only. API calls pass through. */
const CACHE = "webtube-shell-v8";
const SHELL = [
  "/",
  "/static/styles.css?v=12",
  "/static/app.js?v=12",
  "/manifest.webmanifest",
  "/static/icons/icon-192.png",
  "/static/icons/icon-512.png",
  "/static/icons/maskable-512.png",
  "/static/icons/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;

  // API + docs: always network (never cache music data)
  if (!url.pathname.startsWith("/static") && url.pathname !== "/" && url.pathname !== "/manifest.webmanifest") {
    return;
  }
  // App shell: cache-first, refresh in background
  e.respondWith(
    caches.match(e.request, { ignoreSearch: false }).then((hit) => {
      const net = fetch(e.request).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
