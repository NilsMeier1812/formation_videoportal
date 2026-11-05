// Videothek: alle Videos, durchsuchbar, filterbar nach Choreo, Tanz und Tag (Menü „Filtern“)
// und sortierbar nach Aufnahme, Upload, Länge, Titel (Menü „Sortieren“, wird gemerkt).
// „Letztes Training“ (Leiste oben, auch im Filter-Menü): alle Videos des letzten Trainingstags –
// erkannt an der Aufnahmezeit (lib/trainings.js). Trainer können einen Tag ausblenden.
// Wird beim ersten Öffnen geladen und bei jedem weiteren Öffnen still aufgefrischt.
import { api, el, formatDateTime, formatDuration, icon } from "../api.js";
import { library } from "../library.js";
import { trainingDays, trainingLabel, videoDay } from "../lib/trainings.js";
import { session } from "../session.js";

const PLAY = '<path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/>';
const EYE = '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>';
const VIDEO = '<rect x="2" y="6" width="14" height="12" rx="2"/><path d="m16 10 6-3v10l-6-3"/>';

const $ = (id) => document.getElementById(id);
let videos = [];
let excludedDays = []; // „Kein Training“ (vom Server, für alle gleich)
let loaded = ""; // zuletzt gezeigter Stand (JSON) – nur neu zeichnen, wenn sich etwas geändert hat

/** Suchtext eines Videos: alles, wonach man sinnvoll suchen kann. */
function haystack(v) {
  return [
    library.videoTitle(v),
    v.uploaded_by,
    formatDateTime(v.recorded_at),
    v.recorded_at,
    ...v.dance_ids.map((id) => library.dance(id)?.name),
    ...v.tag_ids.map((id) => library.tag(id)?.name),
  ].filter(Boolean).join(" ").toLowerCase();
}

function card(video) {
  const sub = [formatDateTime(video.recorded_at), video.uploaded_by].filter(Boolean).join(" · ");
  const tags = video.tag_ids.map((id) => library.tag(id)?.name).filter(Boolean);
  return el("li", { class: "video-card" },
    el("a", { href: `/videos/${encodeURIComponent(video.id)}` },
      el("div", { class: "thumb" },
        video.thumb_url && el("img", { src: video.thumb_url, alt: "", loading: "lazy" }),
        el("span", { class: "play" }, icon(PLAY, 22)),
        !video.is_processed && el("span", { class: "chip left" }, "wird aufbereitet"),
        video.duration_s && el("span", { class: "chip right" }, formatDuration(video.duration_s)),
        // Aufrufe: liefert der Server nur an Trainer
        video.view_count != null && el("span", {
          class: "chip views", title: "Aufrufe (nur für Trainer sichtbar)", "aria-label": `${video.view_count} Aufrufe`,
        }, icon(EYE, 12), String(video.view_count)),
      ),
      el("div", { class: "meta" },
        el("div", { class: "title" }, library.videoTitle(video)),
        sub && el("div", { class: "sub" }, sub),
        tags.length ? el("div", { class: "card-tags" }, ...tags.map((t) => el("span", { class: "tag" }, t))) : null,
      ),
    ),
  );
}

// ---------------- Filter und Sortieren (je ein Menü) ----------------
const filter = { training: "", choreo: "", dance: "", tag: "" };
const trainings = () => trainingDays(videos, excludedDays);
const SORTS = [
  { key: "recorded_desc", label: "Aufnahme: neueste zuerst" },
  { key: "recorded_asc", label: "Aufnahme: älteste zuerst" },
  { key: "uploaded_desc", label: "Zuletzt hochgeladen" },
  { key: "duration_desc", label: "Länge: längste zuerst" },
  { key: "duration_asc", label: "Länge: kürzeste zuerst" },
  { key: "title_asc", label: "Titel A–Z" },
];
const SORT_KEY = "formation.video_sort";
let sort = (() => { try { return localStorage.getItem(SORT_KEY); } catch { return null; } })();
if (!SORTS.some((x) => x.key === sort)) sort = SORTS[0].key;

