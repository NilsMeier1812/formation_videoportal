# Formation-Videoportal

Trainingsvideos hochladen, mit Abschnitten der Choreo verknüpfen und darüber wiederfinden.
Der Plan dazu steht in [`docs/umsetzungsplan.md`](docs/umsetzungsplan.md).

**Aufbau:** Ein Cloudflare Worker liefert Frontend (`public/`, reines HTML/CSS/JS ohne Build)
und API (`src/`) aus. Metadaten liegen in D1 (`migrations/`), Videos in R2.

```
public/          Frontend: index.html (Liste), upload.html, video.html, css/, js/
src/index.js     Router der API
src/routes/      Endpunkte (videos.js; dev.js nur lokal)
src/lib/         Codes, Presigned URLs, Eingabeprüfung
migrations/      D1-Schema
test/            Tests (laufen lokal in der Workers-Laufzeit)
```

## Stand: Phase 1

- `POST /api/videos` – legt ein Video an (Gruppen-Code), gibt eine 15 Minuten gültige Upload-URL zurück
- `POST /api/videos/:id/complete` – prüft die Datei in R2 (Existenz, echte Größe, Content-Type)
- `GET /api/videos`, `GET /api/videos/:id` – Liste und Einzelvideo
- `GET /api/auth` – prüft einen Code
- Seiten: Videoliste, Upload (mehrere Dateien, Fortschritt, Bildschirm bleibt an), Player (Tempo, Spiegeln)

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
   - `TAGGER_CODE` – Code für Tagger (ab Phase 2 gebraucht)
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
