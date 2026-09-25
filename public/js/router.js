// Die App ist EINE Seite. Die Bereiche liegen nebeneinander im Dokument und
// werden nur umgeschaltet – nichts lädt neu, der Planer behält Musik, Position
// und Ansicht, ein laufender Upload läuft weiter.
//
//   /                Choreo (Planer)       früher /choreo/
//   /videos          Videothek             früher /
//   /videos/<id>     Player                früher /video?id=<id>
//   /upload          Hochladen
//
// Alte Adressen (geteilte Links, installierte App) werden auf die neuen umgeschrieben.
// Bei jedem Wechsel feuert window "routechange" (detail: { view, prev, id }).

const TITLES = {
  choreo: "Choreo · Formation",
  videos: "Videos · Formation",
  upload: "Hochladen · Formation",
  player: "Video · Formation",
};
/** Welcher Reiter der unteren Navigation zu einem Bereich gehört. */
const TAB_OF = { choreo: "choreo", videos: "videos", player: "videos", upload: "upload" };

/** Adresse → Bereich. Unbekanntes landet im Planer. */
export function parse(url) {
  const path = url.pathname.replace(/\/index\.html$/, "/").replace(/\.html$/, "").replace(/(.)\/$/, "$1");
  if (path === "/videos") return { view: "videos", path: "/videos" };
  const m = path.match(/^\/videos\/([^/]+)$/);
  if (m) return player(decodeURIComponent(m[1]));
  if (path === "/video") {
    const id = url.searchParams.get("id");
    return id ? player(id) : { view: "videos", path: "/videos" };
  }
  if (path === "/upload") return { view: "upload", path: "/upload" };
  return { view: "choreo", path: "/" };
}

function player(id) {
  return { view: "player", id, path: `/videos/${encodeURIComponent(id)}` };
}

let current = null; // wird in start() gesetzt
let index = 0; // Position im Verlauf der App (für „Zurück“)

function apply(route) {
  const prev = current.view;
  current = route;
  document.body.dataset.view = route.view;
  for (const section of document.querySelectorAll(".view")) {
    const active = section.dataset.view === route.view;
    section.classList.toggle("active", active);
    section.inert = !active; // unsichtbare Bereiche: kein Fokus, keine Klicks
  }
  for (const link of document.querySelectorAll(".bottom-nav [data-tab]")) {
    if (link.dataset.tab === TAB_OF[route.view]) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  if (route.view !== "player") document.title = TITLES[route.view];
  window.dispatchEvent(new CustomEvent("routechange", { detail: { view: route.view, prev, id: route.id } }));
}

export const router = {
  get view() { return current.view; },
  get route() { return current; },

  navigate(href, { replace = false } = {}) {
    const route = parse(new URL(href, location.origin));
    if (route.path === current.path) {
      // Nochmal auf den offenen Reiter getippt → nach oben
      document.querySelector(`.view[data-view="${route.view}"].vpage`)?.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    if (replace) history.replaceState({ index }, "", route.path);
    else history.pushState({ index: ++index }, "", route.path);
    apply(route);
  },

  /** Zurück innerhalb der App – oder, wenn man direkt hier gelandet ist, zu `fallback`. */
  back(fallback) {
    if (index > 0) history.back();
    else router.navigate(fallback, { replace: true });
  },

  start() {
    current = parse(new URL(location.href));
    index = history.state?.index ?? 0;
    history.replaceState({ index }, "", current.path + location.hash);
    window.addEventListener("popstate", (event) => {
      index = event.state?.index ?? 0;
      apply(parse(new URL(location.href)));
    });
    // Links innerhalb der App abfangen, statt die Seite neu zu laden
    document.addEventListener("click", (event) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target.closest?.("a[href]");
      if (!link || link.target || link.hasAttribute("download")) return;
      const url = new URL(link.href);
      if (url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
      event.preventDefault();
      router.navigate(url.pathname + url.search);
    });
    apply(current);
  },
};
