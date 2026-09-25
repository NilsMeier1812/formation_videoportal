// Lokaler Speicher im Browser (IndexedDB über Dexie):
//  - Spiegel aller Projektdaten, damit Training auch ohne Netz geht
//  - Audio-Cache (die Musik liegt als Blob lokal)
//  - Warteschlange für Änderungen, die offline gemacht wurden
import Dexie from "/vendor/dexie.mjs";

export const db = new Dexie("ChoreoAppDB");
db.version(1).stores({
  audioCache: "projectId",
  syncQueue: "++id, table, timestamp",
  projects: "id",
  segments: "id, project_id",
});
db.version(2).stores({
  audioCache: "projectId",
  syncQueue: "++id, table, timestamp",
  projects: "id",
  segments: "id, project_id",
  tempoSections: "id, project_id",
  persons: "id, project_id",
  parts: "id, project_id",
  memberships: "id, part_id",
  steps: "id, project_id",
});

/** Tabellen der Datenbank → Tabellen im lokalen Spiegel. */
const MIRROR = {
  projects: "projects",
  choreo_segments: "segments",
  tempo_sections: "tempoSections",
  persons: "persons",
  parts: "parts",
  group_memberships: "memberships",
  steps: "steps",
};

const mirror = (table) => {
  const name = MIRROR[table];
  if (!name) throw new Error(`Keine lokale Tabelle für ${table}`);
  return db[name];
};

// Der lokale Speicher ist Komfort, kein Muss: Fehler (voll, privat, blockiert)
// werden geschluckt, die App arbeitet dann eben nur online.
const quiet = (promise, fallback) => promise.catch(() => fallback);

export const local = {
  put: (table, row) => quiet(mirror(table).put(row)),
  remove: (table, id) => quiet(mirror(table).delete(id)),

  /** Alle Zeilen eines Projekts (bzw. bei Gruppenzuteilungen: der Abschnitte). */
  async listByProject(table, projectId) {
    return quiet(mirror(table).where("project_id").equals(projectId).toArray(), []);
  },
  async listMemberships(partIds) {
    return quiet(mirror("group_memberships").where("part_id").anyOf(partIds).toArray(), []);
  },
  async listProjects() {
    return quiet(db.projects.toArray(), []);
  },

  /** Ersetzt den Spiegel eines Projekts durch den frischen Stand vom Server. */
  async replaceProjectRows(table, projectId, rows) {
    await quiet(mirror(table).where("project_id").equals(projectId).delete());
    await quiet(mirror(table).bulkPut(rows));
  },
  async replaceMemberships(partIds, rows) {
    await quiet(mirror("group_memberships").where("part_id").anyOf(partIds).delete());
    await quiet(mirror("group_memberships").bulkPut(rows));
  },
  async replaceProjects(rows) {
    await quiet(db.projects.clear());
    await quiet(db.projects.bulkPut(rows));
  },
  async forgetProject(projectId) {
    await quiet(db.audioCache.delete(projectId));
    for (const table of ["choreo_segments", "tempo_sections", "persons", "parts", "steps"]) {
      await quiet(mirror(table).where("project_id").equals(projectId).delete());
    }
  },

  // ---- Audio ----
  getAudio: (projectId) => quiet(db.audioCache.get(projectId), null),
  putAudio: (projectId, blob) => quiet(db.audioCache.put({ projectId, blob, cachedAt: Date.now() })),
  dropAudio: (projectId) => quiet(db.audioCache.delete(projectId)),

  // ---- Warteschlange ----
  enqueue: (table, op, key, payload) =>
    quiet(db.syncQueue.add({ table, op, key, payload, timestamp: Date.now() })),
  queued: () => quiet(db.syncQueue.orderBy("id").toArray(), null),
  dequeue: (id) => db.syncQueue.delete(id),
};
