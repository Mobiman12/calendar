// Platzhalter-Service-Worker zur Vermeidung von 404-Requests.
// Hier kann später echte Offline-/Caching-Logik ergänzt werden.
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
