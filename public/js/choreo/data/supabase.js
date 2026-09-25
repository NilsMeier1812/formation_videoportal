// Einzige Stelle, die Supabase kennt. In Schritt B wird diese Datei durch einen
// Adapter für die eigene Worker-API ersetzt – mit denselben Funktionen, sodass
// der Rest des Planers davon nichts merkt.
//
// Supabase selbst kommt als klassisches Skript (/vendor/supabase.umd.js) und
// stellt `window.supabase` bereit.
import {
  EDITOR_EMAIL,
  LOCK_TIMEOUT_MS,
  STORAGE_BUCKET,
  SUPABASE_ANON_KEY,
  SUPABASE_URL,
} from "../config.js";

/**
 * Lesen ohne automatische Wiederholung: supabase-js versucht fehlgeschlagene
 * GETs sonst bis zu dreimal mit Wartezeit (1 + 2 + 4 s). Ohne Netz dauerte das
 * Öffnen eines Projekts dadurch über 40 Sekunden. Der Rückfall ist hier der
 * lokale Spiegel – der ist sofort da.
 */
const read = (query) => query.retry(false);

/** Supabase meldet Fehler im Rückgabewert statt zu werfen – hier wird geworfen. */
function unwrap({ data, error }) {
  if (error) throw error;
  return data;
}

export function createSupabaseRemote() {
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  // Für Roh-fetch/XHR: anon (nur Lesen) oder das JWT des angemeldeten Editors.
  let accessToken = SUPABASE_ANON_KEY;
  const useSession = (session) => {
    accessToken = session?.access_token || SUPABASE_ANON_KEY;
    return Boolean(session);
  };
  const restHeaders = () => ({
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  });
  const patchKeepalive = (query, body) =>
    fetch(`${SUPABASE_URL}/rest/v1/${query}`, {
      method: "PATCH",
      keepalive: true,
      headers: { ...restHeaders(), Prefer: "return=minimal" },
      body: JSON.stringify(body),
    });

  return {
    // ---------------- Anmeldung ----------------
    /** Stellt eine gespeicherte Sitzung wieder her; true = Editor. */
    async restoreSession() {
      try {
        const { data } = await sb.auth.getSession();
        return useSession(data?.session);
      } catch {
        return false; // offline o. ä. → Lese-Modus
      }
    },
    /** Meldet Login, Logout und Token-Erneuerung. */
    onAuthChange(callback) {
      sb.auth.onAuthStateChange((_event, session) => callback(useSession(session)));
    },
    async login(password) {
      unwrap(await sb.auth.signInWithPassword({ email: EDITOR_EMAIL, password }));
    },
    async logout() {
      try { await sb.auth.signOut(); } catch { /* egal */ }
      useSession(null);
    },
    /** Prüft das Passwort erneut (Bestätigung vor dem Löschen). */
    async verifyPassword(password) {
      const { error } = await sb.auth.signInWithPassword({ email: EDITOR_EMAIL, password });
      return !error;
    },

    // ---------------- Lesen ----------------
    async listProjects() {
      return unwrap(await read(sb.from("projects").select("*").order("created_at", { ascending: false }))) || [];
    },
    async listByProject(table, projectId, orderBy) {
      let query = sb.from(table).select("*").eq("project_id", projectId);
      if (orderBy) query = query.order(orderBy);
      return unwrap(await read(query)) || [];
    },
    async listMemberships(partIds) {
      if (!partIds.length) return [];
      return unwrap(await read(sb.from("group_memberships").select("*").in("part_id", partIds))) || [];
    },

    // ---------------- Schreiben ----------------
    /** Eine Zeile oder ein Array von Zeilen. */
    async insert(table, rows) {
      unwrap(await sb.from(table).insert(rows));
    },
    async upsert(table, row) {
      unwrap(await sb.from(table).upsert(row));
    },
    async update(table, id, patch) {
      unwrap(await sb.from(table).update(patch).eq("id", id));
    },
    async remove(table, id) {
      unwrap(await sb.from(table).delete().eq("id", id));
    },
    /** Wie update, übersteht aber das Schließen der Seite. */
    updateKeepalive(table, id, patch) {
      return patchKeepalive(`${table}?id=eq.${encodeURIComponent(id)}`, patch);
    },
    async createProject(row) {
      return unwrap(await sb.from("projects").insert(row).select().single());
    },

    // ---------------- Bearbeitungssperre ----------------
    /** @returns {Promise<{ok: boolean, holder?: string}>} */
    async acquireLock(projectId, user) {
      const cutoff = new Date(Date.now() - LOCK_TIMEOUT_MS).toISOString();
      const rows = unwrap(
        await sb.from("projects")
          .update({ locked_by: user.id, locked_by_name: user.name, locked_at: new Date().toISOString() })
          .eq("id", projectId)
          .or(`locked_by.is.null,locked_by.eq.${user.id},locked_at.lt.${cutoff}`)
          .select()
      );
      if (rows?.length) return { ok: true };
      const { data } = await sb.from("projects").select("locked_by_name").eq("id", projectId).single();
      return { ok: false, holder: data?.locked_by_name || "" };
    },
    /** Erneuert die eigene Sperre. false = sie gehört inzwischen jemand anderem. Wirft bei Netzfehlern. */
    async renewLock(projectId, user) {
      const rows = unwrap(
        await sb.from("projects")
          .update({ locked_at: new Date().toISOString(), locked_by_name: user.name })
          .eq("id", projectId)
          .eq("locked_by", user.id)
          .select()
      );
      return Boolean(rows?.length);
    },
    async releaseLock(projectId, userId) {
      await sb.from("projects")
        .update({ locked_by: null, locked_by_name: null, locked_at: null })
        .eq("id", projectId)
        .eq("locked_by", userId);
    },
    releaseLockKeepalive(projectId, userId) {
      patchKeepalive(
        `projects?id=eq.${encodeURIComponent(projectId)}&locked_by=eq.${encodeURIComponent(userId)}`,
        { locked_by: null, locked_by_name: null, locked_at: null }
      ).catch(() => {});
    },

    // ---------------- Audio ----------------
    /**
     * Lädt eine Audiodatei hoch.
     * @returns {{ done: Promise<string>, abort: () => void }} done liefert die öffentliche URL
     */
    uploadAudio(file, path, onProgress) {
      const xhr = new XMLHttpRequest();
      const done = new Promise((resolve, reject) => {
        xhr.open("POST", `${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${path}`);
        xhr.setRequestHeader("Authorization", `Bearer ${accessToken}`); // JWT des Editors (RLS)
        xhr.setRequestHeader("apikey", SUPABASE_ANON_KEY);
        xhr.setRequestHeader("x-upsert", "true");
        xhr.setRequestHeader("cache-control", "3600");
        if (file.type) xhr.setRequestHeader("content-type", file.type);
        xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
        xhr.onload = () =>
          xhr.status >= 200 && xhr.status < 300
            ? resolve(`${SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/${path}`)
            : reject(new Error(`HTTP ${xhr.status} ${xhr.responseText || ""}`.trim()));
        xhr.onerror = () => reject(new Error("Netzwerkfehler"));
        xhr.onabort = () => reject(new Error("abgebrochen"));
        xhr.send(file);
      });
      return { done, abort: () => xhr.abort() };
    },
  };
}
