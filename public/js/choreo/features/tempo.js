// Tempo-Abschnitte: BPM, Taktart, Raster-Start und Tanz je Abschnitt der Musik.
//
// Bedienung im Blatt „Tänze & Takt“ (unten, die Welle bleibt oben sichtbar):
//   Hier teilen        Abschnitt an der Abspielposition in zwei teilen (statt Start/Ende tippen)
//   Takt 1 hier        Raster-Start auf die Abspielposition
//   Taktanfang hier    an einem späteren Taktanfang tippen → BPM wird daraus berechnet
//   Entfernen          Abschnitt löschen, der davor reicht dann bis zu seinem Ende
import { repo } from "../data/index.js";
import { barLength, beatsPerBar, rangeAt } from "../lib/timeline.js";
import { clamp, round3, uuid } from "../lib/util.js";
import { rt } from "../runtime.js";

const clampBpm = (n) => clamp(Math.round(n * 100) / 100, 20, 400);
const cursorTime = () => (rt.ws ? round3(rt.ws.getCurrentTime()) : 0);
// Farben der Tänze (Reihenfolge in der Choreo); Abschnitte ohne Tanz grau
const DANCE_COLORS = ["#4f6ef7", "#e5484d", "#30a46c", "#f59e0b", "#8e4ec6", "#0ea5b7"];

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

    /** Lokal sofort anwenden, verzögert speichern. */
    patchTempo(section, changes) {
      Object.assign(section, changes);
      repo.patch("tempo_sections", section, changes, {
        offlineMessage: "Offline – Änderung gespeichert, wird synchronisiert",
      });
      this.scheduleDraw();
    },

    /** Entfernen: der Abschnitt davor (sonst danach) übernimmt seinen Bereich. */
    deleteTempoSection(section) {
      if (this.tempoSections.length <= 1) { this.setStatus("Mindestens ein Abschnitt muss bleiben"); return; }
      const name = this.sectionTitle(section);
      if (!confirm(`Abschnitt „${name}“ entfernen? Schritte und Notizen darin gehen verloren.`)) return;
      const list = this.sortedTempo;
      const i = list.findIndex((s) => s.id === section.id);
      const prev = list[i - 1];
      const next = list[i + 1];
      this.tempoSections = this.tempoSections.filter((s) => s.id !== section.id);
      if (prev) this.patchTempo(prev, { end_sec: section.end_sec ?? null });
      else if (next) this.patchTempo(next, { start_sec: 0 });
      if (this.openSectionId === section.id) this.openSectionId = null;
      this.scheduleDraw();
      repo.remove("tempo_sections", section);
    },

    // ---------------- Blatt „Tänze & Takt“ ----------------
    settingsTab: "sections", // sections | audio | copy
    openSectionId: null, // aufgeklappter Abschnitt

    /** Abschnitt an der Abspielposition teilen; der neue übernimmt Tempo und Raster. */
    splitSectionHere() {
      const t = cursorTime();
      const sec = rangeAt(this.sortedTempo, t);
      const end = sec?.end_sec == null ? Infinity : Number(sec.end_sec);
      if (!sec || t < Number(sec.start_sec) + 0.2 || t > end - 0.2) {
        this.setStatus("Zum Teilen an eine Stelle mitten in einem Abschnitt gehen");
        return;
      }
      const section = {
        id: uuid(), project_id: this.project.id, sort_index: this.tempoSections.length,
        label: null, dance_id: null,
        start_sec: t, end_sec: sec.end_sec ?? null,
        bpm: Number(sec.bpm), time_signature: sec.time_signature, offset_sec: Number(sec.offset_sec) || 0,
      };
      this.patchTempo(sec, { end_sec: t });
      this.tempoSections.push(section);
      repo.insert("tempo_sections", section, { offlineMessage: "Offline – Abschnitt gespeichert, wird synchronisiert" });
      this.openSectionId = section.id;
      this.scheduleDraw();
      this.setStatus(`Geteilt bei ${this.fmt(t)} – jetzt Tanz und Tempo für den neuen Abschnitt wählen`);
    },

    /** Raster-Start (Takt 1) auf die Abspielposition. */
    beatOneHere(section) {
      this.patchTempo(section, { offset_sec: cursorTime() });
      this.setStatus(`Takt 1 beginnt bei ${this.fmt(section.offset_sec)}`);
    },

    /**
     * An einem späteren Taktanfang tippen: BPM so, dass genau eine ganze Zahl Takte zwischen
     * Takt 1 und hier liegt (nächstliegende). Genauer als jedes Nachstellen per Hand.
     */
    barStartHere(section) {
      const t = cursorTime();
      const offset = Number(section.offset_sec) || 0;
      const bars = Math.round((t - offset) / barLength(section));
      if (bars < 1) { this.setStatus("Erst „Takt 1 hier“ setzen, dann weiter hinten an einem Taktanfang tippen"); return; }
      const bpm = clampBpm((60 * beatsPerBar(section.time_signature) * bars) / (t - offset));
      this.patchTempo(section, { bpm });
      this.setStatus(`Takt ${bars + 1} beginnt hier → ${String(bpm).replace(".", ",")} BPM`);
    },

    toggleSection(section) {
      this.openSectionId = this.openSectionId === section.id ? null : section.id;
      if (this.openSectionId) this.seekTo(Number(section.start_sec) || 0);
    },
    sectionTitle(section) {
      const i = this.sortedTempo.findIndex((s) => s.id === section.id);
      return section.label || this.sectionDanceName(section) || `Abschnitt ${i + 1}`;
    },
    sectionColor(section) {
      const i = this.projectDances.findIndex((d) => d.id === section.dance_id);
      return i < 0 ? "var(--muted)" : DANCE_COLORS[i % DANCE_COLORS.length];
    },
    sectionRange(section) {
      const end = section.end_sec == null ? "Schluss" : this.fmt(section.end_sec).slice(0, -3);
      return `${this.fmt(section.start_sec).slice(0, -3)}–${end}`;
    },
    /** Zeitstrahl: Blöcke in % der Länge. */
    get sectionBlocks() {
      const dur = this.duration || 0;
      if (!dur) return [];
      return this.sortedTempo.map((s) => {
        const start = Math.max(0, Number(s.start_sec) || 0);
        const end = Math.min(dur, s.end_sec == null ? dur : Number(s.end_sec));
        return { s, left: (start / dur) * 100, width: Math.max(0, ((end - start) / dur) * 100) };
      });
    },
    get playheadPct() { return this.duration ? Math.min(100, (this.currentTime / this.duration) * 100) : 0; },

    /** Oberkante des Blatts: direkt unter der Welle, damit Raster und Welle sichtbar bleiben. */
    placeSheet() {
      const wave = document.getElementById("waveform")?.getBoundingClientRect();
      const top = wave && wave.bottom > 0 ? Math.min(wave.bottom, window.innerHeight * 0.45) : window.innerHeight * 0.3;
      document.documentElement.style.setProperty("--sheet-top", `${Math.round(top)}px`);
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
    setBpmStep(section, delta) { this.nudgeBpm(section, delta); },
    onBpmInput(section, value) {
      const n = parseFloat(value);
      if (!isNaN(n)) this.patchTempo(section, { bpm: clampBpm(n) });
    },
    nudgeBpm(section, delta) {
      this.patchTempo(section, { bpm: clampBpm((Number(section.bpm) || 120) + delta) });
    },
    nudgeOffset(section, delta) {
      this.patchTempo(section, { offset_sec: Math.max(0, round3((Number(section.offset_sec) || 0) + delta)) });
    },

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
