/* OpenGSC service worker (N10, docs/tasks/wave-nov/N10-pwa-push.md).
 *
 * Plain JavaScript on purpose — no bundler, no dependencies; it is served straight from
 * /public. Registered by src/components/ServiceWorkerRegister.tsx, and only when the page
 * runs in a secure context (service workers exist on https:// and localhost only — the
 * brief's "Push без HTTPS не работает" trap).
 *
 * Strategy map:
 *   • HTML navigations            — network-first, cached copy as the offline fallback.
 *   • /_next/static/** (hashed)   — stale-while-revalidate: serve instantly, refresh in
 *                                   the background. Hashed names make staleness harmless.
 *   • GET /api/uptime/status and
 *     GET /api/gsc/sites          — network-first "offline reading" whitelist: the only
 *                                   API responses ever stored. When the network is gone
 *                                   the cached copy is served with an X-OpenGSC-Cache-Time
 *                                   header and a postMessage so the UI can label it
 *                                   «данные от {time}» (pwaOfflineData).
 *   • everything else (all POST/PATCH/… API calls included) — network only, never cached.
 */

const VERSION = "opengsc-v1";
const SHELL_CACHE = `${VERSION}-shell`;      // HTML documents
const STATIC_CACHE = `${VERSION}-static`;    // /_next/static (and icons)
const DATA_CACHE = `${VERSION}-data`;        // whitelisted GET API responses
const CACHES = [SHELL_CACHE, STATIC_CACHE, DATA_CACHE];

// The only API GETs stored — the "last look at the dashboard on the road" set.
const OFFLINE_API = ["/api/uptime/status", "/api/gsc/sites"];

self.addEventListener("install", () => {
  // Activate as soon as the old worker is gone; the caches above start empty and fill
  // lazily on first fetch, so there is nothing to pre-cache that could block install.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(n => !CACHES.includes(n)).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

// ─── helpers ──────────────────────────────────────────────────────────────────

function isOfflineApiGet(request) {
  return request.method === "GET" && OFFLINE_API.includes(new URL(request.url).pathname);
}

async function networkFirstDocument(request) {
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put(request, fresh.clone());
    }
    return fresh;
  } catch (e) {
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response("offline", { status: 503, headers: { "Content-Type": "text/plain" } });
  }
}

async function staleWhileRevalidate(request) {
  const cached = await caches.match(request);
  const refresh = fetch(request).then(response => {
    if (response && response.ok) {
      // Background refresh only; a rejected update must not bubble into the page's fetch.
      caches.open(STATIC_CACHE)
        .then(c => c.put(request, response.clone()))
        .catch(() => {});
    }
    return response;
  }).catch(() => null);
  return cached || (await refresh) || Response.error();
}

async function offlineApiGet(request) {
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) {
      const cache = await caches.open(DATA_CACHE);
      await putWithTime(cache, request, fresh);
    }
    return fresh;
  } catch (e) {
    const cached = await caches.match(request);
    if (!cached) throw e; // genuinely nothing to show
    // Tell the page which moment it is looking at: a response header for anything that
    // inspects it, and a message for the banner in ServiceWorkerRegister.
    const time = cached.headers.get("X-OpenGSC-Cache-Time") || "";
    try {
      const clients = await self.clients.matchAll({ type: "window" });
      for (const client of clients) client.postMessage({ type: "opengsc-offline-data", time });
    } catch (_) { /* the banner is best-effort */ }
    return cached;
  }
}

// Stamp every whitelisted response with the moment it was stored, so an offline read
// can always be labelled — the cache is written only here, after a network-first hit.
async function putWithTime(cache, request, response) {
  const time = new Date().toISOString();
  const headers = new Headers(response.headers);
  headers.set("X-OpenGSC-Cache-Time", time);
  const body = await response.clone().arrayBuffer();
  await cache.put(request, new Response(body, { status: response.status, statusText: response.statusText, headers }));
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (url.origin !== self.location.origin) return; // not ours — do not touch

  if (isOfflineApiGet(request)) {
    event.respondWith(offlineApiGet(request));
    return;
  }
  if (url.pathname.startsWith("/api/")) return; // every other API call: network only

  if (request.mode === "navigate" || (request.destination === "document" && request.method === "GET")) {
    event.respondWith(networkFirstDocument(request));
    return;
  }
  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/")) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }
  // Everything else passes through untouched.
});

// ─── push (the reason this file exists for most users) ────────────────────────

self.addEventListener("push", (event) => {
  let payload = { title: "OpenGSC", body: "", url: "/" };
  try {
    if (event.data) {
      const parsed = event.data.json();
      payload = {
        title: typeof parsed.title === "string" && parsed.title ? parsed.title : payload.title,
        body: typeof parsed.body === "string" ? parsed.body : "",
        url: typeof parsed.url === "string" && parsed.url ? parsed.url : "/",
      };
    }
  } catch (e) { /* malformed payload — fall back to the defaults above */ }
  event.waitUntil(self.registration.showNotification(payload.title, {
    body: payload.body,
    icon: "/icons/icon-192.png",
    badge: "/icons/badge-72.png",
    tag: "opengsc-" + payload.url,
    data: { url: payload.url },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of clients) {
      const clientUrl = new URL(client.url);
      if (clientUrl.pathname === url && "focus" in client) return client.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});
