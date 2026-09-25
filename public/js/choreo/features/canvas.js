// Zeichnen über und unter der Wellenform: Taktraster, Schritt-Spuren, Playhead.
// Beide Canvas teilen sich EIN Sichtfenster (Startzeit + Pixel pro Sekunde),
// damit Raster, Spuren und Musik exakt übereinanderliegen.
import { beatsPerBar, countInBar, isOffbeat, secondsPerBeat } from "../lib/timeline.js";
import { rt } from "../runtime.js";

const LANE_ROLES = ["herren", "damen", "note"];

/** Farben der Zeichenflächen aus theme.css (Hell/Dunkel). */
function readPalette() {
  const css = getComputedStyle(document.documentElement);
  const v = (name) => css.getPropertyValue(name).trim();
  return {
    wave: v("--wave"),
    waveProgress: v("--wave-progress"),
    marker: v("--marker"),
    gridBar: v("--grid-bar"),
    gridBeat: v("--grid-beat"),
    gridNumber: v("--grid-number"),
    laneGrid: v("--lane-grid"),
    laneDivider: v("--lane-divider"),
    laneHint: v("--lane-hint"),
    note: v("--note"),
    noteText: v("--note-text"),
    partLine: v("--part-line"),
    partMark: v("--part-mark"),
    footLeft: v("--foot-left"),
    footRight: v("--foot-right"),
    footNone: v("--foot-none"),
  };
}

function createCanvas(className, parent) {
  const canvas = document.createElement("canvas");
  canvas.className = className;
  parent.appendChild(canvas);
  return canvas;
}

function fitToDevicePixels(canvas, ctx) {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
  canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
}

