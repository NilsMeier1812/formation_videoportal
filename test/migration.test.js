import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { audioFileName, buildMigration, reportMarkdown, sqlValue } from "../scripts/migration-lib.mjs";
import worker from "../src/index.js";

const SB = "https://qgklrvagzfvqbbpgpfdl.supabase.co/storage/v1/object/public/audio-tracks";
const call = (path, headers = { "x-portal-code": "gruppe-test" }) => worker.fetch(new Request(`https://formation.nils-meier.de${path}`, { headers }), env);

// So sehen die Zeilen aus, wie die Supabase-REST-Schnittstelle sie liefert
const supabase = {
  projects: [
    { id: "a1b2c3d4-0000-4000-8000-000000000001", title: "Kür „Latein“ – O'Neill", bpm: 120, time_signature: "4/4",
      audio_url: `${SB}/8f1c0a2e-1111-4111-8111-111111111111.mp3`, is_private: false, grid_offset: 0,
      locked_by: "irgendwer", locked_by_name: "Anna", locked_at: "2026-09-01T00:00:00Z",
      created_at: "2026-08-01T10:00:00+00:00", updated_at: null, owner_note: "unbekannte Spalte" },
    { id: "a1b2c3d4-0000-4000-8000-000000000002", title: "Geheim", bpm: 100, time_signature: "3/4",
      audio_url: `${SB}/9f1c0a2e-2222-4222-8222-222222222222.wav`, is_private: true, created_at: "2026-08-02T10:00:00+00:00" },
  ],
  tempo_sections: [
    { id: "t1", project_id: "a1b2c3d4-0000-4000-8000-000000000001", sort_index: 0, label: null, start_sec: 0, end_sec: null, bpm: 120, time_signature: "4/4", offset_sec: 0.25 },
  ],
  choreo_segments: [
    { id: "s1", project_id: "a1b2c3d4-0000-4000-8000-000000000001", timestamp: 8, label: "Kreis links", notes: "Zeile 1\nZeile 2; mit 'Apostroph'" },
    { id: "s-waise", project_id: "gibt-es-nicht", timestamp: 1, label: "verwaist" },
  ],
  persons: [{ id: "x1", project_id: "a1b2c3d4-0000-4000-8000-000000000001", number: 1, name: "Anna & Ben" }],
  parts: [{ id: "p1", project_id: "a1b2c3d4-0000-4000-8000-000000000001", sort_index: 0, label: "Kreis", start_sec: 4, end_sec: 10, group_names: { 1: "Innen", 2: "Außen" } }],
  group_memberships: [
    { id: "m1", part_id: "p1", person_number: 1, group_number: 2 },
    { id: "m-waise", part_id: "gibt-es-nicht", person_number: 1, group_number: 1 },
  ],
  steps: [
    { id: "st1", project_id: "a1b2c3d4-0000-4000-8000-000000000001", tempo_section_id: "t1", role: "herren", group_number: 0, beat_pos: 2.5, length_beats: 1, foot: "L", value: null },
    { id: "st2", project_id: "a1b2c3d4-0000-4000-8000-000000000001", tempo_section_id: "t-geloescht", role: "note", group_number: 0, beat_pos: 4, length_beats: 1, foot: null, value: "Hebung" },
  ],
};

describe("Übernahme aus Supabase", () => {
  it("baut SQL-Werte sicher", () => {
    expect(sqlValue("O'Neill")).toBe("'O''Neill'");
    expect(sqlValue(true)).toBe("1");
    expect(sqlValue(null)).toBe("NULL");
    expect(sqlValue({ 1: "a" })).toBe(`'{"1":"a"}'`);
    expect(audioFileName(`${SB}/x-1.mp3`)).toBe("x-1.mp3");
    expect(audioFileName("https://example.com/lied.mp3")).toBeNull();
  });

  it("übernimmt alles in D1 und die API liefert es wie Supabase", async () => {
    const { statements, report } = buildMigration(supabase);
    await env.DB.batch(statements.map((s) => env.DB.prepare(s)));

    const projects = await (await call("/api/choreo/projects", { "x-portal-code": "tagger-test" })).json();
    const kuer = projects.find((p) => p.id.endsWith("1"));
    expect(kuer.title).toBe("Kür „Latein“ – O'Neill");
    expect(kuer.audio_url).toBe("/api/choreo/audio/8f1c0a2e-1111-4111-8111-111111111111.mp3");
    expect(kuer.is_private).toBe(false);
    expect(projects.find((p) => p.id.endsWith("2")).is_private).toBe(true);
    const lock = await env.DB.prepare("SELECT locked_by FROM projects WHERE id = ?").bind(kuer.id).first();
    expect(lock.locked_by).toBeNull(); // Sperren werden nicht übernommen

    const segs = await (await call(`/api/choreo/projects/${kuer.id}/choreo_segments`)).json();
    expect(segs).toHaveLength(1);
    expect(segs[0].notes).toBe("Zeile 1\nZeile 2; mit 'Apostroph'");
    const parts = await (await call(`/api/choreo/projects/${kuer.id}/parts`)).json();
    expect(parts[0].group_names).toEqual({ 1: "Innen", 2: "Außen" });
    const members = await (await call("/api/choreo/group_memberships?part_ids=p1")).json();
    expect(members).toEqual([{ id: "m1", part_id: "p1", person_number: 1, group_number: 2 }]);
    const steps = await (await call(`/api/choreo/projects/${kuer.id}/steps`)).json();
    expect(steps.find((s) => s.id === "st2").tempo_section_id).toBeNull();
    const tempo = await (await call(`/api/choreo/projects/${kuer.id}/tempo_sections`)).json();
    expect(tempo[0].offset_sec).toBe(0.25);

    expect(report.counts.choreo_segments).toEqual({ supabase: 2, uebernommen: 1 });
    expect(report.counts.group_memberships).toEqual({ supabase: 2, uebernommen: 1 });
    expect(report.unknownColumns.projects).toEqual(["owner_note"]);
    expect(report.audio.map((a) => a.file)).toHaveLength(2);
    const md = reportMarkdown(report, { mode: "probelauf" });
    expect(md).toContain("| choreo_segments | 2 | 1 |");
    expect(md).toContain("owner_note");
    expect(md).toContain("Probelauf");
  });

  it("lässt sich wiederholen, ohne etwas zu verdoppeln", async () => {
    const { statements } = buildMigration(supabase);
    await env.DB.batch(statements.map((s) => env.DB.prepare(s)));
    await env.DB.batch(statements.map((s) => env.DB.prepare(s)));
    const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM steps WHERE project_id LIKE 'a1b2c3d4-%'").first();
    expect(n).toBe(2);
  });
});
