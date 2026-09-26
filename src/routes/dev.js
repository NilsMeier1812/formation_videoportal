// Nur lokal (DEV_MODE=1): Das lokale R2 von `wrangler dev` hat keinen S3-Endpunkt,
// also gibt es keine Presigned URLs. Diese Route ersetzt den direkten Upload nach R2.
// In Produktion antwortet sie mit 404.
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
