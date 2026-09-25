// Zuordnen (nur Trainer): neue Videos im Eingang, nach Aufnahmezeit sortiert und
// zu „gleichzeitig gefilmt“ gruppiert. Eines oder mehrere auswählen → Choreo,
// Tänze, Tags und die Stelle in der Musik (von–bis, gewählt im Planer) festlegen.
// Außerdem: Choreos/Tänze/Audios und Tags verwalten (admin-library.js).
import { api, el, formatDuration, formatTime, icon } from "../api.js";
import { library } from "../library.js";
import { router } from "../router.js";
import { session } from "../session.js";
import { renderChoreos, renderMore } from "./admin-library.js";

const $ = (id) => document.getElementById(id);
const VIDEO = '<rect x="2" y="6" width="14" height="12" rx="2"/><path d="m16 10 6-3v10l-6-3"/>';
const SAME_TAKE_GAP_MS = 5000; // so dicht hintereinander = vermutlich dasselbe gefilmt

let videos = [];
let pane = "inbox";
const selected = new Set();
let editor = null; // offene Zuordnung, siehe openEditor()

export function toast(message) {
  window.dispatchEvent(new CustomEvent("toast", { detail: message }));
}

/** Sekunden als „1:05,2“. */
export function fmtSec(sec) {
  if (sec == null) return "";
  const m = Math.floor(sec / 60);
  const s = (sec - m * 60).toFixed(1).replace(".", ",").padStart(4, "0");
  return `${m}:${s}`;
}

// ---------------- Laden ----------------

async function load() {
  try {
    const [{ videos: list }] = await Promise.all([api("/api/videos"), library.load(true)]);
    videos = list;
  } catch (err) {
    $("ad-info").textContent = `Konnte nicht laden: ${err.message}`;
    return;
  }
  for (const id of [...selected]) if (!videos.some((v) => v.id === id)) selected.delete(id);
  updateBadge();
  render();
}

function updateBadge() {
  const n = videos.filter((v) => v.tag_state === "untagged").length;
  $("ad-count").textContent = n ? String(n) : "";
  const badge = $("nav-inbox");
  badge.hidden = !n;
  badge.textContent = n > 99 ? "99+" : String(n);
}

// ---------------- Liste ----------------

const hasTime = (v) => Boolean(v.recorded_at?.includes("T"));
const startMs = (v) => Date.parse(hasTime(v) ? v.recorded_at : v.recorded_at ? `${v.recorded_at}T00:00:00` : v.created_at);
const dayOf = (v) => {
  const d = new Date(startMs(v));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/**
 * Tage (neueste zuerst), darin nach Uhrzeit. Videos, deren Aufnahmezeiten sich
 * überschneiden (oder höchstens 5 s auseinander liegen), bilden eine Gruppe.
 */
export function groupVideos(list) {
  const days = new Map();
  for (const v of [...list].sort((a, b) => startMs(a) - startMs(b))) {
    const key = dayOf(v);
    if (!days.has(key)) days.set(key, []);
    const groups = days.get(key);
    const last = groups[groups.length - 1];
    const start = startMs(v);
    if (last && hasTime(v) && last.timed && start <= last.end + SAME_TAKE_GAP_MS) {
      last.videos.push(v);
      last.end = Math.max(last.end, start + (v.duration_s || 0) * 1000);
    } else {
      groups.push({ videos: [v], timed: hasTime(v), end: start + (v.duration_s || 0) * 1000 });
    }
  }
  return [...days.entries()].sort((a, b) => b[0].localeCompare(a[0]));
}

function dayTitle(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("de-DE", { weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" });
}

function item(v) {
  const checkbox = el("input", { type: "checkbox", "aria-label": "Auswählen" });
  checkbox.checked = selected.has(v.id);
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) selected.add(v.id);
    else selected.delete(v.id);
    render();
  });
  const source = { file: "Dateidatum", manual: "von Hand" }[v.recorded_source];
  const when = hasTime(v) ? formatTime(v.recorded_at) : v.recorded_at ? "Uhrzeit unbekannt" : "Aufnahmezeit unbekannt";
  const sub = [v.uploaded_by, source].filter(Boolean).join(" · ");
  return el("label", { class: `ad-item${selected.has(v.id) ? " selected" : ""}` },
    checkbox,
    el("a", { class: "ad-thumb", href: `/videos/${encodeURIComponent(v.id)}`, "aria-label": "Ansehen" },
      v.thumb_url ? el("img", { src: v.thumb_url, alt: "", loading: "lazy" }) : icon(VIDEO, 22),
      v.duration_s ? el("span", { class: "chip right" }, formatDuration(v.duration_s)) : null,
    ),
    el("div", { class: "ad-meta" },
      el("div", { class: "ad-when" }, when),
      sub && el("div", { class: "ad-sub" }, sub),
      v.tag_state === "tagged" && el("div", { class: "ad-assigned" }, library.videoTitle(v)),
      v.audio_start_s != null && el("div", { class: "ad-sub" }, `♪ ${fmtSec(v.audio_start_s)} – ${fmtSec(v.audio_end_s)}`),
    ),
  );
}

