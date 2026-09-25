// Videothek: alle Videos, durchsuchbar und filterbar nach Choreo, Tanz und Tag.
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

/** Auswahllisten aus der Bibliothek; Tänze passend zur gewählten Choreo. */
function fillFilters() {
  const keep = (select, options) => {
    const value = select.value;
    select.replaceChildren(select.options[0], ...options);
    select.value = [...select.options].some((o) => o.value === value) ? value : "";
  };
  const { choreos, tags } = library.data;
  keep($("vl-choreo"), choreos.map((c) => el("option", { value: c.id }, c.title)));
  const choreo = library.choreo($("vl-choreo").value);
  const dances = choreo ? choreo.dances : choreos.flatMap((c) => c.dances.map((d) => ({ ...d, name: `${d.name} (${c.title})` })));
  keep($("vl-dance"), dances.map((d) => el("option", { value: d.id }, d.name)));
  keep($("vl-tag"), tags.map((t) => el("option", { value: t.id }, t.name)));
  $("vl-filters").hidden = !choreos.length && !tags.length;
}

function render() {
  const info = $("vl-info");
  const list = $("vl-videos");
  const words = $("vl-q").value.toLowerCase().split(/\s+/).filter(Boolean);
  const choreo = $("vl-choreo").value;
  const dance = $("vl-dance").value;
  const tag = $("vl-tag").value;
  const filtered = Boolean(words.length || choreo || dance || tag);
  const shown = videos.filter((v) =>
    (!choreo || v.choreo_id === choreo) &&
    (!dance || v.dance_ids.includes(dance)) &&
    (!tag || v.tag_ids.includes(tag)) &&
    words.every((w) => haystack(v).includes(w)));
  list.replaceChildren(...shown.map(card));

  if (!videos.length) {
    info.textContent = "";
    list.replaceChildren(el("li", { class: "empty" },
      el("span", { class: "icon-circle" }, icon(VIDEO, 28)),
      el("div", {}, "Noch keine Videos."),
      el("a", { class: "button primary", href: "/upload" }, "Erstes Video hochladen"),
    ));
    return;
  }
  info.textContent = filtered
    ? `${shown.length} von ${videos.length} Videos`
    : `${videos.length} ${videos.length === 1 ? "Video" : "Videos"}`;
}

async function refresh() {
  const info = $("vl-info");
  try {
    const [data] = await Promise.all([api("/api/videos"), library.load()]);
    fillFilters();
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
    $("vl-choreo").addEventListener("change", () => { fillFilters(); render(); });
    $("vl-dance").addEventListener("change", render);
    $("vl-tag").addEventListener("change", render);
    window.addEventListener("librarychange", () => { fillFilters(); render(); });
  },
  show() {
    refresh();
  },
  hide() {},
};
