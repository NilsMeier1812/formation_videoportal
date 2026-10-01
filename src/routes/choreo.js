// API des Choreo-Planers. Bewusst schlicht und nah an den Tabellen: Der Planer
// arbeitet offline-first mit einem lokalen Spiegel und schickt einzelne
// Änderungen (anlegen, ändern, löschen) – genau das bildet diese API ab.
//
// Lesen: für alle (Training), private Projekte nur mit Trainer-Code.
// Schreiben: nur mit Trainer-Code.
import { hasRole, requireRole, roleFor } from "../lib/auth.js";
import { HttpError, json, readJson } from "../lib/http.js";

/** Welche Spalten die App schreiben darf; alles andere wird ignoriert. */
const TABLES = {
  projects: {
    columns: ["title", "bpm", "time_signature", "audio_url", "grid_offset", "is_private", "created_at", "updated_at"],
    booleans: ["is_private"],
  },
  tempo_sections: {
    columns: ["project_id", "sort_index", "label", "start_sec", "end_sec", "bpm", "time_signature", "offset_sec", "dance_id", "updated_at"],
    order: "start_sec",
  },
  choreo_segments: {
    columns: ["project_id", "timestamp", "label", "notes", "updated_at"],
    order: "timestamp",
  },
  persons: { columns: ["project_id", "number", "name"], order: "number" },
  parts: {
    columns: ["project_id", "sort_index", "label", "start_sec", "end_sec", "group_names"],
    json: ["group_names"],
    order: "start_sec",
  },
  group_memberships: { columns: ["part_id", "person_number", "group_number"] },
  steps: {
    columns: ["project_id", "tempo_section_id", "role", "group_number", "beat_pos", "length_beats", "foot", "value"],
    order: "beat_pos",
  },
};
const CHILD_TABLES = ["tempo_sections", "choreo_segments", "persons", "parts", "steps"];
const LOCK_TIMEOUT_MS = 30000;
const AUDIO_TYPES = { mp3: "audio/mpeg", wav: "audio/wav" };
const MAX_AUDIO_BYTES = 90 * 1024 * 1024; // unter dem 100-MB-Limit für Worker-Anfragen

function tableSpec(table) {
  const spec = TABLES[table];
  if (!spec) throw new HttpError(404, "Unbekannte Tabelle");
  return spec;
}

// ---------------- Zeilen umwandeln ----------------

/** DB-Zeile → JSON für die App (Booleans und JSON-Felder zurückverwandeln, Sperre ausblenden). */
function toApi(table, row) {
  const spec = TABLES[table];
  const out = { ...row };
  delete out.locked_by; // Geräte-ID des Sperr-Inhabers geht niemanden etwas an
  for (const col of spec.booleans || []) out[col] = Boolean(out[col]);
  for (const col of spec.json || []) {
    try { out[col] = out[col] == null ? null : JSON.parse(out[col]); } catch { out[col] = null; }
  }
  return out;
}

/** App-Werte → DB-Werte für die erlaubten Spalten, die im Objekt vorkommen. */
function toDb(table, input) {
  const spec = tableSpec(table);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new HttpError(400, "Ungültige Zeile");
  const values = {};
  for (const col of spec.columns) {
    if (!(col in input)) continue;
    let v = input[col];
    if ((spec.json || []).includes(col)) v = v == null ? null : JSON.stringify(v);
    else if ((spec.booleans || []).includes(col)) v = v ? 1 : 0;
    else if (v !== null && !["string", "number"].includes(typeof v)) throw new HttpError(400, `Ungültiger Wert für ${col}`);
    if (typeof v === "string" && v.length > 20000) throw new HttpError(400, `${col} ist zu lang`);
    values[col] = v;
  }
  return values;
}

function checkId(id) {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new HttpError(400, "Ungültige ID");
  return id;
}

/** Fügt ein oder aktualisiert (upsert=true) eine Zeile – als vorbereitetes Statement. */
function writeStatement(env, table, row, { upsert }) {
  const id = checkId(row.id);
  const values = toDb(table, row);
  if (table === "projects") {
    if (!values.title && !upsert) throw new HttpError(400, "Titel fehlt");
    values.created_at ??= new Date().toISOString();
  }
  const cols = Object.keys(values);
  const placeholders = cols.map(() => "?").join(", ");
  const updatable = cols.filter((c) => c !== "created_at"); // Anlagedatum bleibt beim Ersetzen
  const update = updatable.length ? updatable.map((c) => `${c} = excluded.${c}`).join(", ") : null;
  const sql = `INSERT INTO ${table} (id${cols.length ? ", " + cols.join(", ") : ""})
               VALUES (?${cols.length ? ", " + placeholders : ""})
               ${upsert && update ? `ON CONFLICT(id) DO UPDATE SET ${update}` : ""}`;
  return env.DB.prepare(sql).bind(id, ...cols.map((c) => values[c]));
}