function groupBox(group) {
  if (group.videos.length === 1) return item(group.videos[0]);
  const ids = group.videos.map((v) => v.id);
  const all = ids.every((id) => selected.has(id));
  return el("div", { class: "ad-group" },
    el("div", { class: "ad-group-head" },
      el("span", {}, `Gleichzeitig gefilmt · ${ids.length} Videos`),
      el("button", {
        type: "button", class: "link",
        onclick: () => { for (const id of ids) all ? selected.delete(id) : selected.add(id); render(); },
      }, all ? "abwählen" : "alle wählen"),
    ),
    ...group.videos.map(item),
  );
}

function renderList() {
  const shown = pane === "inbox" ? videos.filter((v) => v.tag_state === "untagged") : videos;
  $("ad-info").textContent = pane === "inbox"
    ? (shown.length ? `${shown.length} neue ${shown.length === 1 ? "Video" : "Videos"} – antippen zum Auswählen` : "")
    : `${shown.length} Videos`;
  if (!shown.length && pane === "inbox") {
    $("ad-list").replaceChildren(el("div", { class: "empty" },
      el("span", { class: "icon-circle" }, icon('<path d="M20 6 9 17l-5-5"/>', 28)),
      el("div", {}, "Alles zugeordnet."),
    ));
    return;
  }
  $("ad-list").replaceChildren(...groupVideos(shown).flatMap(([day, groups]) => [
    el("h2", { class: "section-title" }, dayTitle(day)),
    ...groups.map(groupBox),
  ]));
}

function render() {
  const trainer = session.isTrainer;
  $("ad-denied").hidden = trainer;
  $("ad-main").hidden = !trainer;
  if (!trainer) {
    $("ad-bar").hidden = true;
    return;
  }
  for (const b of document.querySelectorAll(".ad-tabs [data-pane]")) {
    b.setAttribute("aria-pressed", String(b.dataset.pane === pane));
  }
  const videoPane = pane === "inbox" || pane === "all";
  $("ad-videos").hidden = !videoPane;
  $("ad-choreos").hidden = pane !== "choreos";
  $("ad-more").hidden = pane !== "more";
  if (videoPane) renderList();
  if (pane === "choreos") renderChoreos($("ad-choreos"), load);
  if (pane === "more") renderMore($("ad-more"), load);

  $("ad-bar").hidden = !videoPane || !selected.size;
  $("ad-selected").textContent = `${selected.size} ausgewählt`;
}

// ---------------- Zuordnen ----------------

/** Wert, wenn er bei allen gewählten Videos gleich ist – sonst `fallback`. */
function common(list, pick, fallback) {
  const first = JSON.stringify(pick(list[0]));
  return list.every((v) => JSON.stringify(pick(v)) === first) ? pick(list[0]) : fallback;
}

