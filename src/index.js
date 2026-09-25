import { requireRole } from "./lib/auth.js";
import { HttpError, errorResponse, json } from "./lib/http.js";
import { devMedia, devUpload } from "./routes/dev.js";
import { completeVideo, createVideo, getVideo, listVideos } from "./routes/videos.js";

const ID = "([0-9a-f-]{36})";

// [Methode, Muster, Handler(request, env, ...Gruppen aus dem Muster)]
const routes = [
  ["GET", /^\/api\/auth$/, async (req, env) => json({ role: await requireRole(req, env, "group") })],
  ["GET", /^\/api\/videos$/, listVideos],
  ["POST", /^\/api\/videos$/, createVideo],
  ["GET", new RegExp(`^/api/videos/${ID}$`), getVideo],
  ["POST", new RegExp(`^/api/videos/${ID}/complete$`), completeVideo],
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
