// Einstieg der Formation-App (eine Seite für alles, siehe router.js).
//
//   router.js        welcher Bereich gerade offen ist (Adresse ↔ Bereich)
//   build.js         Stand der App: passt die Seite zum Programm?
//   session.js       Anmeldung (Gruppen-/Trainer-Code), gilt überall
//   views/           Videothek, Player, Hochladen (reines JS)
//   choreo/main.js   Planer + gemeinsames Menü (Alpine)
import { checkBuild } from "./build.js";
import { registerServiceWorker } from "./pwa.js";
import { router } from "./router.js";
import { startUsage } from "./usage.js";
import { setupViews } from "./views/index.js";

// Seite aus dem Cache, Programm schon neuer (oder umgekehrt)? Dann einmal neu laden.
if (!checkBuild()) {
  setupViews();
  router.start();
  await import("./choreo/main.js");
  registerServiceWorker();
  startUsage(); // still im Hintergrund, siehe usage.js
}
