// Player: ein Video mit Tempo und Spiegeln.
import { api, el, formatBytes, formatDate, formatDuration } from "./api.js";
import { registerServiceWorker } from "./pwa.js";
import { mountThemeButton } from "./theme-button.js";

mountThemeButton(document.getElementById("theme"));
registerServiceWorker();

const $ = (id) => document.getElementById(id);
const video = $("video");
const id = new URLSearchParams(location.search).get("id");

function showFacts(v) {
  const facts = [
    ["Aufgenommen", formatDate(v.recorded_at)],
    ["Kamera", v.camera],
    ["Hochgeladen von", v.uploaded_by],
    ["Länge", formatDuration(v.duration_s)],
    ["Größe", formatBytes(v.size_bytes)],
  ].filter(([, value]) => value);
  $("facts").append(...facts.flatMap(([k, value]) => [el("dt", {}, k), el("dd", {}, value)]));
}

function setupControls() {
  const rateButtons = document.querySelectorAll("[data-rate]");
  for (const button of rateButtons) {
    button.addEventListener("click", () => {
      video.playbackRate = Number(button.dataset.rate);
      for (const b of rateButtons) b.setAttribute("aria-pressed", String(b === button));
    });
  }
  // Manche Browser setzen das Tempo beim Laden zurück
  video.addEventListener("loadedmetadata", () => {
    const active = document.querySelector('[data-rate][aria-pressed="true"]');
    video.playbackRate = Number(active.dataset.rate);
  });

  const mirror = $("mirror");
  mirror.addEventListener("click", () => {
    const on = video.classList.toggle("mirrored");
    mirror.setAttribute("aria-pressed", String(on));
  });
}

try {
  if (!id) throw new Error("Kein Video angegeben");
  const v = await api(`/api/videos/${encodeURIComponent(id)}`);
  document.title = `${v.title || "Video"} · Formation`;
  $("title").textContent = v.title || "Ohne Titel";
  video.src = v.playback_url;
  if (v.thumb_url) video.poster = v.thumb_url;
  $("processing").hidden = v.is_processed;
  showFacts(v);
  setupControls();
  $("status").hidden = true;
  $("player").hidden = false;
} catch (err) {
  $("status").textContent = `Video konnte nicht geladen werden: ${err.message}`;
  $("status").className = "error";
}
