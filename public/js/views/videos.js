// Videothek: alle Videos, durchsuchbar, filterbar nach Choreo, Tanz und Tag (Menü „Filtern“)
// und sortierbar nach Aufnahme, Upload, Länge, Titel (Menü „Sortieren“, wird gemerkt).
// Wird beim ersten Öffnen geladen und bei jedem weiteren Öffnen still aufgefrischt.
import { api, el, formatDateTime, formatDuration, icon } from "../api.js";
import { library } from "../library.js";

const PLAY = '<path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/>';
const VIDEO = '<rect x="2" y="6" width="14" height="12" rx="2"/><path d="m16 10 6-3v10l-6-3"/>';

const $ = (id) => document.getElementById(id);
let videos = [];
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
const filter = { choreo: "", dance: "", tag: "" };
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
  if (filter.choreo && !library.choreo(filter.choreo)) filter.choreo = "";
  if (filter.dance && !danceOptions().some((d) => d.id === filter.dance)) filter.dance = "";
  if (filter.tag && !library.tag(filter.tag)) filter.tag = "";
}

const activeFilters = () => [
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
  $("vl-filter-menu").replaceChildren(
    chipGroup("Choreo", "choreo", choreos.map((c) => ({ id: c.id, name: c.title }))),
    chipGroup("Tanz", "dance", danceOptions()),
    chipGroup("Tag", "tag", tags),
    choreos.length || tags.length ? null : el("p", { class: "muted small" }, "Noch keine Choreos oder Tags."),
    el("div", { class: "vl-menu-foot" },
      el("button", { type: "button", class: "link", disabled: !any, onclick: () => { Object.assign(filter, { choreo: "", dance: "", tag: "" }); renderFilterMenu(); render(); } }, "Zurücksetzen"),
      el("button", { type: "button", class: "small-btn primary", onclick: () => closeMenus() }, "Fertig")),
  );
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
  const { choreo, dance, tag } = filter;
  const filtered = Boolean(words.length || choreo || dance || tag);
  const shown = videos.filter((v) =>
    (!choreo || v.choreo_id === choreo) &&
    (!dance || v.dance_ids.includes(dance)) &&
    (!tag || v.tag_ids.includes(tag)) &&
    words.every((w) => haystack(v).includes(w)))
    .sort(COMPARE[sort]);
  list.replaceChildren(...shown.map(card));
  renderActive();

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
    cleanFilter();
    const json = JSON.stringify(data.videos);
    if (json === loaded) return;
    loaded = json;
    videos = data.videos;
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
