// Nutzung auswerten (rein, testbar) – Daten von GET /api/usage.

const DAY_MS = 86400000;
const WEEKDAYS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
const toUtc = (day) => Date.parse(`${day}T12:00:00Z`);

/** Alle Tage von `from` bis `today` (Lücken = 0): [{ day, devices, trainers, opens, weekday }] */
export function fillDays(from, today, rows) {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const out = [];
  for (let t = toUtc(from); t <= toUtc(today); t += DAY_MS) {
    const day = new Date(t).toISOString().slice(0, 10);
    const r = byDay.get(day);
    out.push({
      day,
      devices: Number(r?.devices) || 0,
      trainers: Number(r?.trainers) || 0,
      opens: Number(r?.opens) || 0,
      weekday: (new Date(t).getUTCDay() + 6) % 7, // 0 = Montag
    });
  }
  return out;
}

/** Ø Geräte je Wochentag (Mo–So) über die Tage: [{ label, avg, days }] */
export function weekdayAverages(days) {
  return WEEKDAYS.map((label, i) => {
    const list = days.filter((d) => d.weekday === i);
    const sum = list.reduce((a, d) => a + d.devices, 0);
    return { label, avg: list.length ? sum / list.length : 0, days: list.length };
  });
}

/** Summe/Ø der letzten n Tage: { devicesAvg, opens } */
export function lastDays(days, n) {
  const list = days.slice(-n);
  const devices = list.reduce((a, d) => a + d.devices, 0);
  return { devicesAvg: list.length ? devices / list.length : 0, opens: list.reduce((a, d) => a + d.opens, 0) };
}

export const weekdayName = (i) => WEEKDAYS[i];
/** „Mo 13.10.“ */
export function shortDay(d) {
  const [, m, day] = d.day.split("-");
  return `${WEEKDAYS[d.weekday]} ${Number(day)}.${Number(m)}.`;
}
