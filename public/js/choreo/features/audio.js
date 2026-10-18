// Musik: laden (mit lokalem Cache), Wellenform, Wiedergabe, Tempo und Zoom.
//
// Wiedergabe – EINE für jedes Tempo: Die Musik wird einmal dekodiert und als verlustfreie
// WAV (16 Bit PCM, exakt die dekodierten Samples) über ein <audio> mit „Tonhöhe beibehalten“
// abgespielt. Tempo ändern ist dadurch sofort da, ohne neu zu laden.
// Warum nicht die Original-MP3 im <audio>? Dessen Decoder schätzt bei MP3 (v. a. VBR) die
// Zeitachse – nach einem Seek läuft die Musik dem Raster davon. Bei PCM gibt es nichts zu
// schätzen: Welle, Raster und Ton haben dieselbe Zeitachse (früher dafür WebAudio, das aber
// beim Verlangsamen tiefer klingt).
// Alles im Planer hängt an der Musik-Zeit; nur die Playhead-Uhr kennt den Tempo-Faktor.
import RegionsPlugin from "/vendor/wavesurfer-regions.esm.js";
import WaveSurfer from "/vendor/wavesurfer.esm.js";
import { AUDIO_TIMEOUT_MS } from "../config.js";
import { local } from "../data/index.js";
import { SPEED_MAX, SPEED_MIN, advance, encodeWav, peaksFrom, formatBpm, formatSpeed, normalizeSpeed, stepSpeed, tempoLines } from "../lib/speed.js";
import { audioLooksTruncated, lastDataTime, segmentAt } from "../lib/timeline.js";
import { rt } from "../runtime.js";

