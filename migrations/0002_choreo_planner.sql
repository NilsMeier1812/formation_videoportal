-- Tabellen des Choreo-Planers (bisher in Supabase). Spalten und IDs 1:1 wie dort,
-- damit die Übernahme der Daten und der lokale Offline-Spiegel im Browser passen.
-- Die Tabellen `choreo`/`section` aus 0001 bleiben vorerst unberührt; wie Videos
-- mit den Planer-Projekten verknüpft werden, entscheidet Schritt D.

CREATE TABLE projects (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  bpm             REAL,
  time_signature  TEXT,
  audio_url       TEXT,                -- /api/choreo/audio/<datei>
  grid_offset     REAL,                -- Altlast; ältere Projekte ohne Tempo-Abschnitt
  is_private      INTEGER NOT NULL DEFAULT 0,
  locked_by       TEXT,                -- Bearbeitungssperre: Geräte-ID
  locked_by_name  TEXT,
  locked_at       TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT
);

CREATE TABLE tempo_sections (          -- Lieder/Tempi innerhalb der Audiodatei
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sort_index      INTEGER,
  label           TEXT,
  start_sec       REAL,
  end_sec         REAL,                -- NULL = bis zum Schluss
  bpm             REAL,
  time_signature  TEXT,
  offset_sec      REAL,                -- Raster-Start
  updated_at      TEXT
);

CREATE TABLE choreo_segments (         -- Sprungmarken
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  timestamp       REAL,
  label           TEXT,
  notes           TEXT,
  updated_at      TEXT
);

CREATE TABLE persons (                 -- Paare
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number          INTEGER,
  name            TEXT
);

CREATE TABLE parts (                   -- Abschnitte mit Gruppen
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sort_index      INTEGER,
  label           TEXT,
  start_sec       REAL,
  end_sec         REAL,
  group_names     TEXT                 -- JSON: {"1": "Innen", "2": "Außen"}
);

CREATE TABLE group_memberships (       -- welches Paar ist in welcher Gruppe
  id              TEXT PRIMARY KEY,
  part_id         TEXT NOT NULL REFERENCES parts(id) ON DELETE CASCADE,
  person_number   INTEGER,
  group_number    INTEGER
);

CREATE TABLE steps (                   -- Schritte (role herren/damen) und Notizen (role note)
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  tempo_section_id  TEXT REFERENCES tempo_sections(id) ON DELETE CASCADE,
  role              TEXT,
  group_number      INTEGER,
  beat_pos          REAL,
  length_beats      REAL,
  foot              TEXT,
  value             TEXT
);

CREATE INDEX idx_tempo_project    ON tempo_sections(project_id);
CREATE INDEX idx_segments_project ON choreo_segments(project_id);
CREATE INDEX idx_persons_project  ON persons(project_id);
CREATE INDEX idx_parts_project    ON parts(project_id);
CREATE INDEX idx_members_part     ON group_memberships(part_id);
CREATE INDEX idx_steps_project    ON steps(project_id);
CREATE INDEX idx_steps_tempo      ON steps(tempo_section_id);
