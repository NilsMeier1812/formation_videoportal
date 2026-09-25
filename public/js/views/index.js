// Die Video-Bereiche: werden beim ersten Öffnen eingerichtet, danach nur noch
// gezeigt und versteckt. Der Planer (Choreo) hängt sich selbst an "routechange".
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
  if (!mounted.has(view)) {
    view.mount();
    mounted.add(view);
  }
  view.show(router.route);
}

export function setupViews() {
  window.addEventListener("routechange", ({ detail }) => {
    if (detail.prev !== detail.view) VIEWS[detail.prev]?.hide();
    showCurrent();
  });

  // Reiter „Zuordnen“ nur für Trainer, mit Zahl der neuen Videos
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