export function audio() {
  return {
    audioLoading: false,
    audioError: null,

    // ---- Tempo (nur für diese Sitzung gemerkt – sonst wundert man sich morgen) ----
    playbackRate: (() => { try { return normalizeSpeed(sessionStorage.getItem("choreo_speed")); } catch { return 1; } })(),
    speedMenuOpen: false,
    fmtSpeed(rate) { return formatSpeed(rate); },
    get speedAtMin() { return this.playbackRate <= SPEED_MIN; },
    get speedAtMax() { return this.playbackRate >= SPEED_MAX; },
    /** BPM der Tänze dieser Audio – original und beim gewählten Tempo. */
    get speedLines() {
      const name = (id) => (id ? this.projectDances.find((d) => d.id === id)?.name : null);
      return tempoLines(this.sortedTempo, name, this.playbackRate);
    },
    /** BPM an der aktuellen Stelle beim gewählten Tempo (für die Kopfzeile). */
    scaledBpm(bpm) { return formatBpm(bpm, this.playbackRate); },
    /** +1 % / −1 %; gedrückt halten wiederholt (erst nach einer kurzen Pause). */
    nudgeSpeed(direction) { this.setSpeed(stepSpeed(this.playbackRate, direction)); },
    holdSpeed(direction) {
      this.releaseSpeed();
      this.nudgeSpeed(direction);
      rt.speedHold = setTimeout(() => {
        rt.speedHold = setInterval(() => {
          const next = stepSpeed(this.playbackRate, direction);
          if (next === this.playbackRate) { this.releaseSpeed(); return; }
          this.setSpeed(next);
        }, 90);
      }, 450);
    },
    releaseSpeed() {
      if (rt.speedHold) { clearTimeout(rt.speedHold); clearInterval(rt.speedHold); rt.speedHold = null; }
    },
    /** Welche Wiedergabe läuft: „pcm“ (WAV aus den dekodierten Samples) oder „element“ (Notlösung: Originaldatei). */
    get audioEngine() {
      if (!rt.ws) return null;
      return rt.pcmMedia ? "pcm" : "element";
    },
    /** Zeit, die die Audio selbst meldet (zum Abgleich mit dem Playhead). */
    mediaTime() { return rt.ws ? rt.ws.getCurrentTime() : 0; },
    get preservesPitch() {
      const media = rt.ws?.getMediaElement?.();
      return media ? media.preservesPitch !== false : null;
    },

    // ---------------- Laden ----------------
    // Spinner/Status hängen an den Wavesurfer-Events 'ready'/'decode'/'error',
    // nicht am load()-Promise (das kann in v7 hängen bleiben).
    //
    // Handy: Wechselt man während des Ladens in eine andere App, friert der Browser die
    // Seite ein – Download oder Dekodieren brechen dann ab. Das ist kein Fehler der Datei:
    // Solche Fehler werden nicht angezeigt (und schalten nicht auf die Notlösung), sondern
    // beim Zurückkommen wird einfach neu geladen (interruptedByBackground / retryAudio).
    async loadAudio(project) {
      this.audioLoading = true;
      this.audioError = null;
      rt.audioRefetchTried = false;
      rt.hiddenDuringLoad = document.visibilityState === "hidden";
      const token = rt.loadToken;

      clearTimeout(rt.audioTimeout);
      rt.audioTimeout = setTimeout(() => {
        if (token !== rt.loadToken || !this.audioLoading) return;
        if (this.interruptedByBackground()) return;
        this.audioLoading = false;
        this.audioError = "Audio-Dekodierung hat zu lange gedauert. Erneut versuchen? (Tipp: MP3/WAV sind am kompatibelsten.)";
      }, AUDIO_TIMEOUT_MS);

      // 1. lokal vorhanden (und dieselbe Datei)? → direkt an Wavesurfer.
      //    Nach „Audio austauschen“ hat das Projekt eine neue URL → neu laden. Ältere
      //    Einträge ohne URL werden einmal frisch geladen; offline gilt, was da ist.
      const cached = await local.getAudio(project.id);
      if (token !== rt.loadToken) return;
      const sameFile = cached?.url === project.audio_url || !navigator.onLine;
      const complete = cached?.blob && (!cached.size || cached.blob.size === cached.size); // abgeschnitten → neu
      if (complete && sameFile) {
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
        // Vollständig angekommen? (Abbruch im Hintergrund darf nicht im Cache landen)
        const expected = res.headers.get("content-encoding") ? null : Number(res.headers.get("content-length")) || null;
        const blob = await res.blob();
        if (expected && blob.size !== expected) throw new Error(`Download unvollständig (${blob.size} von ${expected} Bytes)`);
        await local.putAudio(project.id, blob, project.audio_url, expected);
        if (token !== rt.loadToken) return;
        this.wsLoadBlob(blob).catch((e) => this.handleAudioError(e));
      } catch (e) {
        if (token !== rt.loadToken) return;
        if (this.interruptedByBackground()) return;
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
      rt.backgroundRetries = 0;
      if (rt.ws) {
        this.duration = rt.ws.getDuration();
        rt.ws.setPlaybackRate(this.playbackRate, true); // Tonhöhe beibehalten, auch bei 100 %
      }
      // Musik deutlich kürzer als die Daten darauf → Datei wohl abgeschnitten: einmal frisch laden
      const dataEnd = lastDataTime({ tempoSections: this.tempoSections, segments: this.segments, parts: this.parts, steps: this.steps });
      if (audioLooksTruncated(this.duration, dataEnd) && !rt.truncatedRefetchTried && this.project && navigator.onLine) {
        rt.truncatedRefetchTried = true; // je geöffnetem Projekt nur einmal (siehe openProject)
        local.dropAudio(this.project.id).then(() => this.retryAudio());
        return;
      }
      this.renderRegions();
      this.recalibrate();
    },

    /**
     * Fehler/Abbruch, während die Seite im Hintergrund war (oder es gerade ist)? Dann nichts
     * anzeigen: sichtbar → gleich neu laden, versteckt → beim Zurückkommen (onAudioVisible).
     */
    interruptedByBackground() {
      if (document.visibilityState !== "hidden" && !rt.hiddenDuringLoad) return false;
      if (document.visibilityState === "hidden") rt.retryOnVisible = true;
      else queueMicrotask(() => this.retryAudio());
      return true;
    },

    /**
     * Zurück in der App: abgebrochenes Laden neu starten. (Hängt es nur, greift die Zeitgrenze
     * AUDIO_TIMEOUT_MS – wegen des Hintergrunds dann ebenfalls als Neuladen statt Fehler.)
     */
    onAudioVisible() {
      if (this.project && rt.retryOnVisible) this.retryAudio();
    },

    /** Welle neu aufbauen und Musik neu laden (auch „Erneut versuchen“ – dann ohne Begrenzung). */
    retryAudio({ manual = false } = {}) {
      if (!this.project) return;
      rt.retryOnVisible = false;
      rt.backgroundRetries = manual ? 0 : (rt.backgroundRetries || 0) + 1;
      if (rt.backgroundRetries > 3) { // nicht endlos versuchen
        clearTimeout(rt.audioTimeout);
        this.audioLoading = false;
        this.audioError = "Audio konnte nicht geladen werden. Erneut versuchen?";
        return;
      }
      ++rt.loadToken; // laufendes Laden verwerfen
      if (this.isPlaying) rt.ws?.pause();
      rt.decodeFailed = false;
      this.destroyWs();
      this.createWs();
      this.loadAudio(this.project);
    },

    handleAudioError() {
      if (this.interruptedByBackground()) return; // kein Fehler der Datei
      // iOS hat den Cache geräumt oder der Blob ist kaputt: einmal frisch laden
      if (rt.audioSource === "cache" && !rt.audioRefetchTried && this.project && navigator.onLine) {
        rt.audioRefetchTried = true;
        local.dropAudio(this.project.id);
        this.loadAudioFromNetwork(this.project, rt.loadToken);
        return;
      }
      // Dekodieren klappt nicht: einmalig die Originaldatei direkt im <audio>
      // (mehr Formate, dafür ohne sample-genaue Zeitachse)
      if (!rt.decodeFailed && this.project) {
        rt.decodeFailed = true;
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
      if (rt.audioBlob !== blob) this.dropPcmSource(); // andere Musik → alte WAV weg
      rt.audioBlob = blob;
      if (rt.pcmMedia) return this.loadPcm(blob);
      if (rt.currentObjectUrl) URL.revokeObjectURL(rt.currentObjectUrl);
      rt.currentObjectUrl = URL.createObjectURL(blob);
      return rt.ws.load(rt.currentObjectUrl);
    },

    /** Musik dekodieren → WAV fürs <audio>, verkleinerte Welle; einmal je Datei. */
    async loadPcm(blob) {
      const ws = rt.ws;
      try {
        if (!rt.pcmSource || rt.pcmSource.blob !== blob) {
          const data = await blob.arrayBuffer();
          const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
          const buffer = await new Offline(1, 1, 44100).decodeAudioData(data);
          const peaks = [];
          for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) peaks.push(peaksFrom(buffer.getChannelData(c), buffer.sampleRate));
          this.dropPcmSource();
          // den dekodierten Puffer nicht behalten – WAV + verkleinerte Welle reichen
          rt.pcmSource = { blob, url: URL.createObjectURL(encodeWav(buffer)), peaks, duration: buffer.duration };
        }
        if (ws !== rt.ws) return; // inzwischen neu aufgebaut
        const { url, peaks, duration } = rt.pcmSource;
        return rt.ws.load(url, peaks, duration);
      } catch {
        if (ws !== rt.ws) return;
        this.handleAudioError(); // → Originaldatei direkt abspielen
      }
    },
    dropPcmSource() {
      if (rt.pcmSource) URL.revokeObjectURL(rt.pcmSource.url);
      rt.pcmSource = null;
    },

    // ---------------- Tempo ----------------
    saveSpeed() { try { sessionStorage.setItem("choreo_speed", String(this.playbackRate)); } catch { /* egal */ } },
    /** Tempo wählen – sofort, ohne neu zu laden (alle Tempi laufen über dieselbe Wiedergabe). */
    setSpeed(value) {
      const rate = normalizeSpeed(value);
      if (rate === this.playbackRate) return;
      this.playbackRate = rate;
      this.saveSpeed();
      if (!rt.ws) return; // gilt beim nächsten Laden
      rt.ws.setPlaybackRate(rate, true);
      if (this.isPlaying) { rt.clockP = null; this.syncClock(rt.ws.getCurrentTime()); } // Uhr neu ansetzen
    },

    // ---------------- Wavesurfer ----------------
    createWs() {
      const container = document.getElementById("waveform");
      const height = Math.max(60, container.clientHeight - 6);

      const palette = this.refreshPalette();
      // <audio> für die WAV, Tonhöhe beim Tempo beibehalten (Notlösung ohne: Originaldatei)
      rt.pcmMedia = null;
      if (!rt.decodeFailed) {
        const media = document.createElement("audio");
        media.preservesPitch = true;
        media.webkitPreservesPitch = true;
        media.mozPreservesPitch = true;
        media.preload = "auto";
        rt.pcmMedia = media;
      }
      rt.ws = WaveSurfer.create({
        container,
        height,
        waveColor: palette.wave,
        progressColor: palette.waveProgress,
        cursorWidth: 0, // eigener Playhead über dem Canvas
        barWidth: 2,
        barGap: 1,
        barRadius: 2,
        minPxPerSec: this.zoom || 1,
        fillParent: true,
        // Wiedergabe: siehe Kopf der Datei (WAV aus den dekodierten Samples im <audio>)
        ...(rt.pcmMedia ? { media: rt.pcmMedia } : { backend: "MediaElement" }),
      });
      rt.wsRegions = rt.ws.registerPlugin(RegionsPlugin.create());

      this.setupOverlays(container);
      this.setupDragScroll(container);
      this.setupZoomGestures(); // Mausrad / zwei Finger, siehe gestures.js
      rt.zoomPending = null;

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
      if (rt.pcmMedia) { rt.pcmMedia.pause(); rt.pcmMedia.removeAttribute("src"); rt.pcmMedia = null; }
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
      const estimate = rt.clockP != null ? advance(rt.clockT, now - rt.clockP, this.playbackRate) : mediaTime;
      if (rt.clockP == null || mediaTime < rt.clockT - 1e-3 || Math.abs(estimate - mediaTime) > 0.15) {
        rt.clockT = mediaTime; // Seek / großer Sprung → hart neu
      } else {
        rt.clockT = mediaTime + (estimate - mediaTime) * 0.5; // kleine Drift sanft ausgleichen
      }
      rt.clockP = now;
    },
    clockNow() {
      if (rt.clockP == null) return this.currentTime;
      const pos = advance(rt.clockT, performance.now() - rt.clockP, this.playbackRate); // Musik-Zeit, nicht Echtzeit
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
  };
}
