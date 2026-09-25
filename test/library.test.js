import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index.js";

const BASE = "https://formation.nils-meier.de";
const GROUP = { "x-portal-code": "gruppe-test" };
const TRAINER = { "x-portal-code": "tagger-test" };

async function call(path, { method = "GET", headers = TRAINER, body } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body);
    init.headers["content-type"] ??= "application/json";
  }
  return worker.fetch(new Request(BASE + path, init), env);
}
const data = async (res) => (res.status === 204 ? null : res.json());

const uid = () => crypto.randomUUID();

async function project(name, extra = {}) {
  const id = `${name}-${uid().slice(0, 8)}`;
  await env.DB.prepare("INSERT INTO projects (id, title, created_at, is_private) VALUES (?, ?, ?, ?)")
    .bind(id, extra.title ?? id, "2026-09-01T00:00:00Z", extra.is_private ? 1 : 0).run();
  return id;
}

/** Fertiges Video direkt in der DB (Upload wird in videos.test.js geprüft). */
async function readyVideo(id, recordedAt = "2026-09-24T10:00:00Z") {
  await env.DB.prepare(
    `INSERT INTO video (id, storage_key, size_bytes, file_state, tag_state, recorded_at, created_at)
     VALUES (?, ?, 1, 'ready', 'untagged', ?, ?)`
  ).bind(id, `raw/${id}.mp4`, recordedAt, "2026-09-24T10:00:00Z").run();
  return id;
}
let V1, V2;
beforeEach(() => { V1 = uid(); V2 = uid(); });

async function setup() {
  const { id: kuer } = await data(await call("/api/choreos", { method: "POST", body: { title: "Kür 2026" } }));
  const { id: std } = await data(await call(`/api/choreos/${kuer}/dances`, { method: "POST", body: { name: "Standard" } }));
  const { id: lat } = await data(await call(`/api/choreos/${kuer}/dances`, { method: "POST", body: { name: "Latein" } }));
  const voll = await project("audio-voll");
  const latein = await project("audio-latein");
  return { kuer, std, lat, voll, latein };
}

