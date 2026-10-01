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

describe("Audio austauschen / alles verschieben", () => {
  const rows = (table, id) => call(`/api/choreo/projects/${id}/${table}`).then((r) => r.json());
  async function setup() {
    const p = await project();
    const t1 = uid("t"), t2 = uid("t");
    const post = (table, body) => call(`/api/choreo/${table}`, { method: "POST", headers: TRAINER, body });
    await post("tempo_sections", [
      { id: t1, project_id: p.id, start_sec: 0, end_sec: 10, bpm: 120, time_signature: "4/4", offset_sec: 0.5 },
      { id: t2, project_id: p.id, start_sec: 10, end_sec: null, bpm: 100, time_signature: "4/4", offset_sec: 10 },
    ]);
    await post("steps", [
      { id: uid("s"), project_id: p.id, tempo_section_id: t1, role: "herren", beat_pos: 0, length_beats: 1 }, // 0,5 s
      { id: uid("s"), project_id: p.id, tempo_section_id: t1, role: "damen", beat_pos: 4, length_beats: 1 }, // 2,5 s
      { id: uid("s"), project_id: p.id, tempo_section_id: t2, role: "note", beat_pos: 5, length_beats: 1, value: "Hebung" }, // 13 s
    ]);
    await post("choreo_segments", [{ id: uid("m"), project_id: p.id, timestamp: 1, label: "Start" }, { id: uid("m"), project_id: p.id, timestamp: 12, label: "Mitte" }]);
    await post("parts", [{ id: uid("pa"), project_id: p.id, start_sec: 2, end_sec: 6, group_names: { 1: "A" } }]);
    const v = uid("v");
    await env.DB.prepare(
      `INSERT INTO video (id, storage_key, size_bytes, file_state, tag_state, created_at, audio_project_id, audio_start_s, audio_end_s)
       VALUES (?, ?, 1, 'ready', 'tagged', '2026-09-30T10:00:00Z', ?, 3, 8)`
    ).bind(v, `raw/${v}.mp4`, p.id).run();
    return { p, t1, t2, v };
  }
  const shift = (id, body, headers = TRAINER) => call(`/api/choreo/projects/${id}/shift`, { method: "POST", headers, body });

  it("Intro vorne: alles wandert nach hinten, der erste Abschnitt deckt das Intro ab, Datei wird getauscht", async () => {
    const { p, t1, t2, v } = await setup();
    const up = await call("/api/choreo/audio/neu.mp3", { method: "PUT", headers: { ...TRAINER, "content-length": "4" }, raw: "ID3x" });
    const { url } = await up.json();
    expect((await shift(p.id, { shift_s: 8, audio_url: url })).status).toBe(204);

    const tempo = await rows("tempo_sections", p.id);
    expect(tempo.find((t) => t.id === t1)).toMatchObject({ start_sec: 0, end_sec: 18, offset_sec: 8.5 });
    expect(tempo.find((t) => t.id === t2)).toMatchObject({ start_sec: 18, end_sec: null, offset_sec: 18 });
    expect((await rows("steps", p.id)).length).toBe(3); // Beats unverändert → Zeit + 8 s
    expect((await rows("choreo_segments", p.id)).map((s) => s.timestamp)).toEqual([9, 20]);
    expect((await rows("parts", p.id))[0]).toMatchObject({ start_sec: 10, end_sec: 14 });
    const video = await env.DB.prepare("SELECT audio_start_s, audio_end_s FROM video WHERE id = ?").bind(v).first();
    expect(video).toEqual({ audio_start_s: 11, audio_end_s: 16 });
    const list = await call("/api/choreo/projects", { headers: TRAINER }).then((r) => r.json());
    expect(list.find((x) => x.id === p.id).audio_url).toBe(url);
  });

  it("vorne gekürzt: was vor 0 rutscht, entfällt", async () => {
    const { p, v } = await setup();
    expect((await shift(p.id, { shift_s: -2 })).status).toBe(204);
    const steps = await rows("steps", p.id);
    expect(steps.map((s) => s.role).sort()).toEqual(["damen", "note"]); // der Schritt bei 0,5 s ist weg
    expect((await rows("choreo_segments", p.id)).map((s) => s.label)).toEqual(["Mitte"]);
    expect((await rows("tempo_sections", p.id))[0]).toMatchObject({ start_sec: 0, end_sec: 8, offset_sec: -1.5 });
    const video = await env.DB.prepare("SELECT audio_start_s, audio_end_s FROM video WHERE id = ?").bind(v).first();
    expect(video).toEqual({ audio_start_s: 1, audio_end_s: 6 });
  });

  it("prüft Rechte, Versatz und Datei", async () => {
    const { p } = await setup();
    expect((await shift(p.id, { shift_s: 1 }, GROUP)).status).toBe(401);
    expect((await shift(p.id, { shift_s: 9999 })).status).toBe(400);
    expect((await shift(p.id, { shift_s: 0, audio_url: "/api/choreo/audio/gibtsnicht.mp3" })).status).toBe(400);
    expect((await shift(p.id, { shift_s: 0, audio_url: "https://evil.example/x.mp3" })).status).toBe(400);
    expect((await shift("gibt-es-nicht", { shift_s: 1 })).status).toBe(404);
  });
});

