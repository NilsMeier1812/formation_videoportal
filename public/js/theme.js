// Hell/Dunkel für die ganze App. Wird als normales (blockierendes) Skript im
// <head> geladen, damit das Thema feststeht, bevor die Seite gezeichnet wird –
// sonst blitzt beim Laden kurz das falsche Thema auf.
//
//   Modus "system" (Standard) folgt der Einstellung des Handys/PCs,
//   "light" und "dark" legen fest. Gemerkt wird die Wahl im Browser.
//
// Bei jedem Wechsel feuert window das Ereignis "themechange" (detail: { mode, dark }).
(function () {
  var KEY = "formation.theme";
  var MODES = ["system", "light", "dark"];
  var media = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

  function stored() {
    try {
      var mode = localStorage.getItem(KEY);
      return MODES.indexOf(mode) >= 0 ? mode : "system";
    } catch (e) {
      return "system";
    }
  }

  function apply(mode) {
    var dark = mode === "dark" || (mode === "system" && !!media && media.matches);
    var root = document.documentElement;
    root.setAttribute("data-theme", dark ? "dark" : "light");
    root.setAttribute("data-theme-mode", mode);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", dark ? "#121212" : "#f4f5f8");
    window.dispatchEvent(new CustomEvent("themechange", { detail: { mode: mode, dark: dark } }));
  }

  window.formationTheme = {
    modes: MODES,
    labels: { system: "Automatisch", light: "Hell", dark: "Dunkel" },
    get mode() { return stored(); },
    set: function (mode) {
      try { localStorage.setItem(KEY, mode); } catch (e) { /* dann eben nur für diese Seite */ }
      apply(mode);
    },
    /** Automatisch → Hell → Dunkel → Automatisch */
    cycle: function () {
      this.set(MODES[(MODES.indexOf(stored()) + 1) % MODES.length]);
    },
  };

  if (media && media.addEventListener) {
    media.addEventListener("change", function () {
      if (stored() === "system") apply("system");
    });
  }
  apply(stored());
})();
