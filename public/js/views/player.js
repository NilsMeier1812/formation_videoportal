// Player: ein Video mit wählbarem Tempo, dazu die Zuordnung (Choreo, Tänze, Tags,
// Stelle in der Musik). Trainer können von hier aus die Zuordnung bearbeiten.
import { api, el, formatBytes, formatDateTime, formatDuration } from "../api.js";
import { library } from "../library.js";
import { router } from "../router.js";
import { session } from "../session.js";

const $ = (id) => document.getElementById(id);
let currentId = null;
let loadToken = 0;
let stale = false; // Zuordnung wurde geändert → beim nächsten Zeigen neu laden

function showFacts(v) {
  const facts = [
    ["Aufgenommen", formatDateTime(v.recorded_at) + (v.recorded_source === "file" ? " (Dateidatum)" : "")],
    ["Hochgeladen von", v.uploaded_by],
    ["Länge", formatDuration(v.duration_s)],
    ["Größe", formatBytes(v.size_bytes)],
  ].filter(([, value]) => value);
  $("pl-facts").replaceChildren(...facts.flatMap(([k, value]) => [el("dt", {}, k), el("dd", {}, value)]));
}

const mmss = (sec) => {
  const s = Math.floor(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** Zuordnung als Zeilen + Knöpfe („In der Musik zeigen“, für Trainer „bearbeiten“). */
function showAssignment(v) {
  const choreo = library.choreo(v.choreo_id);
  const dances = v.dance_ids.map((id) => library.dance(id)?.name).filter(Boolean);
  const tags = v.tag_ids.map((id) => library.tag(id)?.name).filter(Boolean);
  const audio = library.audio(v.audio_project_id);
  const box = $("pl-assign");
  box.replaceChildren(
    choreo || tags.length
      ? el("div", { class: "pl-line" },
        choreo && el("strong", {}, [choreo.title, ...dances].join(" · ")),
        tags.length ? el("span", { class: "pl-tags" }, ...tags.map((t) => el("span", { class: "tag" }, t))) : null)
      : el("p", { class: "muted pl-line" }, "Noch nicht zugeordnet."),
    el("div", { class: "pl-actions" },
      v.audio_start_s != null && audio && el("button", {
        type: "button",
        onclick: () => {
          window.dispatchEvent(new CustomEvent("show-in-choreo", { detail: { projectId: v.audio_project_id, time: v.audio_start_s } }));
          router.navigate("/");
        },
      }, `♪ In der Musik zeigen (${mmss(v.audio_start_s)}–${mmss(v.audio_end_s)})`),
      session.isTrainer && v.processing === "failed" && el("button", {
        type: "button",
        onclick: async (e) => {
          e.currentTarget.disabled = true;
          try {
            const { started } = await api(`/api/videos/${v.id}/reprocess`, { method: "POST" });
            window.dispatchEvent(new CustomEvent("toast", { detail: started ? "Umwandlung neu gestartet" : "Umwandlung vorgemerkt" }));
          } catch (err) {
            window.dispatchEvent(new CustomEvent("toast", { detail: err.message }));
          }
        },
      }, "Neu umwandeln"),
      session.isTrainer && el("button", {
        type: "button",
        onclick: () => {
          router.navigate("/zuordnen");
          window.dispatchEvent(new CustomEvent("edit-videos", { detail: { ids: [v.id] } }));
        },
      }, "Zuordnung bearbeiten"),
    ),
  );
}

/** Hinweis, solange die Abspielfassung fehlt (bis dahin läuft das Original). */
function showProcessing(v) {
  const note = $("pl-processing");
  note.hidden = v.is_processed;
  note.textContent = v.processing === "failed"
    ? "Die Umwandlung ist fehlgeschlagen – es läuft die Originaldatei. iPhone-Videos spielen dann nicht überall."
    : "Wird noch umgewandelt (dauert meist wenige Minuten) – bis dahin läuft die Originaldatei. iPhone-Videos spielen auf manchen Geräten erst danach.";
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
    const [v] = await Promise.all([api(`/api/videos/${encodeURIComponent(id)}`), library.load().catch(() => {})]);
    if (token !== loadToken) return; // inzwischen ein anderes Video gewählt
    const title = library.videoTitle(v);
    document.title = `${title} · Formation`;
    $("pl-title").textContent = title;
    showAssignment(v);
    video.src = v.playback_url;
    if (v.thumb_url) video.poster = v.thumb_url;
    showProcessing(v);
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
    window.addEventListener("videos-changed", () => { stale = true; });
  },
  show({ id }) {
    // Nach dem Bearbeiten neu laden, sonst Stand behalten
    if (id === currentId && !stale) {
      // Dasselbe Video wie zuletzt: Stand behalten (Position, Tempo)
      document.title = `${$("pl-title").textContent} · Formation`;
      return;
    }
    stale = false;
    load(id);
  },
  hide() {
    $("pl-video").pause();
  },
};
