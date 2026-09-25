-- Choreos, Tänze, Tags und die Zuordnung der Videos.
--
--   choreos         das Überding („Kür 2026“); genau eine Hauptaudio (main_project_id)
--   dances          Tänze einer Choreo (z. B. zwei)
--   projects        = Audios (die Planer-Projekte); gehören zu einer Choreo, enthalten Tänze
--   project_dances  welche Tänze eine Audio enthält
--   tags            Videoart („Auftritt“, „Üben“ …), von den Admins gepflegt
--   video           gehört zu einer Choreo, hat Tänze und Tags und optional einen
--                   Zeitraum (von–bis) in einer Audio – in der Regel der Hauptaudio
--
-- Die Tabellen choreo/section/take/segment/tag/video_tag aus 0001 wurden nie
-- benutzt und fallen weg. Die Tabelle video wird neu aufgebaut (Fremdschlüssel
-- zeigen jetzt auf choreos/projects), vorhandene Videos bleiben erhalten.

PRAGMA defer_foreign_keys = true;

CREATE TABLE choreos (
  id               TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  main_project_id  TEXT REFERENCES projects(id) ON DELETE SET NULL,  -- Hauptaudio
  sort_index       INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL
);

CREATE TABLE dances (
  id          TEXT PRIMARY KEY,
  choreo_id   TEXT NOT NULL REFERENCES choreos(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  sort_index  INTEGER NOT NULL DEFAULT 0
);

ALTER TABLE projects ADD COLUMN choreo_id TEXT REFERENCES choreos(id) ON DELETE SET NULL;

CREATE TABLE project_dances (
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  dance_id    TEXT NOT NULL REFERENCES dances(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, dance_id)
);

CREATE TABLE tags (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  sort_index  INTEGER NOT NULL DEFAULT 0
);

INSERT INTO tags (id, name, sort_index) VALUES
  ('tag-auftritt', 'Auftritt', 0),
  ('tag-vortanzen', 'Vortanzen', 1),
  ('tag-erklaerung', 'Erklärung', 2),
  ('tag-ueben', 'Üben', 3);

-- ---------------- Alte, nie benutzte Tabellen ----------------
DROP TABLE segment;
DROP TABLE video_tag;
DROP TABLE tag;

-- ---------------- video neu aufbauen ----------------
CREATE TABLE video_new (
  id                   TEXT PRIMARY KEY,
  choreo_id            TEXT REFERENCES choreos(id) ON DELETE SET NULL,
  audio_project_id     TEXT REFERENCES projects(id) ON DELETE SET NULL, -- worauf sich von–bis bezieht
  audio_start_s        REAL,
  audio_end_s          REAL,
  storage_key          TEXT NOT NULL,     -- raw/<id>.<ext>
  play_key             TEXT,              -- play/<id>.mp4
  thumb_key            TEXT,              -- thumb/<id>.jpg
  content_type         TEXT,
  title                TEXT,              -- optional, vom Admin; sonst wird die Anzeige zusammengesetzt
  recorded_at          TEXT,              -- ISO-Zeitpunkt (UTC) oder nur Datum bei alten Videos
  recorded_source      TEXT,              -- meta = aus der Datei, file = Dateidatum, manual = vom Admin
  duration_s           REAL,
  size_bytes           INTEGER NOT NULL,
  play_size_bytes      INTEGER,
  uploaded_by          TEXT,
  multipart_upload_id  TEXT,

  file_state           TEXT NOT NULL,
  tag_state            TEXT NOT NULL DEFAULT 'untagged',   -- untagged = im Eingang der Admins
  processing           TEXT,
  processing_attempts  INTEGER NOT NULL DEFAULT 0,
  dispatched_at        TEXT,

  tagged_by            TEXT,
  tagged_at            TEXT,
  created_at           TEXT NOT NULL,
  deleted_at           TEXT,

  CHECK (file_state IN ('uploading','ready','missing','trashed')),
  CHECK (tag_state  IN ('untagged','tagged')),
  CHECK (recorded_source IS NULL OR recorded_source IN ('meta','file','manual')),
  CHECK ((audio_start_s IS NULL) = (audio_end_s IS NULL)),
  CHECK (audio_start_s IS NULL OR (audio_start_s >= 0 AND audio_start_s < audio_end_s))
);

INSERT INTO video_new (id, storage_key, play_key, thumb_key, content_type, title, recorded_at,
                       duration_s, size_bytes, play_size_bytes, uploaded_by, multipart_upload_id,
                       file_state, tag_state, processing, processing_attempts, dispatched_at,
                       tagged_by, tagged_at, created_at, deleted_at)
SELECT id, storage_key, play_key, thumb_key, content_type, title, recorded_at,
       duration_s, size_bytes, play_size_bytes, uploaded_by, multipart_upload_id,
       file_state, 'untagged', processing, processing_attempts, dispatched_at,
       NULL, NULL, created_at, deleted_at
  FROM video;

DROP TABLE video;
DROP TABLE section;
DROP TABLE take;
DROP TABLE choreo;
ALTER TABLE video_new RENAME TO video;

CREATE TABLE video_dances (
  video_id  TEXT NOT NULL REFERENCES video(id) ON DELETE CASCADE,
  dance_id  TEXT NOT NULL REFERENCES dances(id) ON DELETE CASCADE,
  PRIMARY KEY (video_id, dance_id)
);

CREATE TABLE video_tags (
  video_id  TEXT NOT NULL REFERENCES video(id) ON DELETE CASCADE,
  tag_id    TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (video_id, tag_id)
);

CREATE INDEX idx_video_state   ON video(file_state, tag_state);
CREATE INDEX idx_video_choreo  ON video(choreo_id);
CREATE INDEX idx_video_audio   ON video(audio_project_id, audio_start_s);
CREATE INDEX idx_video_proc    ON video(processing);
CREATE INDEX idx_dances_choreo ON dances(choreo_id);
CREATE INDEX idx_projects_choreo ON projects(choreo_id);
CREATE INDEX idx_video_tags_tag ON video_tags(tag_id);
CREATE INDEX idx_video_dances_dance ON video_dances(dance_id);