describe("Bibliothek", () => {
  it("startet mit den vier Tags", async () => {
    const lib = await data(await call("/api/library", { headers: {} }));
    expect(lib.tags.map((t) => t.name)).toEqual(["Auftritt", "Vortanzen", "Erklärung", "Üben"]);
  });

  it("ändern nur Trainer", async () => {
    expect((await call("/api/choreos", { method: "POST", headers: GROUP, body: { title: "X" } })).status).toBe(401);
    expect((await call("/api/tags", { method: "POST", headers: {}, body: { name: "X" } })).status).toBe(401);
  });

  it("baut Choreo mit Tänzen und Audios auf; die erste Audio wird Hauptaudio", async () => {
    const { kuer, std, lat, voll, latein } = await setup();
    expect((await call(`/api/audios/${voll}`, { method: "PUT", body: { choreo_id: kuer, dance_ids: [std, lat] } })).status).toBe(204);
    await call(`/api/audios/${latein}`, { method: "PUT", body: { choreo_id: kuer, dance_ids: [lat] } });

    const lib = await data(await call("/api/library"));
    const c = lib.choreos.find((x) => x.id === kuer);
    expect(c.main_project_id).toBe(voll);
    expect(c.dances.map((d) => d.name)).toEqual(["Standard", "Latein"]);
    expect(lib.audios.find((a) => a.id === latein)).toMatchObject({ choreo_id: kuer, dance_ids: [lat] });

    // Hauptaudio wechseln – nur innerhalb der Choreo
    expect((await call(`/api/choreos/${kuer}`, { method: "PATCH", body: { main_project_id: latein } })).status).toBe(204);
    const fremd = await project("fremd");
    expect((await call(`/api/choreos/${kuer}`, { method: "PATCH", body: { main_project_id: fremd } })).status).toBe(400);
  });

  it("lehnt Tänze einer anderen Choreo an einer Audio ab", async () => {
    const { kuer, voll } = await setup();
    const { id: other } = await data(await call("/api/choreos", { method: "POST", body: { title: "Andere" } }));
    const { id: fremd } = await data(await call(`/api/choreos/${other}/dances`, { method: "POST", body: { name: "Tanz" } }));
    const res = await call(`/api/audios/${voll}`, { method: "PUT", body: { choreo_id: kuer, dance_ids: [fremd] } });
    expect(res.status).toBe(400);
  });

  it("nimmt einer Choreo die Hauptaudio, wenn die Audio woanders hin wechselt", async () => {
    const { kuer, voll } = await setup();
    const { id: other } = await data(await call("/api/choreos", { method: "POST", body: { title: "Andere" } }));
    await call(`/api/audios/${voll}`, { method: "PUT", body: { choreo_id: kuer } });
    await call(`/api/audios/${voll}`, { method: "PUT", body: { choreo_id: other } });
    const lib = await data(await call("/api/library"));
    expect(lib.choreos.find((c) => c.id === kuer).main_project_id).toBeNull();
    expect(lib.choreos.find((c) => c.id === other).main_project_id).toBe(voll);
  });

  it("zeigt private Audios nur Trainern", async () => {
    const geheim = await project("geheim", { is_private: true });
    const gast = await data(await call("/api/library", { headers: {} }));
    expect(gast.audios.map((a) => a.id)).not.toContain(geheim);
    expect((await data(await call("/api/library"))).audios.map((a) => a.id)).toContain(geheim);
  });

  it("verwaltet Tags; doppelte Namen gibt es nicht", async () => {
    const name = `Technik ${uid().slice(0, 6)}`;
    const { id } = await data(await call("/api/tags", { method: "POST", body: { name } }));
    expect((await call("/api/tags", { method: "POST", body: { name } })).status).toBe(409);
    expect((await call(`/api/tags/${id}`, { method: "PATCH", body: { name: `${name}!` } })).status).toBe(204);
    expect((await call(`/api/tags/${id}`, { method: "DELETE" })).status).toBe(204);
    expect((await call(`/api/tags/${id}`, { method: "DELETE" })).status).toBe(404);
  });

  it("löscht eine Choreo samt Tänzen; Audios und Videos bleiben", async () => {
    const { kuer, std, voll } = await setup();
    await call(`/api/audios/${voll}`, { method: "PUT", body: { choreo_id: kuer, dance_ids: [std] } });
    await readyVideo(V1);
    await call("/api/videos/assign", { method: "POST", body: { ids: [V1], changes: { choreo_id: kuer, dance_ids: [std] } } });

    expect((await call(`/api/choreos/${kuer}`, { method: "DELETE" })).status).toBe(204);
    const audio = await env.DB.prepare("SELECT choreo_id FROM projects WHERE id = ?").bind(voll).first();
    expect(audio.choreo_id).toBeNull();
    const video = await data(await call(`/api/videos/${V1}`));
    expect(video).toMatchObject({ choreo_id: null, dance_ids: [] });
  });
});

