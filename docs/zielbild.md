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
| **B** | Planer-Daten nach D1, Musik nach R2, API im Worker inkl. Bearbeitungssperre; Adapter tauschen; Übernahme der Daten per GitHub-Workflow; Umstieg der Gruppe | als Nächstes |
| **C** | Ein Login-Modell für alles: Codes (Gruppe, Trainer) statt Supabase-Passwort, als Cookie für ein Jahr gemerkt | mit/nach B |
| **D** | Videos ↔ Choreo verknüpfen: Sprungmarken als Abschnitte, Tagging, „Videos zu dieser Stelle" im Planer | Portal Phase 2 |

Der Umsetzungsplan fürs Videoportal (`docs/umsetzungsplan.md`) gilt weiter; seine Phase 2 wird zu Schritt D
und nutzt die Choreos und Sprungmarken des Planers statt einer eigenen Verwaltung.

## Aufbau des Planers (`public/js/choreo/`)

```
main.js            setzt die Alpine-Komponente aus den Bereichen zusammen
config.js          Einstellungen (Supabase, Zeiten, Sperre)
runtime.js         nicht-reaktiver Laufzeitzustand (Wavesurfer, Canvas, Timer)
lib/timeline.js    reine Rechenlogik: Takt, Beats, Bereiche, Gruppen – getestet
lib/util.js        kleine Helfer
data/supabase.js   EINZIGE Stelle, die Supabase kennt  ← wird in Schritt B ersetzt
data/local.js      IndexedDB: Spiegel, Audio-Cache, Warteschlange
data/repository.js offline-fähiges Lesen/Schreiben, verzögertes Speichern – getestet
data/index.js      Verdrahtung (hier wird der Adapter getauscht)
features/*.js      Bereiche: core, auth, projects, audio, canvas, steps, segments, tempo, groups, editing
```

## Umzug der Daten (Schritt B) – geplanter Ablauf

1. D1-Migration mit den Planer-Tabellen (`projects`, `tempo_sections`, `choreo_segments`, `persons`,
   `parts`, `group_memberships`, `steps`) – gleiche Spalten, gleiche IDs.
2. API-Endpunkte im Worker nach dem Muster von `data/supabase.js` (lesen, anlegen, ändern, löschen, Sperre).
3. `data/api.js` als neuer Adapter; in `data/index.js` umstellen.
4. GitHub-Workflow „Daten übernehmen": liest Supabase (öffentlicher Lese-Schlüssel), schreibt nach D1,
   kopiert die Audiodateien nach R2. Erst als Probelauf, dann echt.
5. Umstieg: Bearbeiten im alten Planer kurz anhalten, Übernahme starten, der Gruppe den neuen Link geben.
   Wer den alten Planer installiert hat, fügt die neue App einmal neu zum Homescreen hinzu.
