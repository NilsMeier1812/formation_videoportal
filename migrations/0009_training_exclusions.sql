-- „Letztes Training“ in der Videothek: Trainingstage ergeben sich aus den Aufnahmezeiten
-- (sonntags ab 1 Video, sonst ab 2 – siehe public/js/lib/trainings.js). Tage, die trotzdem
-- kein Training waren, blenden Trainer hier aus.
CREATE TABLE training_exclusions (
  day         TEXT PRIMARY KEY,   -- YYYY-MM-DD (Europe/Berlin)
  excluded_by TEXT,
  created_at  TEXT NOT NULL
);
