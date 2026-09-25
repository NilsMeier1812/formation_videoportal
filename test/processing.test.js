import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteOriginals, retryProcessing } from "../src/cron.js";
import worker from "../src/index.js";
import { dispatchProcessing } from "../src/routes/processing.js";

const BASE = "https://formation.nils-meier.de";
const TRAINER = { "x-portal-code": "tagger-test" };
const GROUP = { "x-portal-code": "gruppe-test" };
const GH = { GH_TOKEN: "gh-test", GH_REPO: "owner/repo", CALLBACK_SECRET: "rueckruf-geheim" };
const DAY = 24 * 3600 * 1000;
const uid = () => crypto.randomUUID();

function call(path, { method = "GET", headers = TRAINER, body, extra = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers["content-type"] = "application/json";
  }
  return worker.fetch(new Request(BASE + path, init), { ...env, ...GH, ...extra });
}

async function video(fields = {}) {
  const id = uid();
  const v = { storage_key: `raw/${id}.mov`, processing: "pending", processing_attempts: 0, ...fields };
  await env.BUCKET.put(v.storage_key, "original-bytes");
  await env.DB.prepare(
    `INSERT INTO video (id, storage_key, size_bytes, file_state, tag_state, created_at, processing,
                        processing_attempts, dispatched_at, play_key, processed_at, thumb_key)
     VALUES (?, ?, 1000, 'ready', 'untagged', ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, v.storage_key, new Date().toISOString(), v.processing, v.processing_attempts,
    v.dispatched_at ?? null, v.play_key ?? null, v.processed_at ?? null, v.thumb_key ?? null).run();
  return { id, ...v };
}
const row = (id) => env.DB.prepare("SELECT * FROM video WHERE id = ?").bind(id).first();

function mockGitHub(status = 204) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(null, { status }));
}
afterEach(() => vi.restoreAllMocks());

describe("Umwandlung anstoßen", () => {
  it("ruft workflow_dispatch mit ID und Original auf und zählt den Versuch", async () => {
    const gh = mockGitHub();
    const v = await video();
    expect(await dispatchProcessing({ ...env, ...GH }, v)).toBe(true);
    const [url, init] = gh.mock.calls[0];
    expect(url).toBe("https://api.github.com/repos/owner/repo/actions/workflows/process-video.yml/dispatches");
    expect(init.headers.authorization).toBe("Bearer gh-test");
    expect(init.headers["user-agent"]).toBeTruthy();
    expect(JSON.parse(init.body)).toEqual({ ref: "main", inputs: { video_id: v.id, storage_key: v.storage_key } });
    const r = await row(v.id);
    expect(r.processing_attempts).toBe(1);
    expect(r.dispatched_at).toBeTruthy();
  });

  it("tut ohne GH_TOKEN nichts (Umwandlung noch nicht eingerichtet)", async () => {
    const gh = mockGitHub();
    const v = await video();
    expect(await dispatchProcessing(env, v)).toBe(false);
    expect(gh).not.toHaveBeenCalled();
    expect((await row(v.id)).processing_attempts).toBe(0);
  });

  it("wird nach dem Upload angestoßen", async () => {
    const gh = mockGitHub();
    const created = await call("/api/videos", { method: "POST", headers: GROUP, body: { filename: "a.mp4", size: 3, content_type: "video/mp4" } });
    const { id } = await created.json();
    await env.BUCKET.put((await row(id)).storage_key, "abc", { httpMetadata: { contentType: "video/mp4" } });
    expect((await call(`/api/videos/${id}/complete`, { method: "POST", headers: GROUP })).status).toBe(200);
    expect(gh).toHaveBeenCalledTimes(1);
    expect(await row(id)).toMatchObject({ processing: "pending", processing_attempts: 1 });
  });
});

describe("Rückmeldung der Umwandlung", () => {
  const callback = (body, secret = GH.CALLBACK_SECRET) =>
    call("/api/internal/processed", { method: "POST", headers: { authorization: `Bearer ${secret}` }, body });

  it("braucht das Geheimnis – kein Login", async () => {
    const v = await video();
    expect((await callback({ id: v.id, status: "done" }, "falsch")).status).toBe(401);
    expect((await call("/api/internal/processed", { method: "POST", headers: {}, body: { id: v.id } })).status).toBe(401);
  });

  it("übernimmt Abspielfassung, echte Größe, Länge und Vorschaubild", async () => {
    const v = await video({ processing_attempts: 1 });
    await env.BUCKET.put(`play/${v.id}.mp4`, "x".repeat(500));
    await env.BUCKET.put(`thumb/${v.id}.jpg`, "jpg");
    expect((await callback({ id: v.id, status: "done", duration: 31.5, play_size: 999999, mode: "encode" })).status).toBe(200);
    const r = await row(v.id);
    expect(r).toMatchObject({ processing: "done", play_key: `play/${v.id}.mp4`, play_size_bytes: 500, duration_s: 31.5, thumb_key: `thumb/${v.id}.jpg` });
    expect(r.processed_at).toBeTruthy();
    const pub = await (await call(`/api/videos/${v.id}`, { headers: GROUP })).json();
    expect(pub).toMatchObject({ is_processed: true, playback_url: `/media/play/${v.id}.mp4`, processing: "done" });
  });

  it("behält ein vorhandenes Vorschaubild aus dem Browser", async () => {
    const v = await video({ thumb_key: "thumb/aus-dem-browser.jpg" });
    await env.BUCKET.put(`play/${v.id}.mp4`, "x");
    await env.BUCKET.put(`thumb/${v.id}.jpg`, "jpg");
    await callback({ id: v.id, status: "done" });
    expect((await row(v.id)).thumb_key).toBe("thumb/aus-dem-browser.jpg");
  });

  it("wiederholt Fehler – nach 3 Versuchen „failed“", async () => {
    const a = await video({ processing_attempts: 1 });
    expect(await (await callback({ id: a.id, status: "failed" })).json()).toMatchObject({ retry: true });
    expect(await row(a.id)).toMatchObject({ processing: "pending", dispatched_at: null });
    const b = await video({ processing_attempts: 3 });
    await callback({ id: b.id, status: "failed" });
    expect((await row(b.id)).processing).toBe("failed");
    // „fertig“ gemeldet, aber keine Datei da → wie Fehler
    const c = await video({ processing_attempts: 1 });
    await callback({ id: c.id, status: "done" });
    expect((await row(c.id)).processing).toBe("pending");
  });
});

describe("Cron: wiederholen und Originale löschen", () => {
  it("stößt Liegengebliebenes an, gibt nach 3 Versuchen auf", async () => {
    const gh = mockGitHub();
    const neu = await video();
    const verloren = await video({ processing_attempts: 1, dispatched_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString() });
    const laeuft = await video({ processing_attempts: 1, dispatched_at: new Date().toISOString() });
    const aufgebraucht = await video({ processing_attempts: 3 });
    await retryProcessing({ ...env, ...GH });
    const dispatched = gh.mock.calls.map(([, init]) => JSON.parse(init.body).inputs.video_id);
    expect(dispatched).toContain(neu.id);
    expect(dispatched).toContain(verloren.id);
    expect(dispatched).not.toContain(laeuft.id);
    expect((await row(aufgebraucht.id)).processing).toBe("failed");
  });

  it("macht ohne GH_TOKEN nichts", async () => {
    const gh = mockGitHub();
    await video();
    expect(await retryProcessing(env)).toBe(0);
    expect(gh).not.toHaveBeenCalled();
  });

  it("löscht Originale 7 Tage nach der Umwandlung – vorher nicht, ohne Abspielfassung nie", async () => {
    const now = Date.now();
    const alt = await video({ processing: "done", play_key: "play/alt.mp4", processed_at: new Date(now - 8 * DAY).toISOString() });
    await env.BUCKET.put("play/alt.mp4", "p");
    const frisch = await video({ processing: "done", play_key: "play/frisch.mp4", processed_at: new Date(now - 2 * DAY).toISOString() });
    await env.BUCKET.put("play/frisch.mp4", "p");
    const ohne = await video({ processing: "done", play_key: "play/fehlt.mp4", processed_at: new Date(now - 8 * DAY).toISOString() });

    await deleteOriginals(env, now);
    expect(await env.BUCKET.head(alt.storage_key)).toBeNull();
    expect((await row(alt.id)).raw_deleted_at).toBeTruthy();
    expect(await env.BUCKET.head(frisch.storage_key)).not.toBeNull();
    expect(await env.BUCKET.head(ohne.storage_key)).not.toBeNull();
    expect((await row(ohne.id)).raw_deleted_at).toBeNull();

    // Neu umwandeln geht dann nicht mehr
    expect((await call(`/api/videos/${alt.id}/reprocess`, { method: "POST" })).status).toBe(409);
  });

  it("Trainer können eine fehlgeschlagene Umwandlung neu starten", async () => {
    mockGitHub();
    const v = await video({ processing: "failed", processing_attempts: 3 });
    expect((await call(`/api/videos/${v.id}/reprocess`, { method: "POST", headers: GROUP })).status).toBe(401);
    const res = await call(`/api/videos/${v.id}/reprocess`, { method: "POST" });
    expect(await res.json()).toEqual({ started: true });
    expect(await row(v.id)).toMatchObject({ processing: "pending", processing_attempts: 1 });
  });
});
