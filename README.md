# Formation-App

Choreo-Planer und Trainingsvideos der Formation – eine App unter `formation.nils-meier.de`.
Wohin es geht, steht in [`docs/zielbild.md`](docs/zielbild.md); der Plan fürs Videoportal in
[`docs/umsetzungsplan.md`](docs/umsetzungsplan.md).

**Aufbau:** Ein Cloudflare Worker liefert Frontend (`public/`, reines HTML/CSS/JS ohne Build)
und API (`src/`) aus. Daten liegen in D1 (`migrations/`), Videos und Musik in R2.

Die App ist **eine Seite** (`public/index.html`): Choreo, Videos und Hochladen liegen darin
nebeneinander und werden nur umgeschaltet – beim Wechsel lädt nichts neu.

```
public/index.html    die App (alle Bereiche)      public/js/app.js     Einstieg
public/js/router.js  Adresse ↔ Bereich            public/js/session.js Anmeldung (gilt überall)
public/js/views/     Videothek, Player, Upload    public/js/choreo/    Planer + Menü (Aufbau: docs/zielbild.md)
public/css/          theme, shell, choreo, app    public/vendor/       Bibliotheken (npm run vendor)
public/sw.js         Service Worker der PWA       src/index.js         Router der API (src/routes/, src/lib/)
migrations/          D1-Schema                    test/                Tests (Workers-Laufzeit)
scripts/             vendor.mjs, Übernahme aus Supabase (migrate-from-supabase.mjs)
```

## Stand

**Bereiche und Adressen:**

| Adresse | Bereich | früher |
| --- | --- | --- |
| `/` | Choreo (Planer) | `/choreo/` |
| `/videos` | Videothek | `/` |
| `/videos/<id>` | Player | `/video?id=<id>` |
| `/upload` | Hochladen | `/upload` |
| `/zuordnen` | Zuordnen (nur Trainer) | – |

Alte Adressen (geteilte Links, installierte App) funktionieren weiter und werden umgeschrieben.

**Menü** (☰ oben links, in jedem Bereich; im Planer auch über den Titel): Anmeldung, Choreo wählen
(gilt für die ganze App), neue Choreo anlegen (Trainer), Hell/Dunkel.

**Anmeldung** (`/api/session`): einmal Code eingeben → HttpOnly-Cookie für ein Jahr; gilt für die ganze App.
- ohne Anmeldung: ansehen und Training
- **Gruppen-Code** (Secret `GROUP_CODE`): zusätzlich Videos hochladen
- **Trainer-Code** (Secret `TAGGER_CODE`): zusätzlich Choreos bearbeiten – im Planer erscheint dann oben
  rechts **Bearbeiten** (setzt die Bearbeitungssperre, „Fertig“ gibt sie wieder frei)

**Choreo-Planer:** vom alten Repo `choreoplanner` übernommen und in Module zerlegt, Funktionen unverändert
(Taktraster, Schritte, Gruppen, Sprungmarken, Bearbeitungssperre, Offline-Betrieb). Daten in D1, Musik in R2,
API unter `/api/choreo/…`. Übernahme der alten Daten aus Supabase: siehe `docs/zielbild.md`.

**Choreos, Tänze, Audios, Tags:**
```
Choreo (z. B. „Kür 2026“) ── genau eine Hauptaudio
 ├─ Tänze    (z. B. Standard, Latein)
 ├─ Audios   (= Planer-Projekte; jede mit einem oder mehreren Tänzen)
 └─ Videos   (je Video: eine Choreo, mehrere Tänze, mehrere Tags, Stelle von–bis in einer Audio)
```

**Videos:**
- **Hochladen:** nur Datei(en) und optional der Name. Aufnahmezeit und Länge liest der Browser aus den
  Metadaten (MP4/MOV; sonst Dateidatum), das Vorschaubild erzeugt er selbst. Neue Videos landen im Eingang.
- **Zuordnen** (Reiter nur für Trainer, mit Zahl der neuen Videos): Eingang nach Tag und Uhrzeit, Videos mit
  überlappender Aufnahmezeit als „gleichzeitig gefilmt“ gruppiert. Eines oder mehrere wählen → Choreo, Tänze,
  Tags und die **Stelle in der Musik**: Der Planer öffnet sich mit „Stelle wählen“, das Video läuft mit,
  Start und Ende werden auf die Position gesetzt. Außerdem Choreos (Tänze, Audios, Hauptaudio) und Tags verwalten,
  Videos in den Papierkorb legen. **Projekt & Takt** einer Audio (Titel, privat, Tempo-Abschnitte) öffnet sich
  von hier aus im Planer, weil das Einstellen des Takts Welle und Raster braucht; „Fertig“ führt zurück.
- **Finden:** im Planer der Tab **Videos** (Videos an der aktuellen Stelle; nur Vorschaubilder, das Video lädt
  erst im Player) und die **Videothek** mit Suche und Filtern (Choreo, Tanz, Tag). Im Player: „In der Musik
  zeigen“ und für Trainer „Zuordnung bearbeiten“.
