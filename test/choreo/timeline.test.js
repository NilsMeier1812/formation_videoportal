import { describe, expect, it } from "vitest";
import {
  barLength,
  beatsPerBar,
  countInBar,
  groupNameOf,
  groupNumbersOf,
  groupOf,
  audioLooksTruncated,
  groupSpans,
  lastDataTime,
  groupTimeline,
  spanIndexAt,
  isOffbeat,
  rangeAt,
  segmentAt,
  snapBeat,
  sortBy,
  stepTime,
  tempoAt,
} from "../../public/js/choreo/lib/timeline.js";

const tempo = (over = {}) => ({ id: "t1", start_sec: 0, end_sec: null, bpm: 120, time_signature: "4/4", offset_sec: 0, ...over });

describe("Takt und Beats", () => {
  it("liest die Schläge pro Takt aus der Taktart", () => {
    expect(beatsPerBar("3/4")).toBe(3);
    expect(beatsPerBar("6/8")).toBe(6);
    expect(beatsPerBar(undefined)).toBe(4);
    expect(beatsPerBar("unsinn")).toBe(4);
  });

  it("berechnet die Taktlänge", () => {
    expect(barLength(tempo())).toBe(2); // 4 × 0,5 s
    expect(barLength(tempo({ bpm: 90, time_signature: "3/4" }))).toBe(2);
    expect(barLength(null)).toBe(0);
  });

  it("rastet auf halbe Beats ein und bleibt nicht negativ", () => {
    const t = tempo({ offset_sec: 1 });
    expect(snapBeat(t, 1.0)).toBe(0);
    expect(snapBeat(t, 1.26)).toBe(0.5);
    expect(snapBeat(t, 2.0)).toBe(2);
    expect(snapBeat(t, 0.2)).toBe(0);
  });

  it("rechnet Schritte über ihren Tempo-Abschnitt in Sekunden um", () => {
    const sections = [tempo({ id: "a", offset_sec: 2 })];
    expect(stepTime({ tempo_section_id: "a", beat_pos: 4 }, sections)).toBe(4);
    expect(stepTime({ tempo_section_id: "fehlt", beat_pos: 4 }, sections)).toBeNull();
  });

  it("erkennt Offbeats und die Zählzeit im Takt", () => {
    expect(isOffbeat({ beat_pos: 2.5 })).toBe(true);
    expect(isOffbeat({ beat_pos: 3 })).toBe(false);
    expect(countInBar({ beat_pos: 0 }, tempo())).toBe(1);
    expect(countInBar({ beat_pos: 5 }, tempo())).toBe(2);
    expect(countInBar({ beat_pos: 5 }, tempo({ time_signature: "3/4" }))).toBe(3);
  });
});