/** Vorschlag für neue Videos: die Choreo, die gerade im Planer gewählt ist – oder die einzige. */
function plannerChoreo() {
  let last = "";
  try { last = localStorage.getItem("choreo_last_project") || ""; } catch { /* egal */ }
  const { choreos } = library.data;
  return library.audio(last)?.choreo_id || (choreos.length === 1 ? choreos[0].id : null);
}

function openEditor(ids) {
  const list = ids.map((id) => videos.find((v) => v.id === id)).filter(Boolean);
  if (!list.length) return;
  const fresh = list.every((v) => v.tag_state === "untagged" && !v.choreo_id);
  const choreoId = fresh ? plannerChoreo() : common(list, (v) => v.choreo_id, null);
  const audio = common(list, (v) => v.audio_project_id && { project_id: v.audio_project_id, start_s: v.audio_start_s, end_s: v.audio_end_s }, null);
  editor = {
    ids: list.map((v) => v.id),
    choreo_id: choreoId,
    dance_ids: new Set(choreoId === list[0].choreo_id ? common(list, (v) => v.dance_ids, []) : []),
    tag_ids: new Set(common(list, (v) => v.tag_ids, [])),
    audio: audio && library.audio(audio.project_id)?.choreo_id === choreoId ? audio : null,
    audio_choice: audio?.project_id || library.choreo(choreoId)?.main_project_id || null,
    title: common(list, (v) => v.title || "", ""),
    recorded_at: list.length === 1 ? list[0].recorded_at : null,
    preview: list[0].id,
  };
  $("ed-title").textContent = list.length === 1 ? "Video zuordnen" : `${list.length} Videos zuordnen`;
  $("ad-editor").hidden = false;
  $("ad-editor").scrollTop = 0;
  buildEditor();
}

function closeEditor() {
  editor = null;
  $("ad-editor").hidden = true;
  $("ed-body").querySelector("video")?.pause();
}

function editorVideos() {
  return editor.ids.map((id) => videos.find((v) => v.id === id)).filter(Boolean);
}

/** Player + Formular. Der Player bleibt bestehen, das Formular wird bei jeder Änderung neu gebaut. */
function buildEditor() {
  const list = editorVideos();
  const player = el("video", { controls: true, playsinline: true, preload: "metadata", class: "ed-player" });
  const thumbs = el("div", { class: "ed-thumbs" });
  const form = el("div", { class: "fields" });
  const showPreview = (id) => {
    editor.preview = id;
    const v = videos.find((x) => x.id === id);
    player.src = v.playback_url;
    if (v.thumb_url) player.poster = v.thumb_url; else player.removeAttribute("poster");
    for (const t of thumbs.children) t.setAttribute("aria-pressed", String(t.dataset.id === id));
  };
  if (list.length > 1) {
    thumbs.append(...list.map((v) => el("button", {
      type: "button", class: "ed-thumb", "data-id": v.id, onclick: () => showPreview(v.id),
      "aria-label": `Video ${formatTime(v.recorded_at) || ""}`,
    }, v.thumb_url ? el("img", { src: v.thumb_url, alt: "" }) : icon(VIDEO, 18),
       el("span", {}, formatTime(v.recorded_at).slice(0, 5) || "?"))));
  }
  $("ed-body").replaceChildren(player, thumbs, form);
  editor.form = form;
  showPreview(editor.preview);
  renderForm(form);
}

function chips(items, chosen, onToggle) {
  return el("div", { class: "chips" }, ...items.map((x) => el("button", {
    type: "button", class: "chip-toggle", "aria-pressed": String(chosen.has(x.id)),
    onclick: () => onToggle(x.id),
  }, x.name)));
}

