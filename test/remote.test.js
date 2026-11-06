import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { cleanCommand, cleanStatus } from "../src/remote-room.js";

const BASE = "https://formation.nils-meier.de";
const TAGGER = { "x-portal-code": "tagger-test" };
const GROUP = { "x-portal-code": "gruppe-test" };

function open(as, headers = TAGGER) {
  return worker.fetch(new Request(`${BASE}/api/remote?as=${as}`, { headers: { ...headers, upgrade: "websocket" } }), env);
}

/** Verbinden und eingehende Nachrichten sammeln. */
async function connect(as) {
  const res = await open(as);
  expect(res.status).toBe(101);
  const ws = res.webSocket;
  const inbox = [];
  const waiters = [];
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    const w = waiters.find((x) => x.match(m));
    if (w) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); } // abgeholt
    else inbox.push(m);
  });
  const closed = new Promise((resolve) => ws.addEventListener("close", (e) => resolve(e.code)));
  ws.accept();
  return {
    ws, inbox, closed,
    send: (m) => ws.send(JSON.stringify(m)),
    /** nächste (oder schon da gewesene, noch nicht abgeholte) Nachricht, die passt */
    next(match) {
      const i = inbox.findIndex(match);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        waiters.push({ match, resolve });
        setTimeout(() => reject(new Error("keine passende Nachricht")), 2000);
      });
    },
  };
}
const type = (t) => (m) => m.type === t;

describe("Fernsteuerung: Zugang", () => {
  it("nur mit Trainer-Code", async () => {
    expect((await open("ctrl", GROUP)).status).toBe(401);
    expect((await open("ctrl", {})).status).toBe(401);
  });
  it("nur als WebSocket und mit bekannter Rolle", async () => {
    const plain = await worker.fetch(new Request(`${BASE}/api/remote?as=ctrl`, { headers: TAGGER }), env);
    expect(plain.status).toBe(426);
    expect((await open("chef")).status).toBe(400);
  });
});

describe("Fernsteuerung: PC ↔ Handy", () => {
  it("Handy steuert, PC meldet seinen Stand", async () => {
    const pc = await connect("host");
    expect((await pc.next(type("ctrls"))).count).toBe(0);

    const phone = await connect("ctrl");
    expect(await phone.next(type("host"))).toEqual({ type: "host", online: true });
    await pc.next(type("hello")); // PC soll gleich seinen Stand schicken
    expect((await pc.next(type("ctrls"))).count).toBe(1);

    pc.send({ type: "status", projectId: "p1", title: "Walzer", time: 12.5, duration: 180, playing: true, rate: 0.9, extra: "weg" });
    expect(await phone.next(type("status"))).toEqual({
      type: "status", projectId: "p1", title: "Walzer", time: 12.5, duration: 180, playing: true, rate: 0.9,
    });

    phone.send({ type: "cmd", action: "pause" });
    expect(await pc.next(type("cmd"))).toEqual({ type: "cmd", action: "pause" });
    phone.send({ type: "cmd", action: "seek", t: 42.25 });
    expect(await pc.next(type("cmd"))).toEqual({ type: "cmd", action: "seek", t: 42.25 });
    phone.send({ type: "cmd", action: "seek", t: -3 }); // unbrauchbar → nicht weiter
    phone.send({ type: "cmd", action: "open", projectId: "p2" });
    expect(await pc.next(type("cmd"))).toEqual({ type: "cmd", action: "open", projectId: "p2" });

    // Handys können keinen Stand vortäuschen, der PC keine Befehle schicken
    phone.send({ type: "status", playing: true });
    pc.send({ type: "cmd", action: "play" });
    await new Promise((r) => setTimeout(r, 100));
    expect(phone.inbox.filter(type("status"))).toEqual([]);
    expect(pc.inbox.filter(type("cmd"))).toEqual([]);

    phone.ws.close(1000);
    expect((await pc.next(type("ctrls"))).count).toBe(0);
    pc.ws.close(1000);
  });

  it("ein neuer PC übernimmt, der alte wird getrennt", async () => {
    const phone = await connect("ctrl");
    const first = await connect("host");
    expect((await phone.next((m) => m.type === "host" && m.online)).online).toBe(true);
    const second = await connect("host");
    expect(await first.closed).toBe(4001);
    phone.send({ type: "cmd", action: "play" });
    expect(await second.next(type("cmd"))).toEqual({ type: "cmd", action: "play" });

    second.ws.close(1000);
    expect(await phone.next((m) => m.type === "host" && !m.online)).toEqual({ type: "host", online: false });
    phone.ws.close(1000);
  });
});

describe("Fernsteuerung: Nachrichten prüfen", () => {
  it("Stand auf bekannte Felder beschränkt", () => {
    expect(cleanStatus({ time: "x", rate: 99, playing: "ja", title: 5 })).toEqual({
      type: "status", projectId: null, title: "", time: 0, duration: 0, playing: false, rate: 1,
    });
  });
  it("nur bekannte Befehle", () => {
    expect(cleanCommand({ action: "delete" })).toBe(null);
    expect(cleanCommand({ action: "seek", t: Infinity })).toBe(null);
    expect(cleanCommand({ action: "open", projectId: "../x" })).toBe(null);
    expect(cleanCommand({ action: "play", t: 5 })).toEqual({ type: "cmd", action: "play" });
  });
});
