import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CRON, runScheduled } from "../src/cron.js";
import worker from "../src/index.js";
import { sendWeeklySummary, weeklyStats } from "../src/mails.js";

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
  it("Sofortmail bei großen Uploads (Schwelle), sonst keine", async () => {
    const spy = mockResend();
    const small = await upload();
    await small.call(`/api/videos/${small.id}/complete`, { method: "POST", headers: GROUP });
    expect(sent(spy)).toHaveLength(0);

    const big = await upload();
    await worker.fetch(new Request(`${BASE}/api/videos/${big.id}/complete`, { method: "POST", headers: GROUP }),
      { ...env, ...MAIL, NOTIFY_FILE_BYTES: "1" });
    const [mail] = sent(spy);
    expect(mail.to).toEqual(["admin@example.org"]);
    expect(mail.subject).toContain("Großer Upload");
    expect(mail.html).toContain(`/videos/${big.id}`);
    expect(mail.html).toContain("Anna &lt;Tänzerin&gt;"); // Namen werden maskiert
    expect(mail.html).not.toContain("<Tänzerin>");
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
    expect(mail.text).toContain("/zuordnen");
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
