// Zoomen der Welle: Knöpfe − / +, Mausrad über Welle und L/F/N-Leiste (PC) und zwei Finger
// (Handy). Die Stelle unter dem Mauszeiger bzw. zwischen den Fingern bleibt stehen.
//
// Alle Wege landen in zoomAt(): neuer Zoom + passende Scroll-Position werden gemerkt und
// höchstens einmal pro Bildschirm-Frame angewendet – schnelles Drehen/Ziehen bremst nicht.
// Ein Finger bleibt wie bisher (wischen, tippen, Marken ziehen); nur zwei Finger zoomen –
// auch wenn ein Finger auf einer Sprungmarke liegt (die bleibt dabei, wo sie ist).
import { clampZoom, scrollFor, wheelFactor } from "../lib/zoom.js";
import { rt } from "../runtime.js";

const BUTTON_STEP = 1.6;
const onMarker = (e) => e.composedPath().some((n) => /\b(region|marker)\b/.test(n.getAttribute?.("part") || ""));

export function gestures() {
  return {
    zoomIn() { this.zoomAt(BUTTON_STEP, this.playheadX()); },
    zoomOut() { this.zoomAt(1 / BUTTON_STEP, this.playheadX()); },

    /** Breite und Länge, auf die sich der Zoom bezieht. */
    zoomFrame() {
      const width = document.getElementById("waveform")?.clientWidth || 0;
      const duration = rt.ws?.getDuration() || 0;
      return { width, duration };
    },

    /** Aktueller (oder schon vorgemerkter) Zustand: { zoom: px/s wie gezeichnet, scroll }. */
    zoomState() {
      if (rt.zoomPending) return rt.zoomPending;
      const { width, duration } = this.zoomFrame();
      return { zoom: clampZoom(this.zoom || 0, width, duration), scroll: rt.ws?.getScroll() || 0 };
    },

    /** Playhead-Position im Bild (für die Knöpfe); nicht sichtbar → Mitte. */
    playheadX() {
      const { width } = this.zoomFrame();
      const s = this.zoomState();
      const x = (this.currentTime || 0) * s.zoom - s.scroll;
      return x >= 0 && x <= width ? x : width / 2;
    },

    /** Um `factor` zoomen; die Musik-Stelle an Bildschirm-Position x bleibt dort. */
    zoomAt(factor, x) {
      if (!rt.ws || !this.duration) return;
      const s = this.zoomState();
      this.zoomTo(s.zoom * factor, (s.scroll + x) / s.zoom, x);
    },

    /** Zoom setzen, so dass Zeit `time` an Bildschirm-Position `anchorX` steht. */
    zoomTo(zoom, time, anchorX) {
      if (!rt.ws || !this.duration) return;
      const { width, duration } = this.zoomFrame();
      const z = clampZoom(zoom, width, duration);
      rt.zoomPending = { zoom: z, scroll: scrollFor({ time, anchorX, pxPerSec: z, width, duration }) };
      if (!rt.zoomRaf) rt.zoomRaf = requestAnimationFrame(() => this.applyZoom());
    },

    applyZoom() {
      rt.zoomRaf = 0;
      const p = rt.zoomPending;
      rt.zoomPending = null;
      if (!p || !rt.ws || !this.duration) return;
      this.zoom = p.zoom;
      try { rt.ws.zoom(p.zoom); } catch { return; } // noch keine Musik geladen
      rt.ws.setScroll(p.scroll);
      this.recomputeViewport();
      this.scheduleDraw();
    },

    /** Mausrad und zwei Finger auf Welle und Leiste (einmal; die Elemente bleiben bestehen). */
    setupZoomGestures() {
      if (rt.zoomGesturesReady) return;
      const wave = document.getElementById("waveform");
      const lanes = document.getElementById("lanes");
      if (!wave || !lanes) return;
      rt.zoomGesturesReady = true;
      const xIn = (clientX) => clientX - wave.getBoundingClientRect().left;

      // ---- PC: Mausrad = zoomen, seitlich (Touchpad, Umschalt+Rad) = verschieben ----
      const onWheel = (e) => {
        if (!rt.ws || !this.duration) return;
        const sideways = !e.ctrlKey && (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY));
        if (sideways) {
          if (e.currentTarget === wave && !e.shiftKey) return; // die Welle scrollt selbst
          e.preventDefault();
          rt.ws.setScroll(Math.max(0, rt.ws.getScroll() + (e.shiftKey ? e.deltaY || e.deltaX : e.deltaX)));
          return;
        }
        e.preventDefault();
        this.zoomAt(wheelFactor(e), xIn(e.clientX));
      };

      // ---- Handy: zwei Finger = zoomen (und dabei verschieben) ----
      let pinch = null;
      let firstOnMarker = false;
      let swallowUntil = 0;
      const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1;
      const mid = (a, b) => xIn((a.clientX + b.clientX) / 2);

      const onTouchStart = (e) => {
        if (e.touches.length === 1) { firstOnMarker = onMarker(e); return; }
        if (e.touches.length !== 2 || !rt.ws || !this.duration) return;
        // Solange gezoomt wird, verschiebt sich keine Sprungmarke (siehe onRegionMoved).
        // Hat ein Finger im Bearbeiten eine Marke gegriffen: Ziehen abbrechen, Marken neu setzen.
        rt.pinchGuard = true;
        if ((firstOnMarker || onMarker(e)) && this.currentMode === "editor") this.renderRegions();
        const [a, b] = e.touches;
        const s = this.zoomState();
        const x = mid(a, b);
        pinch = { d0: dist(a, b), zoom0: s.zoom, time: (s.scroll + x) / s.zoom };
        // kein Tippen/Halten in der Leiste auslösen
        this.cancelLongPress();
        rt.longPress.moved = true;
      };
      const onTouchMove = (e) => {
        if (!pinch || e.touches.length < 2) return;
        if (e.cancelable) e.preventDefault();
        const [a, b] = e.touches;
        this.zoomTo(pinch.zoom0 * (dist(a, b) / pinch.d0), pinch.time, mid(a, b));
      };
      const onTouchEnd = (e) => {
        if (e.touches.length === 0) { firstOnMarker = false; rt.pinchGuard = false; }
        if (!pinch || e.touches.length >= 2) return;
        pinch = null;
        swallowUntil = Date.now() + 350; // Loslassen soll nicht an die Stelle springen
        rt.longPress.moved = true;
      };
      // Klick direkt nach dem Zoomen schlucken (Einfangphase, vor dem Klick der Welle)
      const onClick = (e) => {
        if (Date.now() > swallowUntil) return;
        e.stopPropagation();
        e.preventDefault();
      };
      // Safari (iPhone): sonst zoomt die ganze Seite mit
      const noPageZoom = (e) => e.preventDefault();

      for (const el of [wave, lanes]) {
        el.addEventListener("wheel", onWheel, { passive: false });
        el.addEventListener("touchstart", onTouchStart, { passive: true });
        el.addEventListener("touchmove", onTouchMove, { passive: false });
        el.addEventListener("touchend", onTouchEnd);
        el.addEventListener("touchcancel", onTouchEnd);
        el.addEventListener("click", onClick, true);
        el.addEventListener("gesturestart", noPageZoom);
        el.addEventListener("gesturechange", noPageZoom);
      }
    },
  };
}
