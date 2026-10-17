-- Start-Audio: Wer die App zum allerersten Mal öffnet (noch keine Audio gemerkt), sieht
-- diese – statt einfach der neuesten. Höchstens eine; gesetzt unter Verwalten → Choreos.
ALTER TABLE projects ADD COLUMN is_start INTEGER NOT NULL DEFAULT 0;