const when = (v) => v.recorded_at || v.created_at || "";
const byDuration = (dir) => (a, b) => {
  if (a.duration_s == null) return b.duration_s == null ? 0 : 1; // ohne Länge immer hinten
  if (b.duration_s == null) return -1;
  return dir * (a.duration_s - b.duration_s);
};
const COMPARE = {
  recorded_desc: (a, b) => when(b).localeCompare(when(a)),
  recorded_asc: (a, b) => when(a).localeCompare(when(b)),
  uploaded_desc: (a, b) => String(b.created_at).localeCompare(String(a.created_at)),
  duration_desc: byDuration(-1),
  duration_asc: byDuration(1),
  title_asc: (a, b) => library.videoTitle(a).localeCompare(library.videoTitle(b), "de"),
};

/** Tänze zur Auswahl: der gewählten Choreo – sonst alle, mit Choreo dahinter. */
function danceOptions() {
  const { choreos } = library.data;
  const choreo = library.choreo(filter.choreo);
  return choreo ? choreo.dances : choreos.flatMap((c) => c.dances.map((d) => ({ ...d, name: `${d.name} (${c.title})` })));
}

/** Gewähltes, das es nicht mehr gibt (gelöscht, andere Choreo), verwerfen. */
function cleanFilter() {
  if (filter.training && !trainings().some((t) => t.day === filter.training)) filter.training = "";
  if (filter.choreo && !library.choreo(filter.choreo)) filter.choreo = "";
  if (filter.dance && !danceOptions().some((d) => d.id === filter.dance)) filter.dance = "";
  if (filter.tag && !library.tag(filter.tag)) filter.tag = "";
}

const activeFilters = () => [
  filter.training && { key: "training", label: `Training ${trainingLabel(filter.training)}` },
  filter.choreo && { key: "choreo", label: library.choreo(filter.choreo)?.title },
  filter.dance && { key: "dance", label: library.dance(filter.dance)?.name },
  filter.tag && { key: "tag", label: library.tag(filter.tag)?.name },
].filter((x) => x && x.label);

function setFilter(key, value) {
  filter[key] = filter[key] === value ? "" : value; // nochmal tippen = abwählen
  if (key === "choreo") cleanFilter(); // Tanz muss zur Choreo passen
  renderFilterMenu();
  render();
}

function chipGroup(title, key, options) {
  if (!options.length) return null;
  return el("div", { class: "vl-menu-group" },
    el("div", { class: "vl-menu-title" }, title),
    el("div", { class: "vl-chips" }, ...options.map((o) => el("button", {
      type: "button", class: "vl-chip", "aria-pressed": String(filter[key] === o.id),
      onclick: () => setFilter(key, o.id),
    }, o.name))));
}

function renderFilterMenu() {
  const { choreos, tags } = library.data;
  const any = activeFilters().length;
  $("vl-filter-menu").replaceChildren(...[ // replaceChildren schreibt null als Text – daher filtern
    chipGroup("Training", "training", trainings().slice(0, 8).map((t) => ({ id: t.day, name: `${trainingLabel(t.day)} (${t.count})` }))),
    hiddenTrainings(),
    chipGroup("Choreo", "choreo", choreos.map((c) => ({ id: c.id, name: c.title }))),
    chipGroup("Tanz", "dance", danceOptions()),
    chipGroup("Tag", "tag", tags),
    choreos.length || tags.length ? null : el("p", { class: "muted small" }, "Noch keine Choreos oder Tags."),
    el("div", { class: "vl-menu-foot" },
      el("button", { type: "button", class: "link", disabled: !any, onclick: () => { Object.assign(filter, { training: "", choreo: "", dance: "", tag: "" }); renderFilterMenu(); render(); } }, "Zurücksetzen"),
      el("button", { type: "button", class: "small-btn primary", onclick: () => closeMenus() }, "Fertig")),
  ].filter(Boolean));
}

// ---------------- Training: Leiste und „Kein Training“ ----------------
const RESTORE = '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>';
const HIDE = '<path d="M3 3l18 18"/><path d="M10.6 10.6a2 2 0 0 0 2.8 2.8"/><path d="M9.9 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.1 6.1C3.6 7.8 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 4.2-.9"/>';

