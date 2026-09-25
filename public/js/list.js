// Videothek: alle Videos, durchsuchbar.
import { api, el, formatDate, formatDuration, icon } from "./api.js";
import { registerServiceWorker } from "./pwa.js";
import { mountThemeButton } from "./theme-button.js";

mountThemeButton(document.getElementById("theme"));
registerServiceWorker();

const info = document.getElementById("info");
const list = document.getElementById("videos");
const search = document.getElementById("q");

const PLAY = '<path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/>';
const VIDEO = '<rect x="2" y="6" width="14" height="12" rx="2"/><path d="m16 10 6-3v10l-6-3"/>';

let videos = [];

/** Suchtext eines Videos: alles, wonach man sinnvoll suchen kann. */
function haystack(v) {
  return [v.title, v.uploaded_by, v.camera, formatDate(v.recorded_at), v.recorded_at]
    .filter(Boolean).join(" ").toLowerCase();
}

function card(video) {
  const sub = [formatDate(video.recorded_at), video.camera, video.uploaded_by].filter(Boolean).join(" · ");
  return el("li", { class: "video-card" },
    el("a", { href: `/video?id=${encodeURIComponent(video.id)}` },
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
  const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
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

search.addEventListener("input", render);

try {
  ({ videos } = await api("/api/videos"));
  render();
} catch (err) {
  info.textContent = `Videos konnten nicht geladen werden: ${err.message}`;
  info.className = "result-info error";
}
