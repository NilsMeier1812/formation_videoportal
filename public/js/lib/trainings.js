// Trainingstage aus den Aufnahmezeiten (rein, testbar) – für „Letztes Training“ in der Videothek.
//
// Ein Tag (Berliner Zeit) zählt als Training: sonntags ab 1 Video, an anderen Tagen ab 2.
// Ohne Aufnahmezeit zählt der Upload-Zeitpunkt. Tage, die Trainer mit „Kein Training“
// ausgeblendet haben (Server: training_exclusions), zählen nicht.

const WEEKDAYS = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
const fmtDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" });

/** Kalendertag in Berlin („YYYY-MM-DD“), an dem das Video aufgenommen wurde. */
export function videoDay(video) {
  const iso = video.recorded_at || video.created_at;
  if (!iso) return null;
  const t = Date.parse(iso.includes("T") ? iso : `${iso}T12:00:00`);
  return Number.isNaN(t) ? null : fmtDay.format(new Date(t));
}

/** 0 = Sonntag … 6 = Samstag */
export function weekdayOf(day) {
  return new Date(`${day}T12:00:00Z`).getUTCDay();
}

export function countsAsTraining(day, count) {
  return weekdayOf(day) === 0 ? count >= 1 : count >= 2;
}

/**
 * Trainingstage, neueste zuerst: [{ day, count }].
 * `excluded`: ausgeblendete Tage; mit `{ includeExcluded: true }` kommen sie mit `excluded: true` dazu.
 */
export function trainingDays(videos, excluded = [], { includeExcluded = false } = {}) {
  const counts = new Map();
  for (const v of videos) {
    const day = videoDay(v);
    if (day) counts.set(day, (counts.get(day) || 0) + 1);
  }
  const hidden = new Set(excluded);
  return [...counts]
    .filter(([day, count]) => countsAsTraining(day, count) && (includeExcluded || !hidden.has(day)))
    .map(([day, count]) => ({ day, count, ...(includeExcluded ? { excluded: hidden.has(day) } : {}) }))
    .sort((a, b) => b.day.localeCompare(a.day));
}

/** „So 02.11.“ */
export function trainingLabel(day) {
  const [, m, d] = day.split("-");
  return `${WEEKDAYS[weekdayOf(day)]} ${d}.${m}.`;
}
