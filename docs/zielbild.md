# Formation-App – Zielbild

Stand: 25.09.2026 · @Nils

Aus dem Videoportal und dem Choreo-Planer wird **eine** App für die Formation:
eine Adresse (`formation.nils-meier.de`), ein Menü, ein Login, eine installierbare PWA.
Alles läuft bei Cloudflare.

## Zielarchitektur

```
formation.nils-meier.de            EIN Worker
 ├─ /choreo/        Choreo-Planer   (Musik, Taktraster, Schritte, Gruppen, Sprungmarken)
 ├─ /  /upload …    Videos          (Upload, Liste, Player, später Tagging + Suche)
 ├─ /api/*          API             (D1 für Daten, R2 für Dateien)
 └─ /sw.js          eine PWA        (offline: App-Dateien + lokaler Datenspiegel)

media.formation.nils-meier.de      R2 – Videos (und ab Schritt B die Musik)
```

## Grundsätze

- **Kein Build-Schritt.** HTML, CSS und JS werden so ausgeliefert, wie sie im Repo liegen.
  Bibliotheken liegen unter `public/vendor/` (von `npm run vendor` erzeugt), nicht auf fremden CDNs.
- **Alpine.js** für Screens mit viel Interaktion (Planer, später Tagging). Einfache Seiten bleiben
  reines JS. Große Screens werden aus kleinen Bereichen zusammengesetzt, nicht in eine Riesenkomponente.
- **Eine Datenschicht pro Bereich.** Nur eine Datei kennt das Backend; der Rest spricht mit ihr.
  So lässt sich das Backend tauschen, ohne die Oberfläche anzufassen.
- **Offline zuerst im Planer.** Lesen fällt auf den lokalen Spiegel zurück, Schreiben landet ohne Netz
  in einer Warteschlange. Videos werden nicht offline gespeichert.
- **Jeder Schritt ist lauffähig.** Nach jedem Schritt funktioniert alles; man kann jederzeit anhalten.

## Schritte

| Schritt | Inhalt | Stand |
| --- | --- | --- |
| **A** | Planer ins Repo holen, in Module zerlegen, unter `/choreo/` ausliefern (noch gegen Supabase), gemeinsames Menü, eine PWA | **erledigt** |
| **B** | Planer-Daten nach D1, Musik nach R2, API im Worker inkl. Bearbeitungssperre; Adapter tauschen; Übernahme der Daten per GitHub-Workflow; Umstieg der Gruppe | **erledigt** (Übernahme startest du, siehe unten) |
| **C** | Ein Login-Modell für alles: Codes (Gruppe, Trainer) statt Supabase-Passwort, als Cookie für ein Jahr gemerkt | **im Planer erledigt**; Video-Seiten folgen mit dem Frontend-Umbau |
| **E** | Einheitliches Aussehen: Hell/Dunkel wählbar (Automatisch/Hell/Dunkel), untere Navigation Choreo · Videos · Hochladen, Video-Seiten neu | **erledigt** |
| **D** | Videos ↔ Choreo verknüpfen (siehe unten) | als Nächstes |

Der Umsetzungsplan fürs Videoportal (`docs/umsetzungsplan.md`) gilt weiter; seine Phase 2 wird zu Schritt D
und nutzt die Choreos und Sprungmarken des Planers statt einer eigenen Verwaltung.

## Videos finden – zwei Wege (Schritt D)

1. **Videothek** (Reiter *Videos*): alle Videos, durchsuchbar und filterbar (Choreo, Datum, Kamera, Video-Art).
2. **Im Planer** (Reiter *Choreo*): Stelle im Lied antippen (Sprungmarke oder Zeitleiste) → ein neuer Tab unten
   zeigt die Videos zu dieser Stelle, jeweils mit Sprung an die passende Zeit. Dort wird auch getaggt
   (Clip → Sprungmarke, Durchlauf → Musikstart setzen).

## Aussehen

