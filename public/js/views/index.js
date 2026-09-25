// Die Video-Bereiche: werden beim ersten Öffnen eingerichtet, danach nur noch
// gezeigt und versteckt. Der Planer (Choreo) hängt sich selbst an "routechange".
import { session } from "../session.js";
import { adminView, refreshInboxBadge } from "./admin.js";
import { playerView } from "./player.js";
import { uploadView } from "./upload.js";
import { videosView } from "./videos.js";

const VIEWS = { videos: videosView, upload: uploadView, player: playerView, admin: adminView };
const mounted = new Set();

export function setupViews() {
  window.addEventListener("routechange", ({ detail }) => {
    if (detail.prev !== detail.view) VIEWS[detail.prev]?.hide();
    const view = VIEWS[detail.view];
    if (!view) return;
    if (!mounted.has(view)) {
      view.mount();
      mounted.add(view);
    }
    view.show(detail);
  });

  // Reiter „Zuordnen“ nur für Trainer, mit Zahl der neuen Videos
  const showAdminTab = () => {
    document.querySelector('.bottom-nav [data-tab="admin"]').hidden = !session.isTrainer;
    refreshInboxBadge();
  };
  window.addEventListener("sessionchange", showAdminTab);
  session.restore().then(showAdminTab);

  // Menü-Knopf der Video-Bereiche öffnet das gemeinsame Menü (liegt beim Planer)
  document.addEventListener("click", (event) => {
    if (event.target.closest?.("[data-open-menu]")) window.dispatchEvent(new Event("open-menu"));
  });
}
