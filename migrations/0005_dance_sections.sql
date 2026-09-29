-- Tänze in der Musik: jeder Tempo-Abschnitt gehört zu einem Tanz der Choreo – oder zu
-- keinem (z. B. Intro). Welche Tänze eine Audio hat, ergibt sich daraus; die bisherige
-- Liste project_dances entfällt.
ALTER TABLE tempo_sections ADD COLUMN dance_id TEXT REFERENCES dances(id) ON DELETE SET NULL;

-- Übernehmen, wo es eindeutig ist: Audio mit genau einem Abschnitt und genau einem Tanz
UPDATE tempo_sections
   SET dance_id = (SELECT pd.dance_id FROM project_dances pd WHERE pd.project_id = tempo_sections.project_id)
 WHERE (SELECT COUNT(*) FROM project_dances pd WHERE pd.project_id = tempo_sections.project_id) = 1
   AND (SELECT COUNT(*) FROM tempo_sections t2 WHERE t2.project_id = tempo_sections.project_id) = 1;

DROP TABLE project_dances;

CREATE INDEX idx_tempo_dance ON tempo_sections(dance_id);