- Farben für Hell und Dunkel stehen in `public/css/theme.css`. Die dunklen Werte sind exakt die des alten
  Planers; auch Welle, Taktraster und Spuren lesen ihre Farben dort (`--wave-*`, `--grid-*`, `--lane-*`).
- `public/js/theme.js` setzt das Thema vor dem ersten Zeichnen (kein Aufblitzen) und merkt sich die Wahl.
- `public/css/shell.css`: untere Navigation und Hell/Dunkel-Auswahl – gemeinsam für alle Seiten.

## Aufbau des Planers (`public/js/choreo/`)

```
main.js            setzt die Alpine-Komponente aus den Bereichen zusammen
config.js          Einstellungen (Supabase, Zeiten, Sperre)
runtime.js         nicht-reaktiver Laufzeitzustand (Wavesurfer, Canvas, Timer)
lib/timeline.js    reine Rechenlogik: Takt, Beats, Bereiche, Gruppen – getestet
lib/util.js        kleine Helfer
data/api.js        EINZIGE Stelle, die das Backend kennt (/api/choreo, /api/session)
data/local.js      IndexedDB: Spiegel, Audio-Cache, Warteschlange
data/repository.js offline-fähiges Lesen/Schreiben, verzögertes Speichern – getestet
data/index.js      Verdrahtung (hier wird der Adapter gewählt)
features/*.js      Bereiche: core, auth, projects, audio, canvas, steps, segments, tempo, groups, editing
```

## Umzug der Daten (Schritt B)

**Wie es jetzt aussieht:**

- Die Planer-Tabellen liegen in D1 (`migrations/0002_choreo_planner.sql`), gleiche Spalten und IDs wie in Supabase.
- Die API steht in `src/routes/choreo.js`:
  - Lesen dürfen alle; private Projekte sehen nur Trainer (das prüft jetzt der Server, nicht mehr der Browser).
  - Schreiben geht nur mit Trainer-Code.
  - Die Bearbeitungssperre hat eigene Endpunkte.
- Die Musik liegt in R2 unter `audio/` und wird über `/api/choreo/audio/<datei>` ausgeliefert.
- **Login:** `POST /api/session` mit dem Code setzt ein HttpOnly-Cookie, das ein Jahr gilt. Es ist mit dem Code
  signiert: Wird ein Code geändert, sind alle Anmeldungen dieser Rolle automatisch ungültig.
  - Zum Bearbeiten im Planer braucht es den **Trainer-Code** (Secret `TAGGER_CODE`).
  - Das alte Editor-Passwort gilt nicht mehr.
- **Übernahme:** der Workflow `.github/workflows/choreo-migration.yml` („Choreo-Daten übernehmen“) mit dem Skript
  `scripts/migrate-from-supabase.mjs`. Supabase wird dabei nur gelesen.

**Umstieg – so gehst du vor:**

1. Pull Request mergen. Danach sind die neuen Tabellen da, aber noch leer: `/choreo/` zeigt vorerst keine Projekte.
2. GitHub → *Actions* → **Choreo-Daten übernehmen** → *Run workflow* → `probelauf`. In der Zusammenfassung
   des Laufs stehen die Anzahlen pro Tabelle, die Musikdateien und Hinweise (z. B. verwaiste Zeilen oder
   Spalten, die nicht übernommen werden).
3. Passt der Bericht: der Gruppe sagen, dass im alten Planer gerade niemand bearbeiten soll.
4. Denselben Workflow mit `uebernehmen` starten. Am Ende stehen die Anzahlen in Cloudflare in der Zusammenfassung.
5. `formation.nils-meier.de/choreo/` öffnen, mit dem Trainer-Code anmelden, stichprobenartig vergleichen.
6. Der Gruppe den neuen Link geben. Wer den alten Planer installiert hat, fügt die neue App einmal neu zum
   Homescreen hinzu. Den alten Planer auf Vercel danach abschalten oder mit einem Hinweis versehen.

Die Übernahme lässt sich wiederholen: Bestehende Zeilen werden aktualisiert, nichts wird verdoppelt.
Was nach der Übernahme im neuen Planer entstanden ist, bleibt erhalten.