- API: `POST /api/videos` (+ `/complete`, `/thumb`), `GET /api/videos[/:id]`, `POST /api/videos/assign`,
  `DELETE /api/videos/:id` (Papierkorb), `GET /api/library`, `/api/choreos`, `/api/dances`, `/api/audios`, `/api/tags`.

**Rahmen:** gleiche Kopfzeile in allen Bereichen (☰ oben links, `.appbar` in `shell.css`), untere Navigation
(Choreo · Videos · Hochladen, für Trainer · Zuordnen), Hell/Dunkel wählbar (im Menü).

**Planer-Bedienung am PC:** in der Welle kurz klicken = an die Stelle springen, gedrückt halten und ziehen =
Welle verschieben. Schritt-Anzeige startet mit „123“.
Farben in `public/css/theme.css`.

**PWA:** ein Manifest und ein Service Worker für alles; startet im Planer, startet offline an jeder Adresse.

## Bibliotheken aktualisieren

Versionen stehen in `package.json` (`alpinejs`, `dexie`, `wavesurfer.js`).
Nach einem Update `npm run vendor` ausführen und `public/vendor/` mit committen.

## Lokal entwickeln

Voraussetzung: Node.js 20 oder neuer.

```bash
npm install
cp .dev.vars.example .dev.vars     # lokale Codes, Dev-Modus an
npm run db:migrate:local           # Schema in die lokale D1
npm run dev                        # http://localhost:8787
npm test                           # Tests
```

Lokal gibt es kein echtes R2 mit S3-Endpunkt. Im Dev-Modus (`DEV_MODE=1` in `.dev.vars`) läuft der
Upload deshalb über den Worker (`/api/dev-upload/…`) und die Videos kommen über `/api/dev-media/…`.
In Produktion sind diese Routen abgeschaltet.

## Deployment

Alles läuft über den Browser: GitHub Actions (`.github/workflows/deploy.yml`) testet jeden Push und
deployt `main` nach Cloudflare – erst die D1-Migrationen, dann den Worker. Ein Merge nach `main`
ist also ein Deploy.

### Einmalig einrichten

1. **Cloudflare-API-Token** – Cloudflare-Dashboard → Profil (oben rechts) → *API Tokens* →
   *Create Token* → Vorlage **Edit Cloudflare Workers** → *Use template*.
   - Unter *Permissions* eine Zeile ergänzen: **Account · D1 · Edit**.
   - *Account Resources*: dein Account. *Zone Resources*: *Specific zone* → `nils-meier.de`.
   - *Continue to summary* → *Create Token* → Token kopieren (wird nur einmal angezeigt).
2. **Token bei GitHub hinterlegen** – Repo → *Settings* → *Secrets and variables* → *Actions* →
   *New repository secret*: Name `CLOUDFLARE_API_TOKEN`, Wert = der Token.
3. **Branch `main` anlegen** – Repo → *Branches* (bzw. Branch-Auswahl oben links) → *New branch*:
   Name `main`, Quelle `claude/sleepy-hamilton-7guj78`. Danach unter *Settings* → *General* →
   *Default branch* auf `main` umstellen. Das Anlegen von `main` löst das erste Deployment aus
   (Tab *Actions*).
4. **Secrets des Workers** – nach dem ersten erfolgreichen Deploy im Cloudflare-Dashboard →
   *Workers & Pages* → `formation-portal` → *Settings* → *Variables and Secrets* → *Add*,
   jeweils Typ **Secret**:
   - `GROUP_CODE` – Code zum Hochladen
   - `TAGGER_CODE` – Trainer-Code: Choreos bearbeiten (und später taggen)
   - `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` – aus dem R2-API-Token

   Die Secrets bleiben bei späteren Deploys erhalten.

Danach unter https://formation.nils-meier.de/upload ein Video hochladen – zuerst vom PC-Browser.
Klappt der Upload nicht („Verbindung abgebrochen“), ist fast immer CORS am Bucket der Grund:
F12 → Reiter *Konsole* zeigt dann einen roten CORS-Fehler.

### Später: Änderungen

Neue Arbeit kommt als Pull Request. Die Tests laufen automatisch; *Merge* im Browser deployt.

### Alternativ vom eigenen Rechner

```bash
npm ci
npx wrangler login
npm run db:migrate:remote
npx wrangler secret put GROUP_CODE   # usw.
npm run deploy
```

## iPhone-Test

Siehe Plan, Abschnitt „iPhone-Test“. Kurz:

1. Vom iPhone über Safari hochladen – einmal aus „Fotos“, einmal aus „Dateien“. Dasselbe vom Android-Handy.
2. Originale im Cloudflare-Dashboard (R2 → Bucket → `raw/`) herunterladen und prüfen:
   ```bash
   ffprobe -v error -select_streams v:0 \
     -show_entries stream=codec_name,width,height,pix_fmt,color_transfer -of default=nw=1 datei.mov
   ```
   `codec_name=hevc` → Safari hat nicht umgewandelt. `color_transfer=arib-std-b67` → HDR (HLG).
3. Das Original durch den ffmpeg-Befehl aus dem Plan (Abschnitt „Workflow“) schicken und die
   Abspielfassung auf Android und iPhone ansehen – stimmen die Farben?