function renderForm(form) {
  const choreo = library.choreo(editor.choreo_id);
  const audios = choreo ? library.audiosOf(choreo.id) : [];
  const rerender = () => renderForm(form);

  const choreoSelect = el("select", { "aria-label": "Choreo" },
    el("option", { value: "" }, "— keine Choreo —"),
    ...library.data.choreos.map((c) => el("option", { value: c.id, selected: c.id === editor.choreo_id }, c.title)),
  );
  choreoSelect.addEventListener("change", () => {
    editor.choreo_id = choreoSelect.value || null;
    const dances = new Set(library.dancesOf(editor.choreo_id).map((d) => d.id));
    editor.dance_ids = new Set([...editor.dance_ids].filter((id) => dances.has(id)));
    if (editor.audio && library.audio(editor.audio.project_id)?.choreo_id !== editor.choreo_id) editor.audio = null;
    editor.audio_choice = library.choreo(editor.choreo_id)?.main_project_id || null;
    rerender();
  });

  const toggle = (set) => (id) => { set.has(id) ? set.delete(id) : set.add(id); rerender(); };

  // Stelle in der Musik
  const audioId = editor.audio?.project_id || editor.audio_choice || audios[0]?.id || null;
  const audioSelect = audios.length > 1 ? el("select", { "aria-label": "Audio" },
    ...audios.map((a) => el("option", { value: a.id, selected: a.id === audioId },
      a.title + (a.id === choreo.main_project_id ? " (Hauptaudio)" : "")))) : null;
  audioSelect?.addEventListener("change", () => {
    editor.audio_choice = audioSelect.value;
    if (editor.audio && editor.audio.project_id !== audioSelect.value) editor.audio = null;
    rerender();
  });
  const range = editor.audio
    ? el("p", { class: "ed-range" }, `♪ ${fmtSec(editor.audio.start_s)} – ${fmtSec(editor.audio.end_s)}`,
      el("span", { class: "muted" }, ` in „${library.audio(editor.audio.project_id)?.title || "?"}“`))
    : el("p", { class: "muted ed-range" }, choreo
      ? (audios.length ? "Noch keine Stelle gewählt." : "Diese Choreo hat noch keine Audio (Reiter „Choreos“).")
      : "Erst eine Choreo wählen.");

  const single = editor.ids.length === 1;
  const titleInput = el("input", { type: "text", maxlength: 200, placeholder: single ? "optional – sonst automatisch" : "optional – gilt für alle gewählten" });
  titleInput.value = editor.title;
  titleInput.addEventListener("input", () => { editor.title = titleInput.value; });

  const when = single && el("input", { type: "datetime-local", step: 1, "aria-label": "Aufnahmezeit" });
  if (when) {
    when.value = toLocalInput(editor.recorded_at);
    when.addEventListener("change", () => { editor.recorded_at = when.value ? new Date(when.value).toISOString() : null; });
  }

  form.replaceChildren(
    el("div", { class: "card fields" },
      el("label", { class: "field" }, "Choreo", choreoSelect),
      choreo && el("div", { class: "field" }, "Tänze",
        choreo.dances.length ? chips(choreo.dances, editor.dance_ids, toggle(editor.dance_ids))
          : el("span", { class: "muted" }, "Noch keine Tänze angelegt.")),
      el("div", { class: "field" }, "Tags", chips(library.data.tags, editor.tag_ids, toggle(editor.tag_ids))),
    ),
    el("div", { class: "card fields" },
      el("div", { class: "field" }, "Stelle in der Musik", audioSelect, range),
      el("div", { class: "ed-actions" },
        el("button", { type: "button", class: "primary", disabled: !audioId, onclick: () => pickRange(audioId) },
          editor.audio ? "Stelle ändern" : "Stelle im Planer wählen"),
        editor.audio && el("button", { type: "button", onclick: () => { editor.audio = null; rerender(); } }, "Entfernen"),
      ),
    ),
    el("div", { class: "card fields" },
      el("label", { class: "field" }, "Titel", titleInput),
      when && el("label", { class: "field" }, "Aufnahmezeit", when),
    ),
    el("button", { type: "button", class: "primary block", onclick: save }, single ? "Speichern" : `Für ${editor.ids.length} Videos speichern`),
    el("button", { type: "button", class: "link danger-link", onclick: trash },
      single ? "Video in den Papierkorb" : `${editor.ids.length} Videos in den Papierkorb`),
  );
}