describe("Zeitbereiche", () => {
  const sorted = sortBy([
    { id: "b", start_sec: 10, end_sec: null },
    { id: "a", start_sec: 0, end_sec: 10 },
  ], "start_sec");

  it("sortiert nach Zahlenwert", () => {
    expect(sorted.map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("findet den Bereich; Ende ist exklusiv, leeres Ende läuft bis zum Schluss", () => {
    expect(rangeAt(sorted, 0)?.id).toBe("a");
    expect(rangeAt(sorted, 9.99)?.id).toBe("a");
    expect(rangeAt(sorted, 10)?.id).toBe("b");
    expect(rangeAt(sorted, 999)?.id).toBe("b");
    expect(rangeAt([{ id: "x", start_sec: 5, end_sec: 6 }], 1)).toBeNull();
  });

  it("nimmt außerhalb aller Tempo-Abschnitte den ersten", () => {
    const list = [tempo({ id: "x", start_sec: 5, end_sec: 6 })];
    expect(tempoAt(list, 1)?.id).toBe("x");
    expect(tempoAt([], 1)).toBeNull();
  });

  it("findet die zuletzt erreichte Sprungmarke", () => {
    const segs = [{ id: "1", timestamp: 0 }, { id: "2", timestamp: 5 }];
    expect(segmentAt(segs, 4.9)?.id).toBe("1");
    expect(segmentAt(segs, 4.9995)?.id).toBe("2"); // 1 ms Toleranz
    expect(segmentAt([{ id: "1", timestamp: 3 }], 1)).toBeNull();
  });
});

describe("Gruppen", () => {
  const parts = [
    { id: "p1", start_sec: 10, end_sec: 20, group_names: { 1: "Links", 2: " " } },
    { id: "p2", start_sec: 20, end_sec: 30, group_names: {} },
    { id: "p3", start_sec: 40, end_sec: 50, group_names: { 1: "Vorne" } },
  ];
  const memberships = [
    { part_id: "p1", person_number: 3, group_number: 1 },
    { part_id: "p3", person_number: 3, group_number: 1 },
  ];

  it("liefert Gruppe, Nummern und Namen", () => {
    expect(groupOf(memberships, parts[0], 3)).toBe(1);
    expect(groupOf(memberships, parts[1], 3)).toBe(0);
    expect(groupOf(memberships, null, 3)).toBe(0);
    expect(groupNumbersOf(parts[0])).toEqual([1, 2]);
    expect(groupNameOf(parts[0], 1)).toBe("Links");
    expect(groupNameOf(parts[0], 2)).toBe("Gruppe 2"); // leerer Name
    expect(groupNameOf(parts[0], 0)).toBe("alle");
  });

  it("baut den Gruppenverlauf mit Lücken und fasst Gleiches zusammen", () => {
    expect(groupTimeline(parts, memberships, 3, 60)).toEqual([
      "Alle gleich", "Links", "Alle gleich", "Vorne", "Alle gleich",
    ]);
    expect(groupTimeline(parts, memberships, 0, 60)).toEqual([]);
    expect(groupTimeline([], [], 3, 60)).toEqual(["Alle gleich"]);
  });

  it("kennt die Startzeiten und den laufenden Eintrag", () => {
    const spans = groupSpans(parts, memberships, 3, 60);
    expect(spans.map((x) => x.name)).toEqual(groupTimeline(parts, memberships, 3, 60));
    expect(spans[0].start).toBe(0);
    for (let i = 1; i < spans.length; i++) expect(spans[i].start).toBeGreaterThan(spans[i - 1].start);
    expect(spanIndexAt(spans, 0)).toBe(0);
    expect(spanIndexAt(spans, spans[1].start)).toBe(1);
    expect(spanIndexAt(spans, spans[1].start - 0.01)).toBe(0);
    expect(spanIndexAt(spans, 999)).toBe(spans.length - 1);
    expect(spanIndexAt([], 5)).toBe(-1);
  });
});

describe("Unvollständige Audio erkennen", () => {
  const tempoSections = [
    { id: "t1", start_sec: 0, end_sec: 30, bpm: 120, offset_sec: 0.5 },
    { id: "t2", start_sec: 30, end_sec: null, bpm: 60, offset_sec: 30 },
  ];
  it("späteste Stelle aus Abschnitten, Marken, Gruppen und Schritten", () => {
    expect(lastDataTime({})).toBe(0);
    expect(lastDataTime({ tempoSections })).toBe(30);
    expect(lastDataTime({ tempoSections, segments: [{ timestamp: 51.2 }] })).toBe(51.2);
    expect(lastDataTime({ tempoSections, parts: [{ start_sec: 40, end_sec: 70 }] })).toBe(70);
    // Schritt in t2 bei Beat 100 → 30 + 100 s
    expect(lastDataTime({ tempoSections, steps: [{ tempo_section_id: "t2", beat_pos: 100 }] })).toBe(130);
    expect(lastDataTime({ tempoSections, steps: [{ tempo_section_id: "fehlt", beat_pos: 999 }] })).toBe(30);
  });
  it("zu kurz nur mit deutlichem Abstand", () => {
    expect(audioLooksTruncated(43, 180)).toBe(true);
    expect(audioLooksTruncated(180, 181)).toBe(false); // Spielraum
    expect(audioLooksTruncated(0, 100)).toBe(false); // Länge unbekannt
    expect(audioLooksTruncated(180, 0)).toBe(false); // noch keine Daten
  });
});
