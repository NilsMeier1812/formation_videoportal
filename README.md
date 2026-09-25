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

## Erstes Deployment (Schritt 3)

Einmalig, von deinem Rechner aus im Projektordner:

```bash
npm install
npx wrangler login

# 1. Schema in die echte D1
npm run db:migrate:remote

# 2. Secrets setzen – wrangler fragt jeweils verdeckt nach dem Wert
npx wrangler secret put GROUP_CODE            # Code zum Hochladen
npx wrangler secret put TAGGER_CODE           # Code für Tagger (ab Phase 2 gebraucht)
npx wrangler secret put R2_ACCESS_KEY_ID      # aus dem R2-API-Token
npx wrangler secret put R2_SECRET_ACCESS_KEY  # aus dem R2-API-Token

# 3. Deployen – legt auch die Domain formation.nils-meier.de an
npm run deploy
```

Falls `secret put` meldet, dass es den Worker noch nicht gibt: erst `npm run deploy`, dann die
Secrets setzen, dann noch einmal deployen.

Danach unter https://formation.nils-meier.de/upload ein Video hochladen. Klappt der Upload nicht
(„Verbindung abgebrochen“), ist fast immer CORS am Bucket der Grund – die Browser-Konsole zeigt dann
einen CORS-Fehler.

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
