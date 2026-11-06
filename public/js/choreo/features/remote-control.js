// Fernsteuerung des Musik-Players (nur Trainer), Gegenstück: src/remote-room.js.
//
// PC an der Anlage – Menü „Musik an diesem Gerät“ (rcRole = "host"):
//   bleibt an, solange die Seite offen ist; spielt die Musik wie immer und meldet seinen
//   Stand (Lied, Stelle, läuft/pausiert, Tempo). Befehle der Handys führt er aus.
//   Der Bildschirm bleibt dabei an (sonst schläft der PC mitten im Training ein).
//
// Handy – Menü „Fernsteuern“ (rcRole = "ctrl"):
//   derselbe Planer, auf das Nötigste reduziert. Das Handy spielt selbst NICHTS ab, es
//   spiegelt den PC: Welle, Playhead und Spuren laufen mit der gemeldeten Stelle mit.
//   Play/Pause und jedes Springen (Welle, Spuren, Sprungmarken, Abschnitte …) gehen an den PC.
//   Dafür wird das Wavesurfer-Objekt des Handys umgeleitet (rcWrapWs): playPause → Befehl,
//   setTime → Befehl „seek“, pause → nichts (aufräumende Pausen beim Seitenwechsel sollen den
//   PC nicht anhalten). Choreo wählen im Menü öffnet sie auch am PC.
//   „Beenden“ in der Leiste unter der Kopfzeile führt zurück zum normalen Planer.
import { backoff, controllerLabel, controllerShort, mirrorTime, remoteUrl } from "../lib/remote.js";
import { rt } from "../runtime.js";
import { router } from "/js/router.js";

const REPLACED = 4001; // ein anderer PC hat übernommen (siehe remote-room.js)
// Lebenszeichen: Bricht das WLAN weg, merkt der Browser eine tote Verbindung oft minutenlang
// nicht. Deshalb alle 3 s „ping“ (beantwortet Cloudflare selbst, ohne den Raum zu wecken);
// kommt 7 s kein „pong“, wird neu verbunden.
const PING_MS = 3000;
const DEAD_MS = 7000;
const BEAT_MS = 2000; // PC: Stand spätestens alle 2 s, solange die Musik läuft

