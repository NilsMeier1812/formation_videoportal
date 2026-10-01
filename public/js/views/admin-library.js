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

function newAudioButton(choreoId) {
  return el("button", { type: "button", class: "small-btn", onclick: () => fire("new-audio", { choreoId }) },
    icon(UPLOAD, 16), "Neue Audio hochladen");
}

// ---------------- Choreos: Übersicht → Detail ----------------
// Übersicht: je Choreo eine kompakte Zeile (Tänze, Anzahl Audios, Hauptaudio), dazu
// „Audios ohne Choreo“ und eine Suche über alle Audios. Detail: Tänze als Chips, Audios
// als einzeilige Zeilen – ein Tipp klappt die Aktionen einer Audio auf.

const FREE = "ohne"; // Detail „Audios ohne Choreo“
const CHEVRON = '<path d="m9 6 6 6-6 6"/>';
const BACK = '<path d="m15 18-6-6 6-6"/>';
const ui = { open: null, expanded: null, query: "" }; // bleibt beim Neuzeichnen erhalten

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const byTitle = (a, b) => a.title.localeCompare(b.title, "de");

/** Audios einer Choreo: Hauptaudio zuerst, dann nach Titel. */
function sortedAudios(choreo) {
  return library.audiosOf(choreo.id).sort((a, b) =>
    (b.id === choreo.main_project_id) - (a.id === choreo.main_project_id) || byTitle(a, b));
}

function pillsOf(audio) {
  const pills = library.tempoPills(audio);
  return el("span", { class: "lib-pills" },
    ...pills.map((p) => el("span", { class: `pill${p.dance ? " dance" : ""}` }, p.label)),
    audio.is_private ? el("span", { class: "pill private" }, "privat") : null);
}

/** Eine Audio: einzeilig; antippen klappt die Aktionen auf. */
function audioRow(audio, reload, rerender, { showChoreo = false } = {}) {
  const choreo = library.choreo(audio.choreo_id);
  const isMain = choreo?.main_project_id === audio.id;
  const open = ui.expanded === audio.id;
  const head = el("button", {
    type: "button", class: "lib-audio-btn", "aria-expanded": String(open),
    onclick: () => { ui.expanded = open ? null : audio.id; rerender(); },
  },
    el("span", { class: "lib-audio-main" },
      el("span", { class: "lib-audio-name" },
        isMain ? el("span", { class: "lib-star", title: "Hauptaudio" }, icon(STAR, 14)) : null,
        el("span", {}, audio.title)),
      showChoreo ? el("span", { class: "muted small" }, choreo ? choreo.title : "ohne Choreo") : null,
      pillsOf(audio)),
    el("span", { class: "lib-chev" }, icon(CHEVRON, 18)));

  if (!open) return el("div", { class: "lib-audio2" }, head);

  const move = el("select", { "aria-label": "Choreo der Audio" },
    el("option", { value: "" }, "ohne Choreo"),
    ...library.data.choreos.map((c) => el("option", { value: c.id }, c.title)));
  move.value = audio.choreo_id || "";
  move.addEventListener("change", () => change(reload, `/api/audios/${audio.id}`, "PUT", { choreo_id: move.value || null }));

  return el("div", { class: "lib-audio2 open" }, head,
    el("div", { class: "lib-audio-actions" },
      settingsButton(audio),
      choreo && !isMain ? el("button", {
        type: "button", class: "small-btn",
        onclick: () => change(reload, `/api/choreos/${choreo.id}`, "PATCH", { main_project_id: audio.id }),
      }, icon(STAR, 16), "Als Hauptaudio") : null,
      el("button", { type: "button", class: "small-btn", onclick: () => fire("duplicate-audio", { projectId: audio.id }) },
        icon(COPY, 16), "Duplizieren"),
      el("button", { type: "button", class: "small-btn danger", onclick: () => fire("delete-audio", { projectId: audio.id }) },
        icon(TRASH, 16), "Löschen"),
      el("label", { class: "lib-move" }, "Choreo", move)));
}

