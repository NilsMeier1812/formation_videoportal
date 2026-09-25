// Hochladen: angemeldet (Gruppen- oder Trainer-Code) direkt nach R2.
// Ein laufender Upload geht weiter, während man in andere Bereiche wechselt.
import { api, ApiError, el, formatBytes } from "../api.js";
import { session } from "../session.js";

const $ = (id) => document.getElementById(id);
const ROLE_NAMES = { group: "mit Gruppen-Code", tagger: "als Trainer" };

let busy = false;
let wakeLock = null;

// ---------------- Anmeldung ----------------

function showSection() {
  const role = session.canUpload ? session.role : null;
  $("up-checking").hidden = true;
  $("up-login").hidden = Boolean(role);
  $("up-main").hidden = !role;
  if (role) $("up-signed-in").textContent = `Angemeldet ${ROLE_NAMES[role]}`;
}

async function onLogin(event) {
  event.preventDefault();
  const message = $("up-login-message");
  message.textContent = "";
  try {
    await session.login($("up-code").value.trim()); // → sessionchange → showSection
    $("up-code").value = "";
  } catch (err) {
    message.textContent = err.message;
    message.className = "message error";
  }
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

function titleFor(file, index, count) {
  const title = $("up-title").value.trim();
  if (!title) return file.name.replace(/\.[^.]+$/, "");
  return count > 1 ? `${title} (${index + 1}/${count})` : title;
}

async function uploadOne(file, index, count, meta) {
  const fill = el("span");
  const state = el("span", { class: "state" }, "wartet …");
  $("up-list").append(
    el("li", { class: "card upload-item" },
      el("span", { class: "name" }, `${file.name} · ${formatBytes(file.size)}`),
      el("div", { class: "bar" }, fill),
      state,
    ),
  );
  const progress = (p) => { fill.style.width = `${Math.round(p * 100)}%`; };

  try {
    state.textContent = "startet …";
    const { id, upload } = await api("/api/videos", {
      method: "POST",
      body: {
        ...meta,
        filename: file.name,
        size: file.size,
        content_type: file.type,
        title: titleFor(file, index, count),
      },
    });

    await putFile(upload, file, (p) => {
      progress(p);
      state.textContent = `${Math.round(p * 100)} %`;
    });

    state.textContent = "wird geprüft …";
    await api(`/api/videos/${id}/complete`, { method: "POST" });
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

  const meta = {
    uploaded_by: name,
    recorded_at: $("up-date").value,
    camera: $("up-camera").value.trim(),
    no_choreo: $("up-no-choreo").checked,
  };

  setBusy(true);
  await keepAwake();

  let ok = 0;
  // Nacheinander: schont die Verbindung in der Halle und hält die Reihenfolge.
  for (const [i, file] of files.entries()) {
    if (await uploadOne(file, i, files.length, meta)) ok++;
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
    $("up-login-form").addEventListener("submit", onLogin);
    $("up-files").addEventListener("change", onFilesChanged);
    $("up-form").addEventListener("submit", onSubmit);
    $("up-name").value = session.getName();
    $("up-date").value = new Date().toLocaleDateString("sv-SE"); // JJJJ-MM-TT in lokaler Zeit

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
