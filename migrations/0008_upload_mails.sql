-- Mail bei jedem Upload: gemerkt wird, welche fertigen Videos schon gemeldet sind.
-- Gemeldet wird je Upload-Reihe eine Mail (POST /api/videos/notify), was übrig bleibt,
-- holt der stündliche Cron nach. Alles, was es schon gibt, gilt als gemeldet.
ALTER TABLE video ADD COLUMN notified_at TEXT;
UPDATE video SET notified_at = created_at WHERE file_state != 'uploading';
