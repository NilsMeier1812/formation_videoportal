// Admin: Choreos (mit Tänzen, Audios und Hauptaudio) und Tags verwalten.
// Jede Änderung geht sofort an den Server; danach wird neu geladen (reload).
// Audios anlegen, duplizieren und löschen erledigt der Planer (Dialoge, Upload der
// Musik) – hier werden nur die Ereignisse dafür ausgelöst.
import { api, el, icon } from "../api.js";
import { library } from "../library.js";
import { router } from "../router.js";

const TRASH = '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/>';
const GEAR = '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>';
const CROSS = '<path d="M18 6 6 18M6 6l12 12"/>';
const COPY = '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>';
const UPLOAD = '<path d="M12 15V4"/><path d="m7 9 5-5 5 5"/><path d="M5 20h14"/>';
const STAR = '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>';

function toast(message) {
  window.dispatchEvent(new CustomEvent("toast", { detail: message }));
}

/** Server-Aufruf; bei Erfolg neu laden, bei Fehler Hinweis. */
async function change(reload, path, method, body) {
  try {
    await api(path, { method, body });
  } catch (err) {
    toast(err.message);
  }
  await reload();
}

/** Textfeld, das beim Verlassen (oder Enter) speichert, wenn sich etwas geändert hat. */
function nameInput(value, onSave, attrs = {}) {
  const input = el("input", { type: "text", maxlength: 80, ...attrs });
  input.value = value;
  const commit = () => {
    const next = input.value.trim();
    if (next && next !== value) onSave(next);
    else input.value = value;
  };
  input.addEventListener("change", commit);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });
  return input;
}

function deleteButton(label, onClick, paths = TRASH) {
  return el("button", { type: "button", class: "icon-btn danger", "aria-label": label, title: label, onclick: onClick }, icon(paths, 18));
}

/** Kleines Formular „Name + Hinzufügen“. */
function addForm(placeholder, button, onAdd) {
  const input = el("input", { type: "text", maxlength: 80, placeholder });
  const form = el("form", { class: "add-row" }, input, el("button", { type: "submit" }, button));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = input.value.trim();
    if (name) onAdd(name);
  });
  return form;
}

/** „Tänze & Takt“: öffnet den Planer mit den Einstellungen dieser Audio (Takt braucht die Welle). */
function settingsButton(audio) {
  return el("button", {
    type: "button", class: "small-btn",
    onclick: () => {
      window.dispatchEvent(new CustomEvent("open-project-settings", { detail: { projectId: audio.id } }));
      router.navigate("/");
    },
  }, icon(GEAR, 16), "Tänze & Takt");
}

const fire = (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail }));

/** Duplizieren und Löschen einer Audio (Löschen fragt den Trainer-Code ab). */
function audioTools(audio) {
  return [
    el("button", { type: "button", class: "icon-btn", "aria-label": "Duplizieren", title: "Duplizieren",
      onclick: () => fire("duplicate-audio", { projectId: audio.id }) }, icon(COPY, 18)),
    deleteButton("Audio löschen", () => fire("delete-audio", { projectId: audio.id })),
  ];
}

function newAudioButton(choreoId) {
  return el("button", { type: "button", class: "small-btn", onclick: () => fire("new-audio", { choreoId }) },
    icon(UPLOAD, 16), "Neue Audio hochladen");
}

function audioRow(choreo, audio, reload) {
  const isMain = choreo.main_project_id === audio.id;
  const danceNames = audio.dance_ids.map((id) => library.dance(id)?.name).filter(Boolean);
  return el("div", { class: "lib-audio" },
    el("div", { class: "lib-audio-head" },
      el("span", { class: "lib-audio-title" }, audio.title + (audio.is_private ? " (privat)" : "")),
      ...audioTools(audio),
      deleteButton("Aus der Choreo nehmen", () => change(reload, `/api/audios/${audio.id}`, "PUT", { choreo_id: null }), CROSS),
    ),
    el("div", { class: "lib-audio-foot" },
      el("button", {
        type: "button", class: `main-toggle${isMain ? " on" : ""}`, "aria-pressed": String(isMain),
        title: isMain ? "Hauptaudio" : "Zur Hauptaudio machen",
        onclick: () => !isMain && change(reload, `/api/choreos/${choreo.id}`, "PATCH", { main_project_id: audio.id }),
      }, icon(STAR, 16), isMain ? "Hauptaudio" : "Als Hauptaudio"),
      settingsButton(audio),
    ),
    el("span", { class: "muted small lib-audio-dances" }, danceNames.length
      ? `Tänze: ${danceNames.join(" → ")}`
      : "Noch keine Tänze an den Abschnitten"),
  );
}

