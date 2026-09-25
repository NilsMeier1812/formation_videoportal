// Kleine Helfer ohne Abhängigkeiten.

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** Tiefe Kopie ohne Alpine-Proxy – für IndexedDB (strukturierte Klone mögen keine Proxys). */
export const plain = (value) => JSON.parse(JSON.stringify(value));

/** Auf Millisekunden runden, wie überall für Zeitangaben gespeichert. */
export const round3 = (n) => Math.round(n * 1000) / 1000;

export const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

/** 83.456 → "1:23.45" */
export function formatTime(sec) {
  sec = Number(sec) || 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.floor((sec * 100) % 100);
  return `${m}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

export function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return n.toFixed(n < 10 && i > 0 ? 1 : 0) + " " + units[i];
}

export function isTypingTarget(el) {
  if (!el) return false;
  const tag = (el.tagName || "").toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}