describe("Videos zuordnen", () => {
  let ids;
  beforeEach(async () => {
    ids = await setup();
    await call(`/api/audios/${ids.voll}`, { method: "PUT", body: { choreo_id: ids.kuer, dance_ids: [ids.std, ids.lat] } });
    await readyVideo(V1);
    await readyVideo(V2, "2026-09-24T10:00:03Z");
  });
  const assign = (body, headers) => call("/api/videos/assign", { method: "POST", body, headers });

  it("ordnet mehrere Videos auf einmal zu", async () => {
    const res = await assign({
      ids: [V1, V2],
      changes: {
        choreo_id: ids.kuer,
        dance_ids: [ids.lat],
        tag_ids: ["tag-ueben", "tag-vortanzen"],
        audio: { project_id: ids.voll, start_s: 25.2, end_s: 32.2 },
        tag_state: "tagged",
        tagged_by: "Nils",
      },
    });
    expect(res.status).toBe(200);
    const { videos } = await res.json();
    expect(videos).toHaveLength(2);
    for (const v of videos) {
      expect(v).toMatchObject({
        choreo_id: ids.kuer,
        dance_ids: [ids.lat],
        audio_project_id: ids.voll,
        audio_start_s: 25.2,
        audio_end_s: 32.2,
        tag_state: "tagged",
      });
      expect(v.tag_ids.sort()).toEqual(["tag-ueben", "tag-vortanzen"]);
    }
    const row = await env.DB.prepare("SELECT tagged_by, tagged_at FROM video WHERE id = ?").bind(V1).first();
    expect(row.tagged_by).toBe("Nils");
    expect(row.tagged_at).toBeTruthy();
  });

  it("ändert nur, was mitgeschickt wird", async () => {
    await assign({ ids: [V1], changes: { choreo_id: ids.kuer, tag_ids: ["tag-auftritt"] } });
    await assign({ ids: [V1], changes: { title: "Generalprobe" } });
    const v = await data(await call(`/api/videos/${V1}`));
    expect(v).toMatchObject({ choreo_id: ids.kuer, tag_ids: ["tag-auftritt"], title: "Generalprobe" });
  });

  it("korrigiert die Aufnahmezeit von Hand", async () => {
    await assign({ ids: [V1], changes: { recorded_at: "2026-09-20T18:00:00+02:00" } });
    const v = await data(await call(`/api/videos/${V1}`));
    expect(v).toMatchObject({ recorded_at: "2026-09-20T16:00:00.000Z", recorded_source: "manual" });
  });

  it("prüft Zeitraum, Tänze und Audio gegen die Choreo", async () => {
    const bad = (changes) => assign({ ids: [V1], changes }).then((r) => r.status);
    expect(await bad({ choreo_id: ids.kuer, audio: { project_id: ids.voll, start_s: 10, end_s: 5 } })).toBe(400);
    expect(await bad({ choreo_id: ids.kuer, audio: { project_id: ids.latein, start_s: 1, end_s: 5 } })).toBe(400); // andere Choreo (keine)
    expect(await bad({ dance_ids: [ids.std] })).toBe(400); // Video hat noch keine Choreo
    expect(await bad({ tag_ids: ["gibts-nicht"] })).toBe(400);
    expect(await bad({ choreo_id: "gibts-nicht" })).toBe(400);
  });

  it("entfernt Tänze, wenn die Choreo wechselt", async () => {
    await assign({ ids: [V1], changes: { choreo_id: ids.kuer, dance_ids: [ids.std] } });
    const { id: other } = await data(await call("/api/choreos", { method: "POST", body: { title: "Andere" } }));
    await assign({ ids: [V1], changes: { choreo_id: other } });
    expect((await data(await call(`/api/videos/${V1}`))).dance_ids).toEqual([]);
  });

  it("nimmt den Zeitraum wieder weg", async () => {
    await assign({ ids: [V1], changes: { choreo_id: ids.kuer, audio: { project_id: ids.voll, start_s: 1, end_s: 2 } } });
    await assign({ ids: [V1], changes: { audio: null } });
    expect(await data(await call(`/api/videos/${V1}`))).toMatchObject({ audio_project_id: null, audio_start_s: null });
  });

  it("dürfen nur Trainer", async () => {
    expect((await assign({ ids: [V1], changes: { title: "x" } }, GROUP)).status).toBe(401);
    expect((await assign({ ids: [], changes: {} })).status).toBe(400);
    expect((await assign({ ids: ["33333333-3333-4333-8333-333333333333"], changes: {} })).status).toBe(404);
  });
});

describe("Papierkorb und Vorschaubild", () => {
  it("legt Videos in den Papierkorb (nur Trainer)", async () => {
    await readyVideo(V1);
    expect((await call(`/api/videos/${V1}`, { method: "DELETE", headers: GROUP })).status).toBe(401);
    expect((await call(`/api/videos/${V1}`, { method: "DELETE" })).status).toBe(204);
    expect((await call(`/api/videos/${V1}`)).status).toBe(404);
    const { videos } = await data(await call("/api/videos"));
    expect(videos.map((v) => v.id)).not.toContain(V1);
  });

  it("speichert ein Vorschaubild einmal", async () => {
    await readyVideo(V1);
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const put = (body, type = "image/jpeg") =>
      call(`/api/videos/${V1}/thumb`, { method: "PUT", headers: { ...GROUP, "content-type": type }, body });
    expect((await put(jpeg, "image/png")).status).toBe(415);
    expect((await put(new Uint8Array([1, 2, 3]))).status).toBe(415);
    const res = await put(jpeg);
    expect(res.status).toBe(200);
    expect((await res.json()).thumb_url).toBe(`https://media.formation.nils-meier.de/thumb/${V1}.jpg`);
    expect(await env.BUCKET.head(`thumb/${V1}.jpg`)).not.toBeNull();
    expect((await put(jpeg)).status).toBe(409);
    expect((await data(await call(`/api/videos/${V1}`))).thumb_url).toContain(`thumb/${V1}.jpg`);
  });
});
