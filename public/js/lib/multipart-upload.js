// Upload in Teilen (siehe src/routes/multipart.js): große Videos in 10-MiB-Stücken,
// drei gleichzeitig. Bricht die Verbindung ab, wird nur der betroffene Teil wiederholt
// (mit Pause, und erst wenn das Handy wieder online ist). Die fertigen Teile merkt sich
// der Browser: Wählt man dieselbe Datei später noch einmal, geht es dort weiter.
//
// Im Hintergrund (andere App, Bildschirm aus) friert das Handy die Seite ein. Kommt man
// zurück, geht es sofort weiter: Wartepausen enden, und ein Teil, der sich nicht mehr
// rührt, wird abgebrochen und neu geschickt. Zeit im Hintergrund zählt nicht als Fehlversuch.
import { api } from "../api.js";

const PARALLEL = 3;
const RETRIES = 8; // Fehlversuche pro Teil (ohne die im Hintergrund)
const STALL_MS = 30000; // so lange ohne Fortschritt = hängt
const RESUME_KEY = "formation.uploads";
const RESUME_MAX_AGE_MS = 20 * 3600 * 1000; // der Server räumt offene Uploads nach 24 h weg

// ---------------- Fortsetzen: fertige Teile merken ----------------

/** Erkennungsmerkmal einer Datei – dieselbe Datei erneut gewählt = gleicher Wert. */
export function fingerprint(file) {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

function readAll() {
  try { return JSON.parse(localStorage.getItem(RESUME_KEY) || "{}"); } catch { return {}; }
}
function writeAll(all) {
  try { localStorage.setItem(RESUME_KEY, JSON.stringify(all)); } catch { /* voll/privat – dann ohne Fortsetzen */ }
}
const fresh = (entry) => entry && Date.now() - entry.at <= RESUME_MAX_AGE_MS;

/** Offener Upload zu dieser Datei: { id, partSize, total, parts: { n: etag }, at } – oder null. */
export function loadResume(file) {
  const entry = readAll()[fingerprint(file)];
  return fresh(entry) ? entry : null;
}
export function saveResume(file, entry) {
  const all = readAll();
  for (const [k, v] of Object.entries(all)) if (!fresh(v)) delete all[k];
  all[fingerprint(file)] = { ...entry, at: Date.now() };
  writeAll(all);
}
export function dropResume(file) {
  const all = readAll();
  delete all[fingerprint(file)];
  writeAll(all);
}

/** Unterbrochene Uploads (für den Hinweis „dieselbe Datei nochmal wählen“): [{ key, name, share }]. */
export function pendingResumes() {
  return Object.entries(readAll()).filter(([, v]) => fresh(v)).map(([key, v]) => ({
    key,
    name: key.split("|")[0],
    share: v.total ? Object.keys(v.parts || {}).length / v.total : 0,
  }));
}
export function dropResumeKey(key) {
  const all = readAll();
  delete all[key];
  writeAll(all);
}

// ---------------- Aufwecken ----------------

// Zurück in der App oder wieder online → alle wartenden Wiederholungen sofort starten
const wakeup = new EventTarget();
let hiddenCount = 0; // wie oft die Seite schon im Hintergrund war
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") hiddenCount++;
    else wakeup.dispatchEvent(new Event("wake"));
  });
  window.addEventListener("online", () => wakeup.dispatchEvent(new Event("wake")));
}

/**
 * Steuerung für einen Upload: `kick()` („Erneut versuchen“) bricht hängende Teile ab
 * und beendet Wartepausen. `onKick(fn)` meldet sich dafür an (gibt Abmelden zurück).
 */
export function uploadControl() {
  const target = new EventTarget();
  return {
    kick() { target.dispatchEvent(new Event("kick")); },
    onKick(fn) {
      target.addEventListener("kick", fn);
      return () => target.removeEventListener("kick", fn);
    },
  };
}

/** Pause, die vorzeitig endet: beim Zurückkommen, wieder online oder „Erneut versuchen“. */
function pause(ms, control) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      wakeup.removeEventListener("wake", done);
      off?.();
      resolve();
    };
    const timer = setTimeout(done, ms);
    wakeup.addEventListener("wake", done);
    const off = control?.onKick(done);
  });
}

function whenOnline(control) {
  if (navigator.onLine) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { window.removeEventListener("online", done); off?.(); resolve(); };
    window.addEventListener("online", done);
    const off = control?.onKick(done);
  });
}

// ---------------- Senden ----------------

const retryable = (message, extra = {}) => Object.assign(new Error(message), { retry: true, ...extra });

/**
 * Ein Blob per XHR. Rührt sich der Upload STALL_MS lang nicht (im Vordergrund), wird er
 * abgebrochen und als wiederholbar gemeldet; ebenso bei „Erneut versuchen“.
 * Liefert den XHR (für Kopfzeilen der Antwort).
 */
