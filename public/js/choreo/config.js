// Zentrale Einstellungen des Choreo-Planers.

/** Hochzählend; landet im Menü (vX) und hilft beim Nachvollziehen von Updates. */
export const APP_VERSION = 35;

// ---- Supabase (bis zum Umzug der Daten nach Cloudflare, Schritt B) ----
// Der anon-Key ist öffentlich und nur zum Lesen gedacht; Schreiben erlaubt die
// Datenbank (RLS) nur nach dem Editor-Login.
export const SUPABASE_URL = "https://qgklrvagzfvqbbpgpfdl.supabase.co";
export const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFna2xydmFnemZ2cWJicGdwZmRsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIxMTkyNjksImV4cCI6MjA5NzY5NTI2OX0.3Jo7IBQYHDOr1hNRzuV3zxnof0zI4lD2kF6XqT2QjIs";
/** Gemeinsamer Editor-Login: das Team teilt sich EIN Passwort. */
export const EDITOR_EMAIL = "editor@choreo.app";
export const STORAGE_BUCKET = "audio-tracks";

// ---- Bearbeitungssperre ----
export const LOCK_TIMEOUT_MS = 30000; // ab hier gilt eine Sperre als verwaist
export const HEARTBEAT_MS = 15000; // so oft wird die eigene Sperre erneuert

// ---- Speichern ----
export const SEGMENT_DEBOUNCE_MS = 1000; // Tippen in Sprungmarken
export const FIELD_DEBOUNCE_MS = 500; // alle anderen Felder

// ---- Audio ----
export const AUDIO_TIMEOUT_MS = 40000; // nie ewig "Lade Audio…" anzeigen
export const AUDIO_EXTENSIONS = ["mp3", "wav"];
