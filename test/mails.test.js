import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CRON, runScheduled } from "../src/cron.js";
import worker from "../src/index.js";
import { sendWeeklySummary, uploadMail, weeklyStats } from "../src/mails.js";

const BASE = "https://formation.nils-meier.de";
const GROUP = { "x-portal-code": "gruppe-test" };
const MAIL = { RESEND_API_KEY: "re_test", MAIL_TO: "admin@example.org" };
afterEach(() => vi.restoreAllMocks());

function mockResend() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response('{"id":"x"}', { status: 200 }));
}
const sent = (spy) => spy.mock.calls.filter(([url]) => String(url).includes("resend.com")).map(([, init]) => JSON.parse(init.body));

/** Video anlegen und die Datei „hochladen“ (1 Byte); die Mail-Schwelle stellt der Test ein. */
async function upload(name = "Anna <Tänzerin>") {
  const call = (path, init) => worker.fetch(new Request(BASE + path, init), { ...env, ...MAIL });
  const { id } = await (await call("/api/videos", {
    method: "POST", headers: { ...GROUP, "content-type": "application/json" },
    body: JSON.stringify({ filename: "x.mp4", size: 1000, content_type: "video/mp4", uploaded_by: name }),
  })).json();
  const key = (await env.DB.prepare("SELECT storage_key FROM video WHERE id = ?").bind(id).first()).storage_key;
  await env.BUCKET.put(key, "x", { httpMetadata: { contentType: "video/mp4" } });
  return { id, call };
}

