# Formation-Videoportal — Umsetzungsplan (Cloudflare-Stack)

Stand: 25.09.2026 · @Nils · überarbeitete Fassung (Review eingearbeitet, Änderungen am Ende)

## Überblick

Ein Videoportal für die Formationsgruppe. Trainingsvideos werden hochgeladen, mit Abschnitten der Choreografie verknüpft und lassen sich anschließend über diese Abschnitte finden: Klick auf "Kreis links" → alle Videos, die diese Stelle zeigen, jeweils mit Timecode. Keine Benutzerkonten, aber auch nicht offen für jeden im Internet — wie genau das Ansehen geschützt wird, ist noch offen (siehe **Zugangsschutz**).

**Kernidee:** Die Videodateien liegen im Object Storage, alles Interessante (Abschnitte, Zuordnungen, Timecodes) liegt in einer kleinen relationalen Datenbank. Beide bleiben getrennt und einzeln austauschbar.

**Gewählter Stack:** Cloudflare — R2 für Dateien, D1 für Metadaten, **ein Worker mit Static Assets** für Frontend, API und Cron-Jobs. Das Video-Processing läuft über GitHub Actions. Keine eigene Hardware im Betrieb.

### Architektur

```
Browser ──► formation.nils-meier.de   EIN Worker: Frontend-Assets + /api/* + Cron-Jobs
   │                                     │
   │  liest/schreibt Metadaten ─────────►├──► D1
   │                                     │
   │  holt Upload-URL ──────────────────►│  prüft Code, Größe, Quota → signiert
   │                                     │
   │  lädt Original DIREKT hoch ─────────┼──────────────────────────► R2  raw/
   │                                     │
   │  meldet "fertig" ──────────────────►│  head(): Datei da? echte Größe?
   │                                     │
   │                                     └─ workflow_dispatch ──► GitHub Actions
   │                                                                │ holt raw/, ffmpeg
   │                                                                ├─► R2  play/ + thumb/
   │                                                                └─► /api/internal/processed → D1
   │
   └─ spielt ab ─────────────────────────────────────────────────► R2  play/
                                        (media.formation.nils-meier.de)
```

Der Upload geht **am Worker vorbei** direkt nach R2. Das ist der Grund für Presigned URLs: die API sieht nie 800 MB Videodaten und bleibt winzig.

Die zentrale Designentscheidung: Timecodes und Abschnitte sind Daten, keine Eigenschaft der Videodatei. Ein Umzug zu einem anderen Storage-Anbieter kostet dadurch nur das Umkopieren der Dateien und das Ändern einer Basis-URL — die Tagging-Arbeit bleibt erhalten.

## Storage: Cloudflare R2

**Konditionen:** 10 GB/Monat gratis, danach 0,015 $/GB/Monat. Egress ist komplett kostenlos. S3-kompatibel, also funktioniert jedes S3-SDK und jedes Presigned-URL-Beispiel. Zum Aktivieren von R2 braucht der Account ein hinterlegtes Zahlungsmittel, auch wenn man im Freikontingent bleibt.

Bei 100–300 GB Videobibliothek landet ihr bei 1,35–4,35 $ im Monat. Traffic ist dabei nie ein Thema — das ist der Hauptgrund für R2 gegenüber Backblaze B2, wo Egress nur bis zum Dreifachen der Speichermenge frei ist.

### Mit welchen Größen zu rechnen ist

| Quelle | ca. pro Minute | 5-Minuten-Durchlauf |
| --- | --- | --- |
| iPhone 4K/30 (HEVC) | 350–400 MB | ~2 GB |
| iPhone 1080p/30 (HEVC) | 60 MB | ~300 MB |
| WhatsApp-Weiterleitung | 5–10 MB | ~40 MB |
| Abspielfassung 720p (CRF 23) | 15–25 MB | ~100 MB |

Ein Training mit vier Kameras in 4K sind schnell 8 GB Originale. Die 100–300 GB sind damit eher nach einer Saison erreicht als nach zweien. Stellschrauben: die Gruppe bittet, in 1080p zu filmen, und/oder Originale nach einer Frist löschen (offene Entscheidung 7). Die Abspielfassung ist das eigentliche Archiv.

### Bucket-Layout

```
raw/<id>.<ext>      Original wie hochgeladen — Archiv, nur zum Download
play/<id>.mp4       720p, H.264, faststart — wird abgespielt
thumb/<id>.jpg      Vorschaubild
```

`<id>` ist überall die `video.id` (UUID). Die Endung stammt aus einer festen Liste (`mov`, `mp4`, `m4v`, `webm`, `3gp`), alles andere wird `bin` — nie den Dateinamen des Nutzers in den Key übernehmen.

Ein Bucket reicht, die Präfixe genügen zur Trennung. Abgespielt wird immer `play/`. Die Präfixe machen Lifecycle-Regeln einfach, etwa "Originale nach 180 Tagen löschen, Abspielfassung bleibt".

### Zugriff nach außen

Custom Domain `media.formation.nils-meier.de` an den Bucket binden. Die `r2.dev`-Entwicklungs-URL ist ausdrücklich nicht für Produktion gedacht und hart rate-limited.

**CORS am Bucket** (gilt für den S3-Endpunkt, an den der Browser hochlädt): Origin `https://formation.nils-meier.de`, Methoden `PUT`, Header `content-type`, `ExposeHeaders: ETag` (braucht der Multipart-Upload).

### Bekannte Fallstricke

**Class-A-Operationen sind die Kostenfalle.** 4,50 $ pro Million, 1 Million frei. Bei R2 sind nicht Bytes das Risiko, sondern Schreib- und Listenzugriffe:

- Multipart-Uploads erzeugen **eine Class-A-Operation pro Teil** — ein 2-GB-Video in 5-MB-Teilen sind 400 Operationen, in 32-MB-Teilen 64.
- `list()` im Reconcile-Job ist Class A, eine pro 1000 Objekte.
- Ein Job, der versehentlich alle fünf Minuten statt täglich läuft, frisst das Freikontingent schnell.

Bei vernünftigen Intervallen unproblematisch.

**Kein hartes Spending-Limit.** Cloudflare bietet nur Budget-Alerts per E-Mail, die nichts pausieren. Das Kostenlimit baut der Worker selbst — siehe **Quota**.

**Kein Object Versioning, kein Soft-Delete.** Was in R2 gelöscht ist, ist weg. Deshalb löscht die App nie sofort, sondern über einen Papierkorb (siehe **Löschen und Papierkorb**).

**Video-AGB.** Die früheren CDN-Bedingungen gegen das Ausliefern großer Videomengen sind seit 2023 so gefasst, dass Video über die Developer-Platform-Produkte — also R2 — der vorgesehene Weg ist. Bei der Größenordnung einer Tanzgruppe ohnehin kein Thema.

**Storage-Metriken sind verzögert.** Bei frisch angelegten Buckets kommen anfangs gar keine Storage-Metriken zurück, während Operations-Metriken schon funktionieren — nicht stundenlang das Query debuggen, einen Tag warten.

## Datenmodell

