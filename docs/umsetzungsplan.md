# Formation-Videoportal — Umsetzungsplan (Cloudflare-Stack)

Sep 20, 2026 · @Nils

## Überblick

Ein Videoportal für die Formationsgruppe. Trainingsvideos werden hochgeladen, mit Abschnitten der Choreografie verknüpft und lassen sich anschließend über diese Abschnitte finden: Klick auf "Kreis links" → alle Videos, die diese Stelle zeigen, jeweils mit Timecode. Kein Login, aber auch nicht offen für jeden im Internet.

**Kernidee:** Die Videodateien liegen im Object Storage, alles Interessante (Abschnitte, Zuordnungen, Timecodes) liegt in einer kleinen relationalen Datenbank. Beide bleiben getrennt und einzeln austauschbar.

**Gewählter Stack:** Cloudflare — R2 für Dateien, D1 für Metadaten, Worker für die API, Pages fürs Frontend. Das Video-Processing läuft über GitHub Actions. Keine eigene Hardware.

### Architektur

```
Browser (Pages, formation.nils-meier.de)
   │
   ├─ liest Metadaten ─────────► Worker API ─────► D1
   │                                  │
   ├─ holt Upload-URL ───────────────►│ signiert
   │                                  │
   ├─ lädt Original DIREKT hoch ─────────────────► R2  raw/
   │                                  │
   │                                  └─ stößt an ─► GitHub Actions
   │                                                   │ holt raw/, ffmpeg
   │                                                   ├─► R2  play/ + thumb/
   │                                                   └─► Worker-Callback → D1
   │
   └─ spielt ab ─────────────────────────────────► R2  play/
                                   (media.formation.nils-meier.de)
```

Der Upload geht **am Worker vorbei** direkt nach R2. Das ist der Grund für Presigned URLs: die API sieht nie 800 MB Videodaten und bleibt winzig.

Die zentrale Designentscheidung: Timecodes und Abschnitte sind Daten, keine Eigenschaft der Videodatei. Ein Umzug zu einem anderen Storage-Anbieter kostet dadurch nur das Umkopieren der Dateien und das Ändern einer Basis-URL — die Tagging-Arbeit bleibt erhalten.

## Storage: Cloudflare R2

**Konditionen:** 10 GB/Monat gratis, danach 0,015 $/GB/Monat. Egress ist komplett kostenlos. S3-kompatibel, also funktioniert jedes S3-SDK und jedes Presigned-URL-Beispiel.

Bei realistischen 100–300 GB Videobibliothek landet ihr bei 1,35–4,50 $ im Monat. Traffic ist dabei nie ein Thema — das ist der Hauptgrund für R2 gegenüber Backblaze B2, wo Egress nur bis zum Dreifachen der Speichermenge frei ist.

### Bucket-Layout

```
raw/2026-09-14/<uuid>.mov     Original wie hochgeladen — Archiv, nur zum Download
play/<uuid>.mp4               720p, H.264, faststart — wird abgespielt
thumb/<uuid>.jpg              Vorschaubild
```

Ein Bucket reicht, die Präfixe genügen zur Trennung. Abgespielt wird immer `play/`, das Original bleibt als Archiv liegen. Die Präfixe machen später auch Lifecycle-Regeln einfach — etwa um Originale alter Saisons nach einer Weile zu löschen, während die Abspielfassung bleibt.

### Zugriff nach außen

Bind eine **Custom Domain** an den Bucket (z. B. `videos.eure-domain.de`). Die `r2.dev`-Entwicklungs-URL ist ausdrücklich nicht für Produktion gedacht und hart rate-limited.

### Bekannte Fallstricke

**Class-A-Operationen sind die Kostenfalle.** 4,50 $ pro Million, 1 Million frei. Bei R2 sind nicht Bytes das Risiko, sondern Schreib- und Listenzugriffe:

- Multipart-Uploads erzeugen **eine Class-A-Operation pro Teil** — ein 2-GB-Video in 5-MB-Chunks sind 400 Operationen für ein einziges Video.
- `ListObjectsV2` im Reconcile-Job ist Class A, eine pro 1000 Objekte.
- Ein Job, der versehentlich alle fünf Minuten statt täglich läuft, frisst das Freikontingent schnell.

Bei vernünftigen Intervallen unproblematisch, aber genau hier kostet R2 unerwartet Geld.

**Kein hartes Spending-Limit.** Cloudflare bietet nur Budget-Alerts per E-Mail, die rein informativ sind und nichts pausieren. Das Kostenlimit musst du selbst bauen — siehe Abschnitt Quota.

**Video-AGB-Grauzone.** Cloudflares Regel gegen das Ausliefern großer Videomengen betrifft den CDN, und eine Custom Domain vor R2 läuft durch diesen CDN. Bei der Größenordnung einer Tanzgruppe ist das praktisch kein Thema, sauber definiert ist es aber nicht.

**Storage-Metriken sind verzögert.** Die Werte werden periodisch erhoben, nicht in Echtzeit. Bei frisch angelegten Buckets kommen anfangs gar keine Storage-Metriken zurück, während Operations-Metriken schon funktionieren — nicht stundenlang das Query debuggen, einen Tag warten.

## Datenmodell

