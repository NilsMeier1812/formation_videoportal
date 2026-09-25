// Offline-fähige Datenschicht: Alles, was der Planer liest oder schreibt, läuft hier durch.
//
//  Lesen:     erst Server, Ergebnis lokal spiegeln; ohne Netz der lokale Spiegel.
//  Schreiben: sofort lokal, dann Server. Klappt der Server nicht, landet die
//             Änderung in der Warteschlange und wird später nachgereicht.
//  Tippen:    Änderungen an Feldern werden gesammelt und verzögert gespeichert;
//             beim Verlassen der Seite wird alles Offene sofort gesendet.
//  Abgelehnt: Lehnt der Server eine Änderung dauerhaft ab (z. B. weil die Zeile
//             inzwischen gelöscht wurde), wird sie verworfen statt ewig
//             wiederholt – sonst blockierte sie die ganze Warteschlange.
//
// `remote` ist austauschbar (siehe data/index.js).
import { FIELD_DEBOUNCE_MS } from "../config.js";
import { plain } from "../lib/util.js";
import { local } from "./local.js";

/** Tabellen mit Spalte updated_at – dort wird bei jeder Änderung gestempelt. */
const STAMPED = new Set(["projects", "tempo_sections", "choreo_segments"]);
const OFFLINE_SAVED = "Offline – gespeichert, wird synchronisiert";
const REJECTED = "Eine Änderung wurde vom Server abgelehnt und verworfen";

/**
 * Lohnt es sich, später nochmal zu versuchen? Ja bei Netzfehlern (kein Status),
 * Serverfehlern, fehlender Anmeldung und Überlast; nein bei anderen 4xx.
 */
export function isRetryable(err) {
  const status = err?.status;
  return !status || status >= 500 || [401, 403, 408, 429].includes(status);
}

export function createRepository(remote) {
  let notify = () => {};
  /** "table:id" → { table, id, patch, timer, message } */
  const pending = new Map();

  const stamp = (table, patch) =>
    STAMPED.has(table) ? { ...patch, updated_at: new Date().toISOString() } : patch;

  /** Nach einem fehlgeschlagenen Schreiben: vormerken oder (dauerhaft abgelehnt) verwerfen. */
  async function deferOrDrop(err, table, op, key, payload, message) {
    if (!isRetryable(err)) {
      notify(REJECTED);
      return;
    }
    await local.enqueue(table, op, key, payload);
    if (message) notify(message);
  }

  async function sendPatch(table, id, patch, message) {
    try {
      await remote.update(table, id, patch);
    } catch (err) {
      await deferOrDrop(err, table, "update", id, patch, message);
    }
  }

  return {
    /** Kurze Meldungen an die Oberfläche (z. B. "Offline – …"). */
    onNotice(fn) { notify = fn; },

    // ---------------- Lesen ----------------
    async loadProjects() {
      try {
        const rows = await remote.listProjects();
        await local.replaceProjects(rows);
        return { rows, fromCache: false };
      } catch {
        return { rows: await local.listProjects(), fromCache: true };
      }
    },
    async loadRows(table, projectId, orderBy) {
      try {
        const rows = await remote.listByProject(table, projectId, orderBy);
        await local.replaceProjectRows(table, projectId, rows);
        return rows;
      } catch {
        return local.listByProject(table, projectId);
      }
    },
    async loadMemberships(partIds) {
      if (!partIds.length) return [];
      try {
        const rows = await remote.listMemberships(partIds);
        await local.replaceMemberships(partIds, rows);
        return rows;
      } catch {
        return local.listMemberships(partIds);
      }
    },

    // ---------------- Schreiben ----------------
    async insert(table, row, { offlineMessage = OFFLINE_SAVED } = {}) {
      local.put(table, plain(row));
      try {
        await remote.insert(table, row);
      } catch (err) {
        await deferOrDrop(err, table, "insert", row.id, row, offlineMessage);
      }
    },

    async remove(table, row, { offlineMessage = null } = {}) {
      this.cancelPatch(table, row.id);
      local.remove(table, row.id);
      try {
        await remote.remove(table, row.id);
      } catch (err) {
        await deferOrDrop(err, table, "delete", row.id, null, offlineMessage);
      }
    },

    /**
     * Änderung an einer bestehenden Zeile. `row` ist bereits geändert (für den
     * lokalen Spiegel), `changes` sind nur die geänderten Felder für den Server.
     * Mehrere Änderungen kurz hintereinander werden zu einem Speichern zusammengefasst.
     */
    patch(table, row, changes, { delay = FIELD_DEBOUNCE_MS, offlineMessage = OFFLINE_SAVED } = {}) {
      local.put(table, plain(row));
      const key = `${table}:${row.id}`;
      const entry = pending.get(key) || { table, id: row.id, patch: {} };
      Object.assign(entry.patch, changes);
      entry.message = offlineMessage;
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        pending.delete(key);
        sendPatch(table, row.id, stamp(table, entry.patch), offlineMessage);
      }, delay);
      pending.set(key, entry);
    },

    cancelPatch(table, id) {
      const key = `${table}:${id}`;
      clearTimeout(pending.get(key)?.timer);
      pending.delete(key);
    },

    /** Offene Änderungen sofort senden – beim Verstecken/Schließen der Seite. */
    flush() {
      for (const [key, entry] of pending) {
        clearTimeout(entry.timer);
        pending.delete(key);
        const payload = stamp(entry.table, entry.patch);
        try {
          remote.updateKeepalive(entry.table, entry.id, payload)
            .then((res) => { if (!res.ok && isRetryable({ status: res.status })) throw new Error(`HTTP ${res.status}`); })
            .catch(() => local.enqueue(entry.table, "update", entry.id, payload));
        } catch {
          local.enqueue(entry.table, "update", entry.id, payload);
        }
      }
    },

    /**
     * Warteschlange nachreichen, in Reihenfolge. Bei vorübergehenden Fehlern
     * abbrechen (später erneut), dauerhaft abgelehnte Einträge verwerfen.
     */
    async processQueue() {
      if (!navigator.onLine) return;
      const items = await local.queued();
      if (!items) return;
      for (const item of items) {
        try {
          if (item.op === "update") await remote.update(item.table, item.key, item.payload);
          else if (item.op === "insert") await remote.upsert(item.table, item.payload);
          else if (item.op === "delete") await remote.remove(item.table, item.key);
          await local.dequeue(item.id);
        } catch (err) {
          if (isRetryable(err)) break;
          await local.dequeue(item.id);
          notify(REJECTED);
        }
      }
    },
  };
}
