const CACHE_NAME = "envyenhance-v1";
const STATIC_ASSETS = ["/", "/manifest.json"];

// Install: cache static shell
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// Activate: delete old caches
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
        )
      )
  );
  self.clients.claim();
});

// Fetch: network-first for API, cache-first for assets
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Never cache API requests
  if (url.pathname.startsWith("/api/")) return;

  // Cache-first for static assets (JS/CSS/images with hash in name)
  if (
    url.pathname.startsWith("/assets/") ||
    url.pathname.match(/\.(webp|png|jpg|jpeg|svg|woff2)$/)
  ) {
    event.respondWith(
      caches.match(event.request).then(
        (cached) =>
          cached ??
          fetch(event.request).then((res) => {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(event.request, clone));
            return res;
          })
      )
    );
    return;
  }

  // Network-first for pages (HTML)
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put(event.request, clone));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});

// ─── Push Notification Handler ────────────────────────────────────────────────
self.addEventListener("push", (event) => {
  if (!event.data) return;
  let payload;
  try { payload = event.data.json(); } catch { payload = { title: "Tree Friend", body: event.data.text() }; }

  const options = {
    body: payload.body ?? "You have a new notification",
    icon: "/logo.webp",
    badge: "/logo.webp",
    vibrate: [100, 50, 100],
    data: { url: payload.url ?? "/" },
    actions: payload.actions ?? [],
  };

  event.waitUntil(
    self.registration.showNotification(payload.title ?? "Tree Friend 🌳", options)
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url ?? "/";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      const existing = clientList.find((c) => c.url.includes(self.location.origin) && "focus" in c);
      if (existing) { existing.focus(); existing.navigate?.(url); }
      else { clients.openWindow(url); }
    })
  );
});
