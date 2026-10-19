-- Nutzung (anonym): je Tag und Gerät eine Zeile. `device` ist ein Hash aus zufälliger
-- Geräte-Kennung und Datum – pro Tag zählbar, über Tage nicht verfolgbar. Keine Namen.
-- Sichtbar nur für Trainer (Verwalten → Mehr), älter als ~1 Jahr räumt der Cron weg.
CREATE TABLE usage_days (
  day     TEXT NOT NULL,              -- YYYY-MM-DD (Europe/Berlin)
  device  TEXT NOT NULL,
  role    TEXT NOT NULL,              -- group | tagger
  opens   INTEGER NOT NULL DEFAULT 1, -- App geöffnet oder nach ≥ 30 min zurückgeholt
  PRIMARY KEY (day, device)
);
