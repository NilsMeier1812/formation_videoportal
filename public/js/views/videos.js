// Videothek: alle Videos, durchsuchbar. Wird beim ersten Öffnen geladen und
// bei jedem weiteren Öffnen still aufgefrischt (z. B. nach einem Upload).
import { api, el, formatDate, formatDuration, icon } from "../api.js";

const PLAY = '<path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/>';
const VIDEO = '<rect x="2" y="6" width="14" height="12" rx="2"/><path d="m16 10 6-3v10l-6-3"/>';

const $ = (id) => document.getElementById(id);
let videos = [];
let loaded = ""; // zuletzt gezeigter Stand (JSON) – nur neu zeichnen, wenn sich etwas geändert hat

/** Suchtext eines Videos: alles, wonach man sinnvoll suchen kann. */
function haystack(v) {
  return [v.title, v.uploaded_by, v.camera, formatDate(v.recorded_at), v.recorded_at]
    .filter(Boolean).join(" ").toLowerCase();
}

function card(video) {
  const sub = [formatDate(video.recorded_at), video.camera, video.uploaded_by].filter(Boolean).join(" · ");
  return el("li", { class: "video-card" },
    el("a", { href: `/videos/${encodeURIComponent(video.id)}` },
      el("div", { class: "thumb" },
        video.thumb_url && el("img", { src: video.thumb_url, alt: "", loading: "lazy" }),
        el("span", { class: "play" }, icon(PLAY, 22)),
        !video.is_processed && el("span", { class: "chip left" }, "wird aufbereitet"),
        video.duration_s && el("span", { class: "chip right" }, formatDuration(video.duration_s)),
      ),
      el("div", { class: "meta" },
        el("div", { class: "title" }, video.title || "Ohne Titel"),
        sub && el("div", { class: "sub" }, sub),
      ),
    ),
  );
}

function render() {
  const info = $("vl-info");
  const list = $("vl-videos");
  const words = $("vl-q").value.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = videos.filter((v) => words.every((w) => haystack(v).includes(w)));
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
  info.textContent = words.length
    ? `${shown.length} von ${videos.length} Videos`
    : `${videos.length} ${videos.length === 1 ? "Video" : "Videos"}`;
}

async function refresh() {
  const info = $("vl-info");
  try {
    const data = await api("/api/videos");
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
  },
  show() {
    refresh();
  },
  hide() {},
};
