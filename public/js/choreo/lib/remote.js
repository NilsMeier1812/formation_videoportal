// Fernsteuerung (rein, testbar): Stelle des PCs am Handy weiterrechnen, Wiederverbinden.

/** Wartezeiten (ms) fürs Wiederverbinden: schnell, dann seltener. */
export const BACKOFF = [1000, 2000, 4000, 8000, 10000];
export const backoff = (attempt) => BACKOFF[Math.min(Math.max(0, attempt), BACKOFF.length - 1)];

/** WebSocket-Adresse für eine Rolle (host = PC, ctrl = Handy). */
export function remoteUrl(location, as) {
  return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/remote?as=${as}`;
}

/**
 * Musik-Zeit am PC jetzt: gemeldete Stelle + vergangene Zeit × Tempo (läuft er), höchstens
 * bis zum Ende. `elapsedMs` = Zeit seit Eingang der Meldung.
 */
export function mirrorTime(status, elapsedMs, duration = 0) {
  if (!status) return 0;
  const t = status.playing ? status.time + (Math.max(0, elapsedMs) / 1000) * (status.rate || 1) : status.time;
  const end = duration || status.duration || 0;
  return end ? Math.min(Math.max(0, t), end) : Math.max(0, t);
}

/** Kurz, für die Kopfzeile des Handys. */
export function controllerShort({ connected, hostOnline }) {
  if (!connected) return "Verbinde …";
  return hostOnline ? "PC verbunden" : "Kein Musik-PC";
}

/** Ausführlich, fürs Menü. */
export function controllerLabel({ connected, hostOnline }) {
  if (!connected) return "Verbinde …";
  if (!hostOnline) return "Kein Musik-PC – dort im Menü „Musik an diesem Gerät“ einschalten";
  return "Steuert den Musik-PC";
}