describe("Aus einer anderen Audio übernehmen", () => {
  const imp = (id, body, headers = TRAINER) => call(`/api/choreo/projects/${id}/import`, { method: "POST", headers, body });
  async function target() {
    const p = await project();
    const t = uid("t");
    await call("/api/choreo/tempo_sections", { method: "POST", headers: TRAINER, body: { id: t, project_id: p.id, start_sec: 0, bpm: 120, time_signature: "4/4", offset_sec: 0 } });
    await call("/api/choreo/steps", { method: "POST", headers: TRAINER, body: [
      { id: uid("s"), project_id: p.id, tempo_section_id: t, role: "herren", beat_pos: 1, length_beats: 1 },
      { id: uid("s"), project_id: p.id, tempo_section_id: t, role: "note", beat_pos: 2, length_beats: 1, value: "alt" },
    ] });
    return { p, t };
  }

  it("ersetzt auf Wunsch nur die gewählte Art und fügt alles in einem Rutsch ein", async () => {
    const { p, t } = await target();
    const part = uid("pa");
    const res = await imp(p.id, {
      clear: ["steps", "pairs"],
      rows: {
        steps: [{ tempo_section_id: t, role: "damen", beat_pos: 3, length_beats: 1, foot: "L", project_id: "fremd" }],
        persons: [{ number: 1, name: "Anna & Ben" }],
        parts: [{ id: part, start_sec: 1, end_sec: 4, group_names: { 1: "Innen" } }],
        group_memberships: [{ part_id: part, person_number: 1, group_number: 1 }],
        choreo_segments: [{ timestamp: 2, label: "Neu" }],
      },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).inserted).toBe(5);
    const steps = await call(`/api/choreo/projects/${p.id}/steps`).then((r) => r.json());
    expect(steps.map((s) => s.role).sort()).toEqual(["damen", "note"]); // alter Leader-Schritt ersetzt, Notiz bleibt
    expect((await call(`/api/choreo/projects/${p.id}/persons`).then((r) => r.json()))[0].name).toBe("Anna & Ben");
  });

  it("lehnt fremde Abschnitte, Rechte und Unbekanntes ab – ohne halbe Sachen", async () => {
    const { p, t } = await target();
    const other = await target();
    expect((await imp(p.id, { rows: { steps: [{ tempo_section_id: other.t, role: "herren", beat_pos: 0 }] } })).status).toBe(400);
    expect((await imp(p.id, { rows: { group_memberships: [{ part_id: "fremd", person_number: 1, group_number: 1 }] } })).status).toBe(400);
    expect((await imp(p.id, { clear: ["alles"] })).status).toBe(400);
    expect((await imp(p.id, { rows: { projects: [] } })).status).toBe(400);
    expect((await imp(p.id, { rows: {} }, GROUP)).status).toBe(401);
    // gültige Zeile + ungültige → nichts geschrieben, auch nicht das Löschen
    const bad = await imp(p.id, { clear: ["notes"], rows: { steps: [
      { tempo_section_id: t, role: "herren", beat_pos: 0 },
      { tempo_section_id: other.t, role: "herren", beat_pos: 0 },
    ] } });
    expect(bad.status).toBe(400);
    expect((await call(`/api/choreo/projects/${p.id}/steps`).then((r) => r.json())).length).toBe(2);
  });
});
