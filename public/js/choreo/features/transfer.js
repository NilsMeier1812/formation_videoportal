// Alte Daten übernehmen (unter „Tänze & Takt“, nur Trainer):
//
//   Audio austauschen   neue Datei hochladen und alles um den Versatz verschieben (vorne ein
//                       Intro dazu = positiv, vorne gekürzt = negativ, hinten angehängt = 0).
//                       Danach mit „Alles verschieben“ fein nachstellen. Der Server verschiebt
//                       Abschnitte, Sprungmarken, Gruppen-Abschnitte und die Stellen der Videos;
//                       Schritte hängen am Raster-Start und wandern mit.
//   Übernehmen          Schritte, Notizen, Sprungmarken, Paare/Gruppen aus einer anderen Audio.
//                       Zeiten werden über die Abschnitte umgerechnet (Zeit hier = Zeit dort +
//                       Versatz) und aufs Raster dieser Audio (½-Beats) gelegt.
import { remote, local } from "../data/index.js";
import { sortBy } from "../lib/timeline.js";
import { buildCopy } from "../lib/transfer.js";
import { round3, uuid } from "../lib/util.js";
import { AUDIO_EXTENSIONS } from "../config.js";
import { library } from "/js/library.js";
import { rt } from "../runtime.js";

const num = (v, fallback = 0) => (v === "" || v == null || isNaN(Number(v)) ? fallback : Number(v));

