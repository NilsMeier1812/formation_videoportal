// Player: ein Video mit wählbarem Tempo.
import { api, el, formatBytes, formatDate, formatDuration } from "../api.js";
import { router } from "../router.js";

const $ = (id) => document.getElementById(id);
let currentId = null;
let loadToken = 0;

function showFacts(v) {
  const facts = [
    ["Aufgenommen", formatDate(v.recorded_at)],
    ["Kamera", v.camera],
    ["Hochgeladen von", v.uploaded_by],
    ["Länge", formatDuration(v.duration_s)],
    ["Größe", formatBytes(v.size_bytes)],
  ].filter(([, value]) => value);
  $("pl-facts").replaceChildren(...facts.flatMap(([k, value]) => [el("dt", {}, k), el("dd", {}, value)]));
}

function activeRate() {
  return Number(document.querySelector('#pl-rates [aria-pressed="true"]').dataset.rate);
}

async function load(id) {
  const token = ++loadToken;
  const video = $("pl-video");
  currentId = id;
  video.pause();
  video.removeAttribute("src");
  video.removeAttribute("poster");
  video.load();
  $("pl-title").textContent = "Video";
  $("pl-box").hidden = true;
  $("pl-status").hidden = false;
  $("pl-status").textContent = "Lade …";
  $("pl-status").className = "muted";

  try {
    const v = await api(`/api/videos/${encodeURIComponent(id)}`);
    if (token !== loadToken) return; // inzwischen ein anderes Video gewählt
    document.title = `${v.title || "Video"} · Formation`;
    $("pl-title").textContent = v.title || "Ohne Titel";
    video.src = v.playback_url;
    if (v.thumb_url) video.poster = v.thumb_url;
    $("pl-processing").hidden = v.is_processed;
    showFacts(v);
    $("pl-status").hidden = true;
    $("pl-box").hidden = false;
  } catch (err) {
    if (token !== loadToken) return;
    currentId = null; // beim nächsten Öffnen erneut versuchen
    $("pl-status").textContent = `Video konnte nicht geladen werden: ${err.message}`;
    $("pl-status").className = "error";
  }
}

export const playerView = {
  mount() {
    const video = $("pl-video");
    const rateButtons = document.querySelectorAll("#pl-rates [data-rate]");
    for (const button of rateButtons) {
      button.addEventListener("click", () => {
        video.playbackRate = Number(button.dataset.rate);
        for (const b of rateButtons) b.setAttribute("aria-pressed", String(b === button));
      });
    }
    // Manche Browser setzen das Tempo beim Laden zurück
    video.addEventListener("loadedmetadata", () => { video.playbackRate = activeRate(); });
    $("pl-back").addEventListener("click", () => router.back("/videos"));
  },
  show({ id }) {
    if (id === currentId) {
      // Dasselbe Video wie zuletzt: Stand behalten (Position, Tempo)
      document.title = `${$("pl-title").textContent} · Formation`;
      return;
    }
    load(id);
  },
  hide() {
    $("pl-video").pause();
  },
};
