import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { PART_SIZE } from "../src/routes/multipart.js";

const BASE = "https://formation.nils-meier.de";
const GROUP = { "x-portal-code": "gruppe-test" };
const MIB = 1024 * 1024;

function call(path, { method = "GET", body, raw, headers = {}, extra = {} } = {}) {
  const init = { method, headers: { ...GROUP, ...headers } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers["content-type"] = "application/json";
  }
  if (raw !== undefined) init.body = raw;
  return worker.fetch(new Request(BASE + path, init), { ...env, ...extra });
}
const row = (id) => env.DB.prepare("SELECT * FROM video WHERE id = ?").bind(id).first();
afterEach(() => vi.restoreAllMocks());

describe("Upload in Teilen – Produktion (S3-API)", () => {
  it("legt an, gibt Teil-URLs aus und setzt mit den ETags zusammen", async () => {
    const s3 = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const url = new URL(req.url);
      if (url.searchParams.has("uploads")) {
        return new Response("<InitiateMultipartUploadResult><UploadId>up-123</UploadId></InitiateMultipartUploadResult>");
      }
      return new Response("<CompleteMultipartUploadResult/>");
    });
    const size = 45 * MIB;
    const created = await call("/api/videos", { method: "POST", body: { filename: "gross.mov", size, content_type: "video/quicktime" } });
    const { id, upload } = await created.json();
    expect(upload).toEqual({ multipart: true, part_size: PART_SIZE, parts: 5 });
    expect((await row(id)).multipart_upload_id).toBe("up-123");
    const createCall = s3.mock.calls[0][0];
    expect(createCall.method).toBe("POST");
    expect(createCall.headers.get("content-type")).toBe("video/quicktime");

    const { urls } = await (await call(`/api/videos/${id}/parts`, { method: "POST", body: { numbers: [1, 5] } })).json();
    const u = new URL(urls[1].url);
    expect(urls.map((x) => x.n)).toEqual([1, 5]);
    expect(u.pathname).toBe(`/formation-videos/raw/${id}.mov`);
    expect(u.searchParams.get("partNumber")).toBe("5");
    expect(u.searchParams.get("uploadId")).toBe("up-123");
    expect(u.searchParams.get("X-Amz-Signature")).toBeTruthy();
    expect((await call(`/api/videos/${id}/parts`, { method: "POST", body: { numbers: [6] } })).status).toBe(400);

    // Unvollständig → 400, ohne S3 zu fragen
    const partial = await call(`/api/videos/${id}/complete`, { method: "POST", body: { parts: [{ partNumber: 1, etag: "a" }] } });
    expect(partial.status).toBe(400);

    // Zusammensetzen (S3 simuliert), danach liegt die Datei in R2 → normale Prüfung
    await env.BUCKET.put(`raw/${id}.mov`, "x".repeat(1000), { httpMetadata: { contentType: "video/quicktime" } });
    const parts = [5, 3, 1, 2, 4].map((n) => ({ partNumber: n, etag: `"etag${n}"` }));
    const done = await call(`/api/videos/${id}/complete`, { method: "POST", body: { parts } });
    expect(done.status).toBe(200);
    const completeReq = s3.mock.calls.at(-1)[0];
    expect(new URL(completeReq.url).searchParams.get("uploadId")).toBe("up-123");
    const xml = await completeReq.text();
    expect(xml).toContain('<Part><PartNumber>1</PartNumber><ETag>"etag1"</ETag></Part><Part><PartNumber>2</PartNumber>');
    expect(await row(id)).toMatchObject({ file_state: "ready", multipart_upload_id: null, size_bytes: 1000 });
  });

  it("kleine Dateien gehen weiter in einem Stück", async () => {
    const { upload } = await (await call("/api/videos", { method: "POST", body: { filename: "klein.mp4", size: 5 * MIB, content_type: "video/mp4" } })).json();
    expect(upload.multipart).toBeUndefined();
    expect(upload.method).toBe("PUT");
  });
});

describe("Upload in Teilen – lokal über das Binding", () => {
  it("lädt echte Teile hoch und setzt sie zur ganzen Datei zusammen", async () => {
    const dev = { DEV_MODE: "1" };
    const size = 32 * MIB + 123;
    const { id, upload } = await (await call("/api/videos", { method: "POST", body: { filename: "d.mp4", size, content_type: "video/mp4" }, extra: dev })).json();
    expect(upload.parts).toBe(4);
    const { urls } = await (await call(`/api/videos/${id}/parts`, { method: "POST", body: { numbers: [1, 2, 3, 4] }, extra: dev })).json();
    const parts = [];
    for (const { n, url } of urls) {
      const len = n < 4 ? PART_SIZE : size - 3 * PART_SIZE;
      const res = await call(url, { method: "PUT", raw: new Uint8Array(len).fill(n), headers: {}, extra: dev });
      expect(res.status).toBe(200);
      parts.push({ partNumber: n, etag: res.headers.get("etag") });
    }
    const done = await call(`/api/videos/${id}/complete`, { method: "POST", body: { parts }, extra: dev });
    expect(done.status).toBe(200);
    const obj = await env.BUCKET.get(`raw/${id}.mp4`);
    expect(obj.size).toBe(size);
    const bytes = new Uint8Array(await obj.arrayBuffer());
    expect([bytes[0], bytes[PART_SIZE], bytes[2 * PART_SIZE], bytes[size - 1]]).toEqual([1, 2, 3, 4]);
    expect((await row(id)).file_state).toBe("ready");
  });
});
