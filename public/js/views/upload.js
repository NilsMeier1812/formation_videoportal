// Hochladen: angemeldet (Gruppen- oder Trainer-Code) direkt nach R2.
// Ein laufender Upload geht weiter, während man in andere Bereiche wechselt. Im
// Hintergrund (andere App) pausiert er und läuft beim Zurückkommen von selbst weiter;
// hängt etwas, gibt es „Erneut versuchen“ – mit derselben Datei, ohne neu auszuwählen.
// Große Videos gehen in Teilen (lib/multipart-upload.js): Abbrüche kosten nur einen
// Teil, und nach erneuter Auswahl derselben Datei geht es an der Stelle weiter.
// Mehr als die Datei braucht es nicht: Aufnahmezeit und Länge kommen aus den
// Metadaten des Videos, ein Vorschaubild erzeugt der Browser; zugeordnet wird
// von den Trainern (Reiter „Zuordnen“).
import { api, ApiError, el, formatBytes, formatDateTime } from "../api.js";
import { blobReader, readVideoMeta } from "../lib/mp4meta.js";
import {
  dropResume, dropResumeKey, fingerprint, loadResume, pendingResumes, saveResume,
  sendBlob, uploadControl, uploadInParts, withRetries,
} from "../lib/multipart-upload.js";
import { makeThumbnail } from "../lib/thumbnail.js";
import { session } from "../session.js";

const $ = (id) => document.getElementById(id);
const ROLE_NAMES = { group: "mit Gruppen-Code", tagger: "als Trainer" };

let active = 0; // laufende Uploads (auch einzeln wiederholte)
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
  renderResumes();
}

// Bildschirm anlassen, solange hochgeladen wird (sonst bricht das iPhone ab)
async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch { /* nicht verfügbar */ }
}

/** Zählt laufende Uploads; beim ersten an, beim letzten aus (Knopf, Punkt am Reiter, Hinweis, Bildschirm). */
async function setBusy(on) {
  active = Math.max(0, active + (on ? 1 : -1));
  const busy = active > 0;
  $("up-submit").disabled = busy;
  $("up-stay").hidden = !busy;
  // Punkt am Reiter „Hochladen“, solange etwas läuft – auch aus anderen Bereichen sichtbar
  document.querySelector('.bottom-nav [data-tab="upload"]')?.classList.toggle("busy", busy);
  if (on && active === 1) await keepAwake();
  if (!busy) {
    await wakeLock?.release().catch(() => {});
    wakeLock = null;
    renderResumes();
  }
}