export function transfer() {
  return {
    swapForm: { file: null, shift: 0, busy: false, progress: 0, error: "", nudged: 0 },
    copyForm: { sourceId: "", shift: 0, from: "", to: "", steps: true, notes: true, segments: true, pairs: true, replace: true, busy: false, error: "" },

    /** Alle anderen Audios, mit Choreo im Namen (Auswahl „Übernehmen aus“). */
    get copySources() {
      return this.projects
        .filter((p) => p.id !== this.project?.id)
        .map((p) => {
          const choreo = library.choreo(library.audio(p.id)?.choreo_id);
          return { id: p.id, label: choreo ? `${choreo.title} · ${p.title}` : p.title };
        })
        .sort((a, b) => a.label.localeCompare(b.label, "de"));
    },

    /** Daten der offenen Audio neu laden, ohne die Einstellungen zu schließen. */
    async reloadProjectRows() {
      const id = this.project.id;
      await this.loadSegments(id);
      await this.loadTempoSections(id);
      await this.loadPersons(id);
      await this.loadParts(id);
      await this.loadSteps(id);
      this.renderRegions?.();
      this.scheduleDraw();
    },

    // ---------------- Audio austauschen / alles verschieben ----------------
    onSwapFile(e) {
      const file = e.target.files?.[0] || null;
      const ext = (file?.name.split(".").pop() || "").toLowerCase();
      if (file && !AUDIO_EXTENSIONS.includes(ext)) {
        this.swapForm.error = "Nur MP3 oder WAV.";
        this.swapForm.file = null;
        e.target.value = "";
        return;
      }
      this.swapForm.file = file;
      this.swapForm.error = "";
    },

    async swapAudio() {
      const f = this.swapForm;
      if (!this.project || !f.file || f.busy) return;
      if (!navigator.onLine) { f.error = "Offline – Austauschen geht nur mit Netz."; return; }
      const shift = round3(num(f.shift));
      const what = shift > 0 ? `alles ${shift} s nach hinten` : shift < 0 ? `alles ${-shift} s nach vorne (davor fällt weg)` : "nichts verschieben";
      if (!confirm(`Audio von „${this.project.title}“ durch „${f.file.name}“ ersetzen und ${what}?`)) return;
      f.busy = true;
      f.error = "";
      f.progress = 0;
      try {
        const ext = (f.file.name.split(".").pop() || "mp3").toLowerCase();
        const upload = remote.uploadAudio(f.file, `${uuid()}.${ext}`, (p) => { f.progress = p; });
        const url = await upload.done;
        await remote.shiftProject(this.project.id, { shift_s: shift, audio_url: url });
        await local.putAudio(this.project.id, f.file, url);
        this.project.audio_url = url;
        const listed = this.projects.find((p) => p.id === this.project.id);
        if (listed) listed.audio_url = url;
        await this.reloadWithAudio();
        f.file = null;
        f.shift = 0;
        f.nudged = 0;
        this.setStatus("Audio ausgetauscht – jetzt bei Bedarf mit „Alles verschieben“ nachstellen");
        window.dispatchEvent(new Event("videos-changed"));
      } catch (e) {
        f.error = "Austauschen fehlgeschlagen: " + (e.message || e);
      } finally {
        f.busy = false;
      }
    },

    /** Neue Musik laden (Welle neu), Daten neu – Einstellungen bleiben offen. */
    async reloadWithAudio() {
      const token = ++rt.loadToken;
      if (this.isPlaying) rt.ws?.pause();
      this.destroyWs();
      await this.reloadProjectRows();
      if (token !== rt.loadToken) return;
      this.createWs();
      await this.loadAudio(this.project);
    },

    /** Alles (ohne neue Datei) um delta Sekunden verschieben – zum Feinjustieren. */
    async nudgeAll(delta) {
      const f = this.swapForm;
      if (!this.project || f.busy) return;
      if (!navigator.onLine) { f.error = "Offline – Verschieben geht nur mit Netz."; return; }
      f.busy = true;
      f.error = "";
      try {
        await remote.shiftProject(this.project.id, { shift_s: delta });
        f.nudged = round3(f.nudged + delta);
        await this.reloadProjectRows();
        window.dispatchEvent(new Event("videos-changed"));
      } catch (e) {
        f.error = "Verschieben fehlgeschlagen: " + (e.message || e);
      } finally {
        f.busy = false;
      }
    },

    // ---------------- Aus einer anderen Audio übernehmen ----------------
    async copyFromAudio() {
      const c = this.copyForm;
      if (!this.project || !c.sourceId || c.busy) return;
      if (!navigator.onLine) { c.error = "Offline – Übernehmen geht nur mit Netz."; return; }
      const target = sortBy(this.tempoSections, "start_sec");
      if (!target.length) { c.error = "Diese Audio hat noch keinen Abschnitt."; return; }
      c.busy = true;
      c.error = "";
      try {
        const src = c.sourceId;
        const [tempo, steps, segments, persons, parts] = await Promise.all(
          ["tempo_sections", "steps", "choreo_segments", "persons", "parts"].map((t) => remote.listByProject(t, src))
        );
        const memberships = c.pairs ? await remote.listMemberships(parts.map((p) => p.id)) : [];
        const plan = buildCopy({
          tempo, steps, segments, persons, parts, memberships,
          target, targetId: this.project.id, duration: this.duration,
          existingNumbers: new Set(this.persons.map((p) => Number(p.number))),
          opts: { ...c, shift: num(c.shift), from: c.from === "" ? null : num(c.from), to: c.to === "" ? null : num(c.to) },
        });
        const n = plan.counts;
        const total = n.steps + n.notes + n.segments + n.persons + n.parts;
        if (!total) { c.error = "Nichts zu übernehmen (Auswahl oder Bereich leer)."; return; }
        const source = this.copySources.find((s) => s.id === src)?.label || "der anderen Audio";
        const parts_ = [
          c.steps && `${n.steps} Schritte`, c.notes && `${n.notes} Notizen`, c.segments && `${n.segments} Sprungmarken`,
          c.pairs && `${n.persons} Paare und ${n.parts} Gruppen-Abschnitte`,
        ].filter(Boolean).join(", ");
        const replaced = c.replace ? "\n\nVorhandenes derselben Art in dieser Audio wird vorher gelöscht." : "";
        const skipped = n.outside ? `\n(${n.outside} liegen außerhalb dieser Audio und fallen weg.)` : "";
        if (!confirm(`Aus „${source}“ übernehmen: ${parts_}.${skipped}${replaced}`)) return;
        await remote.importRows(this.project.id, { clear: plan.clear, rows: plan.rows });
        await this.reloadProjectRows();
        this.setStatus(`Übernommen: ${parts_}`);
      } catch (e) {
        c.error = "Übernehmen fehlgeschlagen: " + (e.message || e);
      } finally {
        c.busy = false;
      }
    },
  };
}
