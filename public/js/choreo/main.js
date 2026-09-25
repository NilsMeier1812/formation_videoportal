// Einstieg des Choreo-Planers: setzt die Alpine-Komponente aus den Bereichen zusammen.
//
//   core      Grundzustand, abgeleitete Werte, Start
//   auth      Anmeldung (gemeinsam mit der ganzen App, siehe /js/session.js)
//   projects  Projekte laden/öffnen/anlegen/duplizieren/löschen, Einstellungen
//   audio     Musik laden, Wellenform, Wiedergabe
//   canvas    Taktraster, Schritt-Spuren, Playhead, Tippen in die Spuren
//   steps     Schritte und Notizen
//   segments  Sprungmarken
//   tempo     Tempo-Abschnitte
//   groups    Paare, Abschnitte, Gruppen, Zuteilung
//   editing   Bearbeiten an/aus (nur Trainer), Bearbeitungssperre
//
// Die Komponente hängt am <body> der App: Das gemeinsame Menü (Choreo-Wahl,
// Anmeldung, Hell/Dunkel) und die Dialoge liegen außerhalb des Planer-Bereichs,
// damit sie aus jedem Bereich heraus funktionieren.
//
// Datenzugriff läuft ausschließlich über ./data (siehe dort).
import Alpine from "/vendor/alpine.esm.js";
import { audio } from "./features/audio.js";
import { auth } from "./features/auth.js";
import { canvas } from "./features/canvas.js";
import { core } from "./features/core.js";
import { editing } from "./features/editing.js";
import { groups } from "./features/groups.js";
import { projects } from "./features/projects.js";
import { segments } from "./features/segments.js";
import { steps } from "./features/steps.js";
import { tempo } from "./features/tempo.js";

/**
 * Fügt die Bereiche zu einem Objekt zusammen. Anders als Object.assign bleiben
 * Getter dabei Getter (statt einmalig ausgewertet zu werden).
 */
function compose(...parts) {
  const target = {};
  for (const part of parts) {
    for (const key of Object.keys(part)) {
      if (Object.prototype.hasOwnProperty.call(target, key)) {
        throw new Error(`Doppelter Name im Planer: ${key}`);
      }
    }
    Object.defineProperties(target, Object.getOwnPropertyDescriptors(part));
  }
  return target;
}

Alpine.data("choreo", () =>
  compose(core(), auth(), projects(), audio(), canvas(), steps(), segments(), tempo(), groups(), editing())
);

window.Alpine = Alpine;
Alpine.start();
