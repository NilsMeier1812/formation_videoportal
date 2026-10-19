import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { berlinDay, purgeUsage } from "../src/routes/usage.js";

const BASE = "https://formation.nils-meier.de";
const GROUP = { "x-portal-code": "gruppe-test" };
const TRAINER = { "x-portal-code": "tagger-test" };
const call = (path, { method = "GET", headers = GROUP, body } = {}) =>
  worker.fetch(new Request(BASE + path, {
    method, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }), env);
const ping = (device, headers = GROUP) => call("/api/usage", { method: "POST", headers, body: { device } });

beforeEach(async () => { await env.DB.prepare("DELETE FROM usage_days").run(); });

describe("Nutzung (anonym)", () => {
  it("Berliner Kalendertag", () => {
    expect(berlinDay(Date.parse("2026-10-18T21:30:00Z"))).toBe("2026-10-18"); // 23:30 Sommerzeit
    expect(berlinDay(Date.parse("2026-10-18T22:30:00Z"))).toBe("2026-10-19"); // 00:30
    expect(berlinDay(Date.parse("2026-12-31T23:30:00Z"))).toBe("2027-01-01"); // Winterzeit
  });

  it("zählt Geräte pro Tag und Aufrufe; Trainer getrennt", async () => {
    expect((await ping("geraet-aaaa")).status).toBe(204);
    await ping("geraet-aaaa");
    await ping("geraet-bbbb");
    await ping("geraet-cccc", TRAINER);
    const stats = await (await call("/api/usage?days=7", { headers: TRAINER })).json();
    expect(stats.today).toBe(berlinDay());
    expect(stats.days).toEqual([{ day: stats.today, devices: 3, trainers: 1, opens: 4 }]);
  });

  it("speichert keine Geräte-Kennung im Klartext", async () => {
    await ping("geraet-klartext");
    const { results } = await env.DB.prepare("SELECT device FROM usage_days").all();
    expect(results[0].device).not.toContain("klartext");
    expect(results[0].device).toMatch(/^[0-9a-f]{24}$/);
  });

  it("nur angemeldet zählen, nur Trainer auswerten; Unsinn abgelehnt", async () => {
    expect((await ping("geraet-aaaa", {})).status).toBe(401);
    expect((await call("/api/usage")).status).toBe(401); // Gruppe darf nicht auswerten
    expect((await ping("x")).status).toBe(400);
    expect((await ping("a b c d e f g h")).status).toBe(400);
  });

  it("Cron löscht Tage, die älter als ~1 Jahr sind", async () => {
    await env.DB.prepare("INSERT INTO usage_days (day, device, role) VALUES ('2020-01-01', 'alt', 'group'), (?, 'neu', 'group')")
      .bind(berlinDay()).run();
    expect(await purgeUsage(env)).toBe(1);
    const { results } = await env.DB.prepare("SELECT device FROM usage_days").all();
    expect(results.map((r) => r.device)).toEqual(["neu"]);
  });
});