/** Trainer: Tag ausblenden bzw. wieder als Training zählen. */
async function setExcluded(day, excluded) {
  try {
    const res = await api(`/api/trainings/${day}`, { method: "PUT", body: { excluded, by: session.getName() } });
    excludedDays = res.excluded_training_days;
  } catch (err) {
    window.dispatchEvent(new CustomEvent("toast", { detail: err.message }));
    return;
  }
  cleanFilter();
  if (!$("vl-filter-menu").hidden) renderFilterMenu();
  render();
}

/** Im Filter-Menü (nur Trainer): ausgeblendete Tage mit Videos – antippen zählt sie wieder. */
function hiddenTrainings() {
  if (!session.isTrainer) return null;
  const hidden = trainingDays(videos, excludedDays, { includeExcluded: true }).filter((t) => t.excluded);
  if (!hidden.length) return null;
  return el("div", { class: "vl-menu-group vl-hidden-days" },
    el("div", { class: "vl-menu-title" }, "Kein Training (ausgeblendet)"),
    el("div", { class: "vl-chips" }, ...hidden.map((t) => el("button", {
      type: "button", class: "vl-chip muted-chip", title: "Wieder als Training zählen",
      onclick: () => setExcluded(t.day, false),
    }, icon(RESTORE, 14), `${trainingLabel(t.day)} (${t.count})`))));
}

/** Leiste „Letztes Training“ – gewählt: ‹ älter · Tag · neuer ›, Trainer zusätzlich „Kein Training“. */
function renderTraining() {
  const box = $("vl-training");
  const list = trainings();
  box.hidden = !list.length;
  if (!list.length) { box.replaceChildren(); return; }
  const videosWord = (n) => `${n} ${n === 1 ? "Video" : "Videos"}`;
  const i = list.findIndex((t) => t.day === filter.training);
  if (i < 0) {
    const last = list[0];
    box.replaceChildren(el("button", {
      type: "button", class: "vl-training-go", onclick: () => { filter.training = last.day; render(); },
    }, el("span", { class: "vl-training-kicker" }, "Letztes Training"),
    el("span", { class: "vl-training-day" }, trainingLabel(last.day)),
    el("span", { class: "vl-training-count" }, videosWord(last.count))));
    return;
  }
  const t = list[i];
  const go = (j) => { filter.training = list[j].day; render(); };
  box.replaceChildren(el("div", { class: "vl-training-on" },
    el("button", { type: "button", class: "icon-btn", "aria-label": "Training davor", title: "Training davor", disabled: i >= list.length - 1, onclick: () => go(i + 1) }, "‹"),
    el("div", { class: "vl-training-mid" },
      el("span", { class: "vl-training-kicker" }, i === 0 ? "Letztes Training" : "Training"),
      el("span", { class: "vl-training-day" }, `${trainingLabel(t.day)} · ${videosWord(t.count)}`)),
    el("button", { type: "button", class: "icon-btn", "aria-label": "Training danach", title: "Training danach", disabled: i === 0, onclick: () => go(i - 1) }, "›"),
    session.isTrainer ? el("button", {
      type: "button", class: "icon-btn vl-not-training", title: "Kein Training – ausblenden", "aria-label": `${trainingLabel(t.day)}: kein Training, ausblenden`,
      onclick: () => {
        if (confirm(`${trainingLabel(t.day)} war kein Training? Der Tag wird für alle ausgeblendet – die Videos bleiben. Zurückholen geht im Filter-Menü.`)) setExcluded(t.day, true);
      },
    }, icon(HIDE, 18)) : null,
  ));
}

function renderSortMenu() {
  $("vl-sort-menu").replaceChildren(...SORTS.map((o) => el("button", {
    type: "button", class: "vl-sort-item", role: "menuitemradio", "aria-checked": String(o.key === sort),
    onclick: () => {
      sort = o.key;
      try { localStorage.setItem(SORT_KEY, sort); } catch { /* egal */ }
      closeMenus();
      render();
    },
  }, el("span", {}, o.label), o.key === sort ? el("span", { class: "vl-check", "aria-hidden": "true" }, "✓") : null)));
}

