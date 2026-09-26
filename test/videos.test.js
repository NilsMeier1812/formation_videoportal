import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index.js";

const BASE = "https://formation.nils-meier.de";
const GROUP = { "x-portal-code": "gruppe-test" };

function call(path, { method = "GET", headers = GROUP, body, envOverrides = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
    init.headers["content-type"] ??= "application/json";
  }
  return worker.fetch(new Request(BASE + path, init), { ...env, ...envOverrides });
}

function newVideo(overrides = {}, options = {}) {
  return call("/api/videos", {
    method: "POST",
    headers: GROUP,
    body: {
      filename: "Kreis links.MOV",
      size: 1000,
      content_type: "video/quicktime",
      recorded_at: "2026-09-24T12:31:02+02:00",
      recorded_source: "meta",
      duration_s: 30.5,
      uploaded_by: "Nils",
      ...overrides,
    },
    ...options,
  });
}

async function videoRow(id) {
  return env.DB.prepare("SELECT * FROM video WHERE id = ?").bind(id).first();
}

describe("Codes", () => {
  it("lehnt Upload ohne Code ab", async () => {
    const res = await call("/api/videos", { method: "POST", headers: {}, body: { size: 1 } });
    expect(res.status).toBe(401);
  });

  it("lehnt einen falschen Code ab", async () => {
    const res = await call("/api/auth", { headers: { "x-portal-code": "falsch" } });
    expect(res.status).toBe(401);
  });

  it("erkennt Gruppen- und Tagger-Code", async () => {
    expect(await (await call("/api/auth", { headers: GROUP })).json()).toEqual({ role: "group" });
    const tagger = await call("/api/auth", { headers: { "x-portal-code": "tagger-test" } });
    expect(await tagger.json()).toEqual({ role: "tagger" });
  });
});

describe("POST /api/videos", () => {
  it("legt einen Datensatz an und gibt eine Presigned URL zurück", async () => {
    const res = await newVideo();
    expect(res.status).toBe(201);
    const { id, upload } = await res.json();

    const url = new URL(upload.url);
    expect(url.origin).toBe("https://527266f78a5c7ffa288f4a9d2c49e842.eu.r2.cloudflarestorage.com");
    expect(url.pathname).toBe(`/formation-videos/raw/${id}.mov`);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(url.searchParams.get("X-Amz-Signature")).toBeTruthy();
    expect(upload.headers).toEqual({ "content-type": "video/quicktime" });

    const row = await videoRow(id);
    expect(row).toMatchObject({
      file_state: "uploading",
      tag_state: "untagged",
      storage_key: `raw/${id}.mov`,
      size_bytes: 1000,
      uploaded_by: "Nils",
      recorded_at: "2026-09-24T10:31:02.000Z", // nach UTC umgerechnet
      recorded_source: "meta",
      duration_s: 30.5,
      title: null,
    });
  });

  it("braucht außer der Datei nichts", async () => {
    const res = await call("/api/videos", {
      method: "POST",
      headers: GROUP,
      body: { filename: "clip.mp4", size: 10, content_type: "video/mp4" },
    });
    expect(res.status).toBe(201);
    const row = await videoRow((await res.json()).id);
    expect(row).toMatchObject({ recorded_at: null, recorded_source: null, uploaded_by: null, tag_state: "untagged" });
  });

  it("übernimmt nie den Dateinamen in den Key", async () => {
    const { id } = await (await newVideo({ filename: "../../evil.exe", content_type: "video/mp4" })).json();
    expect((await videoRow(id)).storage_key).toBe(`raw/${id}.bin`);
  });

  it("leitet den Content-Type aus der Endung ab, wenn der Browser keinen liefert", async () => {
    const res = await newVideo({ filename: "clip.mp4", content_type: "" });
    expect((await res.json()).upload.headers["content-type"]).toBe("video/mp4");
  });

  it("landet immer im Eingang der Admins", async () => {
    const { id } = await (await newVideo({ no_choreo: true })).json();
    expect((await videoRow(id)).tag_state).toBe("untagged");
  });

  it("lehnt Nicht-Videos ab", async () => {
    expect((await newVideo({ filename: "a.pdf", content_type: "application/pdf" })).status).toBe(415);
  });

  it("lehnt zu große Dateien ab", async () => {
    expect((await newVideo({ size: 5_000_000_001 })).status).toBe(413);
  });

  it("lehnt fehlende oder unsinnige Größen ab", async () => {
    expect((await newVideo({ size: undefined })).status).toBe(400);
    expect((await newVideo({ size: -5 })).status).toBe(400);
  });

  it("lehnt eine unsinnige Aufnahmezeit ab", async () => {
    expect((await newVideo({ recorded_at: "24.09.2026" })).status).toBe(400);
    expect((await newVideo({ recorded_at: "1904-01-01T00:00:00Z" })).status).toBe(400); // leere Metadaten
    expect((await newVideo({ duration_s: -1 })).status).toBe(400);
  });

  it("nimmt auch nur ein Datum oder eine Zeit ohne Sekunden", async () => {
    const a = await (await newVideo({ recorded_at: "2026-09-24" })).json();
    expect((await videoRow(a.id)).recorded_at).toBe("2026-09-24");
    const b = await (await newVideo({ recorded_at: "2026-09-24T12:31Z", recorded_source: "quatsch" })).json();
    expect(await videoRow(b.id)).toMatchObject({ recorded_at: "2026-09-24T12:31:00.000Z", recorded_source: null });
  });

  it("hält die Quota ein", async () => {
    const res = await newVideo({ size: 600 }, { envOverrides: { QUOTA_BYTES: "500" } });
    expect(res.status).toBe(413);
  });

  it("gibt lokal die Upload-Route des Workers aus", async () => {
    const res = await newVideo({}, { envOverrides: { DEV_MODE: "1" } });
    const { id, upload } = await res.json();
    expect(upload.url).toBe(`/api/dev-upload/${id}`);
  });
});

