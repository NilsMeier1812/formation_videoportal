// Upload in Teilen (siehe src/routes/multipart.js): große Videos in 10-MiB-Stücken,
// drei gleichzeitig. Bricht die Verbindung ab, wird nur der betroffene Teil wiederholt
// (mit Pause, und erst wenn das Handy wieder online ist). Die fertigen Teile merkt sich
// der Browser: Wählt man dieselbe Datei später noch einmal, geht es dort weiter.
import { api } from "../api.js";

const PARALLEL = 3;
const RETRIES = 6; // pro Teil
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

/** Offener Upload zu dieser Datei: { id, partSize, total, parts: { n: etag }, at } – oder null. */
export function loadResume(file) {
  const all = readAll();
  const entry = all[fingerprint(file)];
  if (!entry || Date.now() - entry.at > RESUME_MAX_AGE_MS) return null;
  return entry;
}
export function saveResume(file, entry) {
  const all = readAll();
  for (const [k, v] of Object.entries(all)) if (Date.now() - v.at > RESUME_MAX_AGE_MS) delete all[k];
  all[fingerprint(file)] = entry;
  writeAll(all);
}
export function dropResume(file) {
  const all = readAll();
  delete all[fingerprint(file)];
  writeAll(all);
}

// ---------------- Hochladen ----------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const whenOnline = () => navigator.onLine ? Promise.resolve()
  : new Promise((r) => window.addEventListener("online", r, { once: true }));

/** Ein Teil per PUT; liefert das ETag aus der Antwort (R2-CORS muss „ETag“ freigeben). */
function putPart(url, blob, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded);
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(Object.assign(new Error(`Speicher antwortet mit ${xhr.status}`), { status: xhr.status }));
        return;
      }
      const etag = xhr.getResponseHeader("ETag");
      if (!etag) reject(Object.assign(new Error("ETag nicht lesbar – im R2-CORS fehlt ExposeHeaders „ETag“"), { fatal: true }));
      else resolve(etag);
    };
    xhr.onerror = () => reject(new Error("Verbindung abgebrochen"));
    xhr.send(blob);
  });
}

/**
 * Lädt alle fehlenden Teile hoch. `parts` (Nummer → ETag) enthält schon fertige Teile und
 * wird fortlaufend ergänzt; `onSaved` wird nach jedem Teil aufgerufen (zum Merken).
 * Gibt die Liste für /complete zurück: [{ partNumber, etag }].
 */
export async function uploadInParts({ id, file, partSize, total, parts, onProgress, onSaved, onRetry }) {
  const sizeOf = (n) => Math.min(partSize, file.size - (n - 1) * partSize);
  const inflight = new Map();
  let doneBytes = Object.keys(parts).reduce((sum, n) => sum + sizeOf(Number(n)), 0);
  const report = () => onProgress((doneBytes + [...inflight.values()].reduce((a, b) => a + b, 0)) / file.size);
  report();

  const queue = [];
  for (let n = 1; n <= total; n++) if (!parts[n]) queue.push(n);

  // Presigned URLs in Blöcken holen (1 h gültig); bei 403 (abgelaufen) neu holen
  const urls = new Map();
  async function urlFor(n, fresh = false) {
    if (fresh || !urls.has(n)) {
      const batch = [n, ...queue.slice(0, 19)];
      const { urls: got } = await api(`/api/videos/${id}/parts`, { method: "POST", body: { numbers: batch } });
      for (const u of got) urls.set(u.n, u.url);
    }
    return urls.get(n);
  }

  async function uploadPart(n) {
    const blob = file.slice((n - 1) * partSize, (n - 1) * partSize + sizeOf(n));
    for (let attempt = 0; ; attempt++) {
      try {
        const url = await urlFor(n, attempt > 0);
        const etag = await putPart(url, blob, (loaded) => { inflight.set(n, loaded); report(); });
        inflight.delete(n);
        parts[n] = etag;
        doneBytes += blob.size;
        report();
        onSaved(parts);
        return;
      } catch (err) {
        inflight.delete(n);
        report();
        if (err.fatal || attempt >= RETRIES || (err.status && err.status < 500 && err.status !== 403 && err.status !== 408 && err.status !== 429)) throw err;
        onRetry?.(n, attempt + 1);
        await whenOnline();
        await sleep(Math.min(30000, 2000 * 2 ** attempt));
      }
    }
  }

  async function worker() {
    while (queue.length) await uploadPart(queue.shift());
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, worker));

  return Object.entries(parts).map(([n, etag]) => ({ partNumber: Number(n), etag }));
}