const MENUS = { filter: ["vl-filter-btn", "vl-filter-menu"], sort: ["vl-sort-btn", "vl-sort-menu"] };
function toggleMenu(which) {
  const [btnId, menuId] = MENUS[which];
  const open = $(menuId).hidden;
  closeMenus();
  if (!open) return;
  if (which === "filter") renderFilterMenu(); else renderSortMenu();
  $(menuId).hidden = false;
  $(btnId).setAttribute("aria-expanded", "true");
}
function closeMenus() {
  for (const [btnId, menuId] of Object.values(MENUS)) {
    $(menuId).hidden = true;
    $(btnId).setAttribute("aria-expanded", "false");
  }
}

/** Gesetzte Filter als Pillen unter der Suche (× nimmt sie weg) und Zahl am Filter-Knopf. */
function renderActive() {
  const active = activeFilters();
  const count = $("vl-filter-count");
  count.hidden = !active.length;
  count.textContent = String(active.length);
  $("vl-filter-btn").classList.toggle("on", active.length > 0);
  $("vl-sort-btn").classList.toggle("on", sort !== SORTS[0].key);
  const box = $("vl-active");
  box.hidden = !active.length;
  box.replaceChildren(...active.map((f) => el("button", {
    type: "button", class: "vl-pill", "aria-label": `Filter ${f.label} entfernen`,
    onclick: () => { filter[f.key] = ""; cleanFilter(); render(); },
  }, f.label, el("span", { "aria-hidden": "true" }, "×"))));
}

function render() {
  const info = $("vl-info");
  const list = $("vl-videos");
  const words = $("vl-q").value.toLowerCase().split(/\s+/).filter(Boolean);
  const { training, choreo, dance, tag } = filter;
  const filtered = Boolean(words.length || training || choreo || dance || tag);
  const shown = videos.filter((v) =>
    (!training || videoDay(v) === training) &&
    (!choreo || v.choreo_id === choreo) &&
    (!dance || v.dance_ids.includes(dance)) &&
    (!tag || v.tag_ids.includes(tag)) &&
    words.every((w) => haystack(v).includes(w)))
    .sort(COMPARE[sort]);
  list.replaceChildren(...shown.map(card));
  renderActive();
  renderTraining();

  if (!videos.length) {
    info.textContent = "";
    list.replaceChildren(el("li", { class: "empty" },
      el("span", { class: "icon-circle" }, icon(VIDEO, 28)),
      el("div", {}, "Noch keine Videos."),
      el("a", { class: "button primary", href: "/upload" }, "Erstes Video hochladen"),
    ));
    return;
  }
  const sortLabel = SORTS.find((x) => x.key === sort).label;
  info.textContent = (filtered
    ? `${shown.length} von ${videos.length} Videos`
    : `${videos.length} ${videos.length === 1 ? "Video" : "Videos"}`) + ` · ${sortLabel}`;
}

async function refresh() {
  const info = $("vl-info");
  try {
    const [data] = await Promise.all([api("/api/videos"), library.load()]);
    const json = JSON.stringify([data.videos, data.excluded_training_days]);
    if (json === loaded) return;
    loaded = json;
    videos = data.videos;
    excludedDays = data.excluded_training_days || [];
    cleanFilter();
    info.className = "result-info";
    render();
  } catch (err) {
    if (loaded) return; // Liste steht schon – beim stillen Auffrischen keinen Fehler zeigen
    info.textContent = `Videos konnten nicht geladen werden: ${err.message}`;
    info.className = "result-info error";
  }
}

export const videosView = {
  mount() {
    $("vl-q").addEventListener("input", render);
    $("vl-filter-btn").addEventListener("click", () => toggleMenu("filter"));
    $("vl-sort-btn").addEventListener("click", () => toggleMenu("sort"));
    // Menü schließt beim Tippen daneben und mit Escape
    document.addEventListener("pointerdown", (e) => {
      if (!e.target.closest?.(".vl-menu, #vl-filter-btn, #vl-sort-btn")) closeMenus();
    });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenus(); });
    window.addEventListener("librarychange", () => { cleanFilter(); render(); });
  },
  show() {
    refresh();
  },
  hide() { closeMenus(); },
};