function choreoCard(choreo, reload) {
  const audios = library.audiosOf(choreo.id)
    .sort((a, b) => (b.id === choreo.main_project_id) - (a.id === choreo.main_project_id));
  const free = library.data.audios.filter((a) => !a.choreo_id);
  const addAudio = el("select", { "aria-label": "Audio hinzufügen" },
    el("option", { value: "" }, free.length ? "+ Audio hinzufügen …" : "Keine freien Audios"),
    ...free.map((a) => el("option", { value: a.id }, a.title)),
  );
  addAudio.disabled = !free.length;
  addAudio.addEventListener("change", () => {
    if (addAudio.value) change(reload, `/api/audios/${addAudio.value}`, "PUT", { choreo_id: choreo.id });
  });

  return el("div", { class: "card lib-choreo" },
    el("div", { class: "lib-head" },
      nameInput(choreo.title, (title) => change(reload, `/api/choreos/${choreo.id}`, "PATCH", { title }), { class: "lib-title", "aria-label": "Titel" }),
      deleteButton("Choreo löschen", () => {
        if (confirm(`Choreo „${choreo.title}“ löschen? Audios und Videos bleiben erhalten, nur ohne Choreo.`)) {
          change(reload, `/api/choreos/${choreo.id}`, "DELETE");
        }
      }),
    ),
    el("div", { class: "section-title" }, "Tänze"),
    ...choreo.dances.map((d) => el("div", { class: "lib-row" },
      nameInput(d.name, (name) => change(reload, `/api/dances/${d.id}`, "PATCH", { name }), { "aria-label": "Tanz" }),
      deleteButton("Tanz löschen", () => {
        if (confirm(`Tanz „${d.name}“ löschen? Er verschwindet auch an Audios und Videos.`)) change(reload, `/api/dances/${d.id}`, "DELETE");
      }),
    )),
    addForm("Neuer Tanz, z. B. Latein", "Hinzufügen", (name) => change(reload, `/api/choreos/${choreo.id}/dances`, "POST", { name })),
    el("div", { class: "section-title" }, "Audios"),
    audios.length ? null : el("p", { class: "muted small" }, "Noch keine Audio. Die Hauptaudio ist die, in der man die Videos findet."),
    audios.length ? el("p", { class: "muted small" }, "Wo welcher Tanz in der Musik liegt (und BPM/Taktart), stellst du unter „Tänze & Takt“ ein.") : null,
    ...audios.map((a) => audioRow(choreo, a, reload)),
    el("div", { class: "lib-add-audio" }, addAudio, newAudioButton(choreo.id)),
  );
}

export function renderChoreos(container, reload) {
  const { choreos, audios } = library.data;
  const free = audios.filter((a) => !a.choreo_id);
  container.replaceChildren(...[
    ...choreos.map((c) => choreoCard(c, reload)),
    el("div", { class: "card" },
      el("div", { class: "section-title first" }, "Neue Choreo"),
      addForm("z. B. Kür 2026", "Anlegen", (title) => change(reload, "/api/choreos", "POST", { title })),
    ),
    el("div", { class: "card lib-free-card" },
      el("div", { class: "section-title first" }, free.length ? `Audios ohne Choreo (${free.length})` : "Audios ohne Choreo"),
      free.length ? null : el("p", { class: "muted small" }, "Keine."),
      ...free.map((a) => {
        const select = el("select", { "aria-label": `Choreo für ${a.title}` },
          el("option", { value: "" }, "Choreo wählen …"),
          ...choreos.map((c) => el("option", { value: c.id }, c.title)),
        );
        select.addEventListener("change", () => {
          const choreo = library.choreo(select.value);
          if (choreo) change(reload, `/api/audios/${a.id}`, "PUT", { choreo_id: choreo.id });
        });
        return el("div", { class: "lib-free" },
          el("span", {}, a.title + (a.is_private ? " (privat)" : "")),
          el("div", { class: "lib-free-tools" }, settingsButton(a), ...audioTools(a), select));
      }),
      newAudioButton(null),
    ),
  ].filter(Boolean));
}

