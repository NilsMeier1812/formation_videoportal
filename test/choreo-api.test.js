import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index.js";

const BASE = "https://formation.nils-meier.de";
const TRAINER = { "x-portal-code": "tagger-test" };
const GROUP = { "x-portal-code": "gruppe-test" };

function call(path, { method = "GET", headers = GROUP, body, raw } = {}) {
  const init = { method, headers: { ...headers } };
  if (raw !== undefined) init.body = raw;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers["content-type"] = "application/json";
  }
  return worker.fetch(new Request(BASE + path, init), env);
}

let counter = 0;
const uid = (prefix) => `${prefix}-${++counter}-${crypto.randomUUID().slice(0, 8)}`;

async function project(overrides = {}) {
  const res = await call("/api/choreo/projects", {
    method: "POST", headers: TRAINER,
    body: { title: "Kür", bpm: 120, time_signature: "4/4", ...overrides },
  });
  expect(res.status).toBe(201);
  return res.json();
}

describe("Login per Cookie", () => {
  it("setzt nach richtigem Code ein Cookie, das ein Jahr gilt", async () => {
    const res = await call("/api/session", { method: "POST", body: { code: "tagger-test" } });
    expect(await res.json()).toEqual({ role: "tagger" });
    const cookie = res.headers.get("set-cookie");
    expect(cookie).toMatch(/^formation_session=tagger\.\d+\./);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Max-Age=31536000");

    const value = cookie.split(";")[0];
    const me = await call("/api/session", { headers: { cookie: value } });
    expect(await me.json()).toEqual({ role: "tagger" });
  });

  it("lehnt falsche Codes und gefälschte Cookies ab", async () => {
    expect((await call("/api/session", { method: "POST", body: { code: "falsch" } })).status).toBe(401);
    const fake = await call("/api/session", { headers: { cookie: "formation_session=tagger.9999999999.abc" } });
    expect(await fake.json()).toEqual({ role: null });
  });

  it("macht Cookies ungültig, wenn der Code geändert wird", async () => {
    const res = await call("/api/session", { method: "POST", body: { code: "gruppe-test" } });
    const value = res.headers.get("set-cookie").split(";")[0];
    const changed = { ...env, GROUP_CODE: "neuer-code" };
    const me = await worker.fetch(new Request(`${BASE}/api/session`, { headers: { cookie: value } }), changed);
    expect(await me.json()).toEqual({ role: null });
  });

  it("gilt auch für die Video-API", async () => {
    const res = await call("/api/session", { method: "POST", body: { code: "gruppe-test" } });
    const cookie = res.headers.get("set-cookie").split(";")[0];
    expect((await call("/api/auth", { headers: { cookie } })).status).toBe(200);
  });

  it("meldet ab", async () => {
    const res = await call("/api/session", { method: "DELETE" });
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});

describe("Projekte", () => {
  it("legt an (nur Trainer) und liefert die Zeile mit ID und Datum zurück", async () => {
    expect((await call("/api/choreo/projects", { method: "POST", headers: GROUP, body: { title: "x" } })).status).toBe(401);
    const p = await project({ is_private: false });
    expect(p.id).toBeTruthy();
    expect(p.created_at).toBeTruthy();
    expect(p.is_private).toBe(false);
    expect(p).not.toHaveProperty("locked_by");
  });

  it("zeigt private Projekte nur Trainern", async () => {
    const secret = await project({ title: "Geheim", is_private: true });
    const open = await (await call("/api/choreo/projects")).json();
    expect(open.map((p) => p.id)).not.toContain(secret.id);
    const all = await (await call("/api/choreo/projects", { headers: TRAINER })).json();
    expect(all.map((p) => p.id)).toContain(secret.id);
    expect((await call(`/api/choreo/projects/${secret.id}/steps`)).status).toBe(404);
    expect((await call(`/api/choreo/projects/${secret.id}/steps`, { headers: TRAINER })).status).toBe(200);
  });

  it("gibt Sperr-Spalten nicht zum Schreiben frei", async () => {
    const p = await project();
    await call(`/api/choreo/projects/${p.id}`, { method: "PATCH", headers: TRAINER, body: { locked_by: "hacker", title: "Neu" } });
    const row = await env.DB.prepare("SELECT title, locked_by FROM projects WHERE id = ?").bind(p.id).first();
    expect(row).toEqual({ title: "Neu", locked_by: null });
  });
});

describe("Zeilen des Planers", () => {
  it("liest, ändert, ersetzt und löscht – mit JSON-Feldern", async () => {
    const p = await project();
    const partId = uid("part");
    const created = await call("/api/choreo/parts", {
      method: "POST", headers: TRAINER,
      body: [{ id: partId, project_id: p.id, label: "Kreis", start_sec: 4, end_sec: 10, group_names: { 1: "Innen" } }],
    });
    expect(created.status).toBe(201);
    expect((await created.json())[0].group_names).toEqual({ 1: "Innen" });

    await call(`/api/choreo/parts/${partId}`, { method: "PATCH", headers: TRAINER, body: { group_names: { 1: "Innen", 2: "Außen" } } });
    let rows = await (await call(`/api/choreo/projects/${p.id}/parts`)).json();
    expect(rows[0].group_names).toEqual({ 1: "Innen", 2: "Außen" });

    // PUT legt an bzw. ersetzt (nachgereichte Offline-Änderungen)
    const put = await call(`/api/choreo/parts/${partId}`, { method: "PUT", headers: TRAINER, body: { project_id: p.id, label: "Kreis links" } });
    expect(put.status).toBe(204);
    rows = await (await call(`/api/choreo/projects/${p.id}/parts`)).json();
    expect(rows[0].label).toBe("Kreis links");

    expect((await call(`/api/choreo/parts/${partId}`, { method: "DELETE", headers: TRAINER })).status).toBe(204);
    expect(await (await call(`/api/choreo/projects/${p.id}/parts`)).json()).toEqual([]);
  });

  it("sortiert wie der Planer es erwartet", async () => {
    const p = await project();
    await call("/api/choreo/choreo_segments", {
      method: "POST", headers: TRAINER,
      body: [
        { id: uid("s"), project_id: p.id, timestamp: 8, label: "B" },
        { id: uid("s"), project_id: p.id, timestamp: 2, label: "A" },
      ],
    });
    const rows = await (await call(`/api/choreo/projects/${p.id}/choreo_segments`)).json();
    expect(rows.map((r) => r.label)).toEqual(["A", "B"]);
  });

  it("löscht beim Projekt alles Abhängige mit (Cascade)", async () => {
    const p = await project();
    const tempo = uid("t");
    const part = uid("p");
    await call("/api/choreo/tempo_sections", { method: "POST", headers: TRAINER, body: { id: tempo, project_id: p.id, bpm: 120 } });
    await call("/api/choreo/steps", { method: "POST", headers: TRAINER, body: { id: uid("st"), project_id: p.id, tempo_section_id: tempo, beat_pos: 1 } });
    await call("/api/choreo/parts", { method: "POST", headers: TRAINER, body: { id: part, project_id: p.id } });
    await call("/api/choreo/group_memberships", { method: "POST", headers: TRAINER, body: { id: uid("m"), part_id: part, person_number: 1, group_number: 1 } });

    await call(`/api/choreo/projects/${p.id}`, { method: "DELETE", headers: TRAINER });
    for (const table of ["tempo_sections", "steps", "parts"]) {
      const { n } = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`).bind(p.id).first();
      expect(n, table).toBe(0);
    }
    const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM group_memberships WHERE part_id = ?").bind(part).first();
    expect(n).toBe(0);
  });

  it("antwortet mit 409 statt 500, wenn eine Zeile nicht passt", async () => {
    const res = await call("/api/choreo/steps", { method: "POST", headers: TRAINER, body: { id: uid("st"), project_id: "gibt-es-nicht" } });
    expect(res.status).toBe(409);
  });

  it("lehnt unbekannte Tabellen und ungültige Werte ab", async () => {
    expect((await call("/api/choreo/video", { method: "POST", headers: TRAINER, body: { id: "x" } })).status).toBe(404);
    const p = await project();
    const bad = await call(`/api/choreo/projects/${p.id}`, { method: "PATCH", headers: TRAINER, body: { title: { böse: 1 } } });
    expect(bad.status).toBe(400);
  });

  it("liefert Gruppenzuteilungen nur zu sichtbaren Projekten", async () => {
    const open = await project();
    const secret = await project({ is_private: true });
    const [a, b] = [uid("p"), uid("p")];
    await call("/api/choreo/parts", { method: "POST", headers: TRAINER, body: [{ id: a, project_id: open.id }, { id: b, project_id: secret.id }] });
    await call("/api/choreo/group_memberships", {
      method: "POST", headers: TRAINER,
      body: [{ id: uid("m"), part_id: a, person_number: 1, group_number: 1 }, { id: uid("m"), part_id: b, person_number: 1, group_number: 2 }],
    });
    const rows = await (await call(`/api/choreo/group_memberships?part_ids=${a},${b}`)).json();
    expect(rows.map((r) => r.part_id)).toEqual([a]);
  });
});

describe("Bearbeitungssperre", () => {
  const lock = (id, user, action = "") =>
    call(`/api/choreo/projects/${id}/lock${action}`, { method: "POST", headers: TRAINER, body: { user_id: user, user_name: user.toUpperCase() } });

  it("vergibt die Sperre an genau einen und gibt sie wieder frei", async () => {
    const p = await project();
    expect(await (await lock(p.id, "anna")).json()).toEqual({ ok: true });
    expect(await (await lock(p.id, "ben")).json()).toEqual({ ok: false, holder: "ANNA" });
    expect(await (await lock(p.id, "anna", "/renew")).json()).toEqual({ ok: true });
    expect(await (await lock(p.id, "ben", "/renew")).json()).toEqual({ ok: false });
    await lock(p.id, "anna", "/release");
    expect(await (await lock(p.id, "ben")).json()).toEqual({ ok: true });
  });

  it("lässt eine verwaiste Sperre nach 30 Sekunden übernehmen", async () => {
    const p = await project();
    await env.DB.prepare("UPDATE projects SET locked_by = 'alt', locked_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 31000).toISOString(), p.id).run();
    expect(await (await lock(p.id, "neu")).json()).toEqual({ ok: true });
  });
});

describe("Musik", () => {
  it("nimmt MP3/WAV an und liefert sie aus", async () => {
    const up = await call("/api/choreo/audio/lied.mp3", { method: "PUT", headers: { ...TRAINER, "content-length": "4" }, raw: "ID3x" });
    expect(up.status).toBe(201);
    const { url } = await up.json();
    expect(url).toMatch(/^\/api\/choreo\/audio\/[0-9a-f-]+\.mp3$/);
    const res = await call(url);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(await res.text()).toBe("ID3x");
  });

  it("lehnt andere Formate und Nicht-Trainer ab", async () => {
    expect((await call("/api/choreo/audio/x.m4a", { method: "PUT", headers: { ...TRAINER, "content-length": "1" }, raw: "x" })).status).toBe(415);
    expect((await call("/api/choreo/audio/x.mp3", { method: "PUT", headers: { ...GROUP, "content-length": "1" }, raw: "x" })).status).toBe(401);
    expect((await call("/api/choreo/audio/../../raw/geheim.mp3")).status).toBe(404);
  });
});
