import { describe, expect, it } from "vitest";
import { countsAsTraining, trainingDays, trainingLabel, videoDay } from "../../public/js/lib/trainings.js";

const v = (recorded_at, created_at = "2026-11-05T10:00:00Z") => ({ recorded_at, created_at });

describe("Trainingstage", () => {
  it("Berliner Kalendertag, sonst Upload-Zeit", () => {
    expect(videoDay(v("2026-11-01T22:30:00Z"))).toBe("2026-11-01"); // 23:30 Winterzeit
    expect(videoDay(v("2026-11-01T23:30:00Z"))).toBe("2026-11-02"); // 00:30 am Montag
    expect(videoDay(v(null, "2026-10-25T09:00:00Z"))).toBe("2026-10-25");
    expect(videoDay({})).toBeNull();
  });

  it("sonntags ab 1 Video, sonst ab 2", () => {
    expect(countsAsTraining("2026-11-01", 1)).toBe(true); // Sonntag
    expect(countsAsTraining("2026-11-04", 1)).toBe(false); // Mittwoch
    expect(countsAsTraining("2026-11-04", 2)).toBe(true);
  });

  it("neueste zuerst; ausgeblendete fehlen (oder sind markiert)", () => {
    const videos = [
      v("2026-11-01T10:00:00Z"), // So, 1 Video → Training
      v("2026-11-04T17:00:00Z"), v("2026-11-04T18:00:00Z"), // Mi, 2 → Training
      v("2026-11-05T17:00:00Z"), // Do, 1 → nein
      v("2026-10-25T10:00:00Z"), v("2026-10-25T11:00:00Z"), v("2026-10-25T12:00:00Z"), // So, 3
    ];
    expect(trainingDays(videos)).toEqual([
      { day: "2026-11-04", count: 2 }, { day: "2026-11-01", count: 1 }, { day: "2026-10-25", count: 3 },
    ]);
    expect(trainingDays(videos, ["2026-11-04"]).map((t) => t.day)).toEqual(["2026-11-01", "2026-10-25"]);
    expect(trainingDays(videos, ["2026-11-04"], { includeExcluded: true })[0]).toEqual({ day: "2026-11-04", count: 2, excluded: true });
    expect(trainingDays([])).toEqual([]);
  });

  it("Beschriftung", () => {
    expect(trainingLabel("2026-11-01")).toBe("So 01.11.");
    expect(trainingLabel("2026-11-04")).toBe("Mi 04.11.");
  });
});
