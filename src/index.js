import { requireRole } from "./lib/auth.js";
import { HttpError, errorResponse, json } from "./lib/http.js";
import { devMedia, devUpload } from "./routes/dev.js";
import * as choreo from "./routes/choreo.js";
import * as library from "./routes/library.js";
import * as session from "./routes/session.js";
import * as videos from "./routes/videos.js";

const ID = "([0-9a-f-]{36})";
const KEY = "([A-Za-z0-9_-]{1,64})"; // IDs im Planer (aus Supabase übernommen oder im Browser erzeugt)
const TABLE = "([a-z_]+)";

// [Methode, Muster, Handler(request, env, ...Gruppen aus dem Muster)]
const routes = [
  ["GET", /^\/api\/auth$/, async (req, env) => json({ role: await requireRole(req, env, "group") })],
  ["GET", /^\/api\/videos$/, videos.listVideos],
  ["POST", /^\/api\/videos$/, videos.createVideo],
  ["POST", /^\/api\/videos\/assign$/, videos.assignVideos],
  ["GET", new RegExp(`^/api/videos/${ID}$`), videos.getVideo],
  ["DELETE", new RegExp(`^/api/videos/${ID}$`), videos.trashVideo],
  ["POST", new RegExp(`^/api/videos/${ID}/complete$`), videos.completeVideo],
  ["PUT", new RegExp(`^/api/videos/${ID}/thumb$`), videos.putThumb],

  // Choreos, Tänze, Audios, Tags
  ["GET", /^\/api\/library$/, library.getLibrary],
  ["POST", /^\/api\/choreos$/, library.createChoreo],
  ["PATCH", new RegExp(`^/api/choreos/${KEY}$`), library.updateChoreo],
  ["DELETE", new RegExp(`^/api/choreos/${KEY}$`), library.deleteChoreo],
  ["POST", new RegExp(`^/api/choreos/${KEY}/dances$`), library.createDance],
  ["PATCH", new RegExp(`^/api/dances/${KEY}$`), library.updateDance],
  ["DELETE", new RegExp(`^/api/dances/${KEY}$`), library.deleteDance],
  ["PUT", new RegExp(`^/api/audios/${KEY}$`), library.assignAudio],
  ["POST", /^\/api\/tags$/, library.createTag],
  ["PATCH", new RegExp(`^/api/tags/${KEY}$`), library.updateTag],
  ["DELETE", new RegExp(`^/api/tags/${KEY}$`), library.deleteTag],

  // Anmelden (Cookie, ein Jahr)
  ["POST", /^\/api\/session$/, session.login],
  ["GET", /^\/api\/session$/, session.current],
  ["DELETE", /^\/api\/session$/, session.logout],

  // Choreo-Planer
  ["GET", /^\/api\/choreo\/projects$/, choreo.listProjects],
  ["GET", new RegExp(`^/api/choreo/projects/${KEY}/${TABLE}$`), choreo.listProjectRows],
  ["GET", /^\/api\/choreo\/group_memberships$/, choreo.listMemberships],
  ["POST", new RegExp(`^/api/choreo/projects/${KEY}/lock$`), choreo.acquireLock],
  ["POST", new RegExp(`^/api/choreo/projects/${KEY}/lock/renew$`), choreo.renewLock],
  ["POST", new RegExp(`^/api/choreo/projects/${KEY}/lock/release$`), choreo.releaseLock],
  ["PUT", /^\/api\/choreo\/audio\/([A-Za-z0-9_.-]+)$/, choreo.uploadAudio],
  ["GET", /^\/api\/choreo\/audio\/([A-Za-z0-9_.-]+)$/, choreo.getAudio],
  ["POST", new RegExp(`^/api/choreo/${TABLE}$`), choreo.insertRows],
  ["PUT", new RegExp(`^/api/choreo/${TABLE}/${KEY}$`), choreo.upsertRow],
  ["PATCH", new RegExp(`^/api/choreo/${TABLE}/${KEY}$`), choreo.updateRow],
  ["DELETE", new RegExp(`^/api/choreo/${TABLE}/${KEY}$`), choreo.deleteRow],
];

const devRoutes = [
  ["PUT", new RegExp(`^/api/dev-upload/${ID}$`), devUpload],
  ["GET", /^\/api\/dev-media\/(.+)$/, devMedia],
];

async function handle(request, env) {
  const { pathname } = new URL(request.url);
  const table = env.DEV_MODE === "1" ? [...routes, ...devRoutes] : routes;

  let pathMatched = false;
  for (const [method, pattern, handler] of table) {
    const match = pattern.exec(pathname);
    if (!match) continue;
    pathMatched = true;
    if (method === request.method || (method === "GET" && request.method === "HEAD")) {
      return handler(request, env, ...match.slice(1).map(decodeURIComponent));
    }
  }
  throw new HttpError(pathMatched ? 405 : 404, pathMatched ? "Methode nicht erlaubt" : "Nicht gefunden");
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (err) {
      if (err instanceof HttpError) return errorResponse(err.status, err.message);
      console.error(err);
      return errorResponse(500, "Interner Fehler");
    }
  },
};
