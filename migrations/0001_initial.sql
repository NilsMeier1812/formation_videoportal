-- Ausgangsschema, siehe docs/umsetzungsplan.md → Datenmodell

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