/** SQLite-Constraint-Fehler (Fremdschlüssel, doppelte ID, NOT NULL) → 409 statt 500. */
async function runWrites(fn) {
  try {
    return await fn();
  } catch (err) {
    if (/constraint|FOREIGN KEY|UNIQUE|NOT NULL/i.test(String(err?.message))) {
      throw new HttpError(409, "Passt nicht zu den vorhandenen Daten");
    }
    throw err;
  }
}

// ---------------- Lesen ----------------

async function visibleProject(env, request, id) {
  const project = await env.DB.prepare("SELECT id, is_private FROM projects WHERE id = ?").bind(checkId(id)).first();
  if (!project) throw new HttpError(404, "Projekt nicht gefunden");
  if (project.is_private && !hasRole(await roleFor(request, env), "tagger")) {
    throw new HttpError(404, "Projekt nicht gefunden");
  }
  return project;
}

// GET /api/choreo/projects
export async function listProjects(request, env) {
  const trainer = hasRole(await roleFor(request, env), "tagger");
  const { results } = await env.DB.prepare(
    `SELECT * FROM projects ${trainer ? "" : "WHERE is_private = 0"} ORDER BY created_at DESC`
  ).all();
  return json(results.map((r) => toApi("projects", r)));
}

// GET /api/choreo/projects/:id/:table
export async function listProjectRows(request, env, projectId, table) {
  if (!CHILD_TABLES.includes(table)) throw new HttpError(404, "Unbekannte Tabelle");
  await visibleProject(env, request, projectId);
  const { order } = TABLES[table];
  const { results } = await env.DB.prepare(
    `SELECT * FROM ${table} WHERE project_id = ? ${order ? `ORDER BY ${order}` : ""}`
  ).bind(projectId).all();
  return json(results.map((r) => toApi(table, r)));
}

// GET /api/choreo/group_memberships?part_ids=a,b,c
export async function listMemberships(request, env) {
  const ids = (new URL(request.url).searchParams.get("part_ids") || "").split(",").filter(Boolean);
  if (!ids.length) return json([]);
  if (ids.length > 500) throw new HttpError(400, "Zu viele Abschnitte");
  ids.forEach(checkId);
  const trainer = hasRole(await roleFor(request, env), "tagger");
  const { results } = await env.DB.prepare(
    `SELECT gm.* FROM group_memberships gm
       JOIN parts p ON p.id = gm.part_id
       JOIN projects pr ON pr.id = p.project_id
      WHERE gm.part_id IN (SELECT value FROM json_each(?))
        ${trainer ? "" : "AND pr.is_private = 0"}`
  ).bind(JSON.stringify(ids)).all();
  return json(results);
}

// ---------------- Schreiben (Trainer) ----------------

// POST /api/choreo/:table  – eine Zeile oder ein Array; gibt die angelegten Zeilen zurück
export async function insertRows(request, env, table) {
  await requireRole(request, env, "tagger");
  tableSpec(table);
  const body = await readJson(request);
  const rows = Array.isArray(body) ? body : [body];
  if (!rows.length || rows.length > 1000) throw new HttpError(400, "1 bis 1000 Zeilen");
  for (const row of rows) row.id ??= crypto.randomUUID();
  await runWrites(() => env.DB.batch(rows.map((row) => writeStatement(env, table, row, { upsert: false }))));
  const { results } = await env.DB.prepare(
    `SELECT * FROM ${table} WHERE id IN (SELECT value FROM json_each(?))`
  ).bind(JSON.stringify(rows.map((r) => r.id))).all();
  const created = results.map((r) => toApi(table, r));
  return json(Array.isArray(body) ? created : created[0], 201);
}

// PUT /api/choreo/:table/:id – anlegen oder ersetzen (nachgereichte Offline-Änderungen)
export async function upsertRow(request, env, table, id) {
  await requireRole(request, env, "tagger");
  tableSpec(table);
  const row = { ...(await readJson(request)), id };
  await runWrites(() => writeStatement(env, table, row, { upsert: true }).run());
  return new Response(null, { status: 204 });
}

