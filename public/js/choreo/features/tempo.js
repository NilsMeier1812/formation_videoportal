// Tempo-Abschnitte: BPM, Taktart und Raster-Start je Lied (auch mehrere Lieder in einer Datei).
import { repo } from "../data/index.js";
import { barLength, beatsPerBar } from "../lib/timeline.js";
import { clamp, round3, uuid } from "../lib/util.js";
import { rt } from "../runtime.js";

const clampBpm = (n) => clamp(Math.round(n * 100) / 100, 20, 400);
const cursorTime = () => (rt.ws ? round3(rt.ws.getCurrentTime()) : 0);

export function tempo() {
  return {
    async loadTempoSections(projectId) {
      this.tempoSections = await repo.loadRows("tempo_sections", projectId, "start_sec");
      // Ältere Projekte ohne Abschnitt: aus den alten Projektspalten ableiten (nur lokal)
      if (!this.tempoSections.length && this.project) {
        this.tempoSections = [{
          id: uuid(), project_id: projectId, sort_index: 0, label: null,
          start_sec: 0, end_sec: null,
          bpm: Number(this.project.bpm) || 120,
          time_signature: this.project.time_signature || "4/4",
          offset_sec: Number(this.project.grid_offset) || 0,
        }];
      }
    },

    addTempoSection() {
      if (!this.project) return;
      const list = this.sortedTempo;
      const last = list[list.length - 1];
      let start = 0;
      if (last) {
        start = last.end_sec == null
          ? Math.min(this.duration || 0, (Number(last.start_sec) || 0) + 1)
          : Number(last.end_sec);
      }
      // offenes Ende des letzten Abschnitts schließen, damit nichts überlappt
      if (last && last.end_sec == null) this.patchTempo(last, { end_sec: round3(start) });
      const section = {
        id: uuid(), project_id: this.project.id,
        sort_index: this.tempoSections.length,
        label: "Lied " + (this.tempoSections.length + 1),
        dance_id: null,
        start_sec: round3(start), end_sec: null,
        bpm: last ? Number(last.bpm) : 120,
        time_signature: last ? last.time_signature : "4/4",
        offset_sec: round3(start),
      };
      this.tempoSections.push(section);
      repo.insert("tempo_sections", section, {
        offlineMessage: "Offline – Abschnitt gespeichert, wird synchronisiert",
      });
      this.scheduleDraw();
    },

    /** Lokal sofort anwenden, verzögert speichern. */
    patchTempo(section, changes) {
      Object.assign(section, changes);
      repo.patch("tempo_sections", section, changes, {
        offlineMessage: "Offline – Änderung gespeichert, wird synchronisiert",
      });
      this.scheduleDraw();
    },

    deleteTempoSection(section) {
      if (this.tempoSections.length <= 1) { this.setStatus("Mindestens ein Abschnitt muss bleiben"); return; }
      if (!confirm(`Abschnitt „${section.label || ""}“ löschen? Schritte darin gehen verloren.`)) return;
      this.tempoSections = this.tempoSections.filter((s) => s.id !== section.id);
      this.scheduleDraw();
      repo.remove("tempo_sections", section);
    },

    /** Tanz eines Abschnitts; heißt der Abschnitt noch „Lied N“ (oder nichts), bekommt er den Namen des Tanzes. */
    setSectionDance(section, danceId) {
      const changes = { dance_id: danceId || null };
      const name = this.projectDances.find((d) => d.id === danceId)?.name;
      if (name && (!section.label || /^Lied \d+$/.test(section.label))) changes.label = name;
      this.patchTempo(section, changes);
    },
    sectionDanceName(section) {
      return section?.dance_id ? this.projectDances.find((d) => d.id === section.dance_id)?.name || "" : "";
    },
    /**
     * Tänze, die ein Zeitraum berührt (für die Zuordnung eines Videos) – nur Abschnitte,
     * mit denen er sich nennenswert überschneidet. null, wenn die Audio keine Tänze kennt.
     */
    dancesInRange(start, end) {
      const sections = this.sortedTempo;
      if (!sections.some((s) => s.dance_id)) return null;
      const minOverlap = Math.min(1, (end - start) * 0.25);
      const ids = [];
      for (const s of sections) {
        const from = Number(s.start_sec) || 0;
        const to = s.end_sec == null ? Infinity : Number(s.end_sec);
        const overlap = Math.min(end, to) - Math.max(start, from);
        if (s.dance_id && overlap >= minOverlap && !ids.includes(s.dance_id)) ids.push(s.dance_id);
      }
      return ids;
    },

    setTimeSig(section, value) { this.patchTempo(section, { time_signature: value }); },
    onBpmInput(section, value) {
      const n = parseFloat(value);
      if (!isNaN(n)) this.patchTempo(section, { bpm: clampBpm(n) });
    },
    nudgeBpm(section, delta) {
      this.patchTempo(section, { bpm: clampBpm((Number(section.bpm) || 120) + delta) });
    },
    /** Takt-Abstand direkt verstellen → rechnet auf BPM zurück (für krumme Werte). */
    nudgeBarLength(section, deltaSec) {
      const bar = Math.max(0.05, barLength(section) + deltaSec);
      this.patchTempo(section, { bpm: clampBpm((60 * beatsPerBar(section.time_signature)) / bar) });
    },
    nudgeOffset(section, delta) {
      this.patchTempo(section, { offset_sec: Math.max(0, round3((Number(section.offset_sec) || 0) + delta)) });
    },
    offsetToCursor(section) { this.patchTempo(section, { offset_sec: cursorTime() }); },
    resetOffset(section) { this.patchTempo(section, { offset_sec: 0 }); },

    /** Start/Ende in Sekunden; leeres Ende = bis zum Schluss. */
    setTempoBound(section, field, value) {
      if (field === "end_sec" && (value === "" || value == null)) {
        this.patchTempo(section, { end_sec: null });
        return;
      }
      const n = parseFloat(value);
      if (!isNaN(n)) this.patchTempo(section, { [field]: Math.max(0, round3(n)) });
    },
    boundToCursor(section, field) { this.patchTempo(section, { [field]: cursorTime() }); },
  };
}
