// Hochladen: erst einmal anmelden (Cookie), dann Videos direkt nach R2.
import { api, ApiError, currentRole, el, formatBytes, getName, login, logout, setName } from "./api.js";
import { registerServiceWorker } from "./pwa.js";
import { mountThemeButton } from "./theme-button.js";

mountThemeButton(document.getElementById("theme"));
registerServiceWorker();

const $ = (id) => document.getElementById(id);
const ROLE_NAMES = { group: "Gruppen-Code", tagger: "Trainer-Code" };

// ---------------- Anmeldung ----------------

function showSection(role) {
  $("checking").hidden = true;
  $("login").hidden = Boolean(role);
  $("upload").hidden = !role;
  if (role) $("signed-in-as").textContent = `Angemeldet mit ${ROLE_NAMES[role]}`;
}

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = $("login-message");
  message.textContent = "";
  try {
    showSection(await login($("code").value.trim()));
    $("code").value = "";
  } catch (err) {
    message.textContent = err instanceof ApiError && err.status === 401
      ? "Der Code stimmt nicht."
      : `Server nicht erreichbar: ${err.message}`;
    message.className = "message error";
  }
});

$("logout").addEventListener("click", async () => {
  await logout().catch(() => {});
  showSection(null);
});

try {
  showSection(await currentRole());
} catch {
  showSection(null);
}

// ---------------- Formular ----------------

$("name").value = getName();
$("date").value = new Date().toLocaleDateString("sv-SE"); // JJJJ-MM-TT in lokaler Zeit

$("files").addEventListener("change", () => {
  const files = [...$("files").files];
  const size = files.reduce((sum, f) => sum + f.size, 0);
  $("dropzone").classList.toggle("has-files", files.length > 0);
  $("drop-title").textContent = files.length
    ? `${files.length} ${files.length === 1 ? "Video" : "Videos"} ausgewählt`
    : "Videos auswählen";
  $("drop-sub").textContent = files.length ? `${formatBytes(size)} · tippen zum Ändern` : "Mehrere auf einmal gehen";
});

let busy = false;
window.addEventListener("beforeunload", (event) => {
  if (busy) event.preventDefault();
});

// Bildschirm anlassen, solange hochgeladen wird (sonst bricht das iPhone ab)
let wakeLock = null;
async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch { /* nicht verfügbar */ }
}
document.addEventListener("visibilitychange", () => {
  if (busy && document.visibilityState === "visible") keepAwake();
});

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
  const title = $("title").value.trim();
  if (!title) return file.name.replace(/\.[^.]+$/, "");
  return count > 1 ? `${title} (${index + 1}/${count})` : title;
}

async function uploadOne(file, index, count, meta) {
  const fill = el("span");
  const state = el("span", { class: "state" }, "wartet …");
  $("uploads").append(
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

$("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;

  const files = [...$("files").files];
  const name = $("name").value.trim();
  const message = $("message");
  message.textContent = "";
  message.className = "message";
  setName(name);

  const meta = {
    uploaded_by: name,
    recorded_at: $("date").value,
    camera: $("camera").value.trim(),
    no_choreo: $("noChoreo").checked,
  };

  busy = true;
  $("submit").disabled = true;
  await keepAwake();

  let ok = 0;
  // Nacheinander: schont die Verbindung in der Halle und hält die Reihenfolge.
  for (const [i, file] of files.entries()) {
    if (await uploadOne(file, i, files.length, meta)) ok++;
  }

  busy = false;
  $("submit").disabled = false;
  await wakeLock?.release().catch(() => {});
  wakeLock = null;

  const all = ok === files.length;
  message.textContent = all
    ? `${ok} ${ok === 1 ? "Video" : "Videos"} hochgeladen.`
    : `${ok} von ${files.length} hochgeladen – die fehlgeschlagenen bitte noch einmal auswählen.`;
  message.className = all ? "message ok" : "message error";
  if (all) {
    $("files").value = "";
    $("files").dispatchEvent(new Event("change"));
  }
});