/** ISO → Wert für <input type="datetime-local"> in Ortszeit. */
function toLocalInput(iso) {
  if (!iso) return "";
  const d = new Date(iso.includes("T") ? iso : `${iso}T12:00:00`);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Stelle im Planer wählen: der Planer öffnet die Audio und meldet „range-picked“. */
function pickRange(projectId) {
  $("ed-body").querySelector("video")?.pause();
  const list = editorVideos();
  window.dispatchEvent(new CustomEvent("pick-range", {
    detail: {
      projectId,
      start: editor.audio?.project_id === projectId ? editor.audio.start_s : null,
      end: editor.audio?.project_id === projectId ? editor.audio.end_s : null,
      videos: list.map((v) => ({ id: v.id, url: v.playback_url, poster: v.thumb_url, label: formatTime(v.recorded_at) || "Video" })),
    },
  }));
  router.navigate("/");
}

async function save() {
  const changes = {
    choreo_id: editor.choreo_id,
    dance_ids: [...editor.dance_ids],
    tag_ids: [...editor.tag_ids],
    audio: editor.audio,
    tag_state: "tagged",
    tagged_by: session.getName() || null,
  };
  if (editor.ids.length === 1 || editor.title.trim()) changes.title = editor.title;
  if (editor.ids.length === 1) {
    const before = videos.find((v) => v.id === editor.ids[0]).recorded_at;
    if (editor.recorded_at !== before) changes.recorded_at = editor.recorded_at;
  }
  try {
    await api("/api/videos/assign", { method: "POST", body: { ids: editor.ids, changes } });
  } catch (err) {
    toast(`Speichern fehlgeschlagen: ${err.message}`);
    return;
  }
  const n = editor.ids.length;
  for (const id of editor.ids) selected.delete(id);
  closeEditor();
  window.dispatchEvent(new Event("videos-changed"));
  toast(n === 1 ? "Zugeordnet" : `${n} Videos zugeordnet`);
  await load();
}

async function trash() {
  const n = editor.ids.length;
  if (!confirm(n === 1 ? "Dieses Video in den Papierkorb legen?" : `${n} Videos in den Papierkorb legen?`)) return;
  try {
    for (const id of editor.ids) await api(`/api/videos/${id}`, { method: "DELETE" });
  } catch (err) {
    toast(`Löschen fehlgeschlagen: ${err.message}`);
  }
  for (const id of editor.ids) selected.delete(id);
  closeEditor();
  window.dispatchEvent(new Event("videos-changed"));
  toast(n === 1 ? "Im Papierkorb" : `${n} Videos im Papierkorb`);
  await load();
}

// ---------------- Bereich ----------------

export const adminView = {
  mount() {
    for (const b of document.querySelectorAll(".ad-tabs [data-pane]")) {
      b.addEventListener("click", () => { pane = b.dataset.pane; render(); });
    }
    $("ad-clear").addEventListener("click", () => { selected.clear(); render(); });
    $("ad-assign").addEventListener("click", () => openEditor([...selected]));
    $("ed-close").addEventListener("click", closeEditor);

    window.addEventListener("sessionchange", () => { render(); if (session.isTrainer) load(); });
    window.addEventListener("range-picked", ({ detail }) => {
      if (!editor) return;
      editor.audio = { project_id: detail.projectId, start_s: detail.start, end_s: detail.end };
      editor.audio_choice = detail.projectId;
      renderForm(editor.form);
    });
    // Aus dem Player: „Zuordnung bearbeiten“
    window.addEventListener("edit-videos", async ({ detail }) => {
      await load();
      openEditor(detail.ids);
    });
  },
  async show() {
    await session.restore();
    render();
    if (session.isTrainer && !editor) await load();
  },
  hide() {
    $("ed-body").querySelector("video")?.pause();
  },
};

/** Zähler am Reiter auch ohne die Seite zu öffnen (für Trainer). */
export async function refreshInboxBadge() {
  if (!session.isTrainer) { $("nav-inbox").hidden = true; return; }
  try {
    ({ videos } = await api("/api/videos"));
    updateBadge();
  } catch { /* egal */ }
}

