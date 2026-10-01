import { describe, expect, it } from "vitest";
import { buildCopy } from "../../public/js/choreo/lib/transfer.js";
import { stepTime } from "../../public/js/choreo/lib/timeline.js";

// Quelle: 120 BPM ab 0,5 s (1 Beat = 0,5 s)
const tempo = [{ id: "q", start_sec: 0, end_sec: null, bpm: 120, time_signature: "4/4", offset_sec: 0.5 }];
const step = (id, role, beat, extra = {}) => ({ id, role, tempo_section_id: "q", beat_pos: beat, length_beats: 1, group_number: 0, foot: "L", ...extra });
const steps = [step("a", "herren", 0), step("b", "damen", 4, { group_number: 2 }), step("c", "note", 8, { value: "Hebung" }), step("d", "herren", 40)];
const segments = [{ id: "m1", timestamp: 1, label: "Start" }, { id: "m2", timestamp: 15, label: "Ende" }];
const persons = [{ id: "p1", number: 1, name: "Anna" }, { id: "p2", number: 2, name: "Ben" }];
const parts = [{ id: "pa", start_sec: 2, end_sec: 6, label: "Kreis", group_names: { 1: "Innen" } }];
const memberships = [{ id: "g1", part_id: "pa", person_number: 1, group_number: 1 }];
const all = { steps: true, notes: true, segments: true, pairs: true, replace: true };
const run = (target, opts, extra = {}) => buildCopy({
  tempo, steps, segments, persons, parts, memberships, target, targetId: "ziel",
  duration: 30, existingNumbers: new Set(), opts: { shift: 0, from: null, to: null, ...all, ...opts }, ...extra,
});

describe("Aus einer anderen Audio übernehmen", () => {
  it("gleiches Tempo, 8 s Intro davor: Zeiten + 8 s, Beats im neuen Raster", () => {
    const target = [{ id: "z", start_sec: 0, end_sec: null, bpm: 120, time_signature: "4/4", offset_sec: 8.5 }];
    const { rows, counts, clear } = run(target, { shift: 8 });
    expect(counts).toMatchObject({ steps: 3, notes: 1, segments: 2, persons: 2, parts: 1 });
    const times = rows.steps.map((s) => stepTime(s, target));
    expect(times).toEqual([8.5, 10.5, 12.5, 28.5]);
    expect(rows.steps.map((s) => s.beat_pos)).toEqual([0, 4, 8, 40]);
    expect(rows.steps[1]).toMatchObject({ role: "damen", group_number: 2, foot: "L", project_id: "ziel", tempo_section_id: "z" });
    expect(rows.steps[2].value).toBe("Hebung");
    expect(rows.choreo_segments.map((s) => s.timestamp)).toEqual([9, 23]);
    expect(rows.parts[0]).toMatchObject({ start_sec: 10, end_sec: 14, project_id: "ziel" });
    expect(rows.group_memberships[0]).toMatchObject({ part_id: rows.parts[0].id, person_number: 1, group_number: 1 });
    expect(clear).toEqual(["steps", "notes", "segments", "pairs"]);
  });

  it("anderes Raster im Ziel: legt auf den nächsten ½-Beat, wählt den Abschnitt an der Zeit", () => {
    const target = [
      { id: "z1", start_sec: 0, end_sec: 5, bpm: 100, time_signature: "4/4", offset_sec: 0 }, // 0,6 s/Beat
      { id: "z2", start_sec: 5, end_sec: null, bpm: 120, time_signature: "3/4", offset_sec: 5 },
    ];
    const { rows } = run(target, { notes: false, segments: false, pairs: false });
    expect(rows.steps[0]).toMatchObject({ tempo_section_id: "z1", beat_pos: 1 }); // 0,5 s → 0,83 Beats → 1
    expect(rows.steps[1]).toMatchObject({ tempo_section_id: "z1", beat_pos: 4 }); // 2,5 s → 4,17 → 4
    expect(rows.steps[2]).toMatchObject({ tempo_section_id: "z2", beat_pos: 31 }); // 20,5 s → (15,5 / 0,5) = 31
  });

  it("Bereich, Arten und Grenzen der Ziel-Audio", () => {
    const target = [{ id: "z", start_sec: 0, end_sec: null, bpm: 120, time_signature: "4/4", offset_sec: 0.5 }];
    // nur 2–10 s der Quelle, nur Schritte; nach vorn verschoben → 0,5 s-Schritt fällt eh raus
    const a = run(target, { from: 2, to: 10, notes: false, segments: false, pairs: false, replace: false });
    expect(a.rows.steps.map((s) => s.role)).toEqual(["damen"]);
    expect(a.clear).toEqual([]);
    // Verschiebung über das Ende (30 s) hinaus → fällt weg und wird gezählt
    const b = run(target, { shift: 15 });
    expect(b.counts.outside).toBeGreaterThan(0);
    expect(b.rows.steps.every((s) => stepTime(s, target) <= 30.05)).toBe(true);
  });

  it("vorhandene Paare bleiben, wenn nicht ersetzt wird", () => {
    const target = [{ id: "z", start_sec: 0, end_sec: null, bpm: 120, time_signature: "4/4", offset_sec: 0 }];
    const { rows } = run(target, { replace: false }, { existingNumbers: new Set([1]) });
    expect(rows.persons.map((p) => p.number)).toEqual([2]);
  });
});