describe("POST /api/videos/:id/complete", () => {
  async function started(overrides) {
    const { id } = await (await newVideo(overrides)).json();
    return { id, key: (await videoRow(id)).storage_key };
  }
  const complete = (id) => call(`/api/videos/${id}/complete`, { method: "POST", headers: GROUP });

  it("verlangt den Gruppen-Code", async () => {
    const { id } = await started();
    expect((await call(`/api/videos/${id}/complete`, { method: "POST", headers: {} })).status).toBe(401);
  });

  it("meldet 409, wenn die Datei nicht angekommen ist", async () => {
    const { id } = await started();
    expect((await complete(id)).status).toBe(409);
    expect((await videoRow(id)).file_state).toBe("uploading");
  });

  it("übernimmt die echte Größe und macht das Video sichtbar", async () => {
    const { id, key } = await started({ size: 1000 });
    await env.BUCKET.put(key, "x".repeat(1234), { httpMetadata: { contentType: "video/quicktime" } });

    const res = await complete(id);
    expect(res.status).toBe(200);
    expect(await videoRow(id)).toMatchObject({
      file_state: "ready",
      size_bytes: 1234,
      processing: "pending",
    });

    const { videos } = await (await call("/api/videos")).json();
    expect(videos.map((v) => v.id)).toContain(id);
  });

  it("ist bei doppelter Meldung harmlos", async () => {
    const { id, key } = await started();
    await env.BUCKET.put(key, "x", { httpMetadata: { contentType: "video/mp4" } });
    expect((await complete(id)).status).toBe(200);
    expect((await complete(id)).status).toBe(200);
  });

  it("verwirft Dateien, die kein Video sind, samt Datensatz", async () => {
    const { id, key } = await started();
    await env.BUCKET.put(key, "<html>", { httpMetadata: { contentType: "text/html" } });

    expect((await complete(id)).status).toBe(415);
    expect(await videoRow(id)).toBeNull();
    expect(await env.BUCKET.head(key)).toBeNull();
  });

  it("verwirft Dateien über dem Limit, auch wenn die Angabe klein war", async () => {
    const { id, key } = await started({ size: 10 });
    await env.BUCKET.put(key, "x".repeat(50), { httpMetadata: { contentType: "video/mp4" } });

    const res = await call(`/api/videos/${id}/complete`, {
      method: "POST",
      headers: GROUP,
      envOverrides: { MAX_FILE_BYTES: "20" },
    });
    expect(res.status).toBe(413);
    expect(await videoRow(id)).toBeNull();
    expect(await env.BUCKET.head(key)).toBeNull();
  });
});

