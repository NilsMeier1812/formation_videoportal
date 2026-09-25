// Videos und Vorschaubilder – ausgeliefert vom Worker, nur für Angemeldete.
//
// Früher lagen die Dateien öffentlich unter media.formation.nils-meier.de; wer den
// Link kannte, sah alles. Jetzt prüft der Worker bei jeder Anfrage das Login-Cookie
// (mindestens Nutzer-Code) und streamt dann direkt aus R2. Der Browser schickt das
// Cookie bei <video>/<img> auf derselben Domain automatisch mit.
//
// Unterstützt Range-Anfragen (Springen im Video) und bedingte Anfragen (ETag).
import { requireRole } from "../lib/auth.js";
import { HttpError } from "../lib/http.js";

const KEY = /^(raw|play|thumb)\/[A-Za-z0-9_-]+\.[a-z0-9]{2,4}$/;

// GET /media/<key>
export async function getMedia(request, env, key) {
  await requireRole(request, env, "group");
  if (!KEY.test(key)) throw new HttpError(404, "Nicht gefunden");

  const head = request.method === "HEAD";
  const obj = head
    ? await env.BUCKET.head(key)
    : await env.BUCKET.get(key, { range: request.headers, onlyIf: request.headers });
  if (!obj) throw new HttpError(404, "Nicht gefunden");

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("accept-ranges", "bytes");
  // Nur im Browser des Angemeldeten zwischenspeichern, nie in geteilten Caches
  headers.set("cache-control", "private, max-age=86400");
  headers.set("x-robots-tag", "noindex, nofollow");

  if (head) {
    headers.set("content-length", String(obj.size));
    return new Response(null, { headers });
  }
  // Bedingung (If-None-Match …) erfüllt → kein Inhalt nötig
  if (!("body" in obj)) return new Response(null, { status: 304, headers });

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
