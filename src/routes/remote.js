// GET /api/remote?as=host|ctrl – WebSocket zur Fernsteuerung (nur Trainer), siehe remote-room.js.
import { requireRole } from "../lib/auth.js";
import { HttpError } from "../lib/http.js";

export async function connectRemote(request, env) {
  await requireRole(request, env, "tagger");
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") throw new HttpError(426, "WebSocket erwartet");
  const as = new URL(request.url).searchParams.get("as");
  if (as !== "host" && as !== "ctrl") throw new HttpError(400, "Ungültige Rolle");
  // Ein Raum für alle Trainer (alle teilen sich den Trainer-Code)
  const room = env.REMOTE.get(env.REMOTE.idFromName("trainer"));
  return room.fetch(request);
}
