import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index.js";

const BASE = "https://formation.nils-meier.de";
const GROUP = { "x-portal-code": "gruppe-test" };
const TRAINER = { "x-portal-code": "tagger-test" };
const call = (path, { method = "GET", headers = TRAINER, body } = {}) => worker.fetch(new Request(BASE + path, {
  method, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined,
}), env);

describe("Training ausblenden", () => {
  it("Trainer blenden einen Tag aus und wieder ein; alle sehen es in der Videoliste", async () => {
    expect((await call("/api/trainings/2026-11-04", { method: "PUT", headers: GROUP, body: { excluded: true } })).status).toBe(401);
    const res = await call("/api/trainings/2026-11-04", { method: "PUT", body: { excluded: true, by: "Nils" } });
    expect((await res.json()).excluded_training_days).toContain("2026-11-04");
    await call("/api/trainings/2026-11-04", { method: "PUT", body: { excluded: true } }); // doppelt egal
    const list = await (await call("/api/videos", { headers: GROUP })).json();
    expect(list.excluded_training_days.filter((d) => d === "2026-11-04")).toHaveLength(1);
    await call("/api/trainings/2026-11-04", { method: "PUT", body: { excluded: false } });
    expect((await (await call("/api/videos", { headers: GROUP })).json()).excluded_training_days).not.toContain("2026-11-04");
  });

  it("ungültige Tage abgelehnt; Planer-Liste ohne Trainingstage", async () => {
    expect((await call("/api/trainings/2026-13-45", { method: "PUT", body: { excluded: true } })).status).toBe(400);
    expect((await call("/api/trainings/heute", { method: "PUT", body: { excluded: true } })).status).toBe(404);
    expect(await (await call("/api/videos?audio=x", { headers: GROUP })).json()).not.toHaveProperty("excluded_training_days");
  });
});
