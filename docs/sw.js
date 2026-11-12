const prefix = `voice-line:${self.registration.scope}:`;
const version = `${prefix}1`;
const files = [
  "index.html", "styles.css", "app.mjs", "graph.mjs", "contour.mjs",
  "pitch.mjs", "capture.mjs", "pitch-worker.mjs", "microphone.mjs",
  "manifest.webmanifest", "icon-192.png", "icon-512.png",
];
const indexUrl = new URL("index.html", self.registration.scope).href;
const urls = new Set(files.map((file) => new URL(file, self.registration.scope).href));

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(version).then((cache) => cache.addAll(
    Array.from(urls, (url) => new Request(url, { cache: "reload" })),
  )));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith(prefix) && key !== version).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  const address = url.origin + url.pathname;
  const home = event.request.mode === "navigate" && (address === self.registration.scope || address === indexUrl);
  if (!home && !urls.has(url.href)) return;
  const resource = home ? indexUrl : event.request;
  event.respondWith(caches.open(version).then(async (cache) => await cache.match(resource) ?? fetch(event.request)));
});
