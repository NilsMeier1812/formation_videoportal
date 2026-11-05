// Stand der App-Dateien. Steht genauso in index.html (<html data-build>) und in sw.js
// (VERSION = "v…"); bei jeder Änderung an public/ alle drei hochzählen (Test prüft das).
//
// Wozu: Startet die App, während das Netz kurz weg ist, kommt die Seite aus dem Cache des
// Service Workers – das Programm aber vielleicht schon frisch vom Server. Passen Seite und
// Programm nicht zusammen, lädt app.js die Seite einmal neu (siehe checkBuild).
export const BUILD = "39";

const KEY = "formation.build_reload";

/**
 * Passt die Seite (HTML) zu diesem Programm? Wenn nicht: einmal neu laden.
 * Gibt true zurück, wenn neu geladen wird (dann nichts weiter starten).
 */
export function checkBuild() {
  const page = document.documentElement.dataset.build || "";
  if (page === BUILD) {
    try { sessionStorage.removeItem(KEY); } catch {}
    return false;
  }
  const pair = `${page}→${BUILD}`;
  let tried = false;
  try {
    tried = sessionStorage.getItem(KEY) === pair;
    sessionStorage.setItem(KEY, pair);
  } catch {}
  if (tried) return false; // schon versucht (z. B. offline) – mit dem weitermachen, was da ist
  location.reload();
  return true;
}