describe("Lesen", () => {
  it("zeigt Videos im Upload nicht an", async () => {
    const { id } = await (await newVideo()).json();
    expect((await call(`/api/videos/${id}`)).status).toBe(404);
    const { videos } = await (await call("/api/videos")).json();
    expect(videos.map((v) => v.id)).not.toContain(id);
  });

  it("liefert Abspiel-URL über die Media-Domain und keine internen Felder", async () => {
    const { id } = await (await newVideo()).json();
    const key = (await videoRow(id)).storage_key;
    await env.BUCKET.put(key, "x", { httpMetadata: { contentType: "video/quicktime" } });
    await call(`/api/videos/${id}/complete`, { method: "POST", headers: GROUP });

    const video = await (await call(`/api/videos/${id}`)).json();
    expect(video.playback_url).toBe(`/media/${key}`);
    expect(video.is_processed).toBe(false);
    expect(video).not.toHaveProperty("storage_key");
    expect(video).not.toHaveProperty("processing_attempts");
  });

  it("antwortet mit 404 auf unbekannte Pfade", async () => {
    expect((await call("/api/gibtsnicht")).status).toBe(404);
  });
});

describe("Lokale Entwicklungsrouten", () => {
  it("sind in Produktion abgeschaltet", async () => {
    const { id } = await (await newVideo()).json();
    const res = await call(`/api/dev-upload/${id}`, { method: "PUT", body: "x" });
    expect(res.status).toBe(404);
  });

  it("laden lokal über den Worker hoch", async () => {
    const dev = { DEV_MODE: "1" };
    const { id, upload } = await (await newVideo({}, { envOverrides: dev })).json();
    const put = await worker.fetch(
      new Request(BASE + upload.url, { method: "PUT", body: "0123456789", headers: upload.headers }),
      { ...env, ...dev }
    );
    expect(put.status).toBe(200);
    expect(await (await env.BUCKET.get((await videoRow(id)).storage_key)).text()).toBe("0123456789");
  });
});

describe("Zugangsschutz", () => {
  it("lässt ohne Anmeldung nur die Anmeldung zu", async () => {
    for (const path of ["/api/videos", "/api/library", "/api/choreo/projects", "/api/choreo/audio/x.mp3"]) {
      expect((await call(path, { headers: {} })).status, path).toBe(401);
    }
    expect((await call("/api/session", { headers: {} })).status).toBe(200);
  });

  it("liefert Medien nur Angemeldeten – mit Range und ETag", async () => {
    await env.BUCKET.put("play/abc.mp4", "0123456789", { httpMetadata: { contentType: "video/mp4" } });
    expect((await call("/media/play/abc.mp4", { headers: {} })).status).toBe(401);

    const full = await call("/media/play/abc.mp4");
    expect(full.status).toBe(200);
    expect(full.headers.get("content-type")).toBe("video/mp4");
    expect(full.headers.get("cache-control")).toBe("private, max-age=86400");
    expect(await full.text()).toBe("0123456789");

    const part = await call("/media/play/abc.mp4", { headers: { ...GROUP, range: "bytes=2-5" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await part.text()).toBe("2345");

    const again = await call("/media/play/abc.mp4", { headers: { ...GROUP, "if-none-match": full.headers.get("etag") } });
    expect(again.status).toBe(304);
  });

  it("gibt nur Videos, Abspielfassungen und Bilder heraus", async () => {
    await env.BUCKET.put("audio/lied.mp3", "x");
    expect((await call("/media/audio/lied.mp3")).status).toBe(404);
    expect((await call("/media/play/../audio/lied.mp3")).status).toBe(404);
    expect((await call("/media/play/fehlt.mp4")).status).toBe(404);
  });

  it("bremst das Raten von Codes", async () => {
    let calls = 0;
    const limiter = { limit: async () => ({ success: ++calls <= 2 }) };
    const login = () => worker.fetch(new Request(`${BASE}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7" },
      body: JSON.stringify({ code: "falsch" }),
    }), { ...env, LOGIN_LIMIT: limiter });
    expect((await login()).status).toBe(401);
    expect((await login()).status).toBe(401);
    expect((await login()).status).toBe(429);
  });
});