```sql
CREATE TABLE choreo (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,        -- "Latein 2026"
  season        TEXT,
  duration_s    REAL,                 -- Länge der Musik = Referenz-Zeitleiste
  ref_video_id  TEXT,                 -- optional: Referenzaufnahme zum Scrubben
  archived      INTEGER DEFAULT 0,
  sort_order    INTEGER
);

CREATE TABLE section (                -- die "Stellen" in der Choreo
  id            TEXT PRIMARY KEY,
  choreo_id     TEXT NOT NULL REFERENCES choreo(id),
  name          TEXT NOT NULL,        -- "Einmarsch", "Kreis links", "Hebung"
  start_s       REAL,                 -- Position auf der CHOREO-Zeitleiste
  end_s         REAL,
  start_count   INTEGER,              -- Achter, rein beschreibend
  end_count     INTEGER,
  sort_order    INTEGER NOT NULL
);

CREATE TABLE take (                   -- eine Ausführung, aus mehreren Winkeln gefilmt
  id            TEXT PRIMARY KEY,
  choreo_id     TEXT REFERENCES choreo(id),
  label         TEXT,
  recorded_at   TEXT
);

CREATE TABLE video (
  id                  TEXT PRIMARY KEY,
  choreo_id           TEXT REFERENCES choreo(id),   -- nullable: Videos ohne Choreo
  take_id             TEXT REFERENCES take(id),     -- nullable
  storage_key         TEXT NOT NULL,                -- raw/…  Original
  play_key            TEXT,                         -- play/… 720p-Abspielfassung
  thumb_key           TEXT,
  title               TEXT,
  recorded_at         TEXT,
  camera              TEXT,
  duration_s          REAL,
  size_bytes          INTEGER NOT NULL,
  uploaded_by         TEXT,
  status              TEXT NOT NULL,   -- uploading|untagged|tagged|no_tagging|missing
  processing          TEXT,            -- pending|done|failed
  processing_attempts INTEGER DEFAULT 0,
  dispatched_at       TEXT,
  tagged_by           TEXT,
  tagged_at           TEXT,
  created_at          TEXT NOT NULL
);

CREATE TABLE segment (                -- was zeigt dieses Video
  id            TEXT PRIMARY KEY,
  video_id      TEXT NOT NULL REFERENCES video(id),
  section_id    TEXT NOT NULL REFERENCES section(id),
  start_s       REAL,                 -- NULL = das ganze Video zeigt diesen Abschnitt
  end_s         REAL,
  note          TEXT
);

CREATE TABLE tag (                    -- Videoart, frei erweiterbar
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE, -- "Auftritt", "Vortanzen", "Erklärung"
  color         TEXT
);

CREATE TABLE video_tag (
  video_id      TEXT NOT NULL REFERENCES video(id),
  tag_id        TEXT NOT NULL REFERENCES tag(id),
  PRIMARY KEY (video_id, tag_id)
);

CREATE INDEX idx_seg_section ON segment(section_id);
CREATE INDEX idx_seg_video ON segment(video_id);
CREATE INDEX idx_section_time ON section(choreo_id, start_s);
CREATE INDEX idx_video_status ON video(status);
CREATE INDEX idx_video_processing ON video(processing);
```

### Zwei Zeitleisten, nicht eine

Das ist die zentrale Unterscheidung im Modell:

|  | Wo | Wofür |
| --- | --- | --- |
| **Choreo-Zeitleiste** | `section.start_s` / `end_s` | "die Figur bei 2:31" — der Einstieg ins Portal |
| **Video-Zeitleiste** | `segment.start_s` / `end_s` | wo im Video die Stelle liegt — optional |

Der typische Einstieg ist die Choreo-Zeitleiste: Du weißt, dass die Figur irgendwo bei 2:31 kommt, scrubbst dorthin, und das Portal zeigt alle Videos, die diesen Abschnitt enthalten. Die Abschnittsliste ist der zweite Weg zum selben Ergebnis.

### Segmentzeiten sind optional

`segment.start_s` darf NULL sein. Zwei Fälle:

- **Kurzer Clip** — 30 Sekunden, zeigt eine Figur: nur "dieses Video zeigt Abschnitt X", keine Zeiten. Ein Klick beim Taggen.
- **Langer Durchlauf** — 5 Minuten, zeigt alles: Bereiche setzen, damit klar ist, wo man hinspringt.

Dass ein Clip vorne drei Sekunden Vorlauf hat, ist egal. Es geht ums grobe Ordnen, nicht um Frame-Genauigkeit.

**Ein Video kann dieselbe Stelle mehrfach zeigen**, deshalb hat `segment` einen eigenen Schlüssel statt `(video_id, section_id)`.

**`take` bündelt Winkel** — dieselbe Ausführung aus vier Richtungen. Da Genauigkeit keine Rolle spielt, braucht es keinen Sync zwischen den Aufnahmen: die vier Videos bekommen einfach dasselbe Segment.

### Die Hauptabfragen

```sql
-- Einstieg über die Choreo-Zeitleiste: "was passiert bei 2:31?"
SELECT * FROM section
WHERE choreo_id = ? AND ? BETWEEN start_s AND end_s;

-- Videos zu einem Abschnitt
SELECT v.id, v.title, v.recorded_at, v.camera, s.start_s, s.end_s, s.note
FROM segment s
JOIN video v ON v.id = s.video_id
WHERE s.section_id = ? AND v.status = 'tagged'
ORDER BY v.recorded_at DESC;
```

## Datenbank: Cloudflare D1

D1 ist SQLite und läuft direkt neben dem Worker — kein zweiter Anbieter, keine Verbindungsverwaltung, das Binding steht in der `wrangler.toml`. Für ein paar hundert Videos und ein paar tausend Tag-Zeilen ist das Gratiskontingent weit überdimensioniert.

```toml
[[d1_databases]]
binding = "DB"
database_name = "formation-portal"
database_id = "..."

[[r2_buckets]]
binding = "BUCKET"
bucket_name = "formation-videos"
```

### Backups sind nicht optional

Die Videos sind im Zweifel neu aufnehmbar oder zumindest ersetzbar. **Die Tagging-Arbeit ist es nicht.** Wenn jemand 40 Videos mal acht Abschnitte von Hand gesetzt hat, sind das mehrere Abende Arbeit, die in dieser einen Datenbank liegen.

