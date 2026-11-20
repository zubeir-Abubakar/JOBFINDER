const CACHE = "atw-shell-v6";
const SHELL = [
  "/offline",
  "/manifest.webmanifest",
  "/logo.svg",
  "/logo-mark.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/maskable-512.png",
  "/icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // One missing shell asset must not abort the entire service-worker install.
    // Chrome treats a failed install as "not installable", so cache each item
    // independently and keep the worker usable even if an optional asset 404s.
    await Promise.allSettled(SHELL.map((asset) => cache.add(asset)));
    try {
      const response = await fetch("/offline", { cache: "reload" });
      if (response.ok) {
        await cache.put("/offline", response.clone());
        const html = await response.text();
        const assets = [...html.matchAll(/(?:src|href)="(\/_next\/static\/[^"]+)"/g)]
          .map((match) => match[1]);
        await Promise.allSettled([...new Set(assets)].map((asset) => cache.add(asset)));
      }
    } catch {
      // The shell is still usable even when the offline document could not be warmed.
    }
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never intercept private routes, API responses, documents or auth flows.
  if (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/admin") ||
    url.pathname.startsWith("/login") ||
    url.pathname.startsWith("/setup") ||
    url.pathname.startsWith("/change-password") ||
    url.pathname.startsWith("/documents") ||
    url.pathname.startsWith("/applications") ||
    url.pathname.startsWith("/inbox")
  ) {
    return;
  }

  // The manifest must be network-first. A cache-first manifest can remain
  // stale after a rename/icon/start_url change and make Chrome reject an
  // otherwise valid installation.
  if (url.pathname === "/manifest.webmanifest") {
    event.respondWith(
      fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          void caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      }).catch(() => caches.match(request)),
    );
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("/offline")));
    return;
  }

  const staticAsset =
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/icons/") ||
    url.pathname === "/logo.svg" ||
    url.pathname === "/logo-mark.svg" ||
    url.pathname === "/gemini-pcm-worklet.js" ||
    url.pathname === "/pdf.worker.min.mjs";

  if (staticAsset) {
    // Network-first for JavaScript chunks. Cache-first can keep an old
    // Turbopack/Next chunk after a server restart, leaving the page hydrated by
    // mismatched code. A hashed production asset is still cached for offline
    // use, but the network remains authoritative while it is available.
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const response = await fetch(request);
        if (response.ok && response.type === "basic") {
          await cache.put(request, response.clone());
        }
        return response;
      } catch (error) {
        const cached = await cache.match(request);
        if (cached) return cached;
        throw error;
      }
    })());
  }
});
