// Sprungmarken: benannte Zeitpunkte mit Beschreibung, in der Welle als Marker.
import { SEGMENT_DEBOUNCE_MS } from "../config.js";
import { repo } from "../data/index.js";
import { round3, uuid } from "../lib/util.js";
import { rt } from "../runtime.js";

export function segments() {
  return {
    async loadSegments(projectId) {
      this.segments = await repo.loadRows("choreo_segments", projectId, "timestamp");
    },

    // ---- Marker in der Welle ----
    renderRegions() {
      if (!rt.wsRegions) return;
      rt.wsRegions.clearRegions();
      if (!this.showMarkers) return;
      const draggable = this.currentMode === "editor";
      for (const s of this.sortedSegments) {
        rt.wsRegions.addRegion({
          id: s.id,
          start: Number(s.timestamp),
          content: s.label || "♪",
          color: rt.palette.marker,
          drag: draggable,
          resize: false,
        });
      }
    },
    toggleMarkers() {
      this.showMarkers = !this.showMarkers;
      this.renderRegions();
    },
    onRegionMoved(region) {
      const seg = this.segments.find((s) => s.id === region.id);
      if (seg) this.updateSegment(seg, { timestamp: round3(region.start) }, { delay: 0 });
    },
    selectSegment(id) {
      this.activeSegmentId = id;
      document.getElementById("seg-" + id)?.scrollIntoView({ behavior: "smooth", block: "center" });
    },

    // ---- Bearbeiten ----
    addSegmentAtCursor() {
      if (!this.project) return;
      const timestamp = rt.ws ? round3(rt.ws.getCurrentTime()) : 0;
      const seg = { id: uuid(), project_id: this.project.id, timestamp, label: "", notes: "" };
      this.segments.push(seg);
      rt.wsRegions?.addRegion({ id: seg.id, start: timestamp, content: "♪", color: rt.palette.marker, drag: true, resize: false });
      repo.insert("choreo_segments", seg, {
        offlineMessage: "Offline – Marke gespeichert, wird später synchronisiert",
      });
      this.$nextTick(() => this.selectSegment(seg.id));
    },

    deleteSegment(seg) {
      this.segments = this.segments.filter((s) => s.id !== seg.id);
      rt.wsRegions?.getRegions().find((r) => r.id === seg.id)?.remove();
      repo.remove("choreo_segments", seg);
    },

    /** Tippen in Name/Beschreibung: sofort anzeigen, verzögert speichern. */
    onSegmentInput(seg, field, value) {
      this.updateSegment(seg, { [field]: value });
      if (field === "label") {
        rt.wsRegions?.getRegions().find((r) => r.id === seg.id)?.setOptions?.({ content: value || "♪" });
      }
    },

    updateSegment(seg, changes, { delay = SEGMENT_DEBOUNCE_MS } = {}) {
      Object.assign(seg, changes);
      repo.patch("choreo_segments", seg, changes, {
        delay,
        offlineMessage: "Offline – Änderung gespeichert, wird später synchronisiert",
      });
    },

    /** Einen Takt vor der Sprungmarke starten. */
    seekBarBefore(timestamp) {
      const t = Number(timestamp) || 0;
      this.seekTo(Math.max(0, t - (this.barLengthOf(this.sectionAt(t)) || 0)));
    },
  };
}