/** Zeile der Übersicht → öffnet das Detail. */
function navRow({ title, sub, meta, onclick, cls = "" }) {
  return el("button", { type: "button", class: `lib-nav ${cls}`.trim(), onclick },
    el("span", { class: "lib-nav-main" },
      el("span", { class: "lib-nav-title" }, title),
      sub ? el("span", { class: "lib-nav-sub" }, sub) : null),
    meta ? el("span", { class: "lib-nav-meta" }, meta) : null,
    el("span", { class: "lib-chev" }, icon(CHEVRON, 18)));
}

function openDetail(id, rerender) {
  ui.open = id;
  ui.expanded = null;
  rerender();
  window.scrollTo({ top: 0 });
}

function choreoNav(choreo, rerender) {
  const audios = library.audiosOf(choreo.id);
  const main = library.audio(choreo.main_project_id);
  return navRow({
    title: choreo.title,
    sub: [
      choreo.dances.length ? choreo.dances.map((d) => d.name).join(" · ") : "noch keine Tänze",
      main ? `★ ${main.title}` : null,
    ].filter(Boolean).join("  ·  "),
    meta: plural(audios.length, "Audio", "Audios"),
    onclick: () => openDetail(choreo.id, rerender),
  });
}

function overview(reload, rerender) {
  const { choreos, audios } = library.data;
  const free = audios.filter((a) => !a.choreo_id);
  const results = el("div", { class: "lib-list" });
  const search = el("input", { type: "search", class: "lib-search", placeholder: "Audio oder Choreo suchen", "aria-label": "Suchen" });
  search.value = ui.query;

  const fill = () => {
    ui.query = search.value;
    const q = ui.query.trim().toLowerCase();
    if (!q) {
      results.replaceChildren(
        ...choreos.map((c) => choreoNav(c, rerender)),
        navRow({
          title: "Audios ohne Choreo", cls: "lib-nav-free",
          sub: free.length ? free.slice(0, 3).map((a) => a.title).join(" · ") + (free.length > 3 ? " …" : "") : "keine",
          meta: String(free.length), onclick: () => openDetail(FREE, rerender),
        }),
      );
      return;
    }
    const hitChoreos = choreos.filter((c) => c.title.toLowerCase().includes(q) || c.dances.some((d) => d.name.toLowerCase().includes(q)));
    const hitAudios = audios.filter((a) => a.title.toLowerCase().includes(q)).sort(byTitle);
    results.replaceChildren(
      ...hitChoreos.map((c) => choreoNav(c, rerender)),
      ...hitAudios.map((a) => audioRow(a, reload, rerender, { showChoreo: true })),
      hitChoreos.length || hitAudios.length ? null : el("p", { class: "muted small lib-empty" }, "Nichts gefunden."),
    );
  };
  search.addEventListener("input", fill);
  fill();

  return el("div", { class: "lib-page" },
    search,
    el("div", { class: "card lib-card" }, results),
    el("div", { class: "card lib-card lib-new" },
      addForm("Neue Choreo", "Anlegen", (title) => change(reload, "/api/choreos", "POST", { title })),
      newAudioButton(null)),
  );
}

/** Tanz als Chip: Name direkt änderbar, × löscht. */
function danceChip(d, reload) {
  const input = nameInput(d.name, (name) => change(reload, `/api/dances/${d.id}`, "PATCH", { name }), { "aria-label": "Tanz", class: "chip-input" });
  const fit = () => { input.size = Math.max(3, input.value.length + 1); };
  input.addEventListener("input", fit);
  fit();
  return el("span", { class: "dance-chip" }, input,
    el("button", {
      type: "button", class: "chip-x", "aria-label": `Tanz ${d.name} löschen`, title: "Tanz löschen",
      onclick: () => {
        if (confirm(`Tanz „${d.name}“ löschen? Er verschwindet auch an Abschnitten und Videos.`)) change(reload, `/api/dances/${d.id}`, "DELETE");
      },
    }, icon(CROSS, 14)));
}

