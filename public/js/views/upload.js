// Hochladen: angemeldet (Gruppen- oder Trainer-Code) direkt nach R2.
// Ein laufender Upload geht weiter, während man in andere Bereiche wechselt.
// Mehr als die Datei braucht es nicht: Aufnahmezeit und Länge kommen aus den
// Metadaten des Videos, ein Vorschaubild erzeugt der Browser; zugeordnet wird
// von den Trainern (Reiter „Zuordnen“).
import { api, ApiError, el, formatBytes, formatDateTime } from "../api.js";
import { blobReader, readVideoMeta } from "../lib/mp4meta.js";
import { makeThumbnail } from "../lib/thumbnail.js";
import { session } from "../session.js";

const $ = (id) => document.getElementById(id);
const ROLE_NAMES = { group: "mit Gruppen-Code", tagger: "als Trainer" };

let busy = false;
let wakeLock = null;

// ---------------- Anmeldung ----------------
// Angemeldet ist man immer (sonst zeigt die App den Anmeldebildschirm).

function showSection() {
  const role = session.role;
  $("up-checking").hidden = Boolean(role);
  $("up-main").hidden = !role;
  if (role) $("up-signed-in").textContent = `Angemeldet ${ROLE_NAMES[role]}`;
}

// ---------------- Hochladen ----------------

function onFilesChanged() {
  const files = [...$("up-files").files];
  const size = files.reduce((sum, f) => sum + f.size, 0);
  $("up-dropzone").classList.toggle("has-files", files.length > 0);
  $("up-drop-title").textContent = files.length
    ? `${files.length} ${files.length === 1 ? "Video" : "Videos"} ausgewählt`
    : "Videos auswählen";
  $("up-drop-sub").textContent = files.length ? `${formatBytes(size)} · tippen zum Ändern` : "Mehrere auf einmal gehen";
}

// Bildschirm anlassen, solange hochgeladen wird (sonst bricht das iPhone ab)
async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch { /* nicht verfügbar */ }
}

function setBusy(on) {
  busy = on;
  $("up-submit").disabled = on;
  // Punkt am Reiter „Hochladen“, solange etwas läuft – auch aus anderen Bereichen sichtbar
  document.querySelector('.bottom-nav [data-tab="upload"]')?.classList.toggle("busy", on);
}

function putFile(upload, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(upload.method, upload.url);
    for (const [name, value] of Object.entries(upload.headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`Speicher antwortet mit ${xhr.status}`));
    xhr.onerror = () => reject(new Error("Verbindung abgebrochen"));
    xhr.send(file);
  });
}

/** Manche Kameras schreiben Unsinn (1904, 1970, Zukunft) – das wäre schlimmer als nichts. */
function plausible(date) {
  return Boolean(date) && date.getFullYear() >= 2000 && date.getTime() < Date.now() + 24 * 3600 * 1000;
}

/**
 * Aufnahmezeit: aus den Metadaten; sonst das Dateidatum (auf Android meist die
 * Aufnahmezeit, bei manchen Wegen aber der Zeitpunkt des Kopierens).
 */
async function recordingInfo(file) {
  const meta = await readVideoMeta(blobReader(file), file.size);
  if (plausible(meta.createdAt)) return { recorded_at: meta.createdAt.toISOString(), recorded_source: "meta", duration_s: meta.duration };
  const fromFile = file.lastModified ? new Date(file.lastModified) : null;
  return plausible(fromFile)
    ? { recorded_at: fromFile.toISOString(), recorded_source: "file", duration_s: meta.duration }
    : { recorded_at: null, recorded_source: null, duration_s: meta.duration };
}

async function uploadThumb(id, thumb) {
  const { blob } = await thumb;
  if (!blob) return;
  await fetch(`/api/videos/${id}/thumb`, {
    method: "PUT",
    credentials: "same-origin",
    headers: { "content-type": "image/jpeg" },
    body: blob,
  }).catch(() => {}); // ohne Bild geht es auch
}

async function uploadOne(file, meta) {
  const fill = el("span");
  const state = el("span", { class: "state" }, "wartet …");
  const when = el("span", { class: "when" });
  $("up-list").append(
    el("li", { class: "card upload-item" },
      el("span", { class: "name" }, `${file.name} · ${formatBytes(file.size)}`),
      when,
      el("div", { class: "bar" }, fill),
      state,
    ),
  );
  const progress = (p) => { fill.style.width = `${Math.round(p * 100)}%`; };

  try {
    state.textContent = "startet …";
    // Vorschaubild parallel zum Hochladen erzeugen (aus der lokalen Datei)
    const thumb = makeThumbnail(file);
    const info = await recordingInfo(file);
    if (info.duration_s == null) info.duration_s = (await thumb).duration;
    when.textContent = info.recorded_at
      ? `aufgenommen ${formatDateTime(info.recorded_at)}${info.recorded_source === "file" ? " (Dateidatum)" : ""}`
      : "Aufnahmezeit unbekannt";
    const { id, upload } = await api("/api/videos", {
      method: "POST",
      body: {
        ...meta,
        ...info,
        filename: file.name,
        size: file.size,
        content_type: file.type,
      },
    });

    await putFile(upload, file, (p) => {
      progress(p);
      state.textContent = `${Math.round(p * 100)} %`;
    });

    state.textContent = "wird geprüft …";
    await api(`/api/videos/${id}/complete`, { method: "POST" });
    await uploadThumb(id, thumb);
    progress(1);
    state.textContent = "fertig ✓";
    state.className = "state ok";
    return true;
  } catch (err) {
    state.textContent = err instanceof ApiError && err.status === 401
      ? "Fehler: Anmeldung abgelaufen – bitte neu anmelden"
      : `Fehler: ${err.message}`;
    state.className = "state error";
    return false;
  }
}

async function onSubmit(event) {
  event.preventDefault();
  if (busy) return;

  const files = [...$("up-files").files];
  const name = $("up-name").value.trim();
  const message = $("up-message");
  message.textContent = "";
  message.className = "message";
  session.setName(name);

  const meta = { uploaded_by: name };

  setBusy(true);
  await keepAwake();

  let ok = 0;
  // Nacheinander: schont die Verbindung in der Halle und hält die Reihenfolge.
  for (const file of files) {
    if (await uploadOne(file, meta)) ok++;
  }

  setBusy(false);
  await wakeLock?.release().catch(() => {});
  wakeLock = null;

  const all = ok === files.length;
  message.textContent = all
    ? `${ok} ${ok === 1 ? "Video" : "Videos"} hochgeladen.`
    : `${ok} von ${files.length} hochgeladen – die fehlgeschlagenen bitte noch einmal auswählen.`;
  message.className = all ? "message ok" : "message error";
  if (all) {
    $("up-files").value = "";
    onFilesChanged();
  }
}

export const uploadView = {
  mount() {
    $("up-files").addEventListener("change", onFilesChanged);
    $("up-form").addEventListener("submit", onSubmit);
    $("up-name").value = session.getName();

    window.addEventListener("beforeunload", (event) => {
      if (busy) event.preventDefault();
    });
    document.addEventListener("visibilitychange", () => {
      if (busy && document.visibilityState === "visible") keepAwake();
    });
    window.addEventListener("sessionchange", showSection);
    session.restore().then(showSection);
  },
  show() {
    if (!$("up-name").value) $("up-name").value = session.getName();
  },
  hide() {},
};
