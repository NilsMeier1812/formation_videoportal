// Grundzustand, abgeleitete Werte und Start des Planers.
import { APP_VERSION } from "../config.js";
import { repo } from "../data/index.js";
import {
  barLength,
  groupNameOf,
  groupNumbersOf,
  groupOf,
  groupTimeline,
  rangeAt,
  sortBy,
  tempoAt,
} from "../lib/timeline.js";
import { formatTime, isTypingTarget, uuid } from "../lib/util.js";
import { rt } from "../runtime.js";

export function core() {
  return {
    // ---- Identität (für die Bearbeitungssperre) ----
    userId: "",
    userName: "",

    // ---- Oberfläche ----
    version: APP_VERSION,
    menuOpen: false,
    settingsOpen: false,
    online: navigator.onLine,
    toast: "",
    _toastTimer: null,
    bottomTab: "steps", // 'steps' | 'notes'
    stepDisplay: "dots", // 'dots' | 'letters' | 'numbers'
    showMarkers: true, // Sprungmarken in der Welle zeigen

    // ---- Daten des offenen Projekts ----
    projects: [],
    project: null,
    segments: [], // Sprungmarken
    tempoSections: [], // Tempo-/Takt-Abschnitte
    persons: [], // Paare
    parts: [], // Abschnitte mit Gruppen
    memberships: [], // Gruppen-Zuteilungen (part_id, person_number, group_number)
    steps: [], // Schritte (role 'herren'/'damen') + Notizen-Spur (role 'note')
    myPersonNumber: 0, // "Ich bin Paar X" (0 = niemand)

    // ---- Wiedergabe / Modus ----
    currentMode: "training", // 'training' | 'editor'
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    activeSegmentId: null,
    zoom: 0, // minPxPerSec (0 = ganze Länge)

    // ---- Abgeleitet ----
    get sortedSegments() { return sortBy(this.segments, "timestamp"); },
    get sortedTempo() { return sortBy(this.tempoSections, "start_sec"); },
    get sortedPersons() { return sortBy(this.persons, "number"); },
    get sortedParts() { return sortBy(this.parts, "start_sec"); },
    /** Tempo-Abschnitt an der Abspielposition (für Kopfzeile und Anzeige). */
    get activeTempo() { return tempoAt(this.sortedTempo, this.currentTime); },
    get activePart() { return this.partAt(this.currentTime); },
    /** Gruppe des gewählten Paares an der aktuellen Position. */
    get myGroup() {
      if (!this.myPersonNumber) return 0;
      return this.groupOf(this.activePart, this.myPersonNumber);
    },
    /** Verlauf der Gruppen des gewählten Paares über das ganze Lied. */
    get myGroupTimeline() {
      return groupTimeline(this.sortedParts, this.memberships, this.myPersonNumber, this.duration || 0);
    },

    // ---- Helfer für die Oberfläche ----
    partAt(t) { return rangeAt(this.sortedParts, t); },
    sectionAt(t) { return tempoAt(this.sortedTempo, t); },
    barLengthOf(sec) { return barLength(sec); },
    groupOf(part, personNumber) { return groupOf(this.memberships, part, personNumber); },
    groupNumbersOf(part) { return groupNumbersOf(part); },
    groupNameOf(part, n) { return groupNameOf(part, n); },
    groupNameRaw(part, n) { return (part?.group_names || {})[n] || ""; },
    fmt(sec) { return formatTime(sec); },
    autoGrow(el) {
      if (el) { el.style.height = "auto"; el.style.height = el.scrollHeight + "px"; }
    },
    setStatus(msg) {
      this.toast = msg;
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => { this.toast = ""; }, 3200);
    },
    setTab(tab) { this.bottomTab = tab; this.scheduleDraw(); },

    // ---- Start ----
    async init() {
      repo.onNotice((msg) => this.setStatus(msg));
      await this.initAuth();

      this.userId = localStorage.getItem("choreo_user_id") || (() => {
        const id = uuid();
        localStorage.setItem("choreo_user_id", id);
        return id;
      })();
      this.userName = localStorage.getItem("choreo_user_name") || "";

      window.addEventListener("online", () => {
        this.online = true;
        this.setStatus("Wieder online – synchronisiere…");
        repo.processQueue();
      });
      window.addEventListener("offline", () => {
        this.online = false;
        this.setStatus("Offline");
      });

      // Datenverlust vermeiden: beim Verstecken/Verlassen alles Offene senden
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") {
          repo.flush();
          return;
        }
        if (this.online) repo.processQueue();
        if (this.currentMode === "editor" && this.online) this.verifyLockStillOurs();
        // Nach dem Hintergrund Canvas neu vermessen, sonst verrutscht das Raster
        requestAnimationFrame(() => this.recalibrate());
      });
      window.addEventListener("pagehide", () => {
        repo.flush();
        this.releaseLockBeacon();
      });

      // Tastatur (PC): Leertaste = Play/Pause, Pfeile = ±5 s
      window.addEventListener("keydown", (e) => {
        if (isTypingTarget(e.target) || !rt.ws) return;
        if (e.code === "Space") {
          e.preventDefault();
          this.togglePlay();
        } else if (e.code === "ArrowLeft") {
          e.preventDefault();
          rt.ws.setTime(Math.max(0, rt.ws.getCurrentTime() - 5));
        } else if (e.code === "ArrowRight") {
          e.preventDefault();
          rt.ws.setTime(Math.min(this.duration, rt.ws.getCurrentTime() + 5));
        }
      });

      await this.loadProjects();
      if (this.online) repo.processQueue();

      const last = localStorage.getItem("choreo_last_project");
      const visible = this.visibleProjects;
      const target = visible.find((p) => p.id === last) || visible[0];
      if (target) await this.openProject(target);
    },
  };
}