Also: täglicher Export der D1-Datenbank auf den Proxmox-Server. Ein Cron-Job mit `wrangler d1 export` genügt, das Ergebnis neben die Video-Backups legen und ein paar Wochen Versionen vorhalten.

Migrationen laufen über `wrangler d1 migrations` — von Anfang an nutzen, nicht per Hand am Schema schrauben, sonst weiß nach einem halben Jahr niemand mehr, warum eine Spalte da ist.

## API: Cloudflare Worker

Bewusst klein halten. Das reicht vollständig:

| Methode | Pfad | Zugang | Zweck |
| --- | --- | --- | --- |
| GET | `/api/choreos` | offen | alle Choreos |
| GET | `/api/choreos/:id` | offen | Choreo mit allen Abschnitten |
| GET | `/api/sections/:id/videos` | offen | alle Videos + Zeitbereiche zu dieser Stelle |
| GET | `/api/videos` | offen | Liste, filterbar nach Choreo, Datum, Kamera, Tag, Status |
| GET | `/api/videos/:id` | offen | Einzelvideo inkl. Segmente und Tags |
| POST | `/api/videos` | Gruppen-Code | Datensatz anlegen, Presigned PUT-URL zurückgeben |
| POST | `/api/videos/:id/complete` | Gruppen-Code | Upload bestätigen → `untagged` |
| POST | `/api/takes` | Tagger-Code | Videos zu einem Take gruppieren |
| PUT | `/api/videos/:id/sync` | Tagger-Code | `sync_offset_s` setzen |
| POST | `/api/videos/:id/segments` | Tagger-Code | Segment setzen |
| POST | `/api/takes/:id/segments` | Tagger-Code | Segment auf alle Videos des Takes |
| DELETE | `/api/segments/:id` | Tagger-Code | Segment entfernen |
| PUT | `/api/videos/:id/tags` | Tagger-Code | Video-Tags setzen |
| GET/POST | `/api/tags` | gemischt | Video-Tags lesen/anlegen |
| GET | `/api/stats` | Tagger-Code | belegter Speicher, Videoanzahl, offene Tags |

Dazu ein interner Endpunkt, nicht Teil der öffentlichen API: `POST /api/internal/processed` — Rückmeldung des GitHub-Workflows, geschützt über ein Bearer-Secret (siehe Video-Processing).

### Presigned URLs im Worker

Das R2-Binding kann keine Presigned URLs erzeugen — dafür brauchst du `aws4fetch` oder das AWS SDK mit den S3-API-Zugangsdaten aus dem R2-Dashboard:

```js
import { AwsClient } from "aws4fetch";

const r2 = new AwsClient({
  accessKeyId: env.R2_ACCESS_KEY_ID,
  secretAccessKey: env.R2_SECRET_ACCESS_KEY,
});

const url = new URL(
  `https://${env.ACCOUNT_ID}.r2.cloudflarestorage.com/${bucket}/${key}`
);
url.searchParams.set("X-Amz-Expires", "900"); // 15 Minuten

