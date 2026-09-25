// Projekte: laden, öffnen, anlegen (mit Audio-Upload), duplizieren, löschen, Einstellungen.
import { AUDIO_EXTENSIONS } from "../config.js";
import { local, remote, repo } from "../data/index.js";
import { formatBytes, uuid } from "../lib/util.js";
import { rt } from "../runtime.js";

const emptyForm = () => ({ title: "", bpm: 120, time_signature: "4/4", file: null });

export function projects() {
  return {
    // ---- Neues Projekt ----
    form: emptyForm(),
    uploading: false,
    uploadProgress: 0,
    uploadError: null,

    // ---- Projekt löschen (mit erneuter Code-Eingabe) ----
    deleteTarget: null,
    deletePassword: "",
    deleteError: "",
    deleting: false,
    showDelPw: false,

    /** Nicht angemeldet: private Projekte ausblenden. Angemeldet: alle sehen. */
    get visibleProjects() {
      return (this.projects || []).filter((p) => this.isEditor || !p.is_private);
    },
    /** Gewählte Choreo – auch wenn sie noch nicht geladen ist. */
    get selectedProjectId() { return (this.pendingProject || this.project)?.id || null; },

    /**
     * Choreo im Menü gewählt – gilt für die ganze App. Ist gerade ein anderer
     * Bereich offen, wird die Musik erst beim Öffnen des Planers geladen.
     */
    async selectProject(p) {
      if (this.appView === "choreo") { await this.openProject(p); return; }
      this.menuOpen = false;
      if (p.id === this.selectedProjectId) return;
      this.pendingProject = p.id === this.project?.id ? null : p;
      localStorage.setItem("choreo_last_project", p.id);
      this.setStatus(`Choreo „${p.title}“ gewählt`);
    },

    async loadProjects() {
      const { rows, fromCache } = await repo.loadProjects();
      this.projects = rows;
      if (fromCache && !rows.length) this.setStatus("Offline – keine Projekte im Cache");
    },

    async openProject(p) {
      if (this.currentMode === "editor") await this.releaseLock();
      this.currentMode = "training";
      this.menuOpen = false;
      this.pendingProject = null;
      this.project = p;
      localStorage.setItem("choreo_last_project", p.id);
      this.activeSegmentId = null;
      rt.lastActiveSegmentId = null;
      this.isPlaying = false;
      this.currentTime = 0;
      this.duration = 0;

      const token = ++rt.loadToken;
      this.destroyWs();
      await this.loadSegments(p.id);
      await this.loadTempoSections(p.id);
      await this.loadPersons(p.id);
      await this.loadParts(p.id);
      await this.loadSteps(p.id);
      this.myPersonNumber = Number(localStorage.getItem("choreo_person_" + p.id)) || 0;
      if (token !== rt.loadToken) return; // inzwischen wurde ein anderes Projekt gewählt
      this.createWs();
      await this.loadAudio(p);
    },

    // ---- Einstellungen ----
    openSettings() {
      if (!this.project) return;
      if (!this.isEditor) { this.openLogin(); return; }
      this.settingsOpen = true;
    },
    closeSettings() { this.settingsOpen = false; },

    patchProject(changes) {
      if (!this.project) return;
      Object.assign(this.project, changes);
      const listed = this.projects.find((p) => p.id === this.project.id);
      if (listed && listed !== this.project) Object.assign(listed, changes);
      repo.patch("projects", this.project, changes, {
        offlineMessage: "Offline – Einstellung gespeichert, wird synchronisiert",
      });
    },

    // ---- Anlegen ----
    prettySize(bytes) { return formatBytes(bytes); },

    onFilePick(e) {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const ext = (file.name.split(".").pop() || "").toLowerCase();
      if (!AUDIO_EXTENSIONS.includes(ext)) {
        this.uploadError = "Nur MP3 oder WAV werden unterstützt (m4a/AAC ist mit vielen Browsern nicht kompatibel).";
        this.form.file = null;
        e.target.value = "";
        return;
      }
      this.form.file = file;
      this.uploadError = null;
      if (!this.form.title) this.form.title = file.name.replace(/\.[^.]+$/, "");
    },

    async createProject() {
      if (this.uploading || !this.form.title || !this.form.file) return;
      this.uploading = true;
      this.uploadProgress = 0;
      this.uploadError = null;
      const file = this.form.file;
      const ext = (file.name.split(".").pop() || "bin").toLowerCase();

      try {
        rt.upload = remote.uploadAudio(file, `${uuid()}.${ext}`, (p) => { this.uploadProgress = p; });
        const audio_url = await rt.upload.done;
        rt.upload = null;

        const project = await remote.createProject({
          title: this.form.title.trim(),
          bpm: Number(this.form.bpm) || 120,
          time_signature: this.form.time_signature,
          audio_url,
        });

        // Erster Tempo-Abschnitt über das ganze Lied
        await repo.insert("tempo_sections", {
          id: uuid(), project_id: project.id, sort_index: 0, label: null,
          start_sec: 0, end_sec: null,
          bpm: Number(this.form.bpm) || 120,
          time_signature: this.form.time_signature, offset_sec: 0,
        });

        // Datei gleich lokal ablegen → erstes Öffnen sofort und offline
        await local.putAudio(project.id, file);

        this.uploading = false;
        this.form = emptyForm();
        await this.loadProjects();
        await this.openProject(project);
        this.setStatus("Projekt angelegt");
      } catch (e) {
        rt.upload = null;
        this.uploading = false;
        this.uploadError = "Upload fehlgeschlagen: " + (e.message || e);
      }
    },

    abortUpload() {
      rt.upload?.abort();
      this.uploading = false;
    },

    // ---- Duplizieren ----
    // Alle abhängigen Daten mit neuen IDs kopieren; die Audiodatei wird geteilt
    // (gleiche audio_url). Beim Löschen eines Projekts bleibt die Musik in R2 liegen.
    async duplicateProject(p) {
      if (!this.isEditor) return;
      this.setStatus("Dupliziere Projekt…");
      try {
        const copy = await remote.createProject({
          title: (p.title || "Projekt") + " (Kopie)",
          bpm: p.bpm, time_signature: p.time_signature, audio_url: p.audio_url,
          ...(p.is_private ? { is_private: true } : {}),
        });
        const pid = copy.id;

        const [tempo, persons, parts, steps, segments] = await Promise.all(
          ["tempo_sections", "persons", "parts", "steps", "choreo_segments"]
            .map((table) => remote.listByProject(table, p.id))
        );
        const memberships = await remote.listMemberships(parts.map((x) => x.id));

        const tempoIds = {};
        const partIds = {};
        const rows = {
          tempo_sections: tempo.map((s) => {
            const id = uuid(); tempoIds[s.id] = id;
            return { id, project_id: pid, sort_index: s.sort_index, label: s.label,
              start_sec: s.start_sec, end_sec: s.end_sec, bpm: s.bpm,
              time_signature: s.time_signature, offset_sec: s.offset_sec };
          }),
          persons: persons.map((x) => ({ id: uuid(), project_id: pid, number: x.number, name: x.name })),
          parts: parts.map((x) => {
            const id = uuid(); partIds[x.id] = id;
            return { id, project_id: pid, sort_index: x.sort_index, label: x.label,
              start_sec: x.start_sec, end_sec: x.end_sec, group_names: x.group_names };
          }),
        };
        rows.group_memberships = memberships.map((m) => ({ id: uuid(), part_id: partIds[m.part_id],
          person_number: m.person_number, group_number: m.group_number }));
        rows.steps = steps.map((s) => ({ id: uuid(), project_id: pid,
          tempo_section_id: tempoIds[s.tempo_section_id] || null, role: s.role,
          group_number: s.group_number, beat_pos: s.beat_pos, length_beats: s.length_beats,
          foot: s.foot, value: s.value }));
        rows.choreo_segments = segments.map((s) => ({ id: uuid(), project_id: pid,
          timestamp: s.timestamp, label: s.label, notes: s.notes }));

        // Eltern zuerst
        for (const table of ["tempo_sections", "persons", "parts", "group_memberships", "steps", "choreo_segments"]) {
          if (rows[table].length) await remote.insert(table, rows[table]);
        }

        const cached = await local.getAudio(p.id);
        if (cached?.blob) await local.putAudio(pid, cached.blob);

        await this.loadProjects();
        this.setStatus("Projekt dupliziert");
      } catch {
        this.setStatus("Duplizieren fehlgeschlagen" + (navigator.onLine ? "" : " (offline?)"));
      }
    },

    // ---- Löschen: erst nach erneuter Eingabe des Trainer-Codes (Schutz vor Versehen) ----
    askDeleteProject(p) {
      if (!this.isEditor) return;
      this.deleteTarget = p;
      this.deletePassword = "";
      this.deleteError = "";
      this.showDelPw = false;
      this.deleting = false;
    },
    cancelDeleteProject() {
      this.deleteTarget = null;
      this.deletePassword = "";
      this.deleteError = "";
    },
    async doDeleteProject() {
      const p = this.deleteTarget;
      if (!p || this.deleting) return;
      if (!this.deletePassword) { this.deleteError = "Bitte Trainer-Code eingeben."; return; }
      this.deleting = true;
      this.deleteError = "";
      try {
        if (!(await remote.verifyPassword(this.deletePassword))) {
          this.deleteError = "Code falsch.";
          this.deleting = false;
          return;
        }
        await remote.remove("projects", p.id);
        await local.forgetProject(p.id);
        if (this.pendingProject?.id === p.id) this.pendingProject = null;
        if (this.project && this.project.id === p.id) {
          this.destroyWs();
          this.project = null;
          this.segments = [];
        }
        await this.loadProjects();
        this.deleteTarget = null;
        this.deletePassword = "";
        this.deleting = false;
        this.setStatus("Projekt gelöscht");
      } catch {
        this.deleting = false;
        this.deleteError = "Löschen fehlgeschlagen (offline?).";
      }
    },
  };
}