function tagsCard(reload) {
  return el("div", { class: "card" },
    el("div", { class: "section-title first" }, "Tags"),
    el("p", { class: "muted small" }, "Tags beschreiben die Art des Videos. Ein Video kann mehrere haben."),
    ...library.data.tags.map((t) => el("div", { class: "lib-row" },
      nameInput(t.name, (name) => change(reload, `/api/tags/${t.id}`, "PATCH", { name }), { maxlength: 40, "aria-label": "Tag" }),
      deleteButton("Tag löschen", () => {
        if (confirm(`Tag „${t.name}“ löschen? Er verschwindet auch an den Videos.`)) change(reload, `/api/tags/${t.id}`, "DELETE");
      }),
    )),
    addForm("Neuer Tag", "Hinzufügen", (name) => change(reload, "/api/tags", "POST", { name })),
  );
}

const GB = 1e9;
const gb = (bytes) => `${(bytes / GB).toFixed(bytes < 10 * GB ? 1 : 0).replace(".", ",")} GB`;

function storageCard(info) {
  const share = Math.min(1, info.used / info.quota);
  return el("div", { class: "card" },
    el("div", { class: "section-title first" }, "Speicher"),
    el("div", { class: "meter", role: "meter", "aria-valuemin": 0, "aria-valuemax": info.quota, "aria-valuenow": info.used },
      el("span", { style: `width:${(share * 100).toFixed(1)}%`, class: share > 0.9 ? "full" : "" })),
    el("p", { class: "muted small" },
      `${gb(info.used)} von ${gb(info.quota)} belegt · ${info.videos} ${info.videos === 1 ? "Video" : "Videos"}` +
      (info.trashed ? ` · Papierkorb ${info.trashed} (${gb(info.trash_bytes)})` : "") +
      ` · einzelne Datei höchstens ${gb(info.max_file)}`),
    info.failed ? el("p", { class: "error small" }, `${info.failed} ${info.failed === 1 ? "Video" : "Videos"}: Umwandlung fehlgeschlagen (im Video „Neu umwandeln“)`) : null,
    el("p", { class: "muted small" }, "Nach der Umwandlung (1080p) bleiben die Originale noch 7 Tage, dann werden sie gelöscht."),
  );
}

function trashCard(trash, reload) {
  const daysLeft = (v) => Math.max(0, trash.days - Math.floor((Date.now() - Date.parse(v.deleted_at)) / 86400000));
  return el("div", { class: "card" },
    el("div", { class: "section-title first" }, `Papierkorb (${trash.videos.length})`),
    trash.videos.length
      ? el("p", { class: "muted small" }, `Gelöschte Videos bleiben ${trash.days} Tage hier und lassen sich zurückholen; danach werden sie endgültig gelöscht.`)
      : el("p", { class: "muted small" }, "Leer."),
    ...trash.videos.map((v) => el("div", { class: "trash-row" },
      el("span", { class: "trash-thumb" }, v.thumb_url ? el("img", { src: v.thumb_url, alt: "", loading: "lazy" }) : null),
      el("span", { class: "trash-main" },
        el("span", { class: "trash-title" }, library.videoTitle(v)),
        el("span", { class: "muted small" }, `noch ${daysLeft(v)} Tage`)),
      el("button", {
        type: "button", class: "small-btn",
        onclick: () => change(reload, `/api/videos/${v.id}/restore`, "POST").then(() => {
          window.dispatchEvent(new Event("videos-changed"));
        }),
      }, "Zurückholen"),
    )),
  );
}

/** Reiter „Mehr“: Speicher, Papierkorb, Tags. */
export async function renderMore(container, reload) {
  let info = null;
  let trash = { days: 30, videos: [] };
  try {
    [info, trash] = await Promise.all([api("/api/storage"), api("/api/videos/trash")]);
  } catch (err) {
    toast(err.message);
  }
  container.replaceChildren(...[info && storageCard(info), trashCard(trash, reload), tagsCard(reload)].filter(Boolean));
}
