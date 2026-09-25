// Nur lokal (DEV_MODE=1): Das lokale R2 von `wrangler dev` hat keinen S3-Endpunkt,
// also gibt es keine Presigned URLs und keine Media-Domain. Diese beiden Routen
// ersetzen sie. In Produktion antworten sie mit 404.
import { HttpError } from "../lib/http.js";

// PUT /api/dev-upload/:id – ersetzt den direkten PUT nach R2
export async function devUpload(request, env, id) {
  const row = await env.DB.prepare(
    "SELECT storage_key FROM video WHERE id = ? AND file_state = 'uploading'"
  )
    .bind(id)
    .first();
  if (!row) throw new HttpError(404, "Kein offener Upload");
  await env.BUCKET.put(row.storage_key, request.body, {
    httpMetadata: { contentType: request.headers.get("content-type") ?? undefined },
  });
  return new Response(null, { status: 200 });
}

// GET /api/dev-media/<key> – ersetzt media.formation.nils-meier.de, mit Range für das Springen im Video
export async function devMedia(request, env, key) {
  const obj = await env.BUCKET.get(key, { range: request.headers });
  if (!obj) return new Response("Nicht gefunden", { status: 404 });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("accept-ranges", "bytes");

  if (obj.range && request.headers.has("range")) {
    const { suffix } = obj.range;
    const offset = suffix !== undefined ? obj.size - suffix : (obj.range.offset ?? 0);
    const length = suffix !== undefined ? suffix : (obj.range.length ?? obj.size - offset);
    headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${obj.size}`);
    headers.set("content-length", String(length));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set("content-length", String(obj.size));
  return new Response(obj.body, { headers });
}
