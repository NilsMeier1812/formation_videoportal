import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { cleanupUploads, CRON, purgeTrash, runScheduled } from "../src/cron.js";
import worker from "../src/index.js";

const BASE = "https://formation.nils-meier.de";
const TRAINER = { "x-portal-code": "tagger-test" };
const GROUP = { "x-portal-code": "gruppe-test" };
const DAY = 24 * 3600 * 1000;
const uid = () => crypto.randomUUID();

const call = (path, { method = "GET", headers = TRAINER } = {}) =>
  worker.fetch(new Request(BASE + path, { method, headers }), env);

async function video({ state = "ready", created = new Date().toISOString(), deleted = null, play = false } = {}) {
  const id = uid();
  const raw = `raw/${id}.mp4`;
  await env.BUCKET.put(raw, "original");
  if (play) await env.BUCKET.put(`play/${id}.mp4`, "abspiel");
  await env.DB.prepare(
    `INSERT INTO video (id, storage_key, play_key, size_bytes, file_state, tag_state, created_at, deleted_at)
     VALUES (?, ?, ?, 8, ?, 'untagged', ?, ?)`
  ).bind(id, raw, play ? `play/${id}.mp4` : null, state, created, deleted).run();
  return { id, raw };
}
const row = (id) => env.DB.prepare("SELECT * FROM video WHERE id = ?").bind(id).first();

describe("Papierkorb", () => {
  it("zeigt gelöschte Videos und holt sie zurück (nur Trainer)", async () => {
    const { id } = await video();
    await call(`/api/videos/${id}`, { method: "DELETE" });
    expect((await call("/api/videos/trash", { headers: GROUP })).status).toBe(401);
    const trash = await (await call("/api/videos/trash")).json();
    expect(trash.days).toBe(30);
    expect(trash.videos.map((v) => v.id)).toContain(id);
    expect(trash.videos.find((v) => v.id === id).deleted_at).toBeTruthy();

    expect((await call(`/api/videos/${id}/restore`, { method: "POST" })).status).toBe(200);
    expect(await row(id)).toMatchObject({ file_state: "ready", deleted_at: null });
    expect((await call(`/api/videos/${id}`)).status).toBe(200);
    expect((await call(`/api/videos/${id}/restore`, { method: "POST" })).status).toBe(404);
  });

  it("zeigt den belegten Speicher", async () => {
    const info = await (await call("/api/storage")).json();
    expect(info.quota).toBe(200_000_000_000);
    expect(info.used).toBeGreaterThanOrEqual(0);
    expect(info).toHaveProperty("trashed");
    expect((await call("/api/storage", { headers: GROUP })).status).toBe(401);
  });
});

describe("Aufräumen per Cron", () => {
  it("entfernt Uploads, die seit über 24 h hängen – frische bleiben", async () => {
    const now = Date.now();
    const alt = await video({ state: "uploading", created: new Date(now - 2 * DAY).toISOString() });
    const neu = await video({ state: "uploading", created: new Date(now - 3600 * 1000).toISOString() });
    const fertig = await video({ created: new Date(now - 5 * DAY).toISOString() });
    await cleanupUploads(env, now);
    expect(await row(alt.id)).toBeNull();
    expect(await env.BUCKET.head(alt.raw)).toBeNull();
    expect(await row(neu.id)).not.toBeNull();
    expect(await row(fertig.id)).not.toBeNull();
  });

  it("leert den Papierkorb nach 30 Tagen – samt Dateien", async () => {
    const now = Date.now();
    const alt = await video({ state: "trashed", deleted: new Date(now - 31 * DAY).toISOString(), play: true });
    const frisch = await video({ state: "trashed", deleted: new Date(now - 2 * DAY).toISOString() });
    await purgeTrash(env, now);
    expect(await row(alt.id)).toBeNull();
    expect(await env.BUCKET.head(alt.raw)).toBeNull();
    expect(await env.BUCKET.head(`play/${alt.id}.mp4`)).toBeNull();
    expect(await row(frisch.id)).not.toBeNull();
    expect(await env.BUCKET.head(frisch.raw)).not.toBeNull();
  });

  it("wählt den Job nach dem Zeitplan", async () => {
    expect(await runScheduled(CRON.hourly, env)).toHaveProperty("uploads");
    expect(await runScheduled(CRON.daily, env)).toHaveProperty("trash");
  });
});