const signed = await r2.sign(new Request(url, { method: "PUT" }), {
  aws: { signQuery: true, service: "s3" },
});
// signed.url an den Browser geben
```

Die Zugangsdaten gehören in Worker Secrets (`wrangler secret put`), niemals ins Frontend und niemals ins Repository.

## Upload-Flow und Rollen

**Hochladen und Taggen sind getrennt.** Jeder aus der Gruppe lädt hoch, niemand muss taggen. Getaggt wird nachträglich von wenigen Leuten — sonst macht es jeder anders und die Suche liefert Müll.

### Zwei Codes, keine Accounts

| Rolle | Code | Darf |
| --- | --- | --- |
| Ansehen | keiner | suchen, abspielen |
| Hochladen | Gruppen-Code | Videos hochladen, Metadaten setzen |
| Taggen | Tagger-Code | Segmente setzen, Takes bilden, löschen |

Der Tagger-Code kennen drei Leute. Kein Login, kein Account, keine Benutzerverwaltung — bei einer Tanzgruppe wäre das Overhead ohne Gegenwert.

### Upload

1. Nutzer wählt Datei, gibt Datum, Kamera, seinen Namen und optional Video-Tags (Auftritt, Vortanzen, Erklärung) an.
2. Frontend ruft `POST /api/videos` mit Dateiname, Größe, Content-Type, Gruppen-Code.
3. Worker prüft: Code gültig? Größe unter Limit? Content-Type `video/*`? Quota frei? Dann Datensatz mit `status='uploading'` anlegen und eine **15 Minuten gültige Presigned PUT-URL** zurückgeben.
4. Frontend lädt direkt nach R2: `fetch(url, { method: 'PUT', body: file })`, Fortschritt über XHR.
5. `POST /api/videos/:id/complete` → `status='untagged'`.
6. Video erscheint in der Tagging-Warteschlange.

Mehrere Dateien auf einmal sollten gehen — nach dem Training lädt jemand vier Kameraaufnahmen hoch. Gleiche Metadaten für alle, dann läuft es im Hintergrund durch.

**Niemals Schreib-Credentials ins Frontend.** Das ist der ganze Sinn der Presigned URLs: zeitlich begrenzt, auf einen Schlüssel festgelegt, erst nach der Prüfung ausgestellt.

### Limits und Benachrichtigung

Weil kurzzeitig belegter Speicher praktisch nichts kostet (siehe **Wie R2 abrechnet**), muss das Dateilimit nicht eng sein. Ein versehentlicher 40-GB-Upload, der nach drei Stunden gelöscht wird, kostet rechnerisch 0,17 GB-Monate — also nichts. Wichtiger als ein hartes Limit ist, dass du **mitbekommst**, wenn etwas Ungewöhnliches hochgeladen wird.

Dreistufig:

| Stufe | Wert | Verhalten |
| --- | --- | --- |
| Benachrichtigung | ab ca. 1,5 GB | E-Mail an dich, Upload läuft normal durch |
| Hartes Dateilimit | ca. 5 GB | Upload wird abgelehnt, reine Notbremse |
| Quota | `QUOTA_BYTES` | Gesamtdeckel über alle Videos |

### E-Mail über Resend

Reine HTTP-API, funktioniert aus dem Worker ohne SMTP. `nils-meier.de` muss dort einmal als Absenderdomain verifiziert werden. Das kostenlose Kontingent ist für diesen Zweck um Größenordnungen überdimensioniert.

Die Mail wird beim `complete`-Aufruf ausgelöst und enthält:

- Dateiname, Größe, Hochlader, Choreo
- Link zum Ansehen
- **Link zum Löschen** — signiertes Token in der URL, ein Klick genügt

Der Löschen-Link ist der Teil, der es praktisch macht. Ohne ihn müsstest du dich erst irgendwo hineinklicken, und dann machst du es doch nicht.

**Tageszusammenfassung statt Einzelmails.** Nach einem Training mit acht Videos willst du keine acht Mails. Also: Sofortmail nur bei wirklich auffälligen Einzeluploads, sonst einmal abends per Cron-Trigger eine kurze Übersicht, was an dem Tag dazugekommen ist — und nur, wenn überhaupt etwas hochgeladen wurde.

### Weitere Details, die sonst wehtun

**Verwaiste Datensätze aufräumen.** Alles, was länger als 24 Stunden auf `status='uploading'` steht, ist ein abgebrochener Upload. Cron-Trigger im Worker.

**Multipart-Upload erst nachrüsten.** Über Mobilfunk bricht ein einzelner PUT bei über 1 GB gerne ab. Achtung: Multipart erzeugt **eine Class-A-Operation pro Teil** — Teilgröße 25–50 MB, nicht 5 MB.

**CORS am Bucket konfigurieren**, sonst blockt der Browser den PUT. Origin ist die Pages-Domain, Methode PUT, Header `content-type`.

**Content-Type mitsenden.** Ohne `Content-Type: video/mp4` beim PUT liefert R2 die Datei später als Download aus statt als abspielbares Video.

## Quota und Kostenkontrolle

Cloudflare kennt kein hartes Ausgabenlimit — Budget-Alerts sind rein informativ und pausieren nichts. Das Limit musst du selbst bauen. Da alle Uploads über deine Presigned URLs laufen, bist du der Gatekeeper.

### Quota im Upload-Pfad

```js
const { belegt } = await env.DB.prepare(
  "SELECT COALESCE(SUM(size_bytes),0) AS belegt FROM video WHERE status != 'missing'"
).first();

if (belegt + dateiGroesse > QUOTA_BYTES) {
  return new Response("Speicher voll, bitte alte Videos löschen", { status: 413 });
}
```

Egress ist bei R2 gratis, also kann dort nichts explodieren. Das einzige verbleibende Kostenrisiko sind Class-A-Operationen, und die kontrollierst du über vernünftige Job-Intervalle.

### Reconcile-Job gegen Drift

Wenn jemand von Hand im Dashboard löscht, stimmt die gezählte Summe nicht mehr — und schlimmer: die DB zeigt auf eine Datei, die es nicht mehr gibt. Also einmal täglich `ListObjectsV2` gegen die DB abgleichen:

| Fall | Bedeutung | Reaktion |
| --- | --- | --- |
| In DB, nicht im Bucket | von Hand gelöscht | `status='missing'` setzen, Datensatz **behalten** |
| Im Bucket, nicht in DB | verwaister Upload | wenn älter als 24 h: löschen |
| Größe weicht ab | abgebrochen oder überschrieben | Größe korrigieren, ggf. neu prozessieren |

Danach die Ist-Summe in eine `storage_stats`-Zeile schreiben. Der Quota-Check rechnet mit diesem Wert plus den seitdem hinzugekommenen Uploads.

**`status='missing'` statt hartem Löschen ist der wichtigere Teil.** Wenn versehentlich das falsche Video aus dem Dashboard fliegt, könnt ihr es neu hochladen und die bestehenden Abschnitts-Marker wieder dranhängen, statt alles neu zu taggen.

### Zusätzliche Kontrolle

Setz trotzdem einen Budget-Alert bei etwa 5 $. Der stoppt nichts, aber du merkst früh, wenn ein Job einen Bug hat und im Kreis läuft.

Optional lässt sich der belegte Platz auch über die GraphQL Analytics API (`r2StorageAdaptiveGroups`, Feld `payloadSize`) abfragen — als Gegenprobe zum eigenen Zähler. Die Werte sind aber verzögert, der `ListObjectsV2`-Abgleich ist die verlässlichere Quelle.

## Video-Processing über GitHub Actions

Jedes hochgeladene Video wird einmal serverseitig in eine einheitliche Abspielfassung umgewandelt. Workers können kein ffmpeg, eigene Hardware ist nicht gewünscht — deshalb läuft der Job auf GitHub-Runnern.

### Was dabei herauskommt

Ein einziges Artefakt pro Video: `play/<id>.mp4` — 720p, H.264, 8 Bit, AAC, faststart. Dazu Thumbnail und Dauer. Dieses eine Artefakt löst drei Probleme gleichzeitig:

| Problem | gelöst durch |
| --- | --- |
| iPhone-HEVC spielt nicht in jedem Browser | Umwandlung nach H.264 |
| Springen im Video ist zäh | faststart |
| Datenvolumen in der Halle | 720p statt Original |

Das Original bleibt unverändert in `raw/` und wird nur heruntergeladen, nie abgespielt. Eine faststart-Kopie des Originals gibt es bewusst nicht — sie wäre genauso groß und brächte nichts, was die Abspielfassung nicht schon kann.

### Ablauf

1. `POST /api/videos/:id/complete` setzt `processing='pending'` und stößt per GitHub-API einen `repository_dispatch` an.
2. Der Runner startet (typisch 20–60 Sekunden), zieht das Original aus R2 und wandelt um.
3. Abspielfassung und Thumbnail gehen zurück nach R2.
4. Der Runner ruft einen internen Worker-Endpunkt, der `play_key`, `thumb_key`, `duration_s` und `processing='done'` setzt.

**Nicht im kritischen Pfad.** Ein Video ist ab dem Upload in der Warteschlange sichtbar und taggbar. Solange `play_key` fehlt, spielt der Player das Original — Android-Material funktioniert damit sofort, iPhone-HEVC erst nach der Umwandlung. Ein Hinweis "wird noch aufbereitet" genügt. Fällt GitHub aus, staut sich eine Warteschlange, kaputt ist nichts.

### Worker: Job anstoßen

```js
await fetch(`https://api.github.com/repos/${env.GH_REPO}/dispatches`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${env.GH_TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "formation-portal",   // Pflicht, sonst lehnt GitHub ab
  },
  body: JSON.stringify({
    event_type: "process-video",
    client_payload: { video_id: id, storage_key: key },
  }),
});
```

`GH_TOKEN` ist ein fine-grained Personal Access Token, beschränkt auf genau dieses Repository, mit Schreibrecht auf Contents — das verlangt die Dispatch-API. Er liegt ausschließlich als Worker-Secret.

### Workflow

`.github/workflows/process-video.yml`:

```yaml
name: process-video
on:
  repository_dispatch:
    types: [process-video]

jobs:
  process:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    env:
      AWS_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
      AWS_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
      AWS_DEFAULT_REGION: auto
      R2: https://${{ secrets.R2_ACCOUNT_ID }}.r2.cloudflarestorage.com
      BUCKET: formation-videos
      API: https://formation.nils-meier.de/api/internal/processed
      ID: ${{ github.event.client_payload.video_id }}
      KEY: ${{ github.event.client_payload.storage_key }}
    steps:
      - name: ffmpeg sicherstellen
        run: command -v ffmpeg || (sudo apt-get update && sudo apt-get install -y ffmpeg)

      - name: Original holen
        run: aws s3 cp "s3://$BUCKET/$KEY" in.bin --endpoint-url "$R2"

      - name: Abspielfassung, Thumbnail, Dauer
        run: |
          # kürzere Seite auf max. 720 px — funktioniert für quer und hochkant
          ffmpeg -y -i in.bin \
            -vf "scale=w='if(gt(iw,ih),-2,min(720,iw))':h='if(gt(iw,ih),min(720,ih),-2)'" \
            -c:v libx264 -crf 23 -preset veryfast -pix_fmt yuv420p \
            -c:a aac -b:a 128k -movflags +faststart play.mp4
          ffmpeg -y -ss 1 -i in.bin -frames:v 1 -vf scale=-2:360 thumb.jpg
          ffprobe -v error -show_entries format=duration -of csv=p=0 in.bin > duration.txt

      - name: Zurück nach R2
        run: |
          aws s3 cp play.mp4 "s3://$BUCKET/play/$ID.mp4" --endpoint-url "$R2" --content-type video/mp4
          aws s3 cp thumb.jpg "s3://$BUCKET/thumb/$ID.jpg" --endpoint-url "$R2" --content-type image/jpeg

      - name: Worker benachrichtigen
        run: |
          curl -fsS -X POST "$API" \
            -H "Authorization: Bearer ${{ secrets.CALLBACK_SECRET }}" \
            -H "Content-Type: application/json" \
            -d "{\"id\":\"$ID\",\"status\":\"done\",\"duration\":$(cat duration.txt)}"

      - name: Fehler melden
        if: failure()
        run: |
          curl -fsS -X POST "$API" \
            -H "Authorization: Bearer ${{ secrets.CALLBACK_SECRET }}" \
            -H "Content-Type: application/json" \
            -d "{\"id\":\"$ID\",\"status\":\"failed\"}"
```

Der `-pix_fmt yuv420p` ist nicht optional: iPhone-Videos sind oft 10 Bit, und 10-Bit-H.264 spielt in fast keinem Browser.

### Worker: Rückmeldung empfangen

`POST /api/internal/processed` prüft das Bearer-Secret, setzt `play_key`, `thumb_key`, `duration_s` und `processing`. Der Endpunkt gehört nicht zur öffentlichen API und nimmt ohne gültiges Secret nichts an.

### Wiederholen und Fehler

- **Cron-Trigger im Worker, stündlich:** alles, was länger als eine Stunde auf `processing='pending'` steht, wird neu angestoßen. Höchstens drei Versuche (`processing_attempts`), danach `failed`.
- **Aktive Fehlermeldung** aus dem Workflow (`if: failure()`), damit niemand eine Stunde auf den Cron wartet.
- **`failed`-Videos** stehen in der täglichen Resend-Zusammenfassung. Meist ist es eine kaputte Datei; das Original bleibt erhalten.

### Kontingent und Kosten

Repository **privat** halten — Logs enthalten Dateinamen und Video-IDs. Private Repos haben im kostenlosen GitHub-Plan 2.000 Actions-Minuten pro Monat. Ein Fünf-Minuten-Video braucht auf dem Runner etwa zwei bis drei Minuten inklusive Start, das reicht für mehrere hundert Videos monatlich.

In R2 kommen pro Video zwei Class-A-Operationen dazu (Abspielfassung und Thumbnail) — vernachlässigbar.

### Bekannte Stolperstelle: HDR vom iPhone

Neuere iPhones filmen standardmäßig in HDR (Dolby Vision, 10 Bit). Einfach nach 8-Bit-H.264 umgewandelt, sieht das blass und ausgewaschen aus — die Farben stimmen nicht, obwohl technisch alles funktioniert.

Zwei Wege:

- **Tone-Mapping** im ffmpeg-Aufruf ergänzen (Filterkette mit `zscale` und `tonemap`). Braucht ein ffmpeg mit zimg-Unterstützung — auf dem Runner prüfen, notfalls ein statisches ffmpeg-Build herunterladen.
- **In der Gruppe darum bitten**, am iPhone unter Einstellungen → Kamera → Video aufnehmen "HDR-Video" abzuschalten.

**Zuerst testen:** ein echtes iPhone-Video durch den Workflow schicken und das Ergebnis auf einem Android-Handy ansehen. Das zeigt HEVC- und HDR-Verhalten in einem Durchgang, bevor der Rest darum herum gebaut wird.

### Später möglich: Umwandlung im Browser

Transcoding per WebCodecs vor dem Upload bleibt als Optimierung denkbar — vor allem, weil es Uploads über Mobilfunk kleiner macht.

Als Hauptweg taugt es nicht: Firefox auf Android unterstützt WebCodecs gar nicht, volle Safari-Unterstützung gibt es erst ab Version 26, und ein App-Wechsel während der Umwandlung bricht den Job ab. Weil es deshalb immer einen serverseitigen Fallback bräuchte, lohnt sich der zweite Codepfad erst, wenn die Uploadgröße tatsächlich stört.

### Verworfene Alternativen

| Option | warum nicht |
| --- | --- |
| Mini-PC | technisch in Ordnung, weil nur die kleine Abspielfassung zurückgeht — aber bewusst keine eigene Hardware |
| Cloudflare Containers | braucht Workers Paid, 5 $/Monat |
| Cloudflare Stream | mind. 5 $/Monat, Dateien nicht mehr direkt greifbar |
| Fly.io Machines | gute Alternative, aber ein Anbieter mehr |
| Media Transformations | Limits von 100 MB Eingabe und 1 Minute Ausgabe |
| Gar kein Processing | iPhone-HEVC wäre für einen Teil der Gruppe unsichtbar |

## Tagging-Interface

**Hier entscheidet sich, ob das Portal benutzt wird.** Der Rest ist Infrastruktur, das hier ist die Arbeit, die jede Woche jemand machen muss.

Einstieg ist die Warteschlange: alle Videos mit `status='untagged'`, neueste zuerst.

### Der Normalfall: Clip einem Abschnitt zuordnen

Die meisten Videos sind kurze Clips, die eine Stelle zeigen. Dafür reicht:

1. Video in der Warteschlange ansehen.
2. Choreo auswählen (falls mehrere).
3. Abschnitt anklicken → fertig, `status='tagged'`.

Keine Zeiten, kein Scrubben. Das Segment bekommt `start_s = NULL` und meint damit das ganze Video.

**Mehrere Winkel auf einmal:** vier Videos in der Warteschlange markieren, Abschnitt anklicken, alle vier sind getaggt. Da keine Frame-Genauigkeit gebraucht wird, ist kein Sync zwischen den Aufnahmen nötig — die vier zeigen dieselbe Figur, mehr muss das System nicht wissen.

### Der Sonderfall: langer Durchlauf

Ein Fünf-Minuten-Video zeigt die ganze Choreo. Hier lohnt es, Bereiche zu setzen, damit man weiß, wo man hinspringt.

| Taste | Funktion |
| --- | --- |
| Leertaste | Play/Pause |
| ←/→ | ±5 Sekunden |
| Shift + ←/→ | ±1 Sekunde |
| I | Startzeitpunkt des Segments setzen |
| O | Endzeitpunkt setzen und speichern |
| 1–9 | Abschnitt auswählen |
| Backspace | letztes Segment zurücknehmen |
| +/− | Abspielgeschwindigkeit |

Gesetzte Segmente als Balken unter der Zeitleiste, einzeln korrigierbar. Grob reicht — ein paar Sekunden daneben stört niemanden.

### Abschnitte anlegen

Einmal pro Choreo, im Verwaltungsbereich: Name, Position auf der Choreo-Zeitleiste, optional die Achter. Am einfachsten anhand einer Referenzaufnahme des kompletten Durchlaufs — abspielen, an den Übergängen Grenzen setzen, benennen.

Das muss passieren, bevor überhaupt getaggt werden kann, und ist der einzige Schritt, der ein bisschen Sorgfalt braucht: die Abschnitte sind die Sprache, in der später alle suchen.

### Was ausdrücklich nicht kommt

**Kein Auto-Tagging über BPM.** Beim Training läuft meist keine Musik, es wird gezählt, das Tempo schwankt. Jede Umrechnung Achter ↔ Sekunden wäre Scheingenauigkeit.

**Kein Sync zwischen Kameras.** War im ersten Entwurf vorgesehen und ist ersatzlos gestrichen — für "grob ordnen" ist es überkonstruiert.

### Abspielgeschwindigkeit

0,5× und 0,25× in jedem Player. Beim Analysieren von Timing-Fehlern ist das die meistgenutzte Funktion überhaupt.

## Frontend, Domains und Hosting

**Cloudflare Pages**, gleicher Account wie Worker, D1 und R2.

### Warum Pages und nicht Vercel

Der Grund ist nicht der Preis, sondern die **Bindings**: Auf Pages und Workers greifst du per `env.DB` und `env.BUCKET` direkt auf D1 und R2 zu — kein HTTP, keine Zugangsdaten im Code, kein CORS. Der Worker läuft als Function unter `/api/*` derselben Domain, damit ist Frontend und API same-origin.

Auf Vercel müsstest du den Worker trotzdem separat bei Cloudflare betreiben und cross-origin dagegen sprechen, plus CORS-Konfiguration und zwei Deploy-Pipelines. Vercels Stärke ist Next.js-Komfort, und den braucht dieses Projekt nicht.

### Domains

| Domain | Ziel |
| --- | --- |
| `formation.nils-meier.de` | Pages (Frontend + `/api/*`) |
| `media.formation.nils-meier.de` | R2-Bucket (Videoauslieferung) |

Voraussetzung: `nils-meier.de` liegt mit den Nameservern bei Cloudflare. Die `r2.dev`-URL ist ausdrücklich nicht für Produktion gedacht und hart rate-limited — die Custom Domain ist Pflicht, nicht Kür.

### Ansichten

| Ansicht | Zugang | Zweck |
| --- | --- | --- |
| Choreo-Übersicht | offen | Abschnitte als Liste, Klickziel fürs Hauptfeature |
| Abschnitts-Ansicht | offen | alle Videos zu dieser Stelle, mit Zeitbereich und Vorschaubild |
| Videoliste | offen | filterbar nach Choreo, Datum, Kamera, Video-Tag, Status |
| Player | offen | Einzelvideo mit Segmentbalken |
| Upload | Gruppen-Code | Dateien, Metadaten, Fortschritt |
| Warteschlange | Tagger-Code | alle `untagged`-Videos |
| Tagging | Tagger-Code | Einzel- und Take-Tagging |
| Verwaltung | Tagger-Code | Choreos, Abschnitte, Video-Tags, Speicherstand |

### Player

Start mit dem nativen `<video>`-Element — reicht für progressive MP4s völlig und bringt null Abhängigkeiten. Plyr als leichter Umstieg, wenn einheitliche Optik und Keyboard-Komfort wichtig werden.

In der Abschnitts-Ansicht steht der Zeitbereich (`1:03 – 1:10`) neben jedem Treffer und ist klickbar. Ursprünglich war das nicht gefordert, aber `start_s` liegt ohnehin in der DB und `video.currentTime = start_s` ist eine Zeile.

### Mobil

Geschaut wird in der Halle am Handy: Touch-Ziele groß genug, Segmentbalken mit dem Daumen bedienbar, und immer die 720p-Abspielfassung als Quelle. Das Original gibt es nur als Download-Link für den, der es wirklich braucht.

## Entscheidungen

### Entschieden

### Noch offen

| Frage | Entscheidung |
| --- | --- |
| Storage | Cloudflare R2 |
| Datenbank | Cloudflare D1 |
| API | Cloudflare Worker |
| Frontend | Cloudflare Pages |
| Domain | `formation.nils-meier.de`, Videos über `media.` |
| Video-Processing | GitHub Actions, eine 720p-Abspielfassung pro Video |
| Mehrere Choreos | ja |
| Video-Tags | ja, frei erweiterbar (Auftritt, Vortanzen, Erklärung …) |
| Einstieg ins Portal | Choreo-Zeitleiste oder Abschnittsliste |
| Tagging-Genauigkeit | grob; Segmentzeiten optional |
| Kamera-Sync | nein, gestrichen |
| Auto-Tagging über BPM | nein |
| Upload und Tagging | getrennt, zwei Codes |
| Zugang zum Ansehen | offen, ohne Code |
| Dateilimit | weich, mit E-Mail-Benachrichtigung über Resend |
| Eigene Hardware | nein |

**1. Auflösung der Abspielfassung** — 720p schont Datenvolumen und reicht für Laufwege und Formationsbilder. 1080p zeigt Details wie Handhaltung und Fußarbeit besser, ist aber etwa doppelt so groß. Ist eine Zahl im Workflow und jederzeit änderbar; bestehende Videos müssten dann allerdings neu umgewandelt werden.

**2. Schwellenwerte** — ab welcher Größe kommt die Mail (Vorschlag 1,5 GB), wo liegt das harte Limit (Vorschlag 5 GB), wie hoch ist `QUOTA_BYTES`? 200 GB entspricht etwa 2,85 $/Monat, 500 GB etwa 7,35 $.

**3. Referenzaufnahme je Choreo** — soll es eine feste Durchlaufaufnahme geben, an der die Abschnitte definiert und über die auf der Zeitleiste gescrubbt wird? Macht das Anlegen der Abschnitte deutlich angenehmer, braucht aber pro Choreo eine saubere Aufnahme.

**4. Wer darf löschen** — nur Tagger, oder auch der Hochladende sein eigenes Video? Hart löschen oder Papierkorb? Der Löschen-Link in der Benachrichtigungsmail ist davon unberührt, der geht nur an dich.

**5. Abschnitte pflegen** — wer legt sie an? Das muss einmal pro Choreo passieren, bevor getaggt werden kann, und bestimmt die Sprache, in der später alle suchen.

**6. Frontend-Stack** — bisher nicht festgelegt. Vanilla + Vite reicht für den Umfang völlig und hält den Tagging-Screen mit seiner Tastatursteuerung einfach. React oder Svelte, falls du dich damit wohler fühlst. Auf Pages läuft beides.

### Punkte, die noch nirgends stehen

**Videos ohne Choreo.** Eine allgemeine Technikerklärung, ein Auftritt einer anderen Gruppe, Material aus einer alten Saison: `choreo_id` muss nullable sein. Solche Videos findet man dann über Video-Tags und die Videoliste, nicht über die Zeitleiste — und sie dürfen nicht dauerhaft in der Tagging-Warteschlange hängen bleiben. Ein Status `no_tagging_needed` oder ein Häkchen "gehört zu keiner Choreo" löst das.

**Backup der Videodateien.** Die D1-Backups stehen im Plan, die Videos nicht. R2 ist zuverlässig, aber ein Bug in einem Aufräum-Job oder ein Fehlklick ist damit endgültig. Mindestens: R2-Versioning oder eine Lifecycle-Regel, die Gelöschtes 30 Tage aufhebt. Bei Cloudflare Stream stellt sich die Frage genauso — dort sind die Originale sogar noch schwerer zurückzuholen.

**Bestandsmaterial.** Gibt es schon Videos auf Handys, in WhatsApp oder einer Cloud? Hochladen ist schnell, Taggen nicht. Realistisch nur die letzte Saison importieren und den Rest liegen lassen, bis jemand danach fragt.

**Alte Saisons archivieren.** In zwei Jahren liegen dort mehrere Choreos, von denen die Hälfte niemand mehr braucht. Ein `archived`-Flag auf `choreo` kostet nichts und hält die Auswahl übersichtlich.

### Zur Erinnerung: Datenschutz

Auf den Videos sind identifizierbare Personen. Das Ansehen ist im Plan offen, die URL also der einzige Schutz. Falls die Gruppe das anders will, gehört auch die Leseseite hinter den Gruppen-Code — das ist eine Zeile im Worker, aber eine Entscheidung, die man besser vorher trifft als nachher.

## Umsetzungsreihenfolge

### Phase 1 — tragfähiges Skelett

R2-Bucket mit CORS und Custom Domain, D1 mit Schema, Pages-Projekt auf `formation.nils-meier.de`, Worker mit Upload- und Listen-Endpunkten, Presigned PUT, Videoliste, natives `<video>`. Kein Processing, keine Abschnitte, keine Codes.

**Ziel:** eine Person kann ein Video hochladen und abspielen. Ein Wochenende.

### Phase 2 — das eigentliche Feature

Choreos und Abschnitte verwalten, `segment`-Tabelle, Tagging-Screen für Einzelvideos, Warteschlange, Abschnitts-Ansicht, Video-Tags. Ab hier ist das Portal nützlich — an die Gruppe geht es aber erst nach Phase 3.

**Ziel:** Klick auf "Kreis links" zeigt alle Videos mit Zeitbereich.

### Phase 3 — Alltagstauglichkeit

Video-Processing über GitHub Actions, Gruppen- und Tagger-Code, Mehrfach-Upload mit Fortschritt, Take-Gruppierung und Bulk-Tagging, Resend-Benachrichtigung, Reconcile-Job, Quota-Anzeige, tägliches D1-Backup. **Danach geht das Portal an die Gruppe.**

Das Processing gehört hierher und nicht ans Ende: Sobald iPhone-Nutzer hochladen, sehen andere sonst schwarze Player. Es ist keine Politur, sondern Voraussetzung dafür, dass jeder jedes Video sehen kann.

### Phase 4 — nur bei Bedarf

Umwandlung im Browser vor dem Upload, Multipart-Upload, Kommentare an Zeitstempeln, zwei Videos nebeneinander vergleichen.

---

### Die Reihenfolge ist bewusst so

Phase 2 kommt vor allem anderen, weil **ein Portal ohne das Abschnitts-Feature eine Dateiablage ist** — und dafür nimmt die Gruppe ihre WhatsApp-Gruppe. Der Nutzen muss früh sichtbar sein, sonst taggt niemand.

Die Codes kommen erst in Phase 3, weil in Phase 1 und 2 sowieso nur du das Ding benutzt. Solange die URL nicht kursiert, ist das vertretbar — aber vor der ersten Weitergabe an die Gruppe müssen sie stehen.

**Den iPhone-Test aber schon in Phase 1 machen**, bevor irgendetwas anderes gebaut ist: ein echtes iPhone-Video von Hand durch ffmpeg schicken und auf einem Android-Handy anschauen. Das Ergebnis zeigt, ob HEVC und HDR Probleme machen, und bestimmt, wie viel Aufwand später im Workflow steckt.

## Wie R2 abrechnet

Weder Spitzenwert noch aufsummierter Durchsatz, sondern zeitgewichtet: Storage wird in **GB-Monaten** berechnet, als Durchschnitt der täglichen Spitzenbelegung über 30 Tage.

Cloudflares eigenes Beispiel: 1 GB für 5 Tage, dann 3 GB für die restlichen 25 Tage ergibt 1 × 5/30 + 3 × 25/30 = **2,66 GB-Monate**.

**Konkreter Fall:** 15 GB hochladen, nach zehn Tagen löschen, dann 16 GB hochladen und nach weiteren zehn Tagen auch löschen:

```
15 GB × 10/30  +  16 GB × 10/30  =  10,33 GB-Monate
− 10 GB Freikontingent           =   0,33
aufgerundet                      =   1 GB-Monat
                                 =   $0,015
```

Anderthalb Cent. Kurzzeitig abgelegte Dateien sind also praktisch gratis — was zählt, ist, wie lange etwas liegen bleibt.

Zwei Dinge dazu: Cloudflare **rundet jede Position auf die nächste Einheit auf**, aus 1,1 GB-Monaten werden 2 berechnete. Und die Infrequent-Access-Klasse hat eine Mindestspeicherdauer — dort wird auch bezahlt, was vorher gelöscht wurde. Bei Standard-Storage gibt es diese Falle nicht.
