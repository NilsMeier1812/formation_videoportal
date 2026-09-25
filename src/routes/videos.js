import { requireRole } from "../lib/auth.js";
import { HttpError, json, readJson } from "../lib/http.js";
import { presignPut } from "../lib/presign.js";
import { contentTypeFor, extensionFor, optionalDate, optionalText } from "../lib/validate.js";

const UPLOAD_URL_TTL_S = 900; // 15 Minuten

function mediaUrl(env, key) {
  return key ? `${env.MEDIA_BASE_URL}/${key}` : null;
}

/** Was nach außen geht – ohne interne Felder. */
function publicVideo(env, row) {
  return {
    id: row.id,
    title: row.title,
    recorded_at: row.recorded_at,
    camera: row.camera,
    uploaded_by: row.uploaded_by,
    duration_s: row.duration_s,
    size_bytes: row.size_bytes,
    tag_state: row.tag_state,
    created_at: row.created_at,
    // Bis die Abspielfassung da ist, wird das Original abgespielt.
    playback_url: mediaUrl(env, row.play_key ?? row.storage_key),
    thumb_url: mediaUrl(env, row.thumb_key),
    is_processed: Boolean(row.play_key),
  };
}

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

// POST /api/videos – Datensatz anlegen, Upload-URL ausgeben
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

  const title = optionalText(body.title, 200, "Titel");
  const camera = optionalText(body.camera, 50, "Kamera");
  const uploadedBy = optionalText(body.uploaded_by, 50, "Name");
  const recordedAt = optionalDate(body.recorded_at);
  const tagState = body.no_choreo ? "no_tagging" : "untagged";

  if ((await usedBytes(env)) + size > Number(env.QUOTA_BYTES)) {
    throw new HttpError(413, "Speicher voll, bitte alte Videos löschen");
  }

  const id = crypto.randomUUID();
  const storageKey = `raw/${id}.${ext}`;
  await env.DB.prepare(
    `INSERT INTO video (id, storage_key, content_type, title, recorded_at, camera,
                        uploaded_by, size_bytes, file_state, tag_state, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'uploading', ?, ?)`
  )
    .bind(id, storageKey, contentType, title, recordedAt, camera, uploadedBy, size, tagState,
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
  if (row.file_state === "ready") return json(publicVideo(env, row)); // doppelt gemeldet
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
      RETURNING *`
  )
    .bind(obj.size, contentType, id)
    .first();
  if (!updated) throw new HttpError(409, "Video wurde parallel verändert");

  return json(publicVideo(env, updated));
}

// GET /api/videos
export async function listVideos(request, env) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM video
      WHERE file_state = 'ready'
      ORDER BY COALESCE(recorded_at, substr(created_at, 1, 10)) DESC, created_at DESC
      LIMIT 500`
  ).all();
  return json({ videos: results.map((row) => publicVideo(env, row)) });
}

// GET /api/videos/:id
export async function getVideo(request, env, id) {
  const row = await env.DB.prepare(
    "SELECT * FROM video WHERE id = ? AND file_state = 'ready'"
  )
    .bind(id)
    .first();
  if (!row) throw new HttpError(404, "Video nicht gefunden");
  return json(publicVideo(env, row));
}
