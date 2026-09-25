import { api, el, formatDate } from "./api.js";

const status = document.getElementById("status");
const list = document.getElementById("videos");

function card(video) {
  const thumb = video.thumb_url
    ? el("img", { src: video.thumb_url, alt: "", loading: "lazy" })
    : "▶";
  const sub = [formatDate(video.recorded_at), video.camera, video.uploaded_by]
    .filter(Boolean)
    .join(" · ");

  return el("li", { class: "video-card" },
    el("a", { href: `/video?id=${encodeURIComponent(video.id)}` },
      el("div", { class: "thumb" },
        thumb,
        !video.is_processed && el("span", { class: "badge" }, "wird aufbereitet"),
      ),
      el("div", { class: "meta" },
        el("div", { class: "title" }, video.title || "Ohne Titel"),
        el("div", { class: "sub" }, sub),
      ),
    ),
  );
}

try {
  const { videos } = await api("/api/videos");
  status.textContent = videos.length ? "" : "Noch keine Videos. Lade das erste hoch!";
  list.append(...videos.map(card));
} catch (err) {
  status.textContent = `Videos konnten nicht geladen werden: ${err.message}`;
  status.className = "error";
}