// PATCH /api/choreo/:table/:id – einzelne Felder ändern
export async function updateRow(request, env, table, id) {
  await requireRole(request, env, "tagger");
  const values = toDb(table, await readJson(request));
  const cols = Object.keys(values);
  if (!cols.length) return new Response(null, { status: 204 });
  const result = await runWrites(() =>
    env.DB.prepare(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`)
      .bind(...cols.map((c) => values[c]), checkId(id)).run()
  );
  if (!result.meta.changes) throw new HttpError(404, "Nicht gefunden");
  return new Response(null, { status: 204 });
}

// DELETE /api/choreo/:table/:id – abhängige Zeilen gehen per Cascade mit
export async function deleteRow(request, env, table, id) {
  await requireRole(request, env, "tagger");
  tableSpec(table);
  await env.DB.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(checkId(id)).run();
  return new Response(null, { status: 204 }); // schon gelöscht ist auch in Ordnung
}

// ---------------- Bearbeitungssperre ----------------

async function lockBody(request) {
  const body = await readJson(request);
  const user = { id: String(body.user_id ?? ""), name: String(body.user_name ?? "").slice(0, 80) };
  if (!user.id || user.id.length > 64) throw new HttpError(400, "Geräte-ID fehlt");
  return user;
}

// POST /api/choreo/projects/:id/lock { user_id, user_name } → { ok, holder }
export async function acquireLock(request, env, projectId) {
  await requireRole(request, env, "tagger");
  const user = await lockBody(request);
  const now = new Date();
  const cutoff = new Date(now.getTime() - LOCK_TIMEOUT_MS).toISOString();
  const taken = await env.DB.prepare(
    `UPDATE projects SET locked_by = ?, locked_by_name = ?, locked_at = ?
      WHERE id = ? AND (locked_by IS NULL OR locked_by = ? OR locked_at < ?)
      RETURNING id`
  ).bind(user.id, user.name, now.toISOString(), checkId(projectId), user.id, cutoff).first();
  if (taken) return json({ ok: true });
  const current = await env.DB.prepare("SELECT locked_by_name FROM projects WHERE id = ?").bind(projectId).first();
  if (!current) throw new HttpError(404, "Projekt nicht gefunden");
  return json({ ok: false, holder: current.locked_by_name || "" });
}

// POST /api/choreo/projects/:id/lock/renew { user_id, user_name } → { ok }
export async function renewLock(request, env, projectId) {
  await requireRole(request, env, "tagger");
  const user = await lockBody(request);
  const renewed = await env.DB.prepare(
    `UPDATE projects SET locked_at = ?, locked_by_name = ?
      WHERE id = ? AND locked_by = ? RETURNING id`
  ).bind(new Date().toISOString(), user.name, checkId(projectId), user.id).first();
  return json({ ok: Boolean(renewed) });
}

// POST /api/choreo/projects/:id/lock/release { user_id }
export async function releaseLock(request, env, projectId) {
  await requireRole(request, env, "tagger");
  const user = await lockBody(request);
  await env.DB.prepare(
    `UPDATE projects SET locked_by = NULL, locked_by_name = NULL, locked_at = NULL
      WHERE id = ? AND locked_by = ?`
  ).bind(checkId(projectId), user.id).run();
  return new Response(null, { status: 204 });
}

// ---------------- Musik ----------------

// PUT /api/choreo/audio/:name – Rohdaten im Body; gibt { url } zurück
export async function uploadAudio(request, env, name) {
  await requireRole(request, env, "tagger");
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (!AUDIO_TYPES[ext]) throw new HttpError(415, "Nur MP3 oder WAV");
  const size = Number(request.headers.get("content-length"));
  if (!size) throw new HttpError(411, "Dateigröße fehlt");
  if (size > MAX_AUDIO_BYTES) throw new HttpError(413, "Datei ist zu groß");
  const file = `${crypto.randomUUID()}.${ext}`;
  await env.BUCKET.put(`audio/${file}`, request.body, { httpMetadata: { contentType: AUDIO_TYPES[ext] } });
  return json({ url: `/api/choreo/audio/${file}` }, 201);
}

// GET /api/choreo/audio/:file – Dateinamen sind eindeutig, also lange cachebar
export async function getAudio(request, env, file) {
  if (!/^[A-Za-z0-9_-]{1,64}\.(mp3|wav)$/.test(file)) throw new HttpError(404, "Nicht gefunden");
  const obj = await env.BUCKET.get(`audio/${file}`);
  if (!obj) throw new HttpError(404, "Nicht gefunden");
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("content-length", String(obj.size));
  headers.set("cache-control", "public, max-age=31536000, immutable");
  return new Response(obj.body, { headers });
}

// ---------------- Audio austauschen / alles verschieben ----------------

const MAX_SHIFT_S = 600;

/**
 * POST /api/choreo/projects/:id/shift { shift_s, audio_url? }
 *
 * Verschiebt alles, was an der Zeit der Musik hängt, um shift_s Sekunden – optional
 * zusammen mit dem Austausch der Audiodatei (neue Datei vorher per PUT /api/choreo/audio).
 * Positiv: vorne ist Musik dazugekommen (z. B. ein Intro); negativ: vorne wurde gekürzt.
 *
 *   Tempo-Abschnitte  Raster-Start, Start und Ende verschoben; ein Abschnitt ab 0 bleibt
 *                     bei einem Intro ab 0 (deckt das Intro mit ab)
 *   Schritte/Notizen  hängen über den Raster-Start an ihrem Abschnitt – wandern mit
 *   Sprungmarken, Gruppen-Abschnitte, Stellen der Videos in dieser Audio
 *
 * Was durch Kürzen vor 0 rutscht, entfällt. Alles in einem Batch (ganz oder gar nicht).
 */
export async function shiftProject(request, env, projectId) {
  await requireRole(request, env, "tagger");
  const body = await readJson(request);
  const shift = Number(body.shift_s ?? 0);
  if (!Number.isFinite(shift) || Math.abs(shift) > MAX_SHIFT_S) throw new HttpError(400, "Versatz ungültig");
  let audioUrl = null;
  if (body.audio_url != null) {
    audioUrl = String(body.audio_url);
    const file = /^\/api\/choreo\/audio\/([A-Za-z0-9_-]{1,64}\.(mp3|wav))$/.exec(audioUrl)?.[1];
    if (!file || !(await env.BUCKET.head(`audio/${file}`))) throw new HttpError(400, "Audiodatei nicht gefunden");
  }
  const project = await env.DB.prepare("SELECT id FROM projects WHERE id = ?").bind(checkId(projectId)).first();
  if (!project) throw new HttpError(404, "Projekt nicht gefunden");
  if (!shift && !audioUrl) return new Response(null, { status: 204 });

  const now = new Date().toISOString();
  const db = env.DB;
  const statements = [];
  if (audioUrl) {
    statements.push(db.prepare("UPDATE projects SET audio_url = ?, updated_at = ? WHERE id = ?").bind(audioUrl, now, projectId));
  }
  if (shift) {
    statements.push(
      // Abschnitte, die beim Kürzen ganz vor 0 landen, fallen weg (ihre Schritte per Cascade)
      db.prepare("DELETE FROM tempo_sections WHERE project_id = ?1 AND end_sec IS NOT NULL AND end_sec + ?2 <= 0")
        .bind(projectId, shift),
      db.prepare(
        `UPDATE tempo_sections
            SET offset_sec = COALESCE(offset_sec, 0) + ?2,
                start_sec = CASE WHEN ?2 > 0 AND COALESCE(start_sec, 0) <= 0.0005 THEN 0
                                 ELSE MAX(0, COALESCE(start_sec, 0) + ?2) END,
                end_sec = CASE WHEN end_sec IS NULL THEN NULL ELSE end_sec + ?2 END,
                updated_at = ?3
          WHERE project_id = ?1`
      ).bind(projectId, shift, now),
      // Schritte, die jetzt vor 0 lägen
      db.prepare(
        `DELETE FROM steps WHERE project_id = ?1 AND EXISTS (
           SELECT 1 FROM tempo_sections t
            WHERE t.id = steps.tempo_section_id
              AND t.offset_sec + steps.beat_pos * 60.0 / COALESCE(NULLIF(t.bpm, 0), 120) < -0.001)`
      ).bind(projectId),
      db.prepare("DELETE FROM choreo_segments WHERE project_id = ?1 AND timestamp + ?2 < 0").bind(projectId, shift),
      db.prepare("UPDATE choreo_segments SET timestamp = timestamp + ?2, updated_at = ?3 WHERE project_id = ?1")
        .bind(projectId, shift, now),
      db.prepare("DELETE FROM parts WHERE project_id = ?1 AND end_sec IS NOT NULL AND end_sec + ?2 <= 0").bind(projectId, shift),
      db.prepare(
        `UPDATE parts SET start_sec = MAX(0, COALESCE(start_sec, 0) + ?2),
                          end_sec = CASE WHEN end_sec IS NULL THEN NULL ELSE end_sec + ?2 END
          WHERE project_id = ?1`
      ).bind(projectId, shift),
      // Stellen der Videos in dieser Audio: wandern mit; ganz vor 0 → Stelle entfällt
      db.prepare(
        `UPDATE video SET audio_project_id = NULL, audio_start_s = NULL, audio_end_s = NULL
          WHERE audio_project_id = ?1 AND audio_end_s + ?2 <= 0`
      ).bind(projectId, shift),
      db.prepare(
        `UPDATE video SET audio_start_s = MAX(0, audio_start_s + ?2), audio_end_s = audio_end_s + ?2
          WHERE audio_project_id = ?1`
      ).bind(projectId, shift),
    );
  }
  await runWrites(() => db.batch(statements));
  return new Response(null, { status: 204 });
}

// ---------------- Aus einer anderen Audio übernehmen ----------------

const IMPORT_KINDS = {
  steps: "DELETE FROM steps WHERE project_id = ? AND role IN ('herren', 'damen')",
  notes: "DELETE FROM steps WHERE project_id = ? AND role = 'note'",
  segments: "DELETE FROM choreo_segments WHERE project_id = ?",
  pairs: ["DELETE FROM persons WHERE project_id = ?", "DELETE FROM parts WHERE project_id = ?"],
};
const IMPORT_TABLES = ["persons", "parts", "group_memberships", "steps", "choreo_segments"];
const MAX_IMPORT_ROWS = 5000;

/**
 * POST /api/choreo/projects/:id/import { clear: ["steps"|"notes"|"segments"|"pairs"], rows: { table: [...] } }
 *
 * Fertig umgerechnete Zeilen (der Planer rechnet Zeiten ins Raster dieser Audio um) in
 * einem Rutsch einfügen; vorher auf Wunsch die vorhandenen derselben Art löschen.
 * Alle Zeilen gehören zu dieser Audio; Gruppen-Zuteilungen nur zu Abschnitten dieser Audio.
 */
export async function importRows(request, env, projectId) {
  await requireRole(request, env, "tagger");
  const body = await readJson(request);
  const project = await env.DB.prepare("SELECT id FROM projects WHERE id = ?").bind(checkId(projectId)).first();
  if (!project) throw new HttpError(404, "Projekt nicht gefunden");

  const clear = Array.isArray(body.clear) ? body.clear : [];
  for (const kind of clear) if (!IMPORT_KINDS[kind]) throw new HttpError(400, "Unbekannte Art");
  const rows = body.rows && typeof body.rows === "object" ? body.rows : {};
  for (const table of Object.keys(rows)) {
    if (!IMPORT_TABLES.includes(table) || !Array.isArray(rows[table])) throw new HttpError(400, "Unbekannte Tabelle");
  }
  const total = IMPORT_TABLES.reduce((n, t) => n + (rows[t]?.length || 0), 0);
  if (total > MAX_IMPORT_ROWS) throw new HttpError(413, "Zu viele Zeilen");

  // Abschnitte, an die Zuteilungen dürfen: die mitgeschickten und (ohne Löschen) die vorhandenen
  const partIds = new Set((rows.parts || []).map((p) => p.id));
  if (!clear.includes("pairs") && rows.group_memberships?.length) {
    const { results } = await env.DB.prepare("SELECT id FROM parts WHERE project_id = ?").bind(projectId).all();
    for (const r of results) partIds.add(r.id);
  }
  // Tempo-Abschnitte dieser Audio (Schritte müssen an einem davon hängen)
  const { results: tempo } = await env.DB.prepare("SELECT id FROM tempo_sections WHERE project_id = ?").bind(projectId).all();
  const tempoIds = new Set(tempo.map((t) => t.id));

  const statements = [];
  for (const kind of clear) {
    for (const sql of [].concat(IMPORT_KINDS[kind])) statements.push(env.DB.prepare(sql).bind(projectId));
  }
  for (const table of IMPORT_TABLES) {
    for (const row of rows[table] || []) {
      row.id ??= crypto.randomUUID();
      if (table === "group_memberships") {
        if (!partIds.has(row.part_id)) throw new HttpError(400, "Zuteilung zu fremdem Abschnitt");
      } else {
        row.project_id = projectId;
      }
      if (table === "steps" && !tempoIds.has(row.tempo_section_id)) throw new HttpError(400, "Schritt ohne Abschnitt dieser Audio");
      statements.push(writeStatement(env, table, row, { upsert: false }));
    }
  }
  if (statements.length) await runWrites(() => env.DB.batch(statements));
  return json({ inserted: total });
}