export function remoteControl() {
  return {
    rcRole: null, // null | "host" (dieser PC spielt) | "ctrl" (dieses Gerät steuert)
    rcConnected: false,
    rcHostOnline: false, // Handy: ist ein Musik-PC da?
    rcCtrlCount: 0, // PC: wie viele Handys steuern gerade

    get rcCtrlLabel() { return controllerLabel({ connected: this.rcConnected, hostOnline: this.rcHostOnline }); },
    get rcCtrlShort() { return controllerShort({ connected: this.rcConnected, hostOnline: this.rcHostOnline }); },
    get rcHostLabel() {
      if (!this.rcConnected) return "Fernsteuerung · verbinde …";
      const n = this.rcCtrlCount;
      return n ? `Fernsteuerung · ${n} ${n === 1 ? "Handy" : "Handys"}` : "Fernsteuerung an";
    },

    // ---------------- An / aus ----------------
    rcToggleHost(on) {
      if (on) this.rcStartHost();
      else this.rcStop();
    },

    rcStartHost() {
      if (!this.isEditor || this.rcRole === "host") return;
      if (this.rcRole) this.rcStop();
      this.rcRole = "host";
      this.rcSetup();
      this.rcConnect();
      this.rcKeepAwake();
      clearInterval(rt.rc.beat);
      rt.rc.beat = setInterval(() => {
        if (this.isPlaying && performance.now() - rt.rc.lastSent > BEAT_MS - 100) this.rcSendStatus();
      }, 500);
    },

    async rcStartCtrl() {
      if (!this.isEditor) return;
      if (this.rcRole === "host") this.rcStop();
      if (this.rcRole === "ctrl") { this.menuOpen = false; return; }
      this.menuOpen = false;
      if (this.isPlaying) rt.ws?.pause(); // eigene Wiedergabe aus – ab jetzt spielt der PC
      if (this.currentMode === "editor") await this.exitEditor();
      rt.rc.ownRate = this.playbackRate;
      rt.rc.status = null;
      this.rcRole = "ctrl";
      this.rcHostOnline = false;
      if (this.bottomTab !== "notes") this.setTab("notes");
      if (this.appView !== "choreo") router.navigate("/");
      this.rcWrapWs();
      this.rcSetup();
      this.rcConnect();
      this.rcStartLoop();
    },

    rcStop() {
      const role = this.rcRole;
      this.rcRole = null;
      clearTimeout(rt.rc.retry);
      clearInterval(rt.rc.ping);
      clearInterval(rt.rc.beat);
      clearTimeout(rt.rc.seekTimer);
      const socket = rt.rc.socket;
      rt.rc.socket = null;
      if (socket) {
        socket.onclose = null;
        try { socket.close(1000); } catch { /* egal */ }
      }
      this.rcConnected = false;
      this.rcHostOnline = false;
      this.rcCtrlCount = 0;
      rt.rc.wakeLock?.release?.().catch(() => {});
      rt.rc.wakeLock = null;
      if (role === "ctrl") {
        if (rt.rc.raf) { cancelAnimationFrame(rt.rc.raf); rt.rc.raf = 0; }
        this.rcUnwrapWs();
        this.isPlaying = false;
        rt.rc.status = null;
        if (rt.rc.ownRate != null && rt.rc.ownRate !== this.playbackRate) {
          this.playbackRate = rt.rc.ownRate;
          rt.ws?.setPlaybackRate(this.playbackRate, true);
        }
        this.scheduleDraw();
      }
    },

    /**
     * Einmal je Seite: Zurückkommen verbindet neu. (Kein $watch: gestartet wird aus dem Menü,
     * und Alpine räumt Beobachter mit dem geschlossenen Menü weg. Änderungen melden deshalb
     * die Stellen selbst, an denen sie passieren – siehe rcChanged.)
     */
    rcSetup() {
      if (rt.rc.watching) return;
      rt.rc.watching = true;
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "visible" || !this.rcRole) return;
        if (!rt.rc.socket) { rt.rc.attempt = 0; this.rcConnect(); }
        if (this.rcRole === "host") this.rcKeepAwake();
      });
      // Netz wieder da → nicht auf den nächsten Versuch warten
      window.addEventListener("online", () => {
        if (this.rcRole && !this.rcConnected) { rt.rc.attempt = 0; this.rcConnect(); }
      });
    },

    // ---------------- Verbindung ----------------
    rcConnect() {
      clearTimeout(rt.rc.retry);
      const as = this.rcRole;
      if (!as) return;
      const old = rt.rc.socket;
      if (old) { old.onclose = null; try { old.close(1000); } catch { /* egal */ } }
      let socket;
      try { socket = new WebSocket(remoteUrl(location, as)); } catch { return; }
      rt.rc.socket = socket;
      socket.onopen = () => {
        if (rt.rc.socket !== socket) return;
        this.rcConnected = true;
        rt.rc.attempt = 0;
        rt.rc.lastPong = performance.now();
        clearInterval(rt.rc.ping);
        rt.rc.ping = setInterval(() => {
          if (performance.now() - rt.rc.lastPong > DEAD_MS) { this.rcLost(socket, 1006); return; }
          try { socket.send("ping"); } catch { /* egal */ }
        }, PING_MS);
        if (as === "host") this.rcSendStatus();
      };
      socket.onmessage = (event) => {
        rt.rc.lastPong = performance.now(); // jede Nachricht zeigt: Verbindung lebt
        if (event.data === "pong") return;
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (rt.rc.socket === socket) this.rcOnMessage(message);
      };
      socket.onclose = (event) => this.rcLost(socket, event.code);
    },

    /** Verbindung zu (oder tot): anzeigen, gleich neu verbinden – außer ein anderer PC hat übernommen. */
    rcLost(socket, code) {
      if (rt.rc.socket !== socket) return;
      rt.rc.socket = null;
      socket.onclose = null;
      try { socket.close(); } catch { /* egal */ }
      clearInterval(rt.rc.ping);
      this.rcConnected = false;
      const as = this.rcRole;
      if (as === "ctrl") { this.rcHostOnline = false; this.rcHold(); }
      if (code === REPLACED) {
        this.rcStop();
        this.setStatus("Ein anderer PC spielt jetzt die Musik – Fernsteuerung hier aus");
        return;
      }
      if (!as) return;
      clearTimeout(rt.rc.retry);
      rt.rc.retry = setTimeout(() => this.rcConnect(), backoff(rt.rc.attempt++));
    },

    rcOnMessage(m) {
      if (this.rcRole === "host") {
        if (m.type === "hello") this.rcSendStatus();
        else if (m.type === "ctrls") this.rcCtrlCount = m.count || 0;
        else if (m.type === "cmd") this.rcHandleCommand(m);
      } else if (this.rcRole === "ctrl") {
        if (m.type === "host") {
          this.rcHostOnline = Boolean(m.online);
          if (!m.online) this.rcHold();
        } else if (m.type === "status") {
          this.rcApplyStatus(m);
        }
      }
    },

    // ---------------- PC ----------------
    /** Lied, läuft/pausiert, Tempo oder Länge haben sich geändert (audio.js, projects.js). */
    rcChanged() {
      if (this.rcRole === "host") this.rcSendStatus();
    },

    /** Stand an die Handys. `time` ausdrücklich nach einem Sprung (die Uhr hinkt dann kurz). */
    rcSendStatus(time = null) {
      const socket = rt.rc.socket;
      if (this.rcRole !== "host" || !socket || socket.readyState !== WebSocket.OPEN) return;
      const now = time ?? (this.isPlaying ? this.clockNow() : rt.ws ? rt.ws.getCurrentTime() : this.currentTime);
      socket.send(JSON.stringify({
        type: "status",
        projectId: this.project?.id ?? null,
        title: this.project?.title ?? "",
        time: Number(now) || 0,
        duration: this.duration || 0,
        playing: this.isPlaying,
        rate: this.playbackRate,
      }));
      rt.rc.lastSent = performance.now();
    },

    /** Am PC gesprungen (egal ob per Handy oder am PC selbst) → Handys sofort Bescheid geben. */
    rcOnSeeking() {
      if (this.rcRole !== "host") return;
      clearTimeout(rt.rc.seekTimer);
      rt.rc.seekTimer = setTimeout(() => this.rcSendStatus(rt.ws ? rt.ws.getCurrentTime() : null), 30);
    },

    rcHandleCommand(c) {
      if (c.action === "open") {
        const p = this.projects.find((x) => x.id === c.projectId);
        if (p && p.id !== this.project?.id) {
          if (this.appView !== "choreo") router.navigate("/");
          this.openProject(p);
        } else this.rcSendStatus();
        return;
      }
      if (!rt.ws || !this.project) { this.rcSendStatus(); return; }
      if (c.action === "play") {
        if (this.appView !== "choreo") router.navigate("/"); // Musik nicht unsichtbar laufen lassen
        if (!this.isPlaying && !this.audioLoading && this.duration) this.togglePlay();
        else this.rcSendStatus();
      } else if (c.action === "pause") {
        if (this.isPlaying) rt.ws.pause();
        else this.rcSendStatus();
      } else if (c.action === "seek") {
        this.seekTo(this.duration ? Math.min(c.t, this.duration) : c.t); // → rcOnSeeking
      }
    },

    async rcKeepAwake() {
      if (this.rcRole !== "host" || rt.rc.wakeLock || document.visibilityState !== "visible") return;
      try {
        rt.rc.wakeLock = await navigator.wakeLock?.request("screen");
        rt.rc.wakeLock?.addEventListener("release", () => { rt.rc.wakeLock = null; });
      } catch { /* nicht unterstützt – egal */ }
    },

    // ---------------- Handy ----------------
    /** Befehl an den PC – und sofort so anzeigen (der PC bestätigt gleich mit seinem Stand). */
    rcCommand(action, extra = {}) {
      const socket = rt.rc.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN || !this.rcHostOnline) {
        this.setStatus(this.rcConnected ? "Kein Musik-PC verbunden" : "Verbinde …");
        return false;
      }
      socket.send(JSON.stringify({ type: "cmd", action, ...extra }));
      const s = rt.rc.status;
      if (s && action !== "open") {
        const time = action === "seek" ? extra.t : this.rcNow();
        const playing = action === "play" ? true : action === "pause" ? false : s.playing;
        rt.rc.status = { ...s, time, playing };
        rt.rc.statusAt = performance.now();
        this.isPlaying = playing;
      }
      return true;
    },

    rcNow() { return mirrorTime(rt.rc.status, performance.now() - rt.rc.statusAt, this.duration); },

    /** Verbindung oder PC weg: an der aktuellen Stelle stehen bleiben. */
    rcHold() {
      if (rt.rc.status?.playing) {
        rt.rc.status = { ...rt.rc.status, time: this.rcNow(), playing: false };
        rt.rc.statusAt = performance.now();
      }
      this.isPlaying = false;
    },

    rcApplyStatus(s) {
      rt.rc.status = s;
      rt.rc.statusAt = performance.now();
      this.rcHostOnline = true;
      if (s.rate && s.rate !== this.playbackRate) this.playbackRate = s.rate; // BPM-Anzeige wie am PC
      if (s.projectId && s.projectId !== this.project?.id) this.rcFollow(s.projectId);
      this.isPlaying = s.playing;
    },

    /** Am PC läuft ein anderes Lied → hier dasselbe öffnen (ohne es dem PC zurückzuschicken). */
    async rcFollow(projectId) {
      if (rt.rc.following === projectId) return;
      let p = this.projects.find((x) => x.id === projectId);
      if (!p) { await this.loadProjects(); p = this.projects.find((x) => x.id === projectId); }
      if (!p || this.rcRole !== "ctrl") return;
      rt.rc.following = projectId;
      try { await this.openProject(p); } finally { rt.rc.following = null; }
      if (rt.rc.status) this.isPlaying = rt.rc.status.playing; // openProject setzt das zurück
    },

    /** Läuft, solange das Handy fernsteuert: Playhead, Welle und Sichtbereich folgen dem PC. */
    rcStartLoop() {
      if (rt.rc.raf) return;
      let lastSync = 0;
      const step = (now) => {
        if (this.rcRole !== "ctrl") { rt.rc.raf = 0; return; }
        const s = rt.rc.status;
        if (s && s.projectId === this.project?.id) {
          const t = this.rcNow();
          if (t !== this.currentTime) { this.currentTime = t; this.updatePlayhead(); }
          if (now - lastSync > 250 && rt.ws && this.duration && !this.audioLoading) {
            lastSync = now;
            if (Math.abs(rt.ws.getCurrentTime() - t) > 0.05) this.rcLocalSet(t); // Welle + Sprungmarke
            if (s.playing) this.rcFollowView(t);
          }
        }
        rt.rc.raf = requestAnimationFrame(step);
      };
      rt.rc.raf = requestAnimationFrame(step);
    },

    /** Welle des Handys auf die Stelle des PCs setzen – ohne daraus einen Befehl zu machen. */
    rcLocalSet(t) {
      rt.rc.applying = true;
      try { rt.ws.setTime(t); } finally { rt.rc.applying = false; }
    },

    /** Beim Abspielen mitscrollen, wenn der Playhead aus dem Bild läuft (gezoomt). */
    rcFollowView(t) {
      const vp = this.viewport();
      const width = rt.gridCanvas?.clientWidth || 0;
      if (!vp || !width || !vp.pxPerSec) return;
      const x = (t - vp.startT) * vp.pxPerSec;
      if (x < 0 || x > width * 0.85) rt.ws.setScroll(Math.max(0, t * vp.pxPerSec - width * 0.15));
    },

    /** Wavesurfer des Handys umleiten (nach jedem Neuaufbau, siehe createWs). */
    rcWrapWs() {
      const ws = rt.ws;
      if (!ws || ws.__rc) return;
      const setTime = ws.setTime.bind(ws);
      ws.__rc = true;
      ws.playPause = () => Promise.resolve(this.rcCommand(this.isPlaying ? "pause" : "play"));
      ws.play = () => Promise.resolve(this.rcCommand("play"));
      ws.pause = () => {}; // das Handy spielt nie selbst – und hält den PC nicht beim Aufräumen an
      ws.setTime = (t) => {
        setTime(t);
        if (!rt.rc.applying && this.duration) this.rcCommand("seek", { t: Math.max(0, Number(t) || 0) });
      };
    },

    rcUnwrapWs() {
      const ws = rt.ws;
      if (!ws?.__rc) return;
      for (const key of ["playPause", "play", "pause", "setTime", "__rc"]) delete ws[key];
    },
  };
}
