const CACHE = "aurelia-shell-v1";
const SHELL = [
  "/offline.html",
  "/icon.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/art/hero.svg",
  "/art/afterglow.svg",
  "/art/blue-hours.svg",
  "/art/parallel.svg",
  "/art/still-life.svg",
];
self.addEventListener("install", (event) =>
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL))),
);
self.addEventListener("activate", (event) =>
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  ),
);
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/audio/")
  )
    return;
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request).catch(() => caches.match("/offline.html")),
    );
    return;
  }
  if (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/art/") ||
    url.pathname.startsWith("/icon")
  )
    event.respondWith(
      caches.match(event.request).then(
        (cached) =>
          cached ||
          fetch(event.request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              void caches
                .open(CACHE)
                .then((cache) => cache.put(event.request, copy));
            }
            return response;
          }),
      ),
    );
});
