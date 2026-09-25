// Musik: laden (mit lokalem Cache), Wellenform, Wiedergabe und Zoom.
import RegionsPlugin from "/vendor/wavesurfer-regions.esm.js";
import WaveSurfer from "/vendor/wavesurfer.esm.js";
import { AUDIO_TIMEOUT_MS } from "../config.js";
import { local } from "../data/index.js";
import { segmentAt } from "../lib/timeline.js";
import { rt } from "../runtime.js";

export function audio() {
  return {
    audioLoading: false,
    audioError: null,

    // ---------------- Laden ----------------
    // Spinner/Status hängen an den Wavesurfer-Events 'ready'/'decode'/'error',
    // nicht am load()-Promise (das kann in v7 hängen bleiben).
    async loadAudio(project) {
      this.audioLoading = true;
      this.audioError = null;
      rt.audioRefetchTried = false;
      const token = rt.loadToken;

      clearTimeout(rt.audioTimeout);
      rt.audioTimeout = setTimeout(() => {
        if (token === rt.loadToken && this.audioLoading) {
          this.audioLoading = false;
          this.audioError = "Audio-Dekodierung hat zu lange gedauert. Erneut versuchen? (Tipp: MP3/WAV sind am kompatibelsten.)";
        }
      }, AUDIO_TIMEOUT_MS);

      // 1. lokal vorhanden? → direkt an Wavesurfer
      const cached = await local.getAudio(project.id);
      if (token !== rt.loadToken) return;
      if (cached?.blob) {
        rt.audioSource = "cache";
        this.wsLoadBlob(cached.blob).catch((e) => this.handleAudioError(e));
        return;
      }
      // 2. sonst aus dem Netz laden und lokal ablegen
      await this.loadAudioFromNetwork(project, token);
    },

    async loadAudioFromNetwork(project, token) {
      rt.audioSource = "network";
      try {
        const res = await fetch(project.audio_url);
        if (!res.ok) throw new Error("HTTP " + res.status);
        const blob = await res.blob();
        await local.putAudio(project.id, blob);
        if (token !== rt.loadToken) return;
        this.wsLoadBlob(blob).catch((e) => this.handleAudioError(e));
      } catch (e) {
        if (token !== rt.loadToken) return;
        clearTimeout(rt.audioTimeout);
        this.audioLoading = false;
        this.audioError = navigator.onLine
          ? "Audio konnte nicht geladen werden: " + e.message
          : "Offline – dieses Audio ist nicht im Cache verfügbar.";
      }
    },

    onAudioReady() {
      clearTimeout(rt.audioTimeout);
      this.audioLoading = false;
      this.audioError = null;
      if (rt.ws) this.duration = rt.ws.getDuration();
      this.renderRegions();
      this.recalibrate();
    },

    handleAudioError() {
      // iOS hat den Cache geräumt oder der Blob ist kaputt: einmal frisch laden
      if (rt.audioSource === "cache" && !rt.audioRefetchTried && this.project && navigator.onLine) {
        rt.audioRefetchTried = true;
        local.dropAudio(this.project.id);
        this.loadAudioFromNetwork(this.project, rt.loadToken);
        return;
      }
      // WebAudio konnte das Format nicht dekodieren: einmalig auf <audio>
      // zurückfallen (mehr Formate, dafür ohne sample-genaue Zeitachse)
      if (!rt.webAudioFailed && this.project) {
        rt.webAudioFailed = true;
        this.destroyWs();
        this.createWs();
        this.loadAudio(this.project);
        return;
      }
      clearTimeout(rt.audioTimeout);
      this.audioLoading = false;
      this.audioError = navigator.onLine
        ? "Audio konnte nicht dekodiert werden. Erneut versuchen? (Tipp: MP3/WAV sind am kompatibelsten.)"
        : "Offline – dieses Audio ist nicht im Cache verfügbar.";
    },

    wsLoadBlob(blob) {
      if (rt.currentObjectUrl) URL.revokeObjectURL(rt.currentObjectUrl);
      rt.currentObjectUrl = URL.createObjectURL(blob);
      return rt.ws.load(rt.currentObjectUrl);
    },

    // ---------------- Wavesurfer ----------------
    createWs() {
      const container = document.getElementById("waveform");
      const height = Math.max(60, container.clientHeight - 6);

      rt.ws = WaveSurfer.create({
        container,
        height,
        waveColor: "#5a5a5a",
        progressColor: "#6c8cff",
        cursorWidth: 0, // eigener Playhead über dem Canvas
        barWidth: 2,
        barGap: 1,
        barRadius: 2,
        minPxPerSec: this.zoom || 1,
        fillParent: true,
        // WICHTIG: Wiedergabe über WebAudio statt <audio>-Element. Das <audio>-
        // Element hat einen eigenen Decoder mit geschätzter Zeitachse: bei MP3s
        // (v. a. VBR) landet es nach einem Seek woanders, als currentTime meldet –
        // die Musik läuft dem Raster dann hörbar voraus. WebAudio spielt denselben
        // dekodierten Puffer, aus dem auch die Welle gezeichnet wird.
        backend: rt.webAudioFailed ? "MediaElement" : "WebAudio",
      });
      rt.wsRegions = rt.ws.registerPlugin(RegionsPlugin.create());

      this.setupOverlays(container);

      rt.ws.on("ready", () => this.onAudioReady());
      rt.ws.on("decode", () => this.onAudioReady());
      rt.ws.on("play", () => { this.isPlaying = true; this.recalibrate(); this.startPlayLoop(); });
      rt.ws.on("pause", () => { this.isPlaying = false; this.stopPlayLoop(); });
      rt.ws.on("finish", () => { this.isPlaying = false; this.stopPlayLoop(); });
      // Beim Abspielen treibt die Interpolations-Uhr den Playhead; timeupdate
      // liefert dann nur den groben Anker und die Sprungmarken-Logik.
      rt.ws.on("timeupdate", (t) => { this.onTimeUpdate(t); if (!this.isPlaying) this.updatePlayhead(); });
      rt.ws.on("error", (err) => this.handleAudioError(err));
      // 'scroll' liefert den exakten Sichtbereich (gleicher Bezug wie die Welle)
      rt.ws.on("scroll", (visibleStart, visibleEnd, scrollLeft, scrollRight) => {
        if (visibleEnd > visibleStart && scrollRight > scrollLeft) {
          rt.pxPerSec = (scrollRight - scrollLeft) / (visibleEnd - visibleStart);
          rt.viewStart = visibleStart;
        } else if (typeof visibleStart === "number") {
          rt.viewStart = visibleStart;
        }
        this.scheduleDraw();
      });
      rt.ws.on("zoom", () => { this.recomputeViewport(); this.scheduleDraw(); });
      rt.ws.on("redraw", () => { this.recomputeViewport(); this.scheduleDraw(); });

      rt.wsRegions.on("region-updated", (r) => this.onRegionMoved(r));
      rt.wsRegions.on("region-clicked", (r, e) => {
        e.stopPropagation();
        rt.ws.setTime(r.start);
        this.selectSegment(r.id);
      });
    },

    destroyWs() {
      if (rt.playRaf) { cancelAnimationFrame(rt.playRaf); rt.playRaf = 0; }
      if (rt.heartbeatTimer) { clearInterval(rt.heartbeatTimer); rt.heartbeatTimer = null; }
      if (rt.ws) {
        try { rt.ws.destroy(); } catch { /* egal */ }
        rt.ws = null;
        rt.wsRegions = null;
      }
      this.removeOverlays();
      if (rt.currentObjectUrl) { URL.revokeObjectURL(rt.currentObjectUrl); rt.currentObjectUrl = null; }
    },

    // ---------------- Wiedergabe ----------------
    togglePlay() {
      if (!rt.ws) return;
      // iOS/Safari: der AudioContext startet 'suspended' und darf nur in einer
      // Nutzer-Geste geweckt werden (Absicherung, sonst wirkungslos)
      try {
        const ctx = rt.ws.getMediaElement?.()?.audioContext;
        if (ctx && ctx.state === "suspended") ctx.resume();
      } catch { /* egal */ }
      this.recalibrate(); // vor dem Start neu vermessen
      rt.ws.playPause();
      requestAnimationFrame(() => this.recalibrate()); // nach dem Layout nochmal
    },

    // --- Interpolations-Uhr gegen den ~½-Beat-Versatz ---
    // media.currentTime aktualisiert in vielen Browsern nur grob (~alle 250 ms).
    // Der Playhead würde der echten Wiedergabe hinterherhinken. Deshalb wird
    // zwischen den groben Werten mit performance.now() interpoliert.
    syncClock(mediaTime) {
      const now = performance.now();
      const estimate = rt.clockP != null ? rt.clockT + (now - rt.clockP) / 1000 : mediaTime;
      if (rt.clockP == null || mediaTime < rt.clockT - 1e-3 || Math.abs(estimate - mediaTime) > 0.15) {
        rt.clockT = mediaTime; // Seek / großer Sprung → hart neu
      } else {
        rt.clockT = mediaTime + (estimate - mediaTime) * 0.5; // kleine Drift sanft ausgleichen
      }
      rt.clockP = now;
    },
    clockNow() {
      if (rt.clockP == null) return this.currentTime;
      const pos = rt.clockT + (performance.now() - rt.clockP) / 1000;
      const dur = this.duration || rt.ws?.getDuration() || 0;
      return dur ? Math.min(pos, dur) : pos;
    },
    startPlayLoop() {
      if (rt.playRaf) return;
      rt.clockP = null;
      let lastMediaTime = rt.ws ? rt.ws.getCurrentTime() : 0;
      this.syncClock(lastMediaTime);
      const step = () => {
        if (!rt.ws || !this.isPlaying) { rt.playRaf = 0; return; }
        const mediaTime = rt.ws.getCurrentTime();
        if (mediaTime !== lastMediaTime) { lastMediaTime = mediaTime; this.syncClock(mediaTime); }
        this.currentTime = this.clockNow();
        this.updatePlayhead(); // nur Playhead bewegen, kein Neuzeichnen
        rt.playRaf = requestAnimationFrame(step);
      };
      rt.playRaf = requestAnimationFrame(step);
    },
    stopPlayLoop() {
      if (rt.playRaf) { cancelAnimationFrame(rt.playRaf); rt.playRaf = 0; }
      rt.clockP = null;
      if (rt.ws) this.currentTime = rt.ws.getCurrentTime(); // exakte Endposition
      this.scheduleDraw();
    },

    onTimeUpdate(t) {
      // Während der Wiedergabe gehört currentTime der interpolierten Uhr
      if (!this.isPlaying) this.currentTime = t;
      const active = segmentAt(this.sortedSegments, t);
      const id = active ? active.id : null;
      if (id === rt.lastActiveSegmentId) return;
      rt.lastActiveSegmentId = id;
      this.activeSegmentId = id;
      if (id && this.currentMode === "training") { // Auto-Scroll nur im Training
        document.getElementById("seg-" + id)?.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    },

    seekTo(t) { if (rt.ws && this.duration) rt.ws.setTime(Number(t)); },
    zoomIn() { this.zoom = Math.min(400, (this.zoom || 20) * 1.6); rt.ws?.zoom(this.zoom); },
    zoomOut() { this.zoom = Math.max(1, (this.zoom || 20) / 1.6); rt.ws?.zoom(this.zoom); },
  };
}