```sql
CREATE TABLE choreo (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,        -- "Latein 2026"
  season        TEXT,
  duration_s    REAL,                 -- Länge der Musik = Referenz-Zeitleiste
  ref_video_id  TEXT,                 -- optional: Referenzaufnahme; bewusst ohne FK (zirkulär)
  archived      INTEGER NOT NULL DEFAULT 0,
  sort_order    INTEGER
);

CREATE TABLE section (                -- die "Stellen" in der Choreo
  id            TEXT PRIMARY KEY,
  choreo_id     TEXT NOT NULL REFERENCES choreo(id),
  name          TEXT NOT NULL,        -- "Einmarsch", "Kreis links", "Hebung"
  start_s       REAL,                 -- Position auf der CHOREO-Zeitleiste (0 = erster Ton)
  end_s         REAL,
  start_count   INTEGER,              -- Achter, rein beschreibend
  end_count     INTEGER,
  sort_order    INTEGER NOT NULL,
  CHECK ((start_s IS NULL) = (end_s IS NULL)),
  CHECK (start_s IS NULL OR start_s < end_s)
);

CREATE TABLE take (                   -- eine Ausführung, aus mehreren Winkeln gefilmt
  id            TEXT PRIMARY KEY,
  label         TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE video (
  id                   TEXT PRIMARY KEY,
  choreo_id            TEXT REFERENCES choreo(id),               -- nullable: Videos ohne Choreo
  take_id              TEXT REFERENCES take(id) ON DELETE SET NULL,
  storage_key          TEXT NOT NULL,     -- raw/<id>.<ext>
  play_key             TEXT,              -- play/<id>.mp4
  thumb_key            TEXT,              -- thumb/<id>.jpg
  content_type         TEXT,
  title                TEXT,
  recorded_at          TEXT,
  camera               TEXT,
  duration_s           REAL,
  music_offset_s       REAL,              -- Videozeit, zu der die Musik startet; NULL = keine durchgehende Musik
  size_bytes           INTEGER NOT NULL,  -- Original; nach /complete die echte Größe aus head()
  play_size_bytes      INTEGER,
  uploaded_by          TEXT,
  multipart_upload_id  TEXT,              -- ab Phase 3, nur während des Uploads gesetzt

  file_state           TEXT NOT NULL,     -- Zustand der Datei
  tag_state            TEXT NOT NULL DEFAULT 'untagged',   -- Zustand des Taggings
  processing           TEXT,              -- pending|done|failed
  processing_attempts  INTEGER NOT NULL DEFAULT 0,
  dispatched_at        TEXT,

  tagged_by            TEXT,
  tagged_at            TEXT,
  created_at           TEXT NOT NULL,
  deleted_at           TEXT,              -- gesetzt, solange im Papierkorb

  CHECK (file_state IN ('uploading','ready','missing','trashed')),
  CHECK (tag_state  IN ('untagged','tagged','no_tagging'))
);

CREATE TABLE segment (                -- was zeigt dieses Video
  id            TEXT PRIMARY KEY,
  video_id      TEXT NOT NULL REFERENCES video(id) ON DELETE CASCADE,
  section_id    TEXT NOT NULL REFERENCES section(id),
  start_s       REAL,                 -- NULL = das ganze Video zeigt diesen Abschnitt
  end_s         REAL,
  note          TEXT,
  CHECK ((start_s IS NULL) = (end_s IS NULL)),
  CHECK (start_s IS NULL OR start_s < end_s)
);

CREATE TABLE tag (                    -- Videoart, frei erweiterbar
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE, -- "Auftritt", "Vortanzen", "Erklärung"
  color         TEXT
);

CREATE TABLE video_tag (
  video_id      TEXT NOT NULL REFERENCES video(id) ON DELETE CASCADE,
  tag_id        TEXT NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
  PRIMARY KEY (video_id, tag_id)
);

CREATE INDEX idx_seg_section    ON segment(section_id);
CREATE INDEX idx_seg_video      ON segment(video_id);
CREATE INDEX idx_section_time   ON section(choreo_id, start_s);
CREATE INDEX idx_video_state    ON video(file_state, tag_state);
CREATE INDEX idx_video_choreo   ON video(choreo_id);
CREATE INDEX idx_video_take     ON video(take_id);
CREATE INDEX idx_video_proc     ON video(processing);
```

### Zwei Zustände, nicht einer

`file_state` und `tag_state` sind unabhängig voneinander. Früher steckte beides in einer Spalte `status` — dann ging beim Setzen von `missing` verloren, ob das Video schon getaggt war.

| `file_state` | Bedeutung |
| --- | --- |
| `uploading` | Datensatz angelegt, Upload läuft oder wurde abgebrochen |
| `ready` | Datei in R2 geprüft vorhanden |
| `missing` | Datei fehlt in R2 (Reconcile), Tagging bleibt erhalten |
| `trashed` | im Papierkorb, wird nach 30 Tagen endgültig gelöscht |

| `tag_state` | Bedeutung |
| --- | --- |
| `untagged` | steht in der Warteschlange |
| `tagged` | fertig — entweder Segmente oder Musik-Offset gesetzt |
| `no_tagging` | gehört zu keiner Choreo oder braucht keine Abschnitte (Technikerklärung, fremder Auftritt) — findet man über Video-Tags und die Videoliste |

### Fremdschlüssel

D1 prüft Fremdschlüssel standardmäßig. Daraus folgt:

- Ein Video endgültig löschen nimmt Segmente und Video-Tags per `ON DELETE CASCADE` mit. Ein `choreo.ref_video_id`, das darauf zeigt, setzt der Lösch-Job vorher auf NULL.
- Ein **Abschnitt, auf den Segmente zeigen, lässt sich nicht löschen** — nur umbenennen oder verschieben. Das ist gewollt: die Tagging-Arbeit hängt daran. Die Verwaltung zeigt, wie viele Segmente an einem Abschnitt hängen.
- Choreos werden nicht gelöscht, sondern archiviert (`archived = 1`).

### Zwei Zeitleisten — und der Musik-Offset als Brücke

|  | Wo | Wofür |
| --- | --- | --- |
| **Choreo-Zeitleiste** | `section.start_s` / `end_s` | "die Figur bei 2:31" — der Einstieg ins Portal. 0 = erster Ton der Musik |
| **Video-Zeitleiste** | `segment.start_s` / `end_s` | wo im Video die Stelle liegt — optional |

Der typische Einstieg ist die Choreo-Zeitleiste: Du weißt, dass die Figur irgendwo bei 2:31 kommt, scrubbst dorthin, und das Portal zeigt alle Videos, die diesen Abschnitt enthalten. Die Abschnittsliste ist der zweite Weg zum selben Ergebnis.

**Durchläufe mit Musik brauchen keine Segmente.** Bei einem Durchlauf oder Auftritt läuft die Musikaufnahme mit festem Tempo. Dann gilt für das ganze Video:

```
Videozeit = Choreozeit + music_offset_s
```

Ein einziger Klick im Tagging-Screen ("hier startet die Musik") setzt `music_offset_s` und ordnet das Video damit **allen** Abschnitten mit Zeitbereich zu. Abschnitte, die hinter dem Videoende liegen (Durchlauf abgebrochen), fallen automatisch raus.

Das ist etwas anderes als das verworfene Auto-Tagging über BPM: Im Training wird gezählt und das Tempo schwankt — dafür bleibt es bei Segmenten von Hand. Der Offset gilt nur, wo wirklich die Musik läuft.

Grenzen: ein Offset pro Video. Zwei Durchläufe in einem Video → Segmente von Hand, oder das Video wird beim Filmen geteilt.

### Segmentzeiten sind optional

`segment.start_s` darf NULL sein. Zwei Fälle:

- **Kurzer Clip** — 30 Sekunden, zeigt eine Figur: nur "dieses Video zeigt Abschnitt X", keine Zeiten. Ein Klick beim Taggen.
- **Langer Durchlauf ohne Musik** — gezählt, 5 Minuten: Bereiche setzen, damit klar ist, wo man hinspringt.

Dass ein Clip vorne drei Sekunden Vorlauf hat, ist egal. Es geht ums grobe Ordnen, nicht um Frame-Genauigkeit.

**Ein Video kann dieselbe Stelle mehrfach zeigen**, deshalb hat `segment` einen eigenen Schlüssel statt `(video_id, section_id)`.

### Takes

`take` bündelt Winkel — dieselbe Ausführung aus vier Richtungen. Im Player erscheinen die anderen Winkel als "andere Perspektiven".

Weil die Kameras nicht gleichzeitig starten, liegt dieselbe Stelle in jedem Winkel bei einer anderen Videozeit. Deshalb:

- **Segmente ohne Zeiten** lassen sich auf den ganzen Take setzen — sie werden auf jedes Video des Takes kopiert.
- **Zeiten** bekommt jedes Video einzeln: bei Musik über den eigenen `music_offset_s` (ein Klick pro Winkel), ohne Musik über eigene Segmente.

Ein separater Kamera-Sync entfällt damit.

### Die Hauptabfragen

```sql
-- Einstieg über die Choreo-Zeitleiste: "was passiert bei 2:31?"
SELECT * FROM section
WHERE choreo_id = ?1 AND ?2 BETWEEN start_s AND end_s;

-- Videos zu einem Abschnitt: explizite Segmente + über Musik-Offset abgeleitete
SELECT v.id, v.title, v.recorded_at, v.camera, v.thumb_key,
       sg.start_s, sg.end_s, sg.note, 'segment' AS quelle
FROM segment sg
JOIN video v ON v.id = sg.video_id
WHERE sg.section_id = ?1 AND v.file_state = 'ready'

UNION ALL

SELECT v.id, v.title, v.recorded_at, v.camera, v.thumb_key,
       s.start_s + v.music_offset_s, s.end_s + v.music_offset_s, NULL, 'offset'
FROM section s
JOIN video v ON v.choreo_id = s.choreo_id
WHERE s.id = ?1
  AND v.file_state = 'ready'
  AND v.music_offset_s IS NOT NULL
  AND s.start_s IS NOT NULL
  AND s.start_s + v.music_offset_s < COALESCE(v.duration_s, 1e9)
  AND s.end_s   + v.music_offset_s > 0
  AND NOT EXISTS (SELECT 1 FROM segment x
                  WHERE x.video_id = v.id AND x.section_id = ?1)

ORDER BY recorded_at DESC;
```

Bewusst **kein** Filter auf `tag_state = 'tagged'`: ein halb getaggter Durchlauf soll mit den bereits gesetzten Abschnitten schon gefunden werden. `tag_state` steuert nur die Warteschlange.

## Datenbank: Cloudflare D1

D1 ist SQLite und läuft direkt neben dem Worker — kein zweiter Anbieter, keine Verbindungsverwaltung. Für ein paar hundert Videos und ein paar tausend Tag-Zeilen ist das Gratiskontingent weit überdimensioniert.

Migrationen laufen über `wrangler d1 migrations` — von Anfang an nutzen, nicht per Hand am Schema schrauben, sonst weiß nach einem halben Jahr niemand mehr, warum eine Spalte da ist.