export function canvas() {
  return {
    // ---------------- Farben ----------------
    refreshPalette() {
      rt.palette = readPalette();
      return rt.palette;
    },
    /** Nach Wechsel Hell/Dunkel: Welle, Marker und Overlays neu einfärben. */
    onThemeChange() {
      const palette = this.refreshPalette();
      rt.ws?.setOptions({ waveColor: palette.wave, progressColor: palette.waveProgress });
      this.renderRegions();
      this.scheduleDraw();
    },

    // ---------------- Aufbau ----------------
    setupOverlays(waveContainer) {
      this.removeOverlays();
      if (!rt.palette) this.refreshPalette();
      rt.gridCanvas = createCanvas("grid-canvas", waveContainer);
      rt.gridCtx = rt.gridCanvas.getContext("2d");

      rt.laneCanvas = createCanvas("lane-canvas", document.getElementById("lanes"));
      rt.laneCtx = rt.laneCanvas.getContext("2d");
      rt.laneCanvas.addEventListener("pointerdown", (e) => this.onLanePointerDown(e));
      rt.laneCanvas.addEventListener("pointermove", (e) => this.onLanePointerMove(e));
      rt.laneCanvas.addEventListener("pointerup", () => this.onLanePointerUp());
      rt.laneCanvas.addEventListener("pointercancel", () => this.cancelLongPress());

      rt.phWave = document.getElementById("ph-wave");
      rt.phLane = document.getElementById("ph-lane");

      if (!rt.onResize) {
        rt.onResize = () => this.recalibrate();
        window.addEventListener("resize", rt.onResize);
      }
    },

    removeOverlays() {
      if (rt.drawRaf) { cancelAnimationFrame(rt.drawRaf); rt.drawRaf = 0; }
      rt.pxPerSec = 0;
      rt.gridCanvas?.remove();
      rt.laneCanvas?.remove();
      rt.gridCanvas = rt.gridCtx = rt.laneCanvas = rt.laneCtx = null;
      for (const el of [rt.phWave, rt.phLane]) if (el) el.style.display = "none";
    },

    /** Canvas an die echten Maße anpassen und neu zeichnen (gegen Versatz). */
    recalibrate() {
      if (!rt.ws) return;
      fitToDevicePixels(rt.gridCanvas, rt.gridCtx);
      fitToDevicePixels(rt.laneCanvas, rt.laneCtx);
      this.recomputeViewport();
      this.scheduleDraw();
    },

    // ---------------- Sichtfenster ----------------
    // Pixel/Sekunde aus bekannten Größen rechnen statt aus scrollWidth (das ist
    // nach einem Zoom oft noch veraltet). Wavesurfer rendert mit
    // pxPerSec = max(minPxPerSec, Breite / Dauer).
    recomputeViewport() {
      if (!rt.ws || !rt.gridCanvas) return;
      const dur = rt.ws.getDuration();
      const width = rt.gridCanvas.clientWidth || 0;
      if (!dur || !width) return; // Layout noch nicht bereit → alten Wert behalten
      rt.pxPerSec = Math.max(this.zoom || 1, width / dur);
      rt.viewStart = (rt.ws.getScroll() || 0) / rt.pxPerSec;
    },
    viewport() {
      if (!rt.ws || !rt.pxPerSec) return null;
      return { startT: rt.viewStart || 0, pxPerSec: rt.pxPerSec };
    },

    /** EIN gemeinsames Neuzeichnen pro Frame. */
    scheduleDraw() {
      if (rt.drawRaf) return;
      rt.drawRaf = requestAnimationFrame(() => {
        rt.drawRaf = 0;
        const vp = this.viewport();
        this.drawGrid(vp);
        this.drawLanes(vp);
        this.updatePlayhead(vp);
      });
    },

    /** Playhead nur per transform verschieben – kein Neuzeichnen, immer flüssig. */
    updatePlayhead(vp = this.viewport()) {
      if (!rt.phWave && !rt.phLane) return;
      const width = rt.gridCanvas ? rt.gridCanvas.clientWidth : 0;
      let x = null;
      if (vp) {
        const px = (Math.max(0, this.currentTime) - vp.startT) * vp.pxPerSec;
        if (px >= 0 && px <= width) x = px;
      }
      for (const el of [rt.phWave, rt.phLane]) {
        if (!el) continue;
        if (x == null) el.style.display = "none";
        else { el.style.display = "block"; el.style.transform = `translateX(${x}px)`; }
      }
    },

    /** Ruft fn(t, beatIndex, beatsPerBar) für jeden sichtbaren Beat eines Tempo-Abschnitts. */
    forEachBeat(tempo, from, to, fn) {
      const spb = secondsPerBeat(tempo);
      if (spb <= 0) return;
      const bpb = beatsPerBar(tempo.time_signature);
      const offset = Number(tempo.offset_sec) || 0;
      const start = Number(tempo.start_sec) || 0;
      for (let k = Math.ceil((Math.max(start, from) - offset) / spb - 1e-6); ; k++) {
        const t = offset + k * spb;
        if (t > to + 1e-6) break;
        if (t < start - 1e-6) continue;
        fn(t, k, bpb);
      }
    },

    // ---------------- Taktraster ----------------
    // Pro Tempo-Abschnitt: Takt 1 dick, Beats dünn. Lücken bleiben leer.
    drawGrid(vp = this.viewport()) {
      const ctx = rt.gridCtx;
      if (!ctx || !rt.gridCanvas) return;
      const w = rt.gridCanvas.clientWidth;
      const h = rt.gridCanvas.clientHeight;
      ctx.clearRect(0, 0, w, h);
      if (!vp) return;
      const { startT, pxPerSec } = vp;
      const endT = startT + w / pxPerSec;
      const dur = rt.ws.getDuration() || 0;

      ctx.font = "10px -apple-system, sans-serif";
      ctx.textBaseline = "top";

      for (const tempo of this.sortedTempo) {
        const secEnd = tempo.end_sec == null ? dur : Number(tempo.end_sec);
        const to = Math.min(secEnd, endT);
        const beatPx = secondsPerBeat(tempo) * pxPerSec;
        const barPx = beatPx * beatsPerBar(tempo.time_signature);
        if (barPx < 12) continue; // zu weit rausgezoomt → Raster ausblenden
        const showBeats = beatPx >= 8;
        const showNumbers = barPx >= 22;

        this.forEachBeat(tempo, startT, to, (t, k, bpb) => {
          const isBar = ((k % bpb) + bpb) % bpb === 0;
          if (!isBar && !showBeats) return;
          const x = Math.round((t - startT) * pxPerSec) + 0.5;
          ctx.beginPath();
          ctx.strokeStyle = isBar ? rt.palette.gridBar : rt.palette.gridBeat;
          ctx.lineWidth = isBar ? 2 : 1;
          ctx.moveTo(x, isBar ? 0 : h * 0.5);
          ctx.lineTo(x, h);
          ctx.stroke();
          if (isBar && showNumbers) {
            ctx.fillStyle = rt.palette.gridNumber;
            ctx.fillText(String(Math.floor(k / bpb) + 1), x + 3, 2);
          }
        });
      }
    },

    // ---------------- Schritt-Spuren ----------------
    footColor(foot) {
      return foot === "R" ? rt.palette.footRight : foot === "L" ? rt.palette.footLeft : rt.palette.footNone;
    },

    drawLanes(vp = this.viewport()) {
      const ctx = rt.laneCtx;
      if (!ctx || !rt.laneCanvas) return;
      const w = rt.laneCanvas.clientWidth;
      const h = rt.laneCanvas.clientHeight;
      ctx.clearRect(0, 0, w, h);
      if (!vp) return;
      const { startT, pxPerSec } = vp;
      const endT = startT + w / pxPerSec;
      const dur = rt.ws.getDuration() || 0;
      const laneH = h / 3; // Leader / Follower / Notizen

      // Ohne gewähltes Paar (außerhalb des Editors) nur der Hinweis
      if (!this.isEditingSteps && !this.myPersonNumber) { this.drawLanePlaceholder(w, laneH); return; }

      // schwache Taktlinien zur Ausrichtung mit der Welle
      ctx.strokeStyle = rt.palette.laneGrid;
      ctx.lineWidth = 1;
      for (const tempo of this.sortedTempo) {
        if (barLengthPx(tempo, pxPerSec) < 10) continue;
        const secEnd = tempo.end_sec == null ? dur : Number(tempo.end_sec);
        this.forEachBeat(tempo, startT, Math.min(secEnd, endT), (t, k, bpb) => {
          if (((k % bpb) + bpb) % bpb !== 0) return; // nur Taktanfänge
          const x = Math.round((t - startT) * pxPerSec) + 0.5;
          ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
        });
      }

      this.drawLaneDividers(w, laneH);
      this.drawLaneSteps("herren", 0, laneH, startT, pxPerSec, endT);
      this.drawLaneSteps("damen", laneH, laneH, startT, pxPerSec, endT);
      this.drawNoteLane(2 * laneH, laneH, startT, pxPerSec, endT, dur);
    },

    drawLaneDividers(w, laneH) {
      const ctx = rt.laneCtx;
      ctx.strokeStyle = rt.palette.laneDivider;
      ctx.lineWidth = 1;
      for (let i = 1; i < 3; i++) {
        ctx.beginPath(); ctx.moveTo(0, laneH * i + 0.5); ctx.lineTo(w, laneH * i + 0.5); ctx.stroke();
      }
    },

    drawLanePlaceholder(w, laneH) {
      const ctx = rt.laneCtx;
      this.drawLaneDividers(w, laneH);
      ctx.save();
      ctx.fillStyle = rt.palette.laneHint;
      ctx.font = "13px -apple-system, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      const msg = "Bitte unten Paar auswählen";
      const gap = ctx.measureText(msg + "      ").width;
      for (let i = 0; i < 3; i++) {
        const cy = i * laneH + laneH / 2;
        for (let x = 26; x < w; x += gap) ctx.fillText(msg, x, cy);
      }
      ctx.restore();
    },

    /** Position eines Schritts in Sekunden, oder null ohne passenden Tempo-Abschnitt. */
    stepPosition(step) {
      const tempo = this.tempoSections.find((x) => x.id === step.tempo_section_id);
      if (!tempo) return null;
      const spb = secondsPerBeat(tempo);
      return { tempo, spb, t: Number(tempo.offset_sec || 0) + Number(step.beat_pos) * spb };
    },

    drawLaneSteps(role, y0, laneH, startT, pxPerSec, endT) {
      const ctx = rt.laneCtx;
      const cy = y0 + laneH / 2;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = "bold 13px -apple-system, sans-serif";
      for (const { s: step, dim } of this.laneEntries(role)) {
        const pos = this.stepPosition(step);
        if (!pos || pos.t < startT - pos.spb || pos.t > endT + pos.spb) continue;
        const x = (pos.t - startT) * pxPerSec;
        ctx.globalAlpha = dim ? 0.3 : 1;
        ctx.fillStyle = this.footColor(step.foot);
        if (this.stepDisplay === "dots") {
          // lange Schritte als etwas größerer Punkt
          const r = isOffbeat(step) ? 3.5 : Number(step.length_beats) >= 2 ? 6.5 : 5;
          ctx.beginPath(); ctx.arc(x, cy, r, 0, 7); ctx.fill();
        } else {
          let label;
          if (isOffbeat(step)) label = "u";
          else if (this.stepDisplay === "letters") label = Number(step.length_beats) >= 2 ? "L" : "S";
          else label = String(countInBar(step, pos.tempo));
          ctx.fillText(label, x, cy);
        }
      }
      ctx.globalAlpha = 1;
    },

    /** Notizen-Spur (Punkt + Wort, Wort blendet beim Rauszoomen aus) und Abschnittsgrenzen. */
    drawNoteLane(y0, laneH, startT, pxPerSec, endT, dur) {
      const ctx = rt.laneCtx;
      const cy = y0 + laneH / 2;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.font = "12px -apple-system, sans-serif";
      const showText = pxPerSec >= 30;
      for (const { s: step, dim } of this.laneEntries("note")) {
        const pos = this.stepPosition(step);
        if (!pos || pos.t < startT - pos.spb || pos.t > endT + pos.spb) continue;
        const x = (pos.t - startT) * pxPerSec;
        ctx.globalAlpha = dim ? 0.3 : 1;
        ctx.fillStyle = rt.palette.note;
        ctx.beginPath(); ctx.arc(x, cy, 4, 0, 7); ctx.fill();
        if (showText && step.value) { ctx.fillStyle = rt.palette.noteText; ctx.fillText(step.value, x + 7, cy); }
      }
      ctx.globalAlpha = 1;

      // Abschnittsgrenzen: dezente Linie an der Unterkante + Dreiecke an Start/Ende
      const bottom = y0 + laneH;
      for (const part of this.sortedParts) {
        const start = Number(part.start_sec) || 0;
        const end = part.end_sec == null ? dur : Number(part.end_sec);
        const x0 = (Math.max(start, startT) - startT) * pxPerSec;
        const x1 = (Math.min(end, endT) - startT) * pxPerSec;
        if (x1 > x0) {
          ctx.strokeStyle = rt.palette.partLine;
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(x0, bottom - 1); ctx.lineTo(x1, bottom - 1); ctx.stroke();
        }
        ctx.fillStyle = rt.palette.partMark;
        const bounds = part.end_sec != null ? [start, end] : [start];
        for (const bt of bounds) {
          if (bt < startT - 0.001 || bt > endT + 0.001) continue;
          const x = (bt - startT) * pxPerSec;
          ctx.beginPath();
          ctx.moveTo(x, bottom - 7);
          ctx.lineTo(x - 5, bottom);
          ctx.lineTo(x + 5, bottom);
          ctx.closePath();
          ctx.fill();
        }
      }
    },

    // ---------------- Tippen / Halten in den Spuren ----------------
    onLanePointerDown(e) {
      const vp = this.viewport();
      if (!rt.laneCanvas || !vp) return;
      const rect = rt.laneCanvas.getBoundingClientRect();
      const lp = rt.longPress;
      lp.x = e.clientX;
      lp.y = e.clientY;
      lp.handled = false;
      lp.moved = false;
      lp.role = LANE_ROLES[Math.min(2, Math.max(0, Math.floor((e.clientY - rect.top) / (rect.height / 3))))];
      lp.time = vp.startT + (e.clientX - rect.left) / vp.pxPerSec;
      if (this.isEditingSteps) {
        this.cancelLongPress();
        lp.timer = setTimeout(() => {
          lp.timer = null;
          lp.handled = true;
          this.laneLongPress(lp.role, lp.time);
          try { navigator.vibrate?.(15); } catch { /* egal */ }
        }, 380);
      }
    },
    onLanePointerMove(e) {
      const lp = rt.longPress;
      if (Math.abs(e.clientX - lp.x) > 8 || Math.abs(e.clientY - lp.y) > 8) {
        lp.moved = true;
        this.cancelLongPress();
      }
    },
    cancelLongPress() {
      if (rt.longPress.timer) { clearTimeout(rt.longPress.timer); rt.longPress.timer = null; }
    },
    onLanePointerUp() {
      const lp = rt.longPress;
      this.cancelLongPress();
      if (lp.handled) { lp.handled = false; return; } // Halten hat schon gehandelt
      if (lp.moved) return;
      if (this.isEditingSteps) { this.laneTap(lp.role, lp.time); return; }
      rt.ws?.setTime(Math.max(0, lp.time)); // sonst: nur springen
    },
  };
}

function barLengthPx(tempo, pxPerSec) {
  return secondsPerBeat(tempo) * beatsPerBar(tempo.time_signature) * pxPerSec;
}
