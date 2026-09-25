// Schritte und Notizen in den Spuren (Leader / Follower / Notizen).
import { repo } from "../data/index.js";
import { snapBeat, stepTime } from "../lib/timeline.js";
import { round3, uuid } from "../lib/util.js";
import { rt } from "../runtime.js";

export function steps() {
  return {
    editGroup: 0, // neue Schritte gehören zu dieser Gruppe (0 = alle)
    noteModalOpen: false,
    noteText: "",

    /** Im Editor auf dem Schritte-Tab: Tippen in die Spuren trägt ein. */
    get isEditingSteps() {
      return this.currentMode === "editor" && this.bottomTab === "steps";
    },

    async loadSteps(projectId) {
      this.steps = await repo.loadRows("steps", projectId);
    },

    /**
     * Sichtbare Schritte einer Spur als { s, dim }.
     *  - Editor: die bearbeitete Gruppe voll, dazu „alle"-Schritte gedimmt zur Orientierung.
     *  - Training: „alle"-Schritte + die Gruppe des gewählten Paares im jeweiligen Abschnitt.
     */
    laneEntries(role) {
      const out = [];
      if (this.isEditingSteps) {
        const group = Number(this.editGroup);
        for (const s of this.steps) {
          if (s.role !== role) continue;
          const sg = Number(s.group_number);
          if (sg === group) out.push({ s, dim: false });
          else if (group !== 0 && sg === 0) out.push({ s, dim: true });
        }
        return out;
      }
      for (const s of this.steps) {
        if (s.role !== role) continue;
        const sg = Number(s.group_number);
        if (sg === 0) { out.push({ s, dim: false }); continue; }
        if (!this.myPersonNumber) continue;
        const t = stepTime(s, this.tempoSections);
        if (t == null) continue;
        if (sg === this.groupOf(this.partAt(t), this.myPersonNumber)) out.push({ s, dim: false });
      }
      return out;
    },

    // ---- kurzer Tipp: vorhandenes → Fuß wechseln (Notiz → bearbeiten); leer → neu ----
    laneTap(role, time) {
      const existing = this.findStepAt(role, time);
      if (role === "note") {
        if (existing) this.openNoteModal(existing); else this.createNote(time);
      } else if (existing) this.toggleStepFoot(existing);
      else this.placeStep(role, time, false);
    },
    // ---- langes Halten: vorhandenes → löschen; leer → langer Schritt (Notiz → neu) ----
    laneLongPress(role, time) {
      const existing = this.findStepAt(role, time);
      if (existing) this.deleteStep(existing);
      else if (role === "note") this.createNote(time);
      else this.placeStep(role, time, true);
    },

    /** Schritt/Notiz der bearbeiteten Gruppe auf dem nächsten ½-Beat. */
    findStepAt(role, time) {
      const tempo = this.sectionAt(time);
      if (!tempo) return null;
      const beat = snapBeat(tempo, time);
      return this.steps.find((s) => s.role === role
        && Number(s.group_number) === Number(this.editGroup)
        && s.tempo_section_id === tempo.id
        && Math.abs(Number(s.beat_pos) - beat) < 0.25) || null;
    },

    /** Neue Zeile an der Zeit – oder null, wenn dort kein Tempo-Abschnitt liegt. */
    newStepRow(role, time, fields) {
      if (!this.project || this.currentMode !== "editor") return null;
      const tempo = this.sectionAt(time);
      if (!tempo) { this.setStatus("Hier ist kein Tempo-Abschnitt"); return null; }
      return {
        id: uuid(), project_id: this.project.id, tempo_section_id: tempo.id,
        role, group_number: Number(this.editGroup), beat_pos: round3(snapBeat(tempo, time)),
        ...fields,
      };
    },

    placeStep(role, time, long) {
      const foot = rt.lastFoot[role] === "L" ? "R" : "L"; // Auto-Fuß; Tippen wechselt ihn
      const row = this.newStepRow(role, time, { length_beats: long ? 2 : 1, foot, value: null });
      if (!row) return;
      rt.lastFoot[role] = foot;
      this.steps.push(row);
      repo.insert("steps", row);
      this.scheduleDraw();
    },

    createNote(time) {
      const row = this.newStepRow("note", time, { length_beats: 1, foot: null, value: "" });
      if (!row) return;
      this.steps.push(row);
      repo.insert("steps", row);
      this.scheduleDraw();
      this.openNoteModal(row); // direkt Popup zum Eintragen
    },

    deleteStep(step) {
      this.steps = this.steps.filter((x) => x.id !== step.id);
      repo.remove("steps", step, { offlineMessage: "Offline – gespeichert, wird synchronisiert" });
      this.scheduleDraw();
    },

    updateStep(step, changes) {
      Object.assign(step, changes);
      repo.patch("steps", step, changes);
      this.scheduleDraw();
    },
    toggleStepFoot(step) { this.updateStep(step, { foot: step.foot === "R" ? "L" : "R" }); },
    renameNote(step, text) { this.updateStep(step, { value: text }); },

    // ---- Notiz-Popup ----
    openNoteModal(step) {
      rt.noteStep = step;
      this.noteText = step.value || "";
      this.noteModalOpen = true;
    },
    saveNoteModal() {
      const step = rt.noteStep;
      if (step) {
        const text = (this.noteText || "").trim();
        if (text) this.renameNote(step, text); else this.deleteStep(step);
      }
      this.noteModalOpen = false;
      rt.noteStep = null;
    },
    deleteNoteModal() {
      if (rt.noteStep) this.deleteStep(rt.noteStep);
      this.noteModalOpen = false;
      rt.noteStep = null;
    },

    // ---- Anzeige ----
    setStepDisplay(mode) { this.stepDisplay = mode; this.scheduleDraw(); },
    /** Nur durch die im aktuellen Abschnitt definierten Gruppen schalten (+ „alle"). */
    nudgeEditGroup(direction) {
      const seq = [0, ...this.groupNumbersOf(this.activePart)];
      let idx = seq.indexOf(Number(this.editGroup));
      if (idx < 0) idx = 0;
      this.editGroup = seq[(idx + (direction > 0 ? 1 : -1) + seq.length) % seq.length];
      this.scheduleDraw();
    },
  };
}
