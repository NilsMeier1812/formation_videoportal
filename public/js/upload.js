import { api, ApiError, el, formatBytes, getCode, getName, setCode, setName } from "./api.js";

const $ = (id) => document.getElementById(id);
const form = $("form");
const message = $("message");
const uploadsList = $("uploads");

$("code").value = getCode();
$("name").value = getName();
$("date").value = new Date().toLocaleDateString("sv-SE"); // JJJJ-MM-TT in lokaler Zeit

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
  const bar = el("progress", { max: 1, value: 0 });
  const state = el("span", { class: "muted" }, "wartet …");
  uploadsList.append(
    el("li", { class: "card" },
      el("span", { class: "name" }, `${file.name} · ${formatBytes(file.size)}`),
      bar,
      state,
    ),
  );

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
      bar.value = p;
      state.textContent = `${Math.round(p * 100)} %`;
    });

    state.textContent = "wird geprüft …";
    await api(`/api/videos/${id}/complete`, { method: "POST" });
    bar.value = 1;
    state.textContent = "fertig ✓";
    state.className = "ok";
    return true;
  } catch (err) {
    state.textContent = `Fehler: ${err.message}`;
    state.className = "error";
    return false;
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;

  const code = $("code").value.trim();
  const name = $("name").value.trim();
  const files = [...$("files").files];
  message.textContent = "";
  message.className = "";

  try {
    await api("/api/auth", { code });
  } catch (err) {
    message.textContent = err instanceof ApiError && err.status === 401
      ? "Der Gruppen-Code stimmt nicht."
      : `Server nicht erreichbar: ${err.message}`;
    message.className = "error";
    return;
  }
  setCode(code);
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

  message.textContent = ok === files.length
    ? `${ok} ${ok === 1 ? "Video" : "Videos"} hochgeladen.`
    : `${ok} von ${files.length} hochgeladen – die fehlgeschlagenen bitte noch einmal auswählen.`;
  message.className = ok === files.length ? "ok" : "error";
  if (ok === files.length) $("files").value = "";
});
