// Videos: Hochladen (Gruppen-Code), Ansehen (alle), Zuordnen und Löschen (Trainer-Code).
import { requireRole } from "../lib/auth.js";
import { HttpError, json, readJson } from "../lib/http.js";
import { presignPut } from "../lib/presign.js";
import {
  contentTypeFor,
  extensionFor,
  idList,
  optionalNumber,
  optionalText,
  optionalTimestamp,
} from "../lib/validate.js";

const UPLOAD_URL_TTL_S = 900; // 15 Minuten
const MAX_THUMB_BYTES = 1024 * 1024;
const MAX_ASSIGN = 100; // Videos pro Zuordnung

function mediaUrl(env, key) {
  return key ? `${env.MEDIA_BASE_URL}/${key}` : null;
}

function idArray(text) {
  try { return JSON.parse(text ?? "[]").filter(Boolean); } catch { return []; }
}

/** Was nach außen geht – ohne interne Felder. */
function publicVideo(env, row) {
  return {
    id: row.id,
    title: row.title,
    recorded_at: row.recorded_at,
    recorded_source: row.recorded_source,
    uploaded_by: row.uploaded_by,
    duration_s: row.duration_s,
    size_bytes: row.size_bytes,
    tag_state: row.tag_state,
    created_at: row.created_at,
    choreo_id: row.choreo_id,
    dance_ids: idArray(row.dance_ids),
    tag_ids: idArray(row.tag_ids),
    // Wurde die Audio gelöscht, gelten die Zeiten nicht mehr
    audio_project_id: row.audio_project_id,
    audio_start_s: row.audio_project_id ? row.audio_start_s : null,
    audio_end_s: row.audio_project_id ? row.audio_end_s : null,
    // Bis die Abspielfassung da ist, wird das Original abgespielt.
    playback_url: mediaUrl(env, row.play_key ?? row.storage_key),
    thumb_url: mediaUrl(env, row.thumb_key),
    is_processed: Boolean(row.play_key),
  };
}

// Tänze und Tags gleich mitliefern (als JSON-Liste)
const SELECT_VIDEO = `
  SELECT v.*,
         (SELECT json_group_array(dance_id) FROM video_dances WHERE video_id = v.id) AS dance_ids,
         (SELECT json_group_array(tag_id) FROM video_tags WHERE video_id = v.id) AS tag_ids
    FROM video v`;

