import { describe, expect, it } from "vitest";
import { fillDays, lastDays, shortDay, weekdayAverages } from "../../public/js/lib/usage-stats.js";

describe("Nutzung auswerten", () => {
  const rows = [
    { day: "2026-10-12", devices: 4, trainers: 1, opens: 9 }, // Montag
    { day: "2026-10-15", devices: 2, trainers: 0, opens: 2 }, // Donnerstag
  ];
  const days = fillDays("2026-10-12", "2026-10-25", rows); // zwei Wochen

  it("füllt Lücken mit 0 und kennt den Wochentag", () => {
    expect(days).toHaveLength(14);
    expect(days[0]).toEqual({ day: "2026-10-12", devices: 4, trainers: 1, opens: 9, weekday: 0 });
    expect(days[1]).toMatchObject({ day: "2026-10-13", devices: 0, opens: 0, weekday: 1 });
    expect(days[13]).toMatchObject({ day: "2026-10-25", weekday: 6 });
    expect(shortDay(days[3])).toBe("Do 15.10.");
  });
  it("über Monats- und Jahresgrenze", () => {
    const d = fillDays("2026-12-30", "2027-01-02", []);
    expect(d.map((x) => x.day)).toEqual(["2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02"]);
    expect(fillDays("2026-03-28", "2026-03-30", []).map((x) => x.day)).toEqual(["2026-03-28", "2026-03-29", "2026-03-30"]); // Zeitumstellung
  });
  it("Ø je Wochentag und letzte Tage", () => {
    const w = weekdayAverages(days);
    expect(w[0]).toEqual({ label: "Mo", avg: 2, days: 2 }); // 4 und 0
    expect(w[3].avg).toBe(1);
    expect(w[6]).toEqual({ label: "So", avg: 0, days: 2 });
    expect(lastDays(days, 14)).toEqual({ devicesAvg: 6 / 14, opens: 11 });
    expect(lastDays([], 7)).toEqual({ devicesAvg: 0, opens: 0 });
  });
});