/** Unterbrochene Uploads aus einem früheren Besuch: dieselbe Datei nochmal wählen. */
function renderResumes() {
  const box = $("up-resume");
  const chosen = new Set([...$("up-files").files].map(fingerprint));
  const list = active ? [] : pendingResumes().filter((r) => !chosen.has(r.key));
  box.hidden = !list.length;
  if (!list.length) return;
  box.replaceChildren(
    el("div", { class: "section-title first" }, "Nicht fertig hochgeladen"),
    el("p", { class: "muted small" }, "Dieselbe Datei oben noch einmal auswählen und „Hochladen“ tippen – es geht an der Stelle weiter."),
    ...list.map((r) => el("div", { class: "resume-row" },
      el("span", { class: "resume-name" }, r.name),
      el("span", { class: "muted small" }, `${Math.round(r.share * 100)} %`),
      el("button", {
        type: "button", class: "link", title: "Nicht mehr fortsetzen",
        onclick: () => { dropResumeKey(r.key); renderResumes(); },
      }, "verwerfen"),
    )),
  );
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

const STUCK_MS = 15000; // so lange ohne Fortschritt → Knopf „Erneut versuchen“ zeigen

/** Eine Zeile in der Liste; `run()` lädt die Datei hoch (auch erneut, mit derselben Datei). */
function uploadRow(file, meta) {
  const fill = el("span");
  const state = el("span", { class: "state" }, "wartet …");
  const when = el("span", { class: "when" });
  const retry = el("button", { type: "button", class: "small-btn retry", hidden: true }, "Erneut versuchen");
  $("up-list").append(
    el("li", { class: "card upload-item" },
      el("span", { class: "name" }, `${file.name} · ${formatBytes(file.size)}`),
      when,
      el("div", { class: "bar" }, fill),
      el("div", { class: "upload-foot" }, state, retry),
    ),
  );

  let info = null;
  let thumb = null;
  let control = null;
  let lastMove = Date.now();
  let running = false;

  const setState = (text, cls = "") => { state.textContent = text; state.className = `state ${cls}`.trim(); };
  const progress = (p) => { fill.style.width = `${Math.round(p * 100)}%`; };
  const onProgress = (p) => {
    lastMove = Date.now();
    retry.hidden = true;
    progress(p);
    setState(`${Math.round(p * 100)} %`);
  };
  const onRetry = () => {
    retry.hidden = false;
    setState(document.visibilityState === "visible"
      ? "Verbindung weg – versuche es gleich wieder …"
      : "pausiert – geht weiter, sobald die App wieder offen ist");
  };
  // Hängt es sichtbar (kein Fortschritt), darf man selbst anstoßen
  const watch = setInterval(() => {
    if (running && document.visibilityState === "visible" && Date.now() - lastMove > STUCK_MS) retry.hidden = false;
  }, 3000);
  document.addEventListener("visibilitychange", () => {
    if (running && document.visibilityState === "visible") { lastMove = Date.now(); setState("geht weiter …"); }
  });

  retry.addEventListener("click", () => {
    retry.hidden = true;
    lastMove = Date.now();
    if (running) { setState("neu gestartet …"); control.kick(); } else run();
  });

  const create = () => api("/api/videos", {
    method: "POST",
    body: { ...meta, ...info, filename: file.name, size: file.size, content_type: file.type },
  });
  const startParts = (created) => {
    const entry = { id: created.id, partSize: created.upload.part_size, total: created.upload.parts, parts: {} };
    saveResume(file, entry);
    return entry;
  };

  async function upload() {
    setState("startet …");
    // Vorschaubild parallel zum Hochladen erzeugen (aus der lokalen Datei)
    thumb ??= makeThumbnail(file);
    if (!info) {
      info = await recordingInfo(file);
      if (info.duration_s == null) info.duration_s = (await thumb).duration;
    }
    when.textContent = info.recorded_at
      ? `aufgenommen ${formatDateTime(info.recorded_at)}${info.recorded_source === "file" ? " (Dateidatum)" : ""}`
      : "Aufnahmezeit unbekannt";

    let resume = loadResume(file);
    let id;
    let parts = null;
    if (resume) {
      setState("setzt fort …");
      id = resume.id;
    } else {
      const created = await create();
      id = created.id;
      if (created.upload.multipart) {
        resume = startParts(created);
      } else {
        // kleine Datei am Stück; die Adresse gilt 15 Minuten, danach von vorn
        await withRetries(() => sendBlob({
          method: created.upload.method, url: created.upload.url, headers: created.upload.headers,
          body: file, control, onProgress: (loaded) => onProgress(loaded / file.size),
        }), { control, onRetry, retries: 4 });
      }
    }

    if (resume) {
      const partsOf = (entry) => uploadInParts({
        id: entry.id, file, partSize: entry.partSize, total: entry.total, parts: entry.parts,
        onProgress, onRetry, control,
        onSaved: (p) => saveResume(file, { ...entry, parts: p }),
      });
      try {
        parts = await partsOf(resume);
      } catch (err) {
        // Der Server kennt den Upload nicht mehr (nach 24 h aufgeräumt) → einmal von vorn
        if (!(err instanceof ApiError && err.status === 404)) throw err;
        dropResume(file);
        const created = await create();
        id = created.id;
        parts = await partsOf(startParts(created));
      }
    }

    setState("wird geprüft …");
    await withRetries(async () => {
      try {
        await api(`/api/videos/${id}/complete`, { method: "POST", body: parts ? { parts } : undefined });
      } catch (err) {
        if (err.status) throw err; // echte Antwort des Servers
        throw Object.assign(err, { retry: true }); // Netz weg → nochmal melden
      }
    }, { control, onRetry, retries: 4 });
    dropResume(file);
    await uploadThumb(id, thumb);
  }

  async function run() {
    running = true;
    control = uploadControl();
    lastMove = Date.now();
    await setBusy(true);
    try {
      await upload();
      progress(1);
      setState("fertig ✓", "ok");
      clearInterval(watch);
      return true;
    } catch (err) {
      const resumable = Boolean(loadResume(file));
      setState(err instanceof ApiError && err.status === 401
        ? "Fehler: Anmeldung abgelaufen – bitte neu anmelden"
        : `Fehler: ${err.message}${resumable ? " – „Erneut versuchen“ macht an der Stelle weiter" : ""}`, "error");
      retry.hidden = false;
      return false;
    } finally {
      running = false;
      await setBusy(false);
    }
  }

  return run;
}

async function onSubmit(event) {
  event.preventDefault();
  if (active) return;

  const files = [...$("up-files").files];
  const name = $("up-name").value.trim();
  const message = $("up-message");
  message.textContent = "";
  message.className = "message";
  session.setName(name);

  const meta = { uploaded_by: name };
  const rows = files.map((file) => uploadRow(file, meta));

  await setBusy(true); // über die ganze Reihe hinweg
  let ok = 0;
  // Nacheinander: schont die Verbindung in der Halle und hält die Reihenfolge.
  for (const run of rows) {
    if (await run()) ok++;
  }
  await setBusy(false);

  const all = ok === files.length;
  message.textContent = all
    ? `${ok} ${ok === 1 ? "Video" : "Videos"} hochgeladen.`
    : `${ok} von ${files.length} hochgeladen – bei den anderen „Erneut versuchen“ tippen.`;
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
      if (active) event.preventDefault();
    });
    document.addEventListener("visibilitychange", () => {
      if (active && document.visibilityState === "visible") keepAwake();
    });
    window.addEventListener("sessionchange", showSection);
    session.restore().then(showSection);
  },
  show() {
    if (!$("up-name").value) $("up-name").value = session.getName();
    renderResumes();
  },
  hide() {},
};
