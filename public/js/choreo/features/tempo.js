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
