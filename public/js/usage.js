// Nutzung zählen – still im Hintergrund, ohne Anzeige (Auswertung: Verwalten → Mehr, nur
// Trainer; Server: src/routes/usage.js). Gemeldet wird beim Öffnen und beim Zurückholen der
// App, höchstens alle 30 Minuten je Gerät. Nur eine zufällige Geräte-Kennung, keine Namen.
// Klappt etwas nicht (offline, nicht angemeldet), passiert einfach nichts.
import { session } from "./session.js";

const DEVICE_KEY = "choreo_user_id"; // dieselbe Kennung wie im Planer (Bearbeitungssperre)
const LAST_KEY = "formation.usage_at";
const GAP_MS = 30 * 60 * 1000;
let sending = false;

function deviceId() {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

async function ping() {
  try {
    if (sending || !session.role || document.visibilityState === "hidden" || !navigator.onLine) return;
    if (Date.now() - (Number(localStorage.getItem(LAST_KEY)) || 0) < GAP_MS) return;
    sending = true;
    const res = await fetch("/api/usage", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device: deviceId() }),
      keepalive: true,
    });
    if (res.ok) localStorage.setItem(LAST_KEY, String(Date.now()));
  } catch {
    /* egal – beim nächsten Mal */
  } finally {
    sending = false;
  }
}

export function startUsage() {
  session.restore().then(ping, () => {});
  document.addEventListener("visibilitychange", ping);
  window.addEventListener("sessionchange", ping); // nach dem Anmelden
}