function addDanceChip(choreo, reload) {
  const input = el("input", { type: "text", maxlength: 80, placeholder: "+ Tanz", class: "chip-input", size: 7, "aria-label": "Neuer Tanz" });
  const form = el("form", { class: "dance-chip add" }, input);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = input.value.trim();
    input.value = ""; // sonst legt das Verlassen des Feldes (beim Neuzeichnen) ihn ein zweites Mal an
    if (name) change(reload, `/api/choreos/${choreo.id}/dances`, "POST", { name });
  });
  input.addEventListener("blur", () => { if (input.value.trim()) form.requestSubmit(); });
  return form;
}

function backBar(rerender) {
  return el("button", {
    type: "button", class: "lib-back",
    onclick: () => { ui.open = null; ui.expanded = null; rerender(); window.scrollTo({ top: 0 }); },
  }, icon(BACK, 18), "Alle Choreos");
}

function choreoDetail(choreo, reload, rerender) {
  const audios = sortedAudios(choreo);
  const free = library.data.audios.filter((a) => !a.choreo_id).sort(byTitle);
  const addExisting = el("select", { "aria-label": "Vorhandene Audio hinzufügen" },
    el("option", { value: "" }, free.length ? "+ Vorhandene Audio …" : "keine freien Audios"),
    ...free.map((a) => el("option", { value: a.id }, a.title)));
  addExisting.disabled = !free.length;
  addExisting.addEventListener("change", () => {
    if (addExisting.value) change(reload, `/api/audios/${addExisting.value}`, "PUT", { choreo_id: choreo.id });
  });

  return el("div", { class: "lib-page" },
    backBar(rerender),
    el("div", { class: "card lib-card" },
      nameInput(choreo.title, (title) => change(reload, `/api/choreos/${choreo.id}`, "PATCH", { title }), { class: "lib-title", "aria-label": "Titel der Choreo" }),
      el("div", { class: "section-title" }, "Tänze"),
      el("div", { class: "dance-chips" }, ...choreo.dances.map((d) => danceChip(d, reload)), addDanceChip(choreo, reload)),
    ),
    el("div", { class: "card lib-card" },
      el("div", { class: "section-title first" }, `Audios (${audios.length})`),
      audios.length
        ? el("p", { class: "muted small" }, "★ = Hauptaudio (dort hängen die Videos). Antippen für Tänze & Takt, Duplizieren, Löschen …")
        : el("p", { class: "muted small" }, "Noch keine Audio. Die erste wird automatisch Hauptaudio."),
      el("div", { class: "lib-list" }, ...audios.map((a) => audioRow(a, reload, rerender))),
      el("div", { class: "lib-add-audio" }, newAudioButton(choreo.id), addExisting),
    ),
    el("button", {
      type: "button", class: "link danger-link",
      onclick: () => {
        if (confirm(`Choreo „${choreo.title}“ löschen? Audios und Videos bleiben erhalten, nur ohne Choreo.`)) {
          ui.open = null;
          change(reload, `/api/choreos/${choreo.id}`, "DELETE");
        }
      },
    }, "Choreo löschen"),
  );
}

function freeDetail(reload, rerender) {
  const free = library.data.audios.filter((a) => !a.choreo_id).sort(byTitle);
  return el("div", { class: "lib-page" },
    backBar(rerender),
    el("div", { class: "card lib-card" },
      el("div", { class: "section-title first" }, `Audios ohne Choreo (${free.length})`),
      el("p", { class: "muted small" }, "Antippen und unter „Choreo“ eine wählen, um sie einzuordnen."),
      el("div", { class: "lib-list" }, ...free.map((a) => audioRow(a, reload, rerender))),
      free.length ? null : el("p", { class: "muted small lib-empty" }, "Keine."),
      el("div", { class: "lib-add-audio" }, newAudioButton(null)),
    ),
  );
}

export function renderChoreos(container, reload) {
  const rerender = () => renderChoreos(container, reload);
  if (ui.open && ui.open !== FREE && !library.choreo(ui.open)) ui.open = null; // gelöscht
  const choreo = ui.open && ui.open !== FREE ? library.choreo(ui.open) : null;
  container.replaceChildren(
    choreo ? choreoDetail(choreo, reload, rerender)
      : ui.open === FREE ? freeDetail(reload, rerender)
        : overview(reload, rerender));
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
