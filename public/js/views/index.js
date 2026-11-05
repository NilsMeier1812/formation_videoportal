// Die Video-Bereiche: werden beim ersten Öffnen eingerichtet, danach nur noch
// gezeigt und versteckt. Der Planer (Choreo) hängt sich selbst an "routechange".
import { el } from "../api.js";
import { router } from "../router.js";
import { session } from "../session.js";
import { adminView, refreshInboxBadge } from "./admin.js";
import { playerView } from "./player.js";
import { uploadView } from "./upload.js";
import { videosView } from "./videos.js";

const VIEWS = { videos: videosView, upload: uploadView, player: playerView, admin: adminView };
const mounted = new Set();

/** Offenen Bereich zeigen – aber erst, wenn jemand angemeldet ist (die App ist privat). */
function showCurrent() {
  const view = VIEWS[router.view];
  if (!view || !session.role) return;
  try {
    if (!mounted.has(view)) {
      mounted.add(view);
      view.mount();
    }
    view.show(router.route);
  } catch (err) {
    // Ein kaputter Bereich soll die anderen nicht mitreißen – und nicht ewig „Lade …“ zeigen
    console.error(err);
    showBroken(router.view);
  }
}

/** Hinweis im Bereich: etwas passt nicht (meist: Seite veraltet) – mit „Neu laden“. */
function showBroken(name) {
  const main = document.querySelector(`.view[data-view="${name}"] main`);
  if (!main || main.querySelector(".view-broken")) return;
  main.prepend(el("p", { class: "notice view-broken" },
    "Dieser Bereich konnte nicht geladen werden. ",
    el("button", { type: "button", class: "link", onclick: () => location.reload() }, "Neu laden")));
}

export function setupViews() {
  window.addEventListener("routechange", ({ detail }) => {
    if (detail.prev !== detail.view) VIEWS[detail.prev]?.hide();
    showCurrent();
  });

  // Reiter „Verwalten“ nur für Trainer, mit Zahl der neuen Videos
  const showAdminTab = () => {
    document.querySelector('.bottom-nav [data-tab="admin"]').hidden = !session.isTrainer;
    refreshInboxBadge();
  };
  window.addEventListener("sessionchange", showAdminTab);
  // Nach dem Anmelden (Anmeldebildschirm) den offenen Bereich (neu) laden
  window.addEventListener("sessionchange", ({ detail }) => {
    if (!detail.role) return;
    window.dispatchEvent(new Event("videos-changed"));
    showCurrent();
  });
  session.restore().then(() => { showAdminTab(); showCurrent(); });

  // Menü-Knopf der Video-Bereiche öffnet das gemeinsame Menü (liegt beim Planer)
  document.addEventListener("click", (event) => {
    if (event.target.closest?.("[data-open-menu]")) window.dispatchEvent(new Event("open-menu"));
  });
}
