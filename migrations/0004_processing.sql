-- Umwandlung (GitHub Actions): wann fertig, und wann das Original gelöscht wurde.
-- Originale werden 7 Tage nach erfolgreicher Umwandlung gelöscht (src/cron.js);
-- danach zählt für den Speicher nur noch die Abspielfassung.
ALTER TABLE video ADD COLUMN processed_at TEXT;
ALTER TABLE video ADD COLUMN raw_deleted_at TEXT;