### Sicherheitsnetz bis zum richtigen Backup

**D1 Time Travel** ist automatisch aktiv und kostet nichts: Im Free-Plan lässt sich die Datenbank auf jeden Zeitpunkt der letzten 7 Tage zurücksetzen (`wrangler d1 time-travel restore formation-portal --timestamp=…`). Das deckt "falsch gelöscht" und "Migration kaputt" ab, solange man es innerhalb einer Woche merkt — und reicht für die Aufbauphase.

Ein richtiges Backup (täglicher `wrangler d1 export` auf den Proxmox-Server, Versionen über Wochen) folgt in Phase 4. Die Tagging-Arbeit ist der einzige Teil des Systems, der sich nicht neu erzeugen lässt — spätestens wenn die Gruppe ernsthaft taggt, gehört es dazu.

## Hosting: ein Worker mit Static Assets

Frontend, API und Cron-Jobs laufen in **einem** Worker. Das Frontend (`public/`, reines HTML/CSS/JS ohne Build-Schritt) wird als Static Assets mit ausgeliefert, `/api/*` geht an den Worker-Code. Die maßgebliche Konfiguration ist `wrangler.toml` im Repo; die wichtigen Punkte:

- `run_worker_first = ["/api/*"]` — API-Pfade immer an den Worker, alles andere zuerst als Datei.
- Das R2-Binding braucht `jurisdiction = "eu"`, weil der Bucket in der EU-Jurisdiction liegt. Der S3-Endpunkt für Presigned URLs ist entsprechend `https://<account-id>.eu.r2.cloudflarestorage.com`.
- `workers_dev = false`: ausgeliefert wird nur über `formation.nils-meier.de`.
- Cron-Trigger kommen in Phase 3 dazu: `crons = ["0 * * * *", "0 19 * * *"]` (stündlich; täglich 21:00 MESZ — Cron läuft in UTC).
- `noindex` kommt über `public/_headers` und `robots.txt`.

### Warum Worker und nicht Pages

- **Pages Functions können keine Cron-Trigger.** Der Plan braucht aber mehrere: verwaiste Uploads, Processing-Retry, Reconcile, Papierkorb leeren, Tagesmail.
- Cloudflare empfiehlt für neue Projekte ohnehin Workers mit Static Assets; Pages bekommt keine neuen Funktionen mehr.
- Ein Deploy, eine Konfiguration, same-origin — kein CORS zwischen Frontend und API.

### Warum nicht Vercel

Auf Cloudflare greift der Worker per `env.DB` und `env.BUCKET` direkt auf D1 und R2 zu — kein HTTP, keine Zugangsdaten im Code. Auf Vercel müsste die API trotzdem bei Cloudflare laufen, cross-origin, mit zwei Deploy-Pipelines. Vercels Stärke ist Next.js-Komfort, und den braucht dieses Projekt nicht.

### Domains

| Domain | Ziel |
| --- | --- |
| `formation.nils-meier.de` | Worker (Frontend + `/api/*`) |
| `media.formation.nils-meier.de` | R2-Bucket (Videoauslieferung) |

Voraussetzung: `nils-meier.de` liegt mit den Nameservern bei Cloudflare.

Beide Domains senden `X-Robots-Tag: noindex` (Worker-Header bzw. Transform Rule), dazu eine `robots.txt` mit `Disallow: /`.

## API

Bewusst klein halten. Zugangsstufen: **Lesen** (Schutz noch offen, siehe **Zugangsschutz**), **Gruppe** (Gruppen-Code), **Tagger** (Tagger-Code, schließt Gruppe ein), **intern** (Bearer-Secret).

### Lesen

| Methode | Pfad | Zweck |
| --- | --- | --- |
| GET | `/api/choreos` | alle Choreos (archivierte nur auf Wunsch) |
| GET | `/api/choreos/:id` | Choreo mit allen Abschnitten |
| GET | `/api/sections/:id/videos` | alle Videos + Zeitbereiche zu dieser Stelle |
| GET | `/api/videos` | Liste, filterbar nach Choreo, Datum, Kamera, Video-Tag, Tag-Status |
| GET | `/api/videos/:id` | Einzelvideo inkl. Segmente, Tags, andere Winkel des Takes |
| GET | `/api/tags` | Video-Tags |

### Gruppe

| Methode | Pfad | Zweck |
| --- | --- | --- |
| POST | `/api/videos` | Datensatz anlegen, Presigned PUT-URL zurückgeben |
| POST | `/api/videos/:id/parts` | Multipart (Phase 3): URLs für die nächsten Teile |
| POST | `/api/videos/:id/complete` | Datei per `head()` prüfen → `ready`, Processing anstoßen |

### Tagger

| Methode | Pfad | Zweck |
| --- | --- | --- |
| POST / PATCH | `/api/choreos`, `/api/choreos/:id` | Choreos anlegen, ändern, archivieren |
| POST | `/api/choreos/:id/sections` | Abschnitt anlegen |
| PATCH / DELETE | `/api/sections/:id` | Abschnitt ändern; löschen nur, wenn ungenutzt |
| PATCH | `/api/videos/:id` | Metadaten, Choreo, `music_offset_s`, `tag_state` (z. B. `no_tagging`) |
| DELETE | `/api/videos/:id` | in den Papierkorb |
| POST | `/api/videos/:id/restore` | aus dem Papierkorb zurückholen |
| POST | `/api/videos/:id/replace` | neue Upload-URL für eine Ersatzdatei (bei `missing`), Tagging bleibt |
| GET | `/api/videos/:id/original` | kurzlebige Presigned GET-URL fürs Original |
| POST | `/api/videos/:id/segments` | Segment setzen |
| PATCH / DELETE | `/api/segments/:id` | Segment korrigieren / entfernen |
| POST | `/api/takes` | Videos zu einem Take gruppieren |
| POST | `/api/takes/:id/segments` | Segment **ohne Zeiten** auf alle Videos des Takes |
| PUT | `/api/videos/:id/tags` | Video-Tags setzen |
| POST | `/api/tags` | Video-Tag anlegen |
| GET | `/api/stats` | belegter Speicher, Videoanzahl, offene Tags, Processing-Fehler |

### Sonstige

| Methode | Pfad | Zugang | Zweck |
| --- | --- | --- | --- |
| POST | `/api/mail-delete` | signiertes Token | Video aus der Benachrichtigungsmail in den Papierkorb |
| POST | `/api/internal/processed` | Bearer-Secret | Rückmeldung des GitHub-Workflows |

### Codes prüfen

- Der Code kommt im Header `X-Portal-Code`, das Frontend merkt ihn sich in `localStorage`.
- Der Worker vergleicht in konstanter Zeit gegen die Secrets `GROUP_CODE` und `TAGGER_CODE`.
- **Rate-Limiting:** eine Cloudflare-Rate-Limiting-Regel (im Free-Plan enthalten) auf `POST`/`PUT`/`PATCH`/`DELETE` unter `/api/*`, z. B. 20 Anfragen pro 10 Sekunden je IP. Das macht Durchprobieren der Codes sinnlos.
- `tagged_by` und `uploaded_by` sind Freitext-Namen, die das Frontend einmal abfragt und sich merkt — keine Identität, nur ein Hinweis.

### Presigned URLs im Worker

Das R2-Binding kann keine Presigned URLs erzeugen — dafür `aws4fetch` mit den S3-API-Zugangsdaten eines **auf diesen Bucket beschränkten** R2-API-Tokens:

```js
import { AwsClient } from "aws4fetch";

const r2 = new AwsClient({
  accessKeyId: env.R2_ACCESS_KEY_ID,
  secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  service: "s3",
  region: "auto",
});

const url = new URL(
  `${env.R2_S3_ENDPOINT}/${env.BUCKET_NAME}/${key}` // https://<account-id>.eu.r2.cloudflarestorage.com
);
url.searchParams.set("X-Amz-Expires", "900"); // 15 Minuten

const signed = await r2.sign(new Request(url, { method: "PUT" }), {
  aws: { signQuery: true },
});
// signed.url an den Browser geben
```

**Wichtig:** Eine Presigned PUT-URL begrenzt weder Größe noch Content-Type — `aws4fetch` signiert diese Header nicht, und Presigned POST mit `content-length-range` unterstützt R2 nicht. Was der Client in `POST /api/videos` angibt, ist nur eine Absichtserklärung. Die eigentliche Prüfung passiert in `/complete`.

Die Zugangsdaten gehören in Worker Secrets (`wrangler secret put`), niemals ins Frontend und niemals ins Repository.

## Upload-Flow und Rollen

**Hochladen und Taggen sind getrennt.** Jeder aus der Gruppe lädt hoch, niemand muss taggen. Getaggt wird nachträglich von wenigen Leuten — sonst macht es jeder anders und die Suche liefert Müll.

### Zwei Codes, keine Accounts

| Rolle | Code | Darf |
| --- | --- | --- |
| Ansehen | offen, siehe **Zugangsschutz** | suchen, abspielen |
| Hochladen | Gruppen-Code | Videos hochladen, Metadaten setzen |
| Taggen | Tagger-Code | Segmente und Offsets setzen, Takes bilden, verwalten, löschen |

