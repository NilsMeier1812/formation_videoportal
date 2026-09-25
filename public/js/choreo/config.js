// Zentrale Einstellungen des Choreo-Planers.

/** Hochzählend; landet im Menü (vX) und hilft beim Nachvollziehen von Updates. */
export const APP_VERSION = 37;

// ---- Bearbeitungssperre (verwaist nach 30 s – das prüft der Server) ----
export const HEARTBEAT_MS = 15000; // so oft wird die eigene Sperre erneuert

// ---- Speichern ----
export const SEGMENT_DEBOUNCE_MS = 1000; // Tippen in Sprungmarken
export const FIELD_DEBOUNCE_MS = 500; // alle anderen Felder

// ---- Audio ----
export const AUDIO_TIMEOUT_MS = 40000; // nie ewig "Lade Audio…" anzeigen
export const AUDIO_EXTENSIONS = ["mp3", "wav"];
