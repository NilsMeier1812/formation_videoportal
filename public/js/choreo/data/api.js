// Adapter für die eigene API (/api/choreo, /api/session). Gleiche Funktionen wie
// früher der Supabase-Adapter – der Rest des Planers merkt vom Wechsel nichts.
// Anmeldung läuft über ein HttpOnly-Cookie, das der Server nach Eingabe des
// Trainer-Codes setzt; es wird bei jeder Anfrage automatisch mitgeschickt.

/** Fehler mit HTTP-Status. Ohne Status = Netzwerkfehler (offline). */
export class RemoteError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const enc = encodeURIComponent;

async function request(method, path, { body, keepalive } = {}) {
  const init = { method, credentials: "same-origin", keepalive, headers: {} };
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new RemoteError(res.status, data.error || `HTTP ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

const rows = (table, id) => `/api/choreo/${table}/${enc(id)}`;
const lock = (projectId, action = "") => `/api/choreo/projects/${enc(projectId)}/lock${action}`;

export function createApiRemote() {
  return {
    // ---------------- Anmeldung ----------------
    /** true = mit Trainer-Code angemeldet (darf bearbeiten). */
    async restoreSession() {
      try {
        const { role } = await request("GET", "/api/session");
        return role === "tagger";
      } catch {
        return false; // offline → Lese-Modus
      }
    },
    onAuthChange() { /* Anmeldung ändert sich nur über login/logout */ },
    async login(code) {
      const { role } = await request("POST", "/api/session", { body: { code } });
      if (role !== "tagger") {
        throw new RemoteError(403, "Das ist der Gruppen-Code – zum Bearbeiten braucht es den Trainer-Code.", "group");
      }
    },
    async logout() {
      await request("DELETE", "/api/session").catch(() => {});
    },
    /** Code erneut prüfen (Bestätigung vor dem Löschen). */
    async verifyPassword(code) {
      try {
        const { role } = await request("POST", "/api/session", { body: { code } });
        return role === "tagger";
      } catch {
        return false;
      }
    },

    // ---------------- Lesen ----------------
    listProjects: () => request("GET", "/api/choreo/projects"),
    /** Sortierung übernimmt der Server. */
    listByProject: (table, projectId) => request("GET", `/api/choreo/projects/${enc(projectId)}/${table}`),
    async listMemberships(partIds) {
      if (!partIds.length) return [];
      return request("GET", `/api/choreo/group_memberships?part_ids=${partIds.map(enc).join(",")}`);
    },

    // ---------------- Schreiben ----------------
    insert: (table, rowOrRows) => request("POST", `/api/choreo/${table}`, { body: rowOrRows }),
    upsert: (table, row) => request("PUT", rows(table, row.id), { body: row }),
    update: (table, id, patch) => request("PATCH", rows(table, id), { body: patch }),
    remove: (table, id) => request("DELETE", rows(table, id)),
    /** Wie update, übersteht aber das Schließen der Seite. */
    updateKeepalive(table, id, patch) {
      return fetch(rows(table, id), {
        method: "PATCH",
        keepalive: true,
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
    },
    createProject: (row) => request("POST", "/api/choreo/projects", { body: row }),

    // ---------------- Bearbeitungssperre ----------------
    acquireLock: (projectId, user) =>
      request("POST", lock(projectId), { body: { user_id: user.id, user_name: user.name } }),
    async renewLock(projectId, user) {
      const { ok } = await request("POST", lock(projectId, "/renew"), { body: { user_id: user.id, user_name: user.name } });
      return ok;
    },
    releaseLock: (projectId, userId) =>
      request("POST", lock(projectId, "/release"), { body: { user_id: userId } }),
    releaseLockKeepalive(projectId, userId) {
      request("POST", lock(projectId, "/release"), { body: { user_id: userId }, keepalive: true }).catch(() => {});
    },

    // ---------------- Musik ----------------
    /** @returns {{ done: Promise<string>, abort: () => void }} done liefert die URL der Datei */
    uploadAudio(file, path, onProgress) {
      const xhr = new XMLHttpRequest();
      const done = new Promise((resolve, reject) => {
        xhr.open("PUT", `/api/choreo/audio/${enc(path)}`);
        if (file.type) xhr.setRequestHeader("content-type", file.type);
        xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
        xhr.onload = () => {
          let data = {};
          try { data = JSON.parse(xhr.responseText); } catch { /* egal */ }
          if (xhr.status >= 200 && xhr.status < 300) resolve(data.url);
          else reject(new RemoteError(xhr.status, data.error || `HTTP ${xhr.status}`));
        };
        xhr.onerror = () => reject(new Error("Netzwerkfehler"));
        xhr.onabort = () => reject(new Error("abgebrochen"));
        xhr.send(file);
      });
      return { done, abort: () => xhr.abort() };
    },
  };
}
