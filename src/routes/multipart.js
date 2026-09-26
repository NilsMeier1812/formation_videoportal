// Upload in Teilen (Multipart) für große Videos: Bricht die Verbindung in der Halle ab,
// muss nur der eine Teil neu, nicht die ganze Datei. Der Browser merkt sich die fertigen
// Teile und setzt nach erneuter Auswahl derselben Datei dort fort.
//
//   POST /api/videos          → { upload: { multipart: true, part_size, parts } }
//   POST /api/videos/:id/parts { numbers: [1, 2, …] } → Presigned URLs je Teil (1 h gültig)
//   (Browser lädt die Teile direkt nach R2, liest das ETag aus der Antwort)
//   POST /api/videos/:id/complete { parts: [{ partNumber, etag }] } → zusammensetzen, prüfen
//
// Lokal (DEV_MODE=1, kein S3-Endpunkt) läuft alles über das R2-Binding und
// /api/dev-upload/:id/part/:n.
import { requireRole } from "../lib/auth.js";
import { HttpError, json, readJson } from "../lib/http.js";
import { abortMultipart, completeMultipart, createMultipart, presignPut } from "../lib/presign.js";

export const PART_SIZE = 10 * 1024 * 1024; // 10 MiB (R2: mindestens 5 MiB außer dem letzten Teil)
export const MULTIPART_FROM = 32 * 1024 * 1024; // kleinere Dateien in einem Stück
const PART_URL_TTL_S = 3600;
const MAX_URLS = 50; // pro Anfrage

const dev = (env) => env.DEV_MODE === "1";
const unquote = (etag) => String(etag).replace(/"/g, "");

export function partCount(size) {
  return Math.ceil(size / PART_SIZE);
}

export async function startMultipart(env, key, contentType) {
  if (dev(env)) {
    const upload = await env.BUCKET.createMultipartUpload(key, { httpMetadata: { contentType } });
    return upload.uploadId;
  }
  return createMultipart(env, key, contentType);
}

/** Teile zusammensetzen; `parts` wird vorher geprüft (lückenlos 1..n, ETags). */
export async function finishMultipart(env, key, uploadId, parts, expected) {
  if (!Array.isArray(parts) || parts.length !== expected) throw new HttpError(400, "Es fehlen Teile");
  const clean = parts
    .map((p) => ({ partNumber: Number(p?.partNumber), etag: unquote(p?.etag ?? "") }))
    .sort((a, b) => a.partNumber - b.partNumber);
  clean.forEach((p, i) => {
    if (p.partNumber !== i + 1 || !/^[A-Za-z0-9_-]{1,512}$/.test(p.etag)) throw new HttpError(400, "Ungültige Teile");
  });
  if (dev(env)) {
    await env.BUCKET.resumeMultipartUpload(key, uploadId).complete(clean);
  } else {
    await completeMultipart(env, key, uploadId, clean);
  }
}

export async function abortUpload(env, key, uploadId) {
  try {
    if (dev(env)) await env.BUCKET.resumeMultipartUpload(key, uploadId).abort();
    else await abortMultipart(env, key, uploadId);
  } catch { /* schon weg – egal */ }
}

async function openUpload(env, id) {
  const row = await env.DB.prepare(
    "SELECT storage_key, size_bytes, multipart_upload_id FROM video WHERE id = ? AND file_state = 'uploading'"
  ).bind(id).first();
  if (!row?.multipart_upload_id) throw new HttpError(404, "Kein offener Upload");
  return row;
}

// POST /api/videos/:id/parts { numbers }
export async function partUrls(request, env, id) {
  await requireRole(request, env, "group");
  const row = await openUpload(env, id);
  const { numbers } = await readJson(request);
  const total = partCount(row.size_bytes);
  if (!Array.isArray(numbers) || !numbers.length || numbers.length > MAX_URLS) throw new HttpError(400, "Teilnummern fehlen");
  const urls = [];
  for (const n of numbers) {
    if (!Number.isInteger(n) || n < 1 || n > total) throw new HttpError(400, "Ungültige Teilnummer");
    urls.push({
      n,
      url: dev(env)
        ? `/api/dev-upload/${id}/part/${n}`
        : await presignPut(env, row.storage_key, PART_URL_TTL_S, { partNumber: String(n), uploadId: row.multipart_upload_id }),
    });
  }
  return json({ urls });
}

// PUT /api/dev-upload/:id/part/:n – nur lokal: ein Teil über das Binding
export async function devUploadPart(request, env, id, n) {
  const row = await openUpload(env, id);
  const part = await env.BUCKET.resumeMultipartUpload(row.storage_key, row.multipart_upload_id)
    .uploadPart(Number(n), await request.arrayBuffer());
  return new Response(null, { status: 200, headers: { etag: `"${part.etag}"`, "access-control-expose-headers": "ETag" } });
}
