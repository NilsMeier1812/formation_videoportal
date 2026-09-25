// Wechsel Training ↔ Editor und die Bearbeitungssperre: Es bearbeitet immer nur
// eine Person ein Projekt. Die Sperre wird per Heartbeat erneuert; bleibt sie
// länger aus (Handy zu, Seite weg), darf jemand anderes übernehmen.
import { HEARTBEAT_MS } from "../config.js";
import { remote, repo } from "../data/index.js";
import { rt } from "../runtime.js";

export function editing() {
  return {
    lockOwned: false,
    lockedByOther: null,

    get user() { return { id: this.userId, name: this.userName }; },

    async toggleMode() {
      if (!this.project) return;
      if (this.currentMode === "editor") { await this.exitEditor(); return; }
      if (!this.isEditor) { this.openLogin(); return; } // Bearbeiten nur mit Login
      await this.enterEditor();
    },

    async enterEditor() {
      try {
        if (!(await this.acquireLock())) {
          this.setStatus(this.lockedByOther
            ? `Gesperrt – wird von ${this.lockedByOther} bearbeitet`
            : "Gesperrt – wird gerade bearbeitet");
          return;
        }
      } catch (e) {
        if (navigator.onLine) { this.setStatus("Sperre fehlgeschlagen: " + e.message); return; }
        this.setStatus("Offline-Bearbeitung – Änderungen werden synchronisiert");
      }
      this.currentMode = "editor";
      this.renderRegions();
      this.scheduleDraw();
      if (this.lockOwned) this.startHeartbeat();
    },

    async exitEditor() {
      repo.flush();
      await this.releaseLock();
      this.currentMode = "training";
      this.renderRegions();
      this.scheduleDraw();
    },

    async acquireLock() {
      const { ok, holder } = await remote.acquireLock(this.project.id, this.user);
      this.lockOwned = ok;
      this.lockedByOther = ok ? null : holder;
      return ok;
    },

    startHeartbeat() {
      clearInterval(rt.heartbeatTimer);
      rt.heartbeatTimer = setInterval(() => {
        if (this.project && this.currentMode === "editor") this.verifyLockStillOurs();
      }, HEARTBEAT_MS);
    },

    /** Sperre erneuern; gehört sie uns nicht mehr, zurück ins Training. Netzfehler zählen nicht. */
    async verifyLockStillOurs() {
      if (!this.project) return;
      try {
        if (!(await remote.renewLock(this.project.id, this.user))) this.onLockLost();
      } catch { /* Netzfehler: beim nächsten Mal wieder versuchen */ }
    },

    onLockLost() {
      clearInterval(rt.heartbeatTimer);
      rt.heartbeatTimer = null;
      this.lockOwned = false;
      this.currentMode = "training";
      this.renderRegions();
      this.setStatus("Bearbeitung beendet – Sperre wurde von jemand anderem übernommen");
    },

    async releaseLock() {
      clearInterval(rt.heartbeatTimer);
      rt.heartbeatTimer = null;
      if (!this.project || !this.lockOwned) { this.lockOwned = false; return; }
      this.lockOwned = false;
      try { await remote.releaseLock(this.project.id, this.userId); } catch { /* egal */ }
    },

    /** Beim Schließen der Seite: Sperre per keepalive freigeben. */
    releaseLockBeacon() {
      if (this.project && this.lockOwned) remote.releaseLockKeepalive(this.project.id, this.userId);
    },
  };
}
