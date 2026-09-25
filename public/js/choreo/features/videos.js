// Videos im Planer.
//
//   Tab „Videos“      Videos, deren Zeitraum (von–bis) die aktuelle Stelle der Musik
//                     enthält. Gezeigt werden nur Vorschaubild, Titel und Tags – die
//                     Videos selbst laden erst, wenn man eines antippt (Player).
//   „Stelle wählen“   für Admins (Reiter „Zuordnen“): Start und Ende eines Videos in
//                     der Musik festlegen. Der Zeitraum erscheint als Fläche in der Welle.
//
// Die Choreos/Tänze/Tags kommen aus /js/library.js (auch für das Menü).
import { api } from "/js/api.js";
import { library } from "/js/library.js";
import { router } from "/js/router.js";
import { rt } from "../runtime.js";

const PICK_REGION = "pick-range";

export function videos() {
  return {
    // ---- Choreos, Tänze, Audios, Tags (für Menü und Titel) ----
    libraryData: library.data,

    // ---- Tab „Videos“ ----
    planVideos: [], // alle Videos mit Zeitraum (geladen beim Öffnen des Tabs)
    planVideosLoaded: false,

    // ---- Stelle wählen (Admin) ----
    pick: null, // { projectId, start, end, videos: [{ id, url, poster, label }], preview }

    initVideos() {
      library.load().catch(() => {}); // offline: Menü ohne Gruppen, Planer wie bisher
      window.addEventListener("librarychange", () => { this.libraryData = library.data; });
      window.addEventListener("pick-range", (e) => this.startPick(e.detail));
      window.addEventListener("show-in-choreo", (e) => this.showInChoreo(e.detail));
      window.addEventListener("open-project-settings", (e) => this.openSettingsFor(e.detail.projectId));
      window.addEventListener("videos-changed", () => { if (this.planVideosLoaded) this.loadPlanVideos(); });
    },

    // ---------------- Menü: Audios nach Choreos gruppiert ----------------
    /** [{ key, title, projects }] – ohne Choreos eine einzige Gruppe ohne Titel (wie früher). */
    get projectGroups() {
      const visible = this.visibleProjects;
      const { choreos } = this.libraryData;
      const choreoOf = (p) => this.libraryData.audios.find((a) => a.id === p.id)?.choreo_id || null;
      if (!choreos.length) return [{ key: "alle", title: "", projects: visible }];
      const groups = choreos.map((c) => ({
        key: c.id,
        title: c.title,
        projects: visible
          .filter((p) => choreoOf(p) === c.id)
          .sort((a, b) => (b.id === c.main_project_id) - (a.id === c.main_project_id)),
      })).filter((g) => g.projects.length);
      const rest = visible.filter((p) => !choreoOf(p));
      if (rest.length) groups.push({ key: "ohne", title: "Ohne Choreo", projects: rest });
      return groups;
    },
    isMainAudio(p) {
      return this.libraryData.choreos.some((c) => c.main_project_id === p.id);
    },
    /** „Standard & Latein“ – Tänze einer Audio. */
    audioDances(p) {
      const audio = this.libraryData.audios.find((a) => a.id === p.id);
      return (audio?.dance_ids || []).map((id) => library.dance(id)?.name).filter(Boolean).join(" & ");
    },

    // ---------------- Tab „Videos“ ----------------
    async loadPlanVideos() {
      try {
        const [{ videos }] = await Promise.all([api("/api/videos"), library.load()]);
        this.planVideos = videos.filter((v) => v.audio_project_id && v.audio_start_s != null);
        this.planVideosLoaded = true;
      } catch {
        if (!this.planVideosLoaded) this.setStatus("Videos konnten nicht geladen werden");
      }
    },
    openVideosTab() {
      this.setTab("videos");
      this.loadPlanVideos();
    },
    /** Videos dieser Audio, nach Start sortiert. */
    get audioVideos() {
      if (!this.project) return [];
      return this.planVideos
        .filter((v) => v.audio_project_id === this.project.id)
        .sort((a, b) => a.audio_start_s - b.audio_start_s || a.audio_end_s - b.audio_end_s);
    },
    /**
     * Videos an der aktuellen Stelle. Solange sich die Auswahl nicht ändert, kommt
     * dasselbe Array zurück (Merker in rt, nicht reaktiv) – die Liste bleibt beim
     * Abspielen ruhig stehen, Bilder laden nicht neu.
     */
    get videosHere() {
      const t = this.currentTime;
      const here = this.audioVideos.filter((v) => v.audio_start_s <= t && t <= v.audio_end_s);
      const key = here.map((v) => v.id).join(",");
      if (key !== rt.videosHereKey) { rt.videosHereKey = key; rt.videosHere = here; }
      return rt.videosHere;
    },
    /** Zeitbereiche mit Videos (für „Videos gibt es bei …“), zusammengefasst. */
    get videoRanges() {
      const ranges = [];
      for (const v of this.audioVideos) {
        const last = ranges[ranges.length - 1];
        if (last && v.audio_start_s <= last.end) {
          last.end = Math.max(last.end, v.audio_end_s);
          last.count++;
        } else {
          ranges.push({ start: v.audio_start_s, end: v.audio_end_s, count: 1 });
        }
      }
      return ranges;
    },
    /** Hauptaudio der Choreo dieser Audio, wenn es eine andere ist (dort hängen die Videos). */
    get mainAudioElsewhere() {
      if (!this.project) return null;
      const audio = this.libraryData.audios.find((a) => a.id === this.project.id);
      const choreo = this.libraryData.choreos.find((c) => c.id === audio?.choreo_id);
      if (!choreo?.main_project_id || choreo.main_project_id === this.project.id) return null;
      return this.projects.find((p) => p.id === choreo.main_project_id) || null;
    },
    videoTitle(v) { return library.videoTitle(v); },
    /** Sekunden als „1:05“. */
    fmtShort(sec) {
      const s = Math.floor(Number(sec) || 0);
      return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    },
    videoTags(v) { return v.tag_ids.map((id) => library.tag(id)?.name).filter(Boolean); },
    videoDate(v) {
      if (!v.recorded_at) return "";
      const d = new Date(v.recorded_at.includes("T") ? v.recorded_at : `${v.recorded_at}T12:00:00`);
      return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
    },
    openVideo(v) {
      if (this.isPlaying) rt.ws?.pause();
      router.navigate(`/videos/${encodeURIComponent(v.id)}`);
    },
    /** Aus dem Player: „In der Musik zeigen“. */
    async showInChoreo({ projectId, time }) {
      const p = this.projects.find((x) => x.id === projectId);
      if (!p) { this.setStatus("Audio nicht gefunden"); return; }
      this.pendingProject = null;
      if (this.project?.id !== projectId) await this.openProject(p);
      this.openVideosTab();
      if (await this.waitForAudio()) this.seekTo(time);
    },

    // ---------------- Stelle wählen (Admin) ----------------
    async startPick({ projectId, start, end, videos }) {
      const p = this.projects.find((x) => x.id === projectId);
      if (!p) { this.setStatus("Audio nicht gefunden"); return; }
      this.pick = { projectId, start, end, videos, preview: 0 };
      this.pendingProject = null;
      this.bottomTab = "pick";
      if (this.project?.id !== projectId) await this.openProject(p);
      else this.renderRegions();
      if (start != null && (await this.waitForAudio())) this.seekTo(start);
    },
    /** Wartet, bis die Musik geladen ist (höchstens 15 s). */
    waitForAudio(timeoutMs = 15000) {
      return new Promise((resolve) => {
        const began = Date.now();
        const tick = () => {
          if (this.duration > 0 && rt.ws) resolve(true);
          else if (Date.now() - began > timeoutMs) resolve(false);
          else setTimeout(tick, 100);
        };
        tick();
      });
    },
    get pickValid() {
      return this.pick && this.pick.start != null && this.pick.end != null && this.pick.start < this.pick.end;
    },
    pickVideo() { return this.pick?.videos[this.pick.preview] || null; },
    setPick(which, value) {
      if (!this.pick) return;
      const t = Math.max(0, Math.min(this.duration || Infinity, Math.round(Number(value) * 10) / 10));
      this.pick[which] = t;
      this.renderPickRegion();
    },
    pickHere(which) { this.setPick(which, rt.ws ? rt.ws.getCurrentTime() : this.currentTime); },
    nudgePick(which, delta) { if (this.pick?.[which] != null) this.setPick(which, this.pick[which] + delta); },
    /** Fläche in der Welle; klick-durchlässig, damit man weiter in die Welle tippen kann. */
    renderPickRegion() {
      if (!rt.wsRegions) return;
      rt.wsRegions.getRegions().find((r) => r.id === PICK_REGION)?.remove();
      if (!this.pickValid || this.project?.id !== this.pick.projectId) return;
      const color = getComputedStyle(document.documentElement).getPropertyValue("--accent-dim").trim();
      const region = rt.wsRegions.addRegion({
        id: PICK_REGION, start: this.pick.start, end: this.pick.end, color, drag: false, resize: false,
      });
      if (region?.element) region.element.style.pointerEvents = "none";
    },
    finishPick(apply) {
      if (apply && this.pickValid) {
        const { projectId, start, end } = this.pick;
        window.dispatchEvent(new CustomEvent("range-picked", { detail: { projectId, start, end } }));
      }
      this.pick = null;
      this.bottomTab = "steps";
      this.renderRegions();
      if (this.isPlaying) rt.ws?.pause();
      router.back("/zuordnen");
    },
  };
}