describe("Mails", () => {
  it("eine Mail je Upload-Reihe – nicht schon bei jedem einzelnen Video", async () => {
    const spy = mockResend();
    const a = await upload();
    const b = await upload();
    await a.call(`/api/videos/${a.id}/complete`, { method: "POST", headers: GROUP });
    await b.call(`/api/videos/${b.id}/complete`, { method: "POST", headers: GROUP });
    expect(sent(spy)).toHaveLength(0); // noch keine Mail beim einzelnen Video

    const res = await a.call("/api/videos/notify", {
      method: "POST", headers: { ...GROUP, "content-type": "application/json" }, body: JSON.stringify({ ids: [a.id, b.id] }),
    });
    expect(await res.json()).toEqual({ notified: 2 });
    const mails = sent(spy);
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toEqual(["admin@example.org"]);
    expect(mails[0].subject).toBe("2 neue Videos von Anna <Tänzerin>");
    expect(mails[0].html).toContain(`/videos/${a.id}`);
    expect(mails[0].html).toContain(`/videos/${b.id}`);
    expect(mails[0].html).toContain("/verwalten");
    expect(mails[0].html).toContain("Anna &lt;Tänzerin&gt;"); // Namen werden maskiert
    expect(mails[0].html).not.toContain("<Tänzerin>");
    expect(mails[0].text).toMatch(/Noch nicht zugeordnet: \d+/);

    // nochmal melden: nichts Neues → keine zweite Mail
    await a.call("/api/videos/notify", {
      method: "POST", headers: { ...GROUP, "content-type": "application/json" }, body: JSON.stringify({ ids: [a.id] }),
    });
    expect(sent(spy)).toHaveLength(1);
  });

  it("Cron meldet, was nicht am Ende der Reihe gemeldet wurde (nach 15 min)", async () => {
    const spy = mockResend();
    const a = await upload("Ben");
    await a.call(`/api/videos/${a.id}/complete`, { method: "POST", headers: GROUP });
    expect(await runScheduled(CRON.hourly, { ...env, ...MAIL })).toMatchObject({ notified: 0 }); // zu frisch
    const later = Date.now() + 16 * 60 * 1000;
    const done = await runScheduled(CRON.hourly, { ...env, ...MAIL }, later);
    expect(done.notified).toBeGreaterThanOrEqual(1);
    const mail = sent(spy).at(-1);
    expect(mail.html).toContain(`/videos/${a.id}`);
    expect(mail.subject).toContain("Ben");
    expect((await runScheduled(CRON.hourly, { ...env, ...MAIL }, later)).notified).toBe(0); // nur einmal
  });

  it("schlägt der Versand fehl, bleibt das Video offen", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("kaputt", { status: 500 }));
    const a = await upload();
    await a.call(`/api/videos/${a.id}/complete`, { method: "POST", headers: GROUP });
    const res = await a.call("/api/videos/notify", {
      method: "POST", headers: { ...GROUP, "content-type": "application/json" }, body: JSON.stringify({ ids: [a.id] }),
    });
    expect(await res.json()).toEqual({ notified: 0 });
    expect((await env.DB.prepare("SELECT notified_at FROM video WHERE id = ?").bind(a.id).first()).notified_at).toBeNull();
  });

  it("nur angemeldet; ungültige Liste abgelehnt", async () => {
    const anon = await worker.fetch(new Request(`${BASE}/api/videos/notify`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: [] }),
    }), env);
    expect(anon.status).toBe(401);
    const bad = await worker.fetch(new Request(`${BASE}/api/videos/notify`, {
      method: "POST", headers: { ...GROUP, "content-type": "application/json" }, body: JSON.stringify({ ids: "x" }),
    }), env);
    expect(bad.status).toBe(400);
  });

  it("Betreff und Inhalt: ein Video, große Dateien, Aufnahmezeit in Berliner Zeit", () => {
    const one = uploadMail(env, [{ id: "v1", uploaded_by: "", size_bytes: 52e6, recorded_at: "2026-09-25T10:31:00Z" }], 3);
    expect(one.subject).toBe("Neues Video von Unbekannt");
    expect(one.text).toContain("aufgenommen 25.09.2026, 12:31 · 52 MB");
    const big = uploadMail(env, [
      { id: "v1", uploaded_by: "Anna", size_bytes: 1.5e9, recorded_at: null },
      { id: "v2", uploaded_by: "Ben", size_bytes: 3e8, recorded_at: null },
    ], 5);
    expect(big.subject).toBe("2 neue Videos von Anna, Ben (1,8 GB)");
    expect(big.text).toContain("Aufnahmezeit unbekannt · 1,5 GB – groß");
    expect(big.text).toContain("Noch nicht zugeordnet: 5");
  });

  it("verschickt ohne Schlüssel nichts", async () => {
    const spy = mockResend();
    expect(await sendWeeklySummary({ ...env, MAIL_TO: "a@b.c" })).toBe(false);
    expect(sent(spy)).toHaveLength(0);
  });

  it("Wochenübersicht mit neuen Uploads, Eingang und Speicher – montags per Cron", async () => {
    const spy = mockResend();
    await upload("Ben");
    const stats = await weeklyStats(env);
    expect(stats.quota).toBe(200_000_000_000);
    expect(stats.newCount).toBeGreaterThanOrEqual(1);

    await runScheduled(CRON.weekly, { ...env, ...MAIL });
    const [mail] = sent(spy);
    expect(mail.subject).toMatch(/^Formation: Woche mit \d+ neuen Videos/);
    expect(mail.text).toContain("Noch nicht zugeordnet:");
    expect(mail.text).toContain("Speicher:");
    expect(mail.text).toContain("/verwalten");
  });

  it("schweigt, wenn es nichts zu berichten gibt", async () => {
    const spy = mockResend();
    const quiet = { ...env, ...MAIL, QUOTA_BYTES: "1e15" };
    const far = Date.now() + 400 * 24 * 3600 * 1000; // keine neuen Uploads „in dieser Woche“
    await env.DB.prepare("UPDATE video SET tag_state = 'tagged', processing = 'done'").run();
    expect(await sendWeeklySummary(quiet, far)).toBe(false);
    expect(sent(spy)).toHaveLength(0);
  });
});