Den Tagger-Code kennen drei Leute. Kein Login, kein Account, keine Benutzerverwaltung.

### Upload

1. Nutzer wählt Datei(en), gibt Datum, Kamera, seinen Namen, optional Choreo und Video-Tags an, optional Häkchen "gehört zu keiner Choreo".
2. Frontend ruft `POST /api/videos` mit Dateiname, Größe, Content-Type, Gruppen-Code. Content-Type ist `file.type`; ist der leer (kommt auf Android vor), aus der Endung ableiten.
3. Worker prüft: Code gültig? Angegebene Größe unter `MAX_FILE_BYTES`? Content-Type `video/*`? Quota frei? Dann Datensatz mit `file_state='uploading'` anlegen und eine **15 Minuten gültige Presigned PUT-URL** zurückgeben.
4. Frontend lädt direkt nach R2 (XHR für den Fortschritt), mit `Content-Type`-Header — sonst liefert R2 die Datei später als Download statt als Video aus.
5. `POST /api/videos/:id/complete` — der Worker prüft **jetzt erst wirklich**:

```js
const obj = await env.BUCKET.head(video.storage_key);
if (!obj) return json({ error: "Datei nicht angekommen" }, 409);

const ct = obj.httpMetadata?.contentType ?? "";
if (obj.size > Number(env.MAX_FILE_BYTES) || !ct.startsWith("video/")) {
  await env.BUCKET.delete(video.storage_key);
  await env.DB.prepare("DELETE FROM video WHERE id = ?").bind(video.id).run();
  return json({ error: "Datei abgelehnt" }, 413);
}

await env.DB.prepare(
  `UPDATE video
      SET file_state = 'ready', size_bytes = ?, content_type = ?, processing = 'pending'
    WHERE id = ? AND file_state = 'uploading'`
).bind(obj.size, ct, video.id).run();

ctx.waitUntil(dispatchProcessing(env, video)); // siehe Video-Processing
```

6. Video erscheint in der Tagging-Warteschlange (oder mit `no_tagging` direkt in der Videoliste).

Mehrere Dateien auf einmal: nach dem Training lädt jemand vier Kameraaufnahmen hoch. Gleiche Metadaten für alle, die Dateien laufen nacheinander (höchstens zwei parallel) im Hintergrund durch.

**Niemals Schreib-Credentials ins Frontend.** Das ist der ganze Sinn der Presigned URLs: zeitlich begrenzt, auf einen Schlüssel festgelegt, erst nach der Prüfung ausgestellt.

### Multipart-Upload (Phase 3)

Ein einzelner PUT über 1–2 GB scheitert in der Praxis: Mobilfunk bricht ab, und auf dem iPhone reicht es, dass der Bildschirm sperrt oder man kurz die App wechselt. Bei 4K-Durchläufen von 2 GB ist das der Normalfall, nicht die Ausnahme. Außerdem ist ein einzelner PUT bei R2 auf knapp 5 GB begrenzt.

- Ab ca. 100 MB startet der Worker per `env.BUCKET.createMultipartUpload(key)` einen Multipart-Upload und merkt sich die `uploadId` in `video.multipart_upload_id`.
- Teilgröße **32 MB** (R2 verlangt mindestens 5 MiB und gleich große Teile außer dem letzten). Ein 2-GB-Video sind 64 Class-A-Operationen.
- Das Frontend holt sich per `POST /api/videos/:id/parts` Presigned URLs für die nächsten paar Teile (je 15 Minuten gültig, `partNumber` + `uploadId` in der Query) und merkt sich die ETags fertiger Teile in `localStorage`.
- Bricht der Upload ab, macht der Nutzer an derselben Stelle weiter — nur die fehlenden Teile werden neu übertragen.
- `/complete` schließt per `env.BUCKET.resumeMultipartUpload(key, uploadId).complete(parts)` ab und prüft danach wie oben.
- Während des Uploads `navigator.wakeLock.request("screen")` — hält den Bildschirm an (Safari ab 16.4, Chrome). Dazu ein deutlicher Hinweis "Bildschirm anlassen, App nicht wechseln".

Nicht abgeschlossene Multipart-Uploads räumt R2 nach 7 Tagen selbst ab (Standard-Lifecycle-Regel des Buckets — prüfen, dass sie aktiv ist).

### Limits und Benachrichtigung

Weil kurzzeitig belegter Speicher praktisch nichts kostet (siehe **Wie R2 abrechnet**), muss das Dateilimit nicht eng sein. Ein versehentlicher 40-GB-Upload, der nach drei Stunden gelöscht wird, kostet rechnerisch 0,17 GB-Monate — also nichts. Wichtiger als ein hartes Limit ist, dass du **mitbekommst**, wenn etwas Ungewöhnliches hochgeladen wird.

| Stufe | Wert (Vorschlag) | Verhalten |
| --- | --- | --- |
| Benachrichtigung | ab 3 GB | Sofortmail an dich, Upload läuft normal durch |
| Hartes Dateilimit | 5 GB | Upload wird abgelehnt (vorab nach Angabe, in `/complete` nach echter Größe) |
| Quota | `QUOTA_BYTES` | Gesamtdeckel über alle Videos |

Die Schwelle liegt bewusst über 2 GB: ein normaler 4K-Durchlauf soll keine Mail auslösen.

### E-Mail über Resend

Reine HTTP-API, funktioniert aus dem Worker ohne SMTP. `nils-meier.de` muss dort einmal als Absenderdomain verifiziert werden. Das kostenlose Kontingent ist für diesen Zweck um Größenordnungen überdimensioniert.

**Tageszusammenfassung statt Einzelmails.** Einmal abends per Cron eine kurze Übersicht — nur wenn es etwas zu berichten gibt:

- neu hochgeladene Videos (Titel, Größe, Hochlader, Choreo, Link)
- Videos mit `processing='failed'`
- Auffälligkeiten aus dem Reconcile-Job (fehlende Dateien, unbekannte Objekte, Größenabweichungen)
- Stand Speicher / Quota

**Sofortmail** nur bei Einzeluploads über der Benachrichtigungsschwelle, mit:

- Dateiname, Größe, Hochlader, Choreo
- Link zum Ansehen
- **Link zum Löschen**

### Der Löschen-Link

Mailprogramme und Virenscanner (Outlook Safe Links, Link-Vorschauen, Gmail-Proxy) rufen Links vorab auf. Ein GET, der sofort löscht, löst deshalb irgendwann von selbst aus. Also:

1. Der Link zeigt auf eine **Bestätigungsseite** im Frontend: `https://formation.nils-meier.de/loeschen?v=<id>&exp=<ts>&sig=<hmac>`. Die Seite zeigt Vorschaubild, Titel und einen Button.
2. Erst der Button schickt `POST /api/mail-delete` mit denselben drei Werten.
3. `sig = HMAC-SHA256(MAIL_TOKEN_SECRET, "<id>.<exp>")`, gültig 7 Tage.
4. Das Video geht in den **Papierkorb**, nicht sofort weg — ein versehentlicher Klick ist damit ebenfalls harmlos.

### Löschen und Papierkorb

R2 hat kein Versioning, deshalb baut die App die Absicherung selbst — ohne Dateien zu kopieren:

- **Löschen** (Tagger oder Mail-Link) setzt nur `file_state='trashed'` und `deleted_at`. Das Video verschwindet aus allen Ansichten, Dateien und Tagging bleiben unangetastet.
- **Wiederherstellen** setzt `file_state` zurück auf `ready`. Ein Klick in der Verwaltung ("Papierkorb").
- **Endgültig** löscht der tägliche Cron alles, was länger als 30 Tage im Papierkorb liegt: `raw/`, `play/`, `thumb/` in R2, dann die Zeile (Segmente und Video-Tags per Cascade).
- Papierkorb-Videos zählen weiter zur Quota, bis sie endgültig gelöscht sind.

Gegen einen Fehlklick im Cloudflare-Dashboard hilft das nicht — dafür ist das Video-Backup in Phase 4 da.

### Weitere Details, die sonst wehtun

**Verwaiste Uploads aufräumen.** Alles, was länger als 24 Stunden auf `file_state='uploading'` steht, ist ein abgebrochener Upload: Objekt unter `storage_key` löschen (falls vorhanden), offenen Multipart-Upload abbrechen, Zeile löschen. Täglicher Cron.

## Quota und Kostenkontrolle

Cloudflare kennt kein hartes Ausgabenlimit. Da alle Uploads über deine Presigned URLs laufen, ist der Worker der Gatekeeper.

### Quota im Upload-Pfad

```js
const { belegt } = await env.DB.prepare(
  `SELECT COALESCE(SUM(size_bytes + COALESCE(play_size_bytes, 0)), 0) AS belegt
     FROM video
    WHERE file_state != 'missing'`
).first();

if (belegt + angegebeneGroesse > Number(env.QUOTA_BYTES)) {
  return new Response("Speicher voll, bitte alte Videos löschen", { status: 413 });
}
```

