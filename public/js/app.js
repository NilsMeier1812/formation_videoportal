// Einstieg der Formation-App (eine Seite für alles, siehe router.js).
//
//   router.js        welcher Bereich gerade offen ist (Adresse ↔ Bereich)
//   session.js       Anmeldung (Gruppen-/Trainer-Code), gilt überall
//   views/           Videothek, Player, Hochladen (reines JS)
//   choreo/main.js   Planer + gemeinsames Menü (Alpine)
import { registerServiceWorker } from "./pwa.js";
import { router } from "./router.js";
import { setupViews } from "./views/index.js";

setupViews();
router.start();
await import("./choreo/main.js");
registerServiceWorker();