export function sendBlob({ method, url, headers = {}, body, onProgress, control }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let last = Date.now();
    let reason = null;
    const touch = () => { last = Date.now(); };
    const onVisible = () => document.visibilityState === "visible" && touch();
    const stop = (why) => { reason = why; xhr.abort(); };
    const watchdog = setInterval(() => {
      if (document.visibilityState === "visible" && Date.now() - last > STALL_MS) stop("stall");
    }, 5000);
    const offKick = control?.onKick(() => stop("kick"));
    document.addEventListener("visibilitychange", onVisible);
    const cleanup = () => {
      clearInterval(watchdog);
      offKick?.();
      document.removeEventListener("visibilitychange", onVisible);
    };

    xhr.open(method, url);
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (e) => { touch(); if (e.lengthComputable) onProgress?.(e.loaded); };
    xhr.onload = () => {
      cleanup();
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr);
      else {
        const transient = xhr.status >= 500 || [403, 408, 429].includes(xhr.status);
        reject(Object.assign(new Error(`Speicher antwortet mit ${xhr.status}`), { status: xhr.status, retry: transient }));
      }
    };
    xhr.onerror = () => { cleanup(); reject(retryable("Verbindung abgebrochen")); };
    xhr.onabort = () => {
      cleanup();
      reject(retryable(reason === "stall" ? "Upload hing" : "neu gestartet", { kicked: reason === "kick" }));
    };
    xhr.send(body);
  });
}

/**
 * Führt `attempt()` aus und wiederholt bei wiederholbaren Fehlern mit wachsender Pause.
 * Versuche, während derer die Seite im Hintergrund war oder die per „Erneut versuchen“
 * abgebrochen wurden, zählen nicht.
 */
export async function withRetries(attempt, { control, onRetry, retries = RETRIES } = {}) {
  let failures = 0; // zählen fürs Aufgeben
  let tries = 0; // alle, für die Länge der Pause
  for (;;) {
    const hiddenBefore = hiddenCount;
    try {
      return await attempt(failures);
    } catch (err) {
      if (!err.retry) throw err;
      const counts = !err.kicked && hiddenCount === hiddenBefore && document.visibilityState === "visible";
      if (counts) failures++;
      if (failures > retries) throw err;
      onRetry?.(err);
      await whenOnline(control);
      if (!err.kicked) await pause(Math.min(30000, 2000 * 2 ** tries++), control);
    }
  }
}

/**
 * Lädt alle fehlenden Teile hoch. `parts` (Nummer → ETag) enthält schon fertige Teile und
 * wird fortlaufend ergänzt; `onSaved` wird nach jedem Teil aufgerufen (zum Merken).
 * Gibt die Liste für /complete zurück: [{ partNumber, etag }].
 */
export async function uploadInParts({ id, file, partSize, total, parts, onProgress, onSaved, onRetry, control }) {
  const sizeOf = (n) => Math.min(partSize, file.size - (n - 1) * partSize);
  const inflight = new Map();
  let doneBytes = Object.keys(parts).reduce((sum, n) => sum + sizeOf(Number(n)), 0);
  const report = () => onProgress((doneBytes + [...inflight.values()].reduce((a, b) => a + b, 0)) / file.size);
  report();

  const queue = [];
  for (let n = 1; n <= total; n++) if (!parts[n]) queue.push(n);

  // Presigned URLs in Blöcken holen (1 h gültig); nach einem Fehler neu holen
  const urls = new Map();
  async function urlFor(n, renew) {
    if (renew || !urls.has(n)) {
      const batch = [n, ...queue.slice(0, 19)];
      let got;
      try {
        ({ urls: got } = await api(`/api/videos/${id}/parts`, { method: "POST", body: { numbers: batch } }));
      } catch (err) {
        // Netz weg → wiederholen; eine echte Antwort des Servers (404, 409 …) nicht
        if (err.status) throw err;
        throw retryable(err.message);
      }
      for (const u of got) urls.set(u.n, u.url);
    }
    return urls.get(n);
  }

  async function uploadPart(n) {
    const blob = file.slice((n - 1) * partSize, (n - 1) * partSize + sizeOf(n));
    await withRetries(async (failures) => {
      try {
        const url = await urlFor(n, failures > 0);
        const xhr = await sendBlob({
          method: "PUT", url, body: blob, control,
          onProgress: (loaded) => { inflight.set(n, loaded); report(); },
        });
        const etag = xhr.getResponseHeader("ETag");
        if (!etag) throw Object.assign(new Error("ETag nicht lesbar – im R2-CORS fehlt ExposeHeaders „ETag“"), { fatal: true });
        parts[n] = etag;
        doneBytes += blob.size;
      } finally {
        inflight.delete(n);
        report();
      }
      onSaved(parts);
    }, { control, onRetry });
  }

  async function worker() {
    while (queue.length) await uploadPart(queue.shift());
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, worker));

  return Object.entries(parts).map(([n, etag]) => ({ partNumber: Number(n), etag }));
}