/** Belegter Speicher; `excludeId` nimmt ein Video aus der Summe (für die Nachprüfung in /complete). */
async function usedBytes(env, excludeId = "") {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(size_bytes + COALESCE(play_size_bytes, 0)), 0) AS used
       FROM video
      WHERE file_state != 'missing' AND id != ?`
  )
    .bind(excludeId)
    .first();
  return row.used;
}

// POST /api/videos – Datensatz anlegen, Upload-URL ausgeben.
// Mehr als die Datei braucht es nicht: Aufnahmezeit und Länge liest der Browser aus
// den Metadaten, alles Weitere ordnen die Admins zu.
export async function createVideo(request, env) {
  await requireRole(request, env, "group");
  const body = await readJson(request);

  const size = Number(body.size);
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new HttpError(400, "Dateigröße fehlt");
  }
  if (size > Number(env.MAX_FILE_BYTES)) {
    throw new HttpError(413, "Datei ist zu groß");
  }

  const ext = extensionFor(body.filename);
  const contentType = contentTypeFor(body.content_type, ext);
  if (!contentType) {
    throw new HttpError(415, "Nur Videodateien");
  }

  const uploadedBy = optionalText(body.uploaded_by, 50, "Name");
  const recordedAt = optionalTimestamp(body.recorded_at);
  const recordedSource = recordedAt && ["meta", "file"].includes(body.recorded_source) ? body.recorded_source : null;
  const duration = optionalNumber(body.duration_s, 0, 24 * 3600, "Länge");

  if ((await usedBytes(env)) + size > Number(env.QUOTA_BYTES)) {
    throw new HttpError(413, "Speicher voll, bitte alte Videos löschen");
  }

  const id = crypto.randomUUID();
  const storageKey = `raw/${id}.${ext}`;
  await env.DB.prepare(
    `INSERT INTO video (id, storage_key, content_type, recorded_at, recorded_source, duration_s,
                        uploaded_by, size_bytes, file_state, tag_state, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'uploading', 'untagged', ?)`
  )
    .bind(id, storageKey, contentType, recordedAt, recordedSource, duration, uploadedBy, size,
      new Date().toISOString())
    .run();

  // Lokal relativ: `wrangler dev` schreibt den Host auf die Produktionsdomain um.
  const url =
    env.DEV_MODE === "1"
      ? `/api/dev-upload/${id}`
      : await presignPut(env, storageKey, UPLOAD_URL_TTL_S);

  return json(
    { id, upload: { method: "PUT", url, headers: { "content-type": contentType } } },
    201
  );
}

// POST /api/videos/:id/complete – erst hier wird wirklich geprüft
export async function completeVideo(request, env, id) {
  await requireRole(request, env, "group");

  const row = await env.DB.prepare("SELECT * FROM video WHERE id = ?").bind(id).first();
  if (!row) throw new HttpError(404, "Video nicht gefunden");
  if (row.file_state === "ready") return json(await loadVideo(env, id)); // doppelt gemeldet
  if (row.file_state !== "uploading") throw new HttpError(409, "Video ist nicht im Upload");

  const obj = await env.BUCKET.head(row.storage_key);
  if (!obj) throw new HttpError(409, "Datei ist nicht angekommen");

  const contentType = obj.httpMetadata?.contentType ?? "";
  const reject = async (status, message) => {
    await env.BUCKET.delete(row.storage_key);
    await env.DB.prepare("DELETE FROM video WHERE id = ?").bind(id).run();
    throw new HttpError(status, message);
  };
  if (obj.size > Number(env.MAX_FILE_BYTES)) await reject(413, "Datei ist zu groß");
  if (!contentType.startsWith("video/")) await reject(415, "Nur Videodateien");
  // Die angegebene Größe war nur eine Absichtserklärung – mit der echten nachprüfen.
  if (obj.size > row.size_bytes && (await usedBytes(env, id)) + obj.size > Number(env.QUOTA_BYTES)) {
    await reject(413, "Speicher voll, bitte alte Videos löschen");
  }

  // processing='pending': sobald der Workflow existiert (Phase 3), holt der Cron auch
  // die bis dahin hochgeladenen Videos nach.
  const updated = await env.DB.prepare(
    `UPDATE video
        SET file_state = 'ready', size_bytes = ?, content_type = ?, processing = 'pending'
      WHERE id = ? AND file_state = 'uploading'
      RETURNING id`
  )
    .bind(obj.size, contentType, id)
    .first();
  if (!updated) throw new HttpError(409, "Video wurde parallel verändert");

  return json(await loadVideo(env, id));
}

// PUT /api/videos/:id/thumb – Vorschaubild (JPEG), vom Browser beim Hochladen erzeugt.
// Nur einmal: ein vorhandenes Bild wird nicht überschrieben.
export async function putThumb(request, env, id) {
  await requireRole(request, env, "group");
  if (request.headers.get("content-type") !== "image/jpeg") throw new HttpError(415, "Nur JPEG");
  const length = Number(request.headers.get("content-length"));
  if (length > MAX_THUMB_BYTES) throw new HttpError(413, "Bild ist zu groß");

  const row = await env.DB.prepare(
    "SELECT thumb_key FROM video WHERE id = ? AND file_state IN ('uploading', 'ready')"
  ).bind(id).first();
  if (!row) throw new HttpError(404, "Video nicht gefunden");
  if (row.thumb_key) throw new HttpError(409, "Vorschaubild gibt es schon");

  const bytes = await request.arrayBuffer();
  if (!bytes.byteLength || bytes.byteLength > MAX_THUMB_BYTES) throw new HttpError(413, "Bild ist zu groß");
  const view = new Uint8Array(bytes);
  if (view[0] !== 0xff || view[1] !== 0xd8) throw new HttpError(415, "Nur JPEG");

  const key = `thumb/${id}.jpg`;
  await env.BUCKET.put(key, bytes, { httpMetadata: { contentType: "image/jpeg" } });
  await env.DB.prepare("UPDATE video SET thumb_key = ? WHERE id = ? AND thumb_key IS NULL").bind(key, id).run();
  return json({ thumb_url: mediaUrl(env, key) });
}

async function loadVideo(env, id) {
  const row = await env.DB.prepare(`${SELECT_VIDEO} WHERE v.id = ?`).bind(id).first();
  return row && publicVideo(env, row);
}

// GET /api/videos – alle fertigen Videos, neueste Aufnahme zuerst
export async function listVideos(request, env) {
  const { results } = await env.DB.prepare(
    `${SELECT_VIDEO}
      WHERE v.file_state = 'ready' AND v.deleted_at IS NULL
      ORDER BY COALESCE(v.recorded_at, v.created_at) DESC, v.created_at DESC
      LIMIT 2000`
  ).all();
  return json({ videos: results.map((row) => publicVideo(env, row)) });
}

// GET /api/videos/:id
export async function getVideo(request, env, id) {
  const row = await env.DB.prepare(
    `${SELECT_VIDEO} WHERE v.id = ? AND v.file_state = 'ready' AND v.deleted_at IS NULL`
  )
    .bind(id)
    .first();
  if (!row) throw new HttpError(404, "Video nicht gefunden");
  return json(publicVideo(env, row));
}

// ---------------- Zuordnen (Trainer) ----------------

/**
 * POST /api/videos/assign – ein oder mehrere Videos auf einmal zuordnen.
 * Body: { ids: [...], changes: { choreo_id, dance_ids, tag_ids, audio, title, recorded_at, tag_state } }
 * Geändert wird nur, was in `changes` steht. `audio` ist { project_id, start_s, end_s } oder null.
 */
export async function assignVideos(request, env) {
  await requireRole(request, env, "tagger");
  const body = await readJson(request);
  const ids = idList(body.ids, "Videos", MAX_ASSIGN);
  if (!ids.length) throw new HttpError(400, "Keine Videos gewählt");
  const changes = body.changes && typeof body.changes === "object" ? body.changes : {};

  const marks = ids.map(() => "?").join(", ");
  const { results: videos } = await env.DB.prepare(
    `SELECT id, choreo_id FROM video WHERE id IN (${marks}) AND deleted_at IS NULL`
  ).bind(...ids).all();
  if (videos.length !== ids.length) throw new HttpError(404, "Video nicht gefunden");

  const set = {};
  if ("choreo_id" in changes) {
    set.choreo_id = changes.choreo_id || null;
    if (set.choreo_id && !(await env.DB.prepare("SELECT 1 FROM choreos WHERE id = ?").bind(set.choreo_id).first())) {
      throw new HttpError(400, "Choreo gibt es nicht");
    }
  }
  // Tänze und Audio müssen zur Choreo passen, die das Video danach hat
  const choreoAfter = "choreo_id" in set ? [set.choreo_id] : [...new Set(videos.map((v) => v.choreo_id))];

  let danceIds = null;
  if ("dance_ids" in changes) {
    danceIds = idList(changes.dance_ids, "Tänze");
    if (danceIds.length) {
      if (choreoAfter.length !== 1 || !choreoAfter[0]) throw new HttpError(400, "Tänze gibt es nur mit einer Choreo");
      const { results } = await env.DB.prepare(
        `SELECT id FROM dances WHERE choreo_id = ? AND id IN (${danceIds.map(() => "?").join(", ")})`
      ).bind(choreoAfter[0], ...danceIds).all();
      if (results.length !== danceIds.length) throw new HttpError(400, "Tanz gehört nicht zur Choreo");
    }
  } else if ("choreo_id" in set) {
    danceIds = null; // Tänze einer anderen Choreo werden unten entfernt
  }

  let tagIds = null;
  if ("tag_ids" in changes) {
    tagIds = idList(changes.tag_ids, "Tags");
    if (tagIds.length) {
      const { results } = await env.DB.prepare(
        `SELECT id FROM tags WHERE id IN (${tagIds.map(() => "?").join(", ")})`
      ).bind(...tagIds).all();
      if (results.length !== tagIds.length) throw new HttpError(400, "Tag gibt es nicht");
    }
  }

  if ("audio" in changes) {
    const audio = changes.audio;
    if (audio === null) {
      Object.assign(set, { audio_project_id: null, audio_start_s: null, audio_end_s: null });
    } else {
      const start = optionalNumber(audio?.start_s, 0, 24 * 3600, "Start");
      const end = optionalNumber(audio?.end_s, 0, 24 * 3600, "Ende");
      if (start === null || end === null || start >= end) throw new HttpError(400, "Start muss vor dem Ende liegen");
      const project = await env.DB.prepare("SELECT id, choreo_id FROM projects WHERE id = ?")
        .bind(String(audio.project_id ?? "")).first();
      if (!project) throw new HttpError(400, "Audio gibt es nicht");
      if (choreoAfter.some((c) => c && c !== project.choreo_id)) throw new HttpError(400, "Audio gehört nicht zur Choreo");
      Object.assign(set, { audio_project_id: project.id, audio_start_s: start, audio_end_s: end });
    }
  }
  if ("title" in changes) set.title = optionalText(changes.title, 200, "Titel");
  if ("recorded_at" in changes) {
    set.recorded_at = optionalTimestamp(changes.recorded_at);
    set.recorded_source = set.recorded_at ? "manual" : null;
  }
  if ("tag_state" in changes) {
    if (!["untagged", "tagged"].includes(changes.tag_state)) throw new HttpError(400, "Ungültiger Status");
    set.tag_state = changes.tag_state;
    if (set.tag_state === "tagged") {
      set.tagged_at = new Date().toISOString();
      set.tagged_by = optionalText(changes.tagged_by, 50, "Name");
    }
  }

  const statements = [];
  const cols = Object.keys(set);
  if (cols.length) {
    statements.push(env.DB.prepare(
      `UPDATE video SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id IN (${marks})`
    ).bind(...cols.map((c) => set[c]), ...ids));
  }
  if (danceIds) {
    statements.push(env.DB.prepare(`DELETE FROM video_dances WHERE video_id IN (${marks})`).bind(...ids));
    for (const id of ids) for (const d of danceIds) {
      statements.push(env.DB.prepare("INSERT INTO video_dances (video_id, dance_id) VALUES (?, ?)").bind(id, d));
    }
  } else if ("choreo_id" in set) {
    statements.push(env.DB.prepare(
      `DELETE FROM video_dances WHERE video_id IN (${marks})
         AND dance_id NOT IN (SELECT id FROM dances WHERE choreo_id IS ?)`
    ).bind(...ids, set.choreo_id));
  }
  if (tagIds) {
    statements.push(env.DB.prepare(`DELETE FROM video_tags WHERE video_id IN (${marks})`).bind(...ids));
    for (const id of ids) for (const t of tagIds) {
      statements.push(env.DB.prepare("INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)").bind(id, t));
    }
  }
  if (statements.length) await env.DB.batch(statements);

  const { results } = await env.DB.prepare(`${SELECT_VIDEO} WHERE v.id IN (${marks})`).bind(...ids).all();
  return json({ videos: results.map((row) => publicVideo(env, row)) });
}

// DELETE /api/videos/:id – in den Papierkorb (die Datei bleibt vorerst in R2)
export async function trashVideo(request, env, id) {
  await requireRole(request, env, "tagger");
  const row = await env.DB.prepare(
    `UPDATE video SET file_state = 'trashed', deleted_at = ?
      WHERE id = ? AND deleted_at IS NULL RETURNING id`
  ).bind(new Date().toISOString(), id).first();
  if (!row) throw new HttpError(404, "Video nicht gefunden");
  return new Response(null, { status: 204 });
}

// ---------------- Papierkorb und Speicher (Trainer) ----------------

export const TRASH_DAYS = 30; // danach löscht der tägliche Aufräum-Job endgültig

// GET /api/videos/trash – was im Papierkorb liegt, zuletzt gelöschtes zuerst
export async function listTrash(request, env) {
  await requireRole(request, env, "tagger");
  const { results } = await env.DB.prepare(
    `${SELECT_VIDEO} WHERE v.deleted_at IS NOT NULL ORDER BY v.deleted_at DESC LIMIT 500`
  ).all();
  return json({
    days: TRASH_DAYS,
    videos: results.map((row) => ({ ...publicVideo(env, row), deleted_at: row.deleted_at })),
  });
}

// POST /api/videos/:id/restore – aus dem Papierkorb zurückholen
export async function restoreVideo(request, env, id) {
  await requireRole(request, env, "tagger");
  const row = await env.DB.prepare(
    `UPDATE video SET file_state = 'ready', deleted_at = NULL
      WHERE id = ? AND deleted_at IS NOT NULL RETURNING id`
  ).bind(id).first();
  if (!row) throw new HttpError(404, "Nicht im Papierkorb");
  return json(await loadVideo(env, id));
}

// GET /api/storage – belegter Speicher (Originale + Abspielfassungen) und Anzahlen
export async function storageInfo(request, env) {
  await requireRole(request, env, "tagger");
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(size_bytes + COALESCE(play_size_bytes, 0)), 0) AS used,
            COALESCE(SUM(CASE WHEN deleted_at IS NOT NULL THEN size_bytes + COALESCE(play_size_bytes, 0) END), 0) AS trash_bytes,
            COUNT(CASE WHEN file_state = 'ready' THEN 1 END) AS videos,
            COUNT(CASE WHEN deleted_at IS NOT NULL THEN 1 END) AS trashed,
            COUNT(CASE WHEN file_state = 'ready' AND tag_state = 'untagged' THEN 1 END) AS untagged
       FROM video WHERE file_state != 'missing'`
  ).first();
  return json({ ...row, quota: Number(env.QUOTA_BYTES), max_file: Number(env.MAX_FILE_BYTES) });
}