Laufende Uploads zählen mit ihrer angegebenen Größe (reserviert), fertige mit der echten Größe aus `head()`, Abspielfassungen mit der Größe aus dem Processing-Callback. Eine zweite Zählung (`storage_stats`) braucht es nicht — der Reconcile-Job korrigiert Abweichungen direkt in `size_bytes`.

Egress ist bei R2 gratis. Das einzige verbleibende Kostenrisiko sind Class-A-Operationen, und die kontrollierst du über vernünftige Job-Intervalle.

### Reconcile-Job gegen Drift

Einmal täglich per `env.BUCKET.list()` den Bucket gegen die DB abgleichen:

| Fall | Bedeutung | Reaktion |
| --- | --- | --- |
| In DB (`ready`), nicht im Bucket | von Hand gelöscht | `file_state='missing'`, Datensatz und Tagging **behalten**, in Tagesmail |
| Im Bucket, nicht in DB | unbekanntes Objekt | **nur melden**, nie automatisch löschen |
| Größe weicht ab | überschrieben | `size_bytes` korrigieren, melden, ggf. neu prozessieren |

**Warum "nur melden":** Wird D1 einmal auf einen älteren Stand zurückgesetzt (Time Travel, Backup), fehlen darin die Videos der letzten Tage. Ein Job, der "im Bucket, nicht in DB" automatisch löscht, würde genau diese Videos vernichten — dasselbe bei einem Bug in der Abfrage. Abgebrochene Uploads räumt der eigene Aufräum-Job ab, der die Keys aus der DB kennt.

**`missing` statt hartem Löschen:** Fliegt versehentlich das falsche Video aus dem Dashboard, lässt es sich über `POST /api/videos/:id/replace` neu hochladen, und die bestehenden Abschnitts-Marker hängen wieder dran.

### Zusätzliche Kontrolle

Budget-Alert bei etwa 5 $. Der stoppt nichts, aber du merkst früh, wenn ein Job einen Bug hat und im Kreis läuft.

Optional als Gegenprobe: GraphQL Analytics API (`r2StorageAdaptiveGroups`, Feld `payloadSize`). Die Werte sind verzögert, der `list()`-Abgleich ist die verlässlichere Quelle.

## Video-Processing über GitHub Actions

Jedes hochgeladene Video wird einmal serverseitig in eine einheitliche Abspielfassung umgewandelt. Workers können kein ffmpeg, eigene Hardware ist nicht gewünscht — deshalb läuft der Job auf GitHub-Runnern.

### Was dabei herauskommt

Ein Artefakt pro Video: `play/<id>.mp4` — 720p, H.264, 8 Bit, AAC, faststart, ohne Metadaten. Dazu Thumbnail, Dauer und Dateigröße.

| Problem | gelöst durch |
| --- | --- |
| iPhone-HEVC spielt nicht in jedem Browser | Umwandlung nach H.264 |
| iPhone-HDR sieht blass aus | Tone-Mapping, wenn HDR erkannt |
| Springen im Video ist zäh | faststart |
| Datenvolumen in der Halle | 720p statt Original |
| GPS-Koordinaten in der Datei | `-map_metadata -1` |

Das Original bleibt unverändert in `raw/` und wird nur heruntergeladen, nie abgespielt.

### Ablauf

1. `POST /api/videos/:id/complete` setzt `processing='pending'` und stößt per GitHub-API einen `workflow_dispatch` an (`processing_attempts + 1`, `dispatched_at = jetzt`).
2. Der Runner startet (typisch 20–60 Sekunden), prüft die Eingaben, zieht das Original aus R2 und wandelt um.
3. Abspielfassung und Thumbnail gehen zurück nach R2.
4. Der Runner ruft `POST /api/internal/processed`; der Worker setzt `play_key`, `thumb_key`, `duration_s`, `play_size_bytes` und `processing='done'`.

**Nicht im kritischen Pfad.** Ein Video ist ab dem Upload in der Warteschlange sichtbar und taggbar. Solange `play_key` fehlt, spielt der Player das Original — Android-Material funktioniert damit sofort, iPhone-HEVC erst nach der Umwandlung. Ein Hinweis "wird noch aufbereitet" genügt. Fällt GitHub aus, staut sich eine Warteschlange, kaputt ist nichts.

### Worker: Job anstoßen

```js
async function dispatchProcessing(env, video) {
  const res = await fetch(
    `https://api.github.com/repos/${env.GH_REPO}/actions/workflows/process-video.yml/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "formation-portal", // Pflicht, sonst lehnt GitHub ab
      },
      body: JSON.stringify({
        ref: "main",
        inputs: { video_id: video.id, storage_key: video.storage_key },
      }),
    }
  );
  // 204 = angenommen. Bei Fehler bleibt processing='pending', der stündliche Cron versucht es erneut.
  await env.DB.prepare(
    `UPDATE video SET processing_attempts = processing_attempts + 1, dispatched_at = ? WHERE id = ?`
  ).bind(new Date().toISOString(), video.id).run();
}
```

`GH_TOKEN` ist ein fine-grained Personal Access Token, beschränkt auf genau dieses Repository, mit **Actions: Read and write** — das genügt für `workflow_dispatch`. Anders als `repository_dispatch` braucht es damit kein Schreibrecht auf Contents; ein geleakter Token kann also keinen Code ins Repo pushen. Der Token liegt ausschließlich als Worker-Secret. **Ablaufdatum in den Kalender eintragen** — läuft er ab, bleiben alle neuen Videos auf `pending`.

### Workflow

`.github/workflows/process-video.yml`:

```yaml
name: process-video
on:
  workflow_dispatch:
    inputs:
      video_id:
        required: true
        type: string
      storage_key:
        required: true
        type: string

# Nie zwei Jobs für dasselbe Video gleichzeitig (z. B. Cron-Retry während der erste noch läuft)
concurrency:
  group: video-${{ inputs.video_id }}
  cancel-in-progress: false

permissions: {}

jobs:
  process:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    env:
      AWS_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
      AWS_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
      AWS_DEFAULT_REGION: auto
      # neuere AWS-CLI-Versionen senden Prüfsummen, mit denen R2 nicht immer zurechtkommt
      AWS_REQUEST_CHECKSUM_CALCULATION: when_required
      AWS_RESPONSE_CHECKSUM_VALIDATION: when_required
      R2: https://${{ secrets.R2_ACCOUNT_ID }}.eu.r2.cloudflarestorage.com   # EU-Jurisdiction
      BUCKET: formation-videos
      API: https://formation.nils-meier.de/api/internal/processed
      CALLBACK_SECRET: ${{ secrets.CALLBACK_SECRET }}
      # Eingaben nur über env, nie direkt per ${{ }} in run-Blöcke (Script-Injection)
      ID: ${{ inputs.video_id }}
      KEY: ${{ inputs.storage_key }}
    steps:
      - name: Eingaben prüfen
        run: |
          [[ "$ID"  =~ ^[0-9a-f-]{36}$ ]] || { echo "ungültige ID"; exit 1; }
          [[ "$KEY" =~ ^raw/[0-9a-f-]{36}\.[a-z0-9]{2,4}$ ]] || { echo "ungültiger Key"; exit 1; }

      - name: ffmpeg (statisches Build mit zimg für Tone-Mapping)
        run: |
          # Version pinnen; BtbN-GPL-Builds enthalten zscale/zimg
          curl -fsSL -o ff.tar.xz \
            "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n7.1-latest-linux64-gpl-7.1.tar.xz"
          mkdir ff && tar xf ff.tar.xz -C ff --strip-components=1
          echo "$PWD/ff/bin" >> "$GITHUB_PATH"

      - name: Original holen
        run: aws s3 cp "s3://$BUCKET/$KEY" in.bin --endpoint-url "$R2"

      - name: Abspielfassung, Thumbnail, Dauer
        run: |
          # kürzere Seite auf max. 720 px — funktioniert für quer und hochkant
          SCALE="scale=w='if(gt(iw,ih),-2,min(720,iw))':h='if(gt(iw,ih),min(720,ih),-2)'"

          # HDR (HLG oder PQ) erkennen → Tone-Mapping nach SDR, sonst blass
          TRC=$(ffprobe -v error -select_streams v:0 -show_entries stream=color_transfer -of csv=p=0 in.bin)
          TM=""
          if [[ "$TRC" == "arib-std-b67" || "$TRC" == "smpte2084" ]]; then
            TM="zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,"
          fi

          # erst skalieren (billig), dann tone-mappen; format=yuv420p ist Pflicht:
          # 10-Bit-H.264 spielt in fast keinem Browser
          ffmpeg -y -i in.bin -map 0:v:0 -map 0:a:0? -map_metadata -1 -map_chapters -1 \
            -vf "${SCALE},${TM}format=yuv420p" \
            -c:v libx264 -crf 23 -preset veryfast \
            -c:a aac -b:a 128k -movflags +faststart play.mp4

          DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 play.mp4)
          SS=$(awk -v d="$DUR" 'BEGIN { print (d > 2) ? 1 : 0 }')
          ffmpeg -y -ss "$SS" -i play.mp4 -frames:v 1 -vf scale=-2:360 thumb.jpg

          echo "DUR=$DUR" >> "$GITHUB_ENV"
          echo "PLAY_SIZE=$(stat -c%s play.mp4)" >> "$GITHUB_ENV"

      - name: Zurück nach R2
        run: |
          aws s3 cp play.mp4  "s3://$BUCKET/play/$ID.mp4"  --endpoint-url "$R2" --content-type video/mp4
          aws s3 cp thumb.jpg "s3://$BUCKET/thumb/$ID.jpg" --endpoint-url "$R2" --content-type image/jpeg

      - name: Worker benachrichtigen
        run: |
          curl -fsS --retry 3 -X POST "$API" \
            -H "Authorization: Bearer $CALLBACK_SECRET" \
            -H "Content-Type: application/json" \
            -d "{\"id\":\"$ID\",\"status\":\"done\",\"duration\":$DUR,\"play_size\":$PLAY_SIZE}"

      - name: Fehler melden
        # failure() allein greift nicht, wenn der Job am Timeout abgebrochen wird
        if: failure() || cancelled()
        run: |
          curl -fsS --retry 3 -X POST "$API" \
            -H "Authorization: Bearer $CALLBACK_SECRET" \
            -H "Content-Type: application/json" \
            -d "{\"id\":\"$ID\",\"status\":\"failed\"}"
