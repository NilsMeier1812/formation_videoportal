// Admin: Choreos (mit Tänzen, Audios und Hauptaudio) und Tags verwalten.
// Jede Änderung geht sofort an den Server; danach wird neu geladen (reload).
import { api, el, icon } from "../api.js";
import { library } from "../library.js";
import { router } from "../router.js";

const TRASH = '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/>';
const GEAR = '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>';
const CROSS = '<path d="M18 6 6 18M6 6l12 12"/>';
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

/** „Projekt & Takt“: öffnet den Planer mit den Einstellungen dieser Audio (Takt braucht die Welle). */
function settingsButton(audio) {
  return el("button", {
    type: "button", class: "small-btn",
    onclick: () => {
      window.dispatchEvent(new CustomEvent("open-project-settings", { detail: { projectId: audio.id } }));
      router.navigate("/");
    },
  }, icon(GEAR, 16), "Projekt & Takt");
}

function audioRow(choreo, audio, reload) {
  const isMain = choreo.main_project_id === audio.id;
  const dances = new Set(audio.dance_ids);
  const setDances = (next) => change(reload, `/api/audios/${audio.id}`, "PUT", { choreo_id: choreo.id, dance_ids: [...next] });
  return el("div", { class: "lib-audio" },
    el("div", { class: "lib-audio-head" },
      el("button", {
        type: "button", class: `main-toggle${isMain ? " on" : ""}`, "aria-pressed": String(isMain),
        title: isMain ? "Hauptaudio" : "Zur Hauptaudio machen",
        onclick: () => !isMain && change(reload, `/api/choreos/${choreo.id}`, "PATCH", { main_project_id: audio.id }),
      }, icon(STAR, 16), isMain ? "Hauptaudio" : "Als Hauptaudio"),
      el("span", { class: "lib-audio-title" }, audio.title + (audio.is_private ? " (privat)" : "")),
      deleteButton("Aus der Choreo nehmen", () => change(reload, `/api/audios/${audio.id}`, "PUT", { choreo_id: null }), CROSS),
    ),
    el("div", { class: "lib-audio-foot" },
      choreo.dances.length ? el("div", { class: "chips" }, ...choreo.dances.map((d) => el("button", {
        type: "button", class: "chip-toggle", "aria-pressed": String(dances.has(d.id)),
        onclick: () => { dances.has(d.id) ? dances.delete(d.id) : dances.add(d.id); setDances(dances); },
      }, d.name))) : el("span"),
      settingsButton(audio),
    ),
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
    if (addAudio.value) change(reload, `/api/audios/${addAudio.value}`, "PUT", { choreo_id: choreo.id, dance_ids: choreo.dances.map((d) => d.id) });
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
    ...audios.map((a) => audioRow(choreo, a, reload)),
    addAudio,
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
    free.length ? el("div", { class: "card" },
      el("div", { class: "section-title first" }, `Audios ohne Choreo (${free.length})`),
      ...free.map((a) => {
        const select = el("select", { "aria-label": `Choreo für ${a.title}` },
          el("option", { value: "" }, "Choreo wählen …"),
          ...choreos.map((c) => el("option", { value: c.id }, c.title)),
        );
        select.addEventListener("change", () => {
          const choreo = library.choreo(select.value);
          if (choreo) change(reload, `/api/audios/${a.id}`, "PUT", { choreo_id: choreo.id, dance_ids: choreo.dances.map((d) => d.id) });
        });
        return el("div", { class: "lib-free" }, el("span", {}, a.title + (a.is_private ? " (privat)" : "")), settingsButton(a), select);
      }),
    ) : null,
  ].filter(Boolean));
}

export function renderTags(container, reload) {
  container.replaceChildren(el("div", { class: "card" },
    el("p", { class: "muted small first" }, "Tags beschreiben die Art des Videos. Ein Video kann mehrere haben."),
    ...library.data.tags.map((t) => el("div", { class: "lib-row" },
      nameInput(t.name, (name) => change(reload, `/api/tags/${t.id}`, "PATCH", { name }), { maxlength: 40, "aria-label": "Tag" }),
      deleteButton("Tag löschen", () => {
        if (confirm(`Tag „${t.name}“ löschen? Er verschwindet auch an den Videos.`)) change(reload, `/api/tags/${t.id}`, "DELETE");
      }),
    )),
    addForm("Neuer Tag", "Hinzufügen", (name) => change(reload, "/api/tags", "POST", { name })),
  ));
}
