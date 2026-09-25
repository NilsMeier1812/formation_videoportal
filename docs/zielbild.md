# Formation-App – Zielbild

Stand: 25.09.2026 · @Nils

Aus dem Videoportal und dem Choreo-Planer wird **eine** App für die Formation:
eine Adresse (`formation.nils-meier.de`), ein Menü, ein Login, eine installierbare PWA.
Alles läuft bei Cloudflare.

## Zielarchitektur

```
formation.nils-meier.de            EIN Worker, EINE Seite (Bereiche werden nur umgeschaltet)
 ├─ /               Choreo-Planer   (Musik, Taktraster, Schritte, Gruppen, Sprungmarken)
 ├─ /videos …       Videos          (Liste, Player, Upload unter /upload, später Tagging + Suche)
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
| **C** | Ein Login-Modell für alles: Codes (Gruppe, Trainer) statt Supabase-Passwort, als Cookie für ein Jahr gemerkt | **erledigt** |
| **E** | Einheitliches Aussehen: Hell/Dunkel wählbar (Automatisch/Hell/Dunkel), untere Navigation Choreo · Videos · Hochladen, Video-Seiten neu | **erledigt** |
| **F** | Eine Seite statt einzelner Seiten (kein Neuladen beim Wechsel), gemeinsames Menü mit Anmeldung und Choreo-Wahl, „Bearbeiten“ nur für Trainer | **erledigt** |
| **D** | Videos ↔ Choreo: Choreos/Tänze/Audios/Tags, Hochladen ohne Angaben, Zuordnen (Admin), Tab „Videos“ im Planer, Filter in der Videothek | **erledigt** |

Der Umsetzungsplan fürs Videoportal (`docs/umsetzungsplan.md`) gilt weiter, wo er nicht durch Schritt D ersetzt ist
(Datenmodell der Videos: `migrations/0003_choreos_and_tagging.sql`).

## Choreos, Tänze, Audios, Videos (Schritt D)

```
Choreo ── genau eine Hauptaudio (choreos.main_project_id)
 ├─ Tänze   (dances)
 ├─ Audios  (projects = Planer-Projekte; project_dances: welche Tänze eine Audio enthält)
 └─ Videos  (video.choreo_id; video_dances; video_tags; audio_project_id + audio_start_s/audio_end_s)
```

- **Hochladen:** nur die Datei (und optional der Name). `public/js/lib/mp4meta.js` liest Aufnahmezeit
  (Apple `creationdate` mit Zeitzone, sonst `mvhd`) und Länge aus der Datei – nur das Inhaltsverzeichnis,
  nicht das ganze Video. Fehlt beides, gilt das Dateidatum (`recorded_source = 'file'`). Das Vorschaubild
  (`thumb/<id>.jpg`) erzeugt der Browser.
- **Eingang:** alle Videos mit `tag_state = 'untagged'`, nach Tag und Uhrzeit. Überschneiden sich
  Aufnahmezeiten (Start bis Start + Länge, 5 s Spielraum), stehen die Videos als „gleichzeitig gefilmt“ zusammen.
- **Zuordnen:** eines oder mehrere Videos auf einmal (`POST /api/videos/assign`). Die Stelle (von–bis) wird im
  Planer gewählt: Der Admin-Bereich schickt `pick-range`, der Planer öffnet die Audio mit dem Tab „Stelle wählen“
  und meldet `range-picked` zurück. Die Zeiten beziehen sich auf die gewählte Audio (in der Regel die Hauptaudio);
  wird die Audio gelöscht, entfallen sie.
- **Finden:** Tab „Videos“ im Planer (Videos, deren von–bis die aktuelle Position enthält; ohne Treffer die
  Bereiche mit Videos zum Hinspringen) und die Videothek mit Filtern.

## Eine Seite

- `public/index.html` enthält alle Bereiche. `public/js/router.js` ordnet Adressen den Bereichen zu und schaltet um;
  alte Adressen werden umgeschrieben. Der Worker liefert für jede unbekannte Adresse `index.html`
  (`not_found_handling = "single-page-application"`).
- Unsichtbare Bereiche sind nur versteckt (`visibility`), nicht entfernt: Der Planer behält Musik, Position, Zoom
  und seine Maße; Listen behalten die Scroll-Position; ein Upload läuft weiter.
- Beim Verlassen des Planers hält die Musik an. Startet man über einen Video-Link, lädt die Musik erst, wenn der
  Planer geöffnet wird.
- **Menü und Dialoge** gehören zur Planer-Komponente (Alpine, am `<body>`), liegen aber außerhalb des
  Planer-Bereichs und funktionieren überall. Die Video-Bereiche (reines JS) öffnen das Menü über das Ereignis
  `open-menu`.
- **Anmeldung:** `public/js/session.js` für alle Bereiche; Änderungen gehen als Ereignis `sessionchange` an alle.
  Offline gilt die zuletzt bekannte Rolle (der Server prüft beim Synchronisieren ohnehin selbst).
- **Gewählte Choreo** gilt für die ganze App (`selectedProjectId`); das Menü zeigt die Audios nach Choreos
  gruppiert (★ = Hauptaudio). Der Admin-Bereich schlägt sie beim Zuordnen neuer Videos vor.

## Aussehen

- Farben für Hell und Dunkel stehen in `public/css/theme.css`. Die dunklen Werte sind exakt die des alten
  Planers; auch Welle, Taktraster und Spuren lesen ihre Farben dort (`--wave-*`, `--grid-*`, `--lane-*`).
- `public/js/theme.js` setzt das Thema vor dem ersten Zeichnen (kein Aufblitzen) und merkt sich die Wahl.
- `public/css/shell.css`: Seite, Bereiche, Kopfzeile (`.appbar`, `.menu-btn` – überall gleich), untere Navigation,
  Hell/Dunkel-Auswahl.
- `public/css/app.css` gilt nur in den Video-Bereichen (`.vpage`), damit nichts in den Planer durchschlägt.

## Aufbau des Planers (`public/js/choreo/`)

```
main.js            setzt die Alpine-Komponente aus den Bereichen zusammen (hängt am <body> der App)
config.js          Einstellungen (Zeiten, Sperre, Version)
runtime.js         nicht-reaktiver Laufzeitzustand (Wavesurfer, Canvas, Timer)
lib/timeline.js    reine Rechenlogik: Takt, Beats, Bereiche, Gruppen – getestet
lib/util.js        kleine Helfer
data/api.js        EINZIGE Stelle, die das Backend kennt (/api/choreo, /api/session)
data/local.js      IndexedDB: Spiegel, Audio-Cache, Warteschlange
data/repository.js offline-fähiges Lesen/Schreiben, verzögertes Speichern – getestet
data/index.js      Verdrahtung (hier wird der Adapter gewählt)
features/*.js      Bereiche: core, auth, projects, audio, canvas, steps, segments, tempo, groups, editing, videos
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
5. `formation.nils-meier.de` öffnen, mit dem Trainer-Code anmelden, stichprobenartig vergleichen.
6. Der Gruppe den neuen Link geben. Wer den alten Planer installiert hat, fügt die neue App einmal neu zum
   Homescreen hinzu. Den alten Planer auf Vercel danach abschalten oder mit einem Hinweis versehen.

Die Übernahme lässt sich wiederholen: Bestehende Zeilen werden aktualisiert, nichts wird verdoppelt.
Was nach der Übernahme im neuen Planer entstanden ist, bleibt erhalten.
