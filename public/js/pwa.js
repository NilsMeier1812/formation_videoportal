// Eine installierbare App für alle Bereiche: ein Service Worker an der Wurzel.
export function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  // Lokal (wrangler dev) nicht registrieren – sonst hängen beim Entwickeln alte Dateien fest
  if (location.hostname === "localhost" || location.hostname === "127.0.0.1") return;
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