```

Die HDR-Filterkette ist ein bewährtes Rezept, muss aber an echtem Material geprüft werden (siehe **iPhone-Test**). Wenn die Farben nicht passen, sind `npl` und der Tonemap-Operator die Stellschrauben.

### Worker: Rückmeldung empfangen

`POST /api/internal/processed`:

- prüft das Bearer-Secret (konstante Zeit) und dass `id` ein existierendes Video ist;
- leitet `play_key` und `thumb_key` selbst aus der ID ab, statt sie aus dem Request zu übernehmen;
- `done` → Felder setzen, `processing='done'`;
- `failed` → unter 3 Versuchen zurück auf `pending` (der stündliche Cron stößt neu an), ab 3 Versuchen `failed`.

Der Endpunkt gehört nicht zur öffentlichen API und nimmt ohne gültiges Secret nichts an. Falls das Ansehen später hinter Cloudflare Access liegt, braucht `/api/internal/*` eine Ausnahme.

### Wiederholen und Fehler

Eine Regel, ein Zähler: `processing_attempts` zählt Anstöße.

- **Stündlicher Cron:** `processing='pending'` und (`dispatched_at` leer oder älter als eine Stunde):
  - unter 3 Versuchen → erneut anstoßen;
  - ab 3 Versuchen → `failed`.
- **Aktive Fehlermeldung** aus dem Workflow, damit ein kaputtes Video nicht erst nach einer Stunde auffällt.
- **`failed`-Videos** stehen in der Tagesmail und in `/api/stats`. Meist ist es eine kaputte Datei; das Original bleibt erhalten, ein manueller Neustart setzt den Zähler zurück.

### Kontingent und Kosten

Repository **privat** halten — Logs enthalten Video-IDs, und wer die ID kennt, kommt an das Video. Private Repos haben im kostenlosen GitHub-Plan 2.000 Actions-Minuten pro Monat auf 2-Kern-Runnern.

Realistisch: ein 5-Minuten-Durchlauf in 4K-HEVC braucht dort **4–8 Minuten** inklusive Start (4K-HEVC zu dekodieren ist der teure Teil), ein 30-Sekunden-Clip gut eine Minute. Das reicht für einige hundert Videos im Monat — mit weniger Puffer als zunächst gedacht. Wer in 1080p filmt, halbiert die Laufzeit grob.

In R2 kommen pro Video zwei Class-A-Operationen dazu (Abspielfassung und Thumbnail) — vernachlässigbar.

### Zugangsdaten getrennt halten

Zwei getrennte R2-API-Tokens, beide auf den Bucket `formation-videos` beschränkt (Object Read & Write):

- einer für den Worker (Presigned URLs),
- einer für GitHub Actions.

So lässt sich einer rotieren, ohne den anderen anzufassen.

### iPhone-Test — der erste echte Test

Neuere iPhones filmen standardmäßig in HEVC und HDR (Dolby Vision/HLG, 10 Bit). Bevor der Rest gebaut wird, einmal den **echten Weg** durchspielen, nicht nur ffmpeg von Hand:

1. Ein aktuelles iPhone-Video **über Safari und das Upload-Formular** hochladen. Safari rechnet Videos aus der Fotomediathek beim Datei-Upload teilweise selbst um (H.264, kleinere Auflösung) — das kann das HEVC-Problem entschärfen, aber auch die Qualität drücken. Das Original aus R2 herunterladen und mit `ffprobe` nachsehen: Codec, Auflösung, `color_transfer`.
2. Dasselbe mit einem Android-Handy.
3. Das Original von Hand durch den ffmpeg-Befehl aus dem Workflow schicken und die Abspielfassung auf einem Android-Handy und einem iPhone ansehen. Stimmen die Farben?

Das Ergebnis bestimmt, wie viel Aufwand im Workflow steckt. Zusätzlich die Gruppe bitten, unter Einstellungen → Kamera → Video aufnehmen auf 1080p zu stellen — spart Speicher, Uploadzeit und Runner-Minuten. Darauf verlassen, dass alle HDR abschalten, sollte man sich nicht; deshalb erkennt der Workflow HDR selbst.

### Später möglich: Umwandlung im Browser

Transcoding per WebCodecs vor dem Upload bleibt als Optimierung denkbar — vor allem, weil es Uploads über Mobilfunk kleiner macht.

Als Hauptweg taugt es nicht: Firefox auf Android unterstützt WebCodecs gar nicht, volle Safari-Unterstützung gibt es erst ab Version 26, und ein App-Wechsel während der Umwandlung bricht den Job ab. Weil es deshalb immer einen serverseitigen Fallback bräuchte, lohnt sich der zweite Codepfad erst, wenn die Uploadgröße tatsächlich stört.

### Verworfene Alternativen

| Option | warum nicht |
| --- | --- |
| Mini-PC / Proxmox | technisch in Ordnung, aber bewusst keine eigene Hardware im Betrieb |
| Cloudflare Containers | braucht Workers Paid, 5 $/Monat |
| Cloudflare Stream | mind. 5 $/Monat, Dateien nicht mehr direkt greifbar |
| Fly.io Machines | gute Alternative, aber ein Anbieter mehr |
| Media Transformations | Limits von 100 MB Eingabe und 1 Minute Ausgabe |
| Gar kein Processing | iPhone-HEVC wäre für einen Teil der Gruppe unsichtbar |

## Tagging-Interface

**Hier entscheidet sich, ob das Portal benutzt wird.** Der Rest ist Infrastruktur, das hier ist die Arbeit, die jede Woche jemand machen muss.

Einstieg ist die Warteschlange: alle Videos mit `file_state='ready'` und `tag_state='untagged'`, neueste zuerst. Pro Video drei Wege, je nach Material:

### 1. Kurzer Clip → Abschnitt anklicken

Die meisten Videos sind kurze Clips, die eine Stelle zeigen:

1. Video ansehen.
2. Choreo auswählen (falls mehrere).
3. Abschnitt anklicken → fertig, `tag_state='tagged'`.

Keine Zeiten, kein Scrubben. Das Segment bekommt `start_s = NULL` und meint damit das ganze Video.

**Mehrere Winkel auf einmal:** vier Videos in der Warteschlange markieren (oder den Take wählen), Abschnitt anklicken, alle vier sind getaggt.

### 2. Durchlauf mit Musik → ein Klick auf den Musikstart

1. Video bis zum ersten Ton abspielen.
2. `M` drücken → `music_offset_s` ist gesetzt, `tag_state='tagged'`.
3. Die Abschnitte erscheinen sofort als Balken unter der Zeitleiste. Passen sie nicht ganz, den Offset mit `,` / `.` in 0,5-Sekunden-Schritten nachschieben.

Bei einem Take mit vier Winkeln: für jeden Winkel einmal `M`.

### 3. Durchlauf ohne Musik (gezählt) → Bereiche setzen

| Taste | Funktion |
| --- | --- |
| Leertaste | Play/Pause |
| ←/→ | ±5 Sekunden |
| Shift + ←/→ | ±1 Sekunde |
| ↑/↓ | vorheriger / nächster Abschnitt |
| I | Startzeitpunkt des Segments setzen |
| O | Endzeitpunkt setzen, speichern, **nächster Abschnitt wird automatisch gewählt** |
| M | Musikstart setzen (Weg 2) |
| , / . | Musik-Offset ±0,5 s |
| Backspace | letztes Segment zurücknehmen |
| +/− | Abspielgeschwindigkeit |

Eine Choreo hat eher 15–25 Abschnitte als 9 — deshalb keine Zifferntasten, sondern eine durchsuchbare Abschnittsliste neben dem Video und automatisches Weiterschalten. Bei einem Durchlauf ist die Reihenfolge ohnehin fest: `I`, `O`, `I`, `O` … bis zum Ende.

Gesetzte Segmente als Balken unter der Zeitleiste, einzeln korrigierbar. Grob reicht — ein paar Sekunden daneben stört niemanden.

### Abschnitte anlegen

Einmal pro Choreo, im Verwaltungsbereich: Name, Position auf der Choreo-Zeitleiste, optional die Achter.

Am einfachsten anhand einer Referenzaufnahme des kompletten Durchlaufs: zuerst deren Musikstart setzen (`M`), dann abspielen und an den Übergängen Grenzen setzen. Die Zeiten werden automatisch in Choreozeit umgerechnet (Videozeit − Offset). Weil die Choreo-Zeitleiste die Musik ist, sind Abschnitte, die so angelegt werden, sofort für alle Durchläufe mit Offset gültig.

Das muss passieren, bevor überhaupt getaggt werden kann, und ist der einzige Schritt, der Sorgfalt braucht: die Abschnitte sind die Sprache, in der später alle suchen.

### Was ausdrücklich nicht kommt

**Kein Auto-Tagging über BPM.** Beim Training läuft meist keine Musik, es wird gezählt, das Tempo schwankt. Jede Umrechnung Achter ↔ Sekunden wäre Scheingenauigkeit. (Der Musik-Offset ist davon unberührt: er gilt nur, wo die Musikaufnahme wirklich läuft.)

**Kein separater Kamera-Sync.** Jeder Winkel bekommt seinen eigenen Offset bzw. seine eigenen Segmente — das genügt fürs grobe Ordnen.

### Player-Funktionen

- **Abspielgeschwindigkeit** 0,5× und 0,25× in jedem Player. Beim Analysieren von Timing-Fehlern die meistgenutzte Funktion überhaupt.
- **Spiegeln** — ein Knopf, `transform: scaleX(-1)`. Wer von vorne gefilmt mitlernt, braucht das Bild seitenrichtig.
- **Schleife über einen Abschnitt** — Segment antippen, es läuft in Endlosschleife.
- **Andere Winkel** desselben Takes als Vorschaubilder unter dem Player.

## Frontend

### Ansichten

| Ansicht | Zugang | Zweck |
| --- | --- | --- |
| Choreo-Übersicht | Lesen | Zeitleiste und Abschnittsliste, Klickziel fürs Hauptfeature |
| Abschnitts-Ansicht | Lesen | alle Videos zu dieser Stelle, mit Zeitbereich und Vorschaubild |
| Videoliste | Lesen | filterbar nach Choreo, Datum, Kamera, Video-Tag, Tag-Status |
| Player | Lesen | Einzelvideo mit Segmentbalken, Spiegeln, Schleife, Tempo |
| Upload | Gruppen-Code | Dateien, Metadaten, Fortschritt, Fortsetzen nach Abbruch |
| Warteschlange | Tagger-Code | alle `untagged`-Videos |
| Tagging | Tagger-Code | Clip, Musik-Offset, Bereiche, Takes |
| Verwaltung | Tagger-Code | Choreos, Abschnitte, Video-Tags, Papierkorb, Speicherstand, Processing-Fehler |
| Löschen bestätigen | Mail-Token | Bestätigungsseite für den Link aus der Mail |

### Player

Start mit dem nativen `<video>`-Element — reicht für progressive MP4s völlig und bringt null Abhängigkeiten. Plyr als leichter Umstieg, wenn einheitliche Optik und Keyboard-Komfort wichtig werden.

In der Abschnitts-Ansicht steht der Zeitbereich (`1:03 – 1:10`) neben jedem Treffer und ist klickbar. Zum Springen die Startzeit als Media Fragment an die Quelle hängen (`play/<id>.mp4#t=63`) — `video.currentTime` direkt zu setzen, bevor die Metadaten geladen sind, ist auf iOS unzuverlässig.

### Mobil

Geschaut wird in der Halle am Handy: Touch-Ziele groß genug, Segmentbalken mit dem Daumen bedienbar, und immer die 720p-Abspielfassung als Quelle. Das Original gibt es nur für Tagger, als kurzlebiger Download-Link.

## Zugangsschutz (noch zu entscheiden)

Auf den Videos sind identifizierbare Personen. Stand heute: Wer den Link zum Portal kennt, sieht alle Videos — und der Link landet garantiert in der WhatsApp-Gruppe und wird weitergeleitet. "Die URL ist der Schutz" reicht deshalb nicht. Das muss vor der Weitergabe an die Gruppe (Ende Phase 3) entschieden und umgesetzt sein.

### Optionen

| | Wie | Vorteile | Nachteile |
| --- | --- | --- | --- |
| **A. Cloudflare Access** | Zero Trust Free (bis 50 Nutzer), Anmeldung per Einmal-Code an die E-Mail-Adresse, schützt beide Domains | echte Anmeldung ohne eigene Benutzerverwaltung; einzeln entziehbar, wenn jemand die Gruppe verlässt; Sitzung bis zu einem Monat | E-Mail-Liste pflegen; Ausnahme für `/api/internal/*` nötig; eine Hürde mehr beim ersten Aufruf |
| **B. Ansehen-Code + Cookie** | Code einmal eingeben → Cookie auf `.formation.nils-meier.de` (HttpOnly, Secure, SameSite=Lax, 1 Jahr). Eine WAF-Regel blockt Anfragen an `media.` ohne dieses Cookie | kaum Aufwand, fühlt sich an wie "kein Login"; Cookie wird auch für `media.` mitgeschickt (gleiche Site) | ein geteilter Code wird weitergegeben; Code wechseln heißt: alle neu eingeben und WAF-Regel anpassen |
| **C. Offen lassen** | wie bisher | null Aufwand | nur mit ausdrücklichem Einverständnis der Gruppe vertretbar |

Mein Vorschlag wäre B für den Start (passt zur Idee "Codes statt Accounts") mit A als Ausweg, falls die Gruppe es strenger will.

### Unabhängig von der Wahl

- **Originale nicht öffentlich ausliefern.** Eine WAF-Regel blockt `media.formation.nils-meier.de/raw/*` komplett. Originale gibt es nur über `GET /api/videos/:id/original` als 15 Minuten gültige Presigned GET-URL. Grund: iPhone-Originale enthalten GPS-Koordinaten, und der Key ist aus der öffentlichen Video-ID ableitbar.
- **Metadaten entfernen** in der Abspielfassung (`-map_metadata -1`, bereits im Workflow).
- **Nicht indexieren** (`noindex`, `robots.txt`, bereits eingeplant).
- **Mit der Gruppe klären:** Einverständnis zum Filmen und Hochladen, Löschen auf Wunsch (z. B. beim Austritt), bei Minderjährigen die Eltern.

## Konfiguration und Secrets

| Wo | Name | Inhalt |
| --- | --- | --- |
| Worker Secret | `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | R2-Token #1, nur dieser Bucket |
| Worker Secret | `GROUP_CODE`, `TAGGER_CODE` | die beiden Codes |
| Worker Secret | `GH_TOKEN` | fine-grained PAT, Actions: write, nur dieses Repo — **läuft ab** |
| Worker Secret | `CALLBACK_SECRET` | gemeinsam mit GitHub |
| Worker Secret | `MAIL_TOKEN_SECRET` | HMAC für den Löschen-Link |
| Worker Secret | `RESEND_API_KEY` | Resend |
| Worker Var | `ACCOUNT_ID`, `BUCKET_NAME`, `GH_REPO`, `QUOTA_BYTES`, `MAX_FILE_BYTES`, `NOTIFY_FILE_BYTES` | nicht geheim |
| GitHub Secret | `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | R2-Token #2, nur dieser Bucket |
| GitHub Secret | `R2_ACCOUNT_ID`, `CALLBACK_SECRET` | |

Lokal entwickeln mit `wrangler dev` (lokale D1 und R2), Secrets dafür in `.dev.vars` — die Datei gehört in `.gitignore`.

## Entscheidungen

### Entschieden

| Frage | Entscheidung |
| --- | --- |
| Storage | Cloudflare R2 |
| Datenbank | Cloudflare D1 |
| API + Frontend + Cron | ein Cloudflare Worker mit Static Assets |
| Frontend-Stack | reines HTML/CSS/JS ohne Framework und ohne Build-Schritt |
| Standort | R2-Bucket in der EU-Jurisdiction |
| Domain | `formation.nils-meier.de`, Videos über `media.` |
| Video-Processing | GitHub Actions per `workflow_dispatch`, eine 720p-Abspielfassung pro Video, HDR-Erkennung |
| Mehrere Choreos | ja |
| Video-Tags | ja, frei erweiterbar (Auftritt, Vortanzen, Erklärung …) |
| Einstieg ins Portal | Choreo-Zeitleiste oder Abschnittsliste |
| Tagging-Genauigkeit | grob; Segmentzeiten optional |
| Durchläufe mit Musik | ein Musik-Offset pro Video statt Segmente |
| Kamera-Sync | kein eigener Sync; Offset bzw. Segmente je Winkel |
| Auto-Tagging über BPM | nein |
| Upload und Tagging | getrennt, zwei Codes |
| Dateilimit | weich, mit E-Mail-Benachrichtigung über Resend |
| Löschen | immer über Papierkorb (30 Tage) |
| Reconcile | meldet nur, löscht nie selbst |
| Eigene Hardware | nicht im Betrieb |

### Noch offen

**1. Auflösung der Abspielfassung** — 720p schont Datenvolumen und reicht für Laufwege und Formationsbilder. 1080p zeigt Details wie Handhaltung und Fußarbeit besser, ist aber etwa doppelt so groß. Eine Zahl im Workflow; bestehende Videos müssten dann neu umgewandelt werden.

**2. Schwellenwerte** — Mail ab 3 GB, hartes Limit 5 GB, `QUOTA_BYTES`? 200 GB entspricht etwa 2,85 $/Monat, 500 GB etwa 7,35 $.

**3. Referenz je Choreo** — eine feste Durchlaufaufnahme (oder die Musikdatei), an der die Abschnitte definiert werden. Mit dem Musik-Offset wichtiger als vorher: die Abschnittszeiten sind dann die Grundlage für alle Durchläufe.

**4. Wer darf löschen** — nur Tagger, oder auch der Hochladende sein eigenes Video? (Papierkorb ist entschieden; der Löschen-Link in der Mail geht nur an dich.)

**5. Abschnitte pflegen** — wer legt sie an? Muss einmal pro Choreo passieren, bevor getaggt werden kann.

**6. Zugangsschutz fürs Ansehen** — A, B oder C, siehe **Zugangsschutz**. Muss vor der Weitergabe an die Gruppe stehen.

**7. Originale behalten?** — dauerhaft, oder per Lifecycle-Regel nach z. B. 180 Tagen löschen (die Abspielfassung bleibt)? Die Originale sind bei 4K der größte Kostenblock.

**8. Abschnitts-Vorschlag beim Upload?** — Der Engpass sind drei Tagger. Kompromiss: Hochladende dürfen optional einen Abschnitt aus der *festen* Liste wählen (keine Freitexte, also kein Wildwuchs). Das Video landet trotzdem in der Warteschlange, der Tagger bestätigt nur noch mit einem Klick.

### Weitere Hinweise

**Bestandsmaterial.** Gibt es schon Videos auf Handys, in WhatsApp oder einer Cloud? Hochladen ist schnell, Taggen nicht. Realistisch nur die letzte Saison importieren und den Rest liegen lassen, bis jemand danach fragt.

## Umsetzungsreihenfolge

### Phase 1 — tragfähiges Skelett

- R2-Bucket mit CORS und Custom Domain, D1 mit Schema über Migrationen.
- Worker mit Static Assets auf `formation.nils-meier.de`.
- Gruppen-Code (ein Secret, ein Header-Vergleich — ein offener Upload-Endpunkt gehört nicht ins Netz).
- `POST /api/videos` mit Presigned PUT, `/complete` mit `head()`-Prüfung.
- Videoliste, natives `<video>`, `noindex`.
- **iPhone-Test** über den echten Upload-Weg (siehe oben) — sobald der Upload steht, bevor irgendetwas anderes gebaut wird.

**Ziel:** eine Person kann ein Video hochladen und abspielen, und du weißt, was iPhone-Material wirklich ankommt. Ein Wochenende.

### Phase 2 — das eigentliche Feature

- Tagger-Code.
- Choreos und Abschnitte verwalten.
- Tagging-Screen: Clip, Musik-Offset, Bereiche; Warteschlange.
- Abschnitts-Ansicht, Choreo-Zeitleiste, Video-Tags.
- Papierkorb (Löschen, Wiederherstellen).
- Sicherheitsnetz: D1 Time Travel (nichts zu bauen, nur den Restore-Befehl einmal ausprobieren).

Ab hier ist das Portal nützlich — an die Gruppe geht es aber erst nach Phase 3.

**Ziel:** Klick auf "Kreis links" zeigt alle Videos mit Zeitbereich.

### Phase 3 — Alltagstauglichkeit

- Video-Processing über GitHub Actions inkl. HDR-Erkennung.
- Multipart-Upload mit Fortsetzen und Wake Lock, Mehrfach-Upload mit Fortschritt.
- Takes und Bulk-Tagging.
- Resend: Tagesmail, Sofortmail mit Löschen-Link über Bestätigungsseite.
- Cron-Jobs: verwaiste Uploads, Processing-Retry, Reconcile (nur melden), Papierkorb leeren.
- Quota-Anzeige, Rate-Limiting-Regel.
- **Zugangsschutz umsetzen** (Entscheidung 6), `raw/` sperren.

**Danach geht das Portal an die Gruppe.**

Das Processing gehört hierher und nicht ans Ende: Sobald iPhone-Nutzer hochladen, sehen andere sonst schwarze Player. Multipart ebenso: ohne ihn scheitert jeder zweite 4K-Durchlauf vom Handy.

### Phase 4 — nach dem Start

- **Backups:** täglicher `wrangler d1 export` auf den Proxmox-Server mit Versionen über Wochen; `rclone sync` von `raw/` (oder `play/`) dorthin. Egress ist gratis, das Backup kostet nur Class-B-Operationen. Einmal eine Wiederherstellung durchspielen.
- Automatischer Musik-Offset: im Workflow die Tonspur mit der Choreo-Musik kreuzkorrelieren und den Offset als Vorschlag setzen.
- Umwandlung im Browser vor dem Upload.
- Kommentare an Zeitstempeln, zwei Videos nebeneinander vergleichen.

---

### Die Reihenfolge ist bewusst so

Das Abschnitts-Feature kommt direkt nach dem Skelett und vor aller Alltagstauglichkeit, weil **ein Portal ohne Abschnitte eine Dateiablage ist** — und dafür nimmt die Gruppe ihre WhatsApp-Gruppe. Der Nutzen muss früh sichtbar sein, sonst taggt niemand.

Backups kommen bewusst erst nach dem Start: bis dahin fängt D1 Time Travel Fehler der letzten sieben Tage ab, und der Papierkorb Löschungen aus der App. Sobald die Gruppe ernsthaft taggt, rückt Phase 4 nach vorne.

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

Anderthalb Cent. Kurzzeitig abgelegte Dateien sind also praktisch gratis — was zählt, ist, wie lange etwas liegen bleibt. Für den Papierkorb heißt das: 30 Tage Aufbewahrung eines 2-GB-Videos kosten rund 3 Cent.

Zwei Dinge dazu: Cloudflare **rundet jede Position auf die nächste Einheit auf**, aus 1,1 GB-Monaten werden 2 berechnete. Und die Infrequent-Access-Klasse hat eine Mindestspeicherdauer — dort wird auch bezahlt, was vorher gelöscht wurde. Bei Standard-Storage gibt es diese Falle nicht.

## Änderungen gegenüber der ersten Fassung

- **Worker mit Static Assets statt Pages** — Pages Functions können keine Cron-Trigger.
- **`/complete` prüft per `head()`** Existenz, echte Größe und Content-Type — die Presigned URL erzwingt nichts davon.
- **Reconcile meldet nur**, löscht nie unbekannte Objekte (Schutz nach D1-Restore und vor Bugs).
- **Papierkorb** statt sofortigem Löschen; Video-Backups nach Phase 4, bis dahin D1 Time Travel als Netz.
- **Löschen-Link** führt auf eine Bestätigungsseite, gelöscht wird per POST.
- **Musik-Offset** pro Video für Durchläufe mit Musik; ersetzt den Kamera-Sync und löst das Takes-mit-Zeiten-Problem.
- **Zugangsschutz** als eigener Abschnitt mit Optionen; Originale nicht öffentlich, GPS-Metadaten entfernt, `noindex`.
- **`workflow_dispatch`** statt `repository_dispatch` (Token braucht nur Actions: write); getrennte, bucket-beschränkte R2-Tokens.
- **Workflow:** Eingabeprüfung, `concurrency`, `failure() || cancelled()`, Dauer aus der Abspielfassung, Thumbnail auch bei sehr kurzen Clips, HDR-Erkennung mit Tone-Mapping, statisches ffmpeg.
- **Datenmodell:** `status` aufgeteilt in `file_state` und `tag_state`; `ON DELETE CASCADE`, `CHECK`-Constraints; `take` ohne doppelte Felder; `play_size_bytes` für die Quota; `storage_stats` entfällt.
- **API:** Choreo-/Abschnitts-Verwaltung, Video ändern/löschen/wiederherstellen/ersetzen, Original-Download ergänzt; `PUT /sync` entfernt.
- **Größen realistischer:** Mail-Schwelle 3 GB statt 1,5 GB, Runner-Laufzeit 4–8 statt 2–3 Minuten, Multipart von Phase 4 nach Phase 3.
- **Tagging:** automatisches Weiterschalten statt Zifferntasten; Spiegeln und Schleife im Player.
- **Gruppen-Code ab Phase 1**, Tagger-Code ab Phase 2.
- Aufgeräumt: leere/vertauschte Entscheidungstabellen, veralteter Abschnitt "Punkte, die noch nirgends stehen", Verweis auf Cloudflare Stream beim Backup, Beispiel-Domain, Kostenangabe (4,35 $ statt 4,50 $).
