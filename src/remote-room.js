// Fernsteuerung des Musik-Players: ein „Raum“ für alle Trainer (Durable Object).
//
//   host   der PC an der Anlage („Fernsteuerung erlauben“ im Menü) – spielt die Musik,
//          meldet seinen Stand (Lied, Stelle, läuft/pausiert, Tempo)
//   ctrl   Handys im Modus „Fernsteuern“ – schicken Befehle (Play, Pause, Springen, Lied)
//
// Der Raum leitet nur weiter: Befehle der Handys an den PC, den Stand des PCs an die Handys.
// Es gibt höchstens einen PC: Ein neuer übernimmt, der alte wird mit Code 4001 getrennt.
// WebSockets mit Hibernation – zwischen Nachrichten schläft das Objekt und kostet nichts;
// „ping“ beantwortet Cloudflare selbst, ohne es zu wecken.
import { DurableObject } from "cloudflare:workers";

export const REPLACED = 4001; // anderer PC hat übernommen
const ACTIONS = new Set(["play", "pause", "seek", "open"]);
const MAX_MESSAGE = 2000;

/** Stand des PCs prüfen und auf die bekannten Felder beschränken. */
export function cleanStatus(m) {
  const num = (x) => (Number.isFinite(x) && x >= 0 ? x : 0);
  return {
    type: "status",
    projectId: typeof m.projectId === "string" ? m.projectId.slice(0, 64) : null,
    title: typeof m.title === "string" ? m.title.slice(0, 200) : "",
    time: num(m.time),
    duration: num(m.duration),
    playing: m.playing === true,
    rate: Number.isFinite(m.rate) && m.rate > 0 && m.rate <= 4 ? m.rate : 1,
  };
}

/** Befehl eines Handys prüfen – null, wenn unbrauchbar. */
export function cleanCommand(m) {
  if (!ACTIONS.has(m.action)) return null;
  if (m.action === "seek") return Number.isFinite(m.t) && m.t >= 0 ? { type: "cmd", action: "seek", t: m.t } : null;
  if (m.action === "open") {
    return typeof m.projectId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(m.projectId)
      ? { type: "cmd", action: "open", projectId: m.projectId } : null;
  }
  return { type: "cmd", action: m.action };
}

export class RemoteRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /** Verbindungen einer Rolle, die nicht gerade schließen (optional ohne eine bestimmte). */
  sockets(tag, except = null) {
    return this.ctx.getWebSockets(tag).filter((ws) => ws !== except && ws.readyState !== WebSocket.CLOSING && ws.readyState !== WebSocket.CLOSED);
  }

  send(ws, message) {
    try { ws.send(JSON.stringify(message)); } catch { /* schon zu */ }
  }

  broadcast(tag, message, except = null) {
    for (const ws of this.sockets(tag, except)) this.send(ws, message);
  }

  /** PCs wissen, wie viele Handys gerade steuern. */
  announceControllers(except = null) {
    this.broadcast("host", { type: "ctrls", count: this.sockets("ctrl", except).length }, except);
  }

  async fetch(request) {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket erwartet", { status: 426 });
    }
    const as = new URL(request.url).searchParams.get("as");
    if (as !== "host" && as !== "ctrl") return new Response("as=host|ctrl", { status: 400 });

    const [client, server] = Object.values(new WebSocketPair());
    if (as === "host") {
      for (const old of this.sockets("host")) {
        try { old.close(REPLACED, "Ein anderer PC hat übernommen"); } catch { /* egal */ }
      }
    }
    this.ctx.acceptWebSocket(server, [as]);

    if (as === "host") {
      this.broadcast("ctrl", { type: "host", online: true });
    } else {
      const online = this.sockets("host").length > 0;
      this.send(server, { type: "host", online });
      if (online) this.broadcast("host", { type: "hello" }); // PC meldet gleich seinen Stand
    }
    this.announceControllers();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, data) {
    if (typeof data !== "string" || data.length > MAX_MESSAGE) return;
    let message;
    try { message = JSON.parse(data); } catch { return; }
    if (!message || typeof message !== "object") return;
    const [tag] = this.ctx.getTags(ws);
    if (tag === "host" && message.type === "status") {
      this.broadcast("ctrl", cleanStatus(message));
    } else if (tag === "ctrl" && message.type === "cmd") {
      const command = cleanCommand(message);
      if (command) this.broadcast("host", command);
    }
  }

  async webSocketClose(ws, code) {
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, "bye"); } catch { /* schon zu */ }
    this.left(ws);
  }

  async webSocketError(ws) {
    this.left(ws);
  }

  left(ws) {
    const [tag] = this.ctx.getTags(ws);
    if (tag === "host" && this.sockets("host", ws).length === 0) {
      this.broadcast("ctrl", { type: "host", online: false });
    }
    if (tag === "ctrl") this.announceControllers(ws);
  }
}
