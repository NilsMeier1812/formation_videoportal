// Trainingstage ausblenden („Kein Training“): Welche Tage Trainings sind, rechnet die App aus
// den Aufnahmezeiten (public/js/lib/trainings.js). Hier steht nur, was Trainer davon
// ausgeblendet haben – für alle gleich. Lesen: mit GET /api/videos (excluded_training_days).
import { requireRole } from "../lib/auth.js";
import { HttpError, json, readJson } from "../lib/http.js";
import { optionalText } from "../lib/validate.js";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export async function excludedTrainingDays(env) {
  const { results } = await env.DB.prepare("SELECT day FROM training_exclusions ORDER BY day DESC").all();
  return results.map((r) => r.day);
}

// PUT /api/trainings/:day { excluded, by? } – Tag ausblenden bzw. wieder als Training zählen (nur Trainer)
export async function setTrainingExcluded(request, env, day) {
  await requireRole(request, env, "tagger");
  if (!DAY.test(day) || Number.isNaN(Date.parse(`${day}T12:00:00Z`))) throw new HttpError(400, "Ungültiger Tag");
  const body = await readJson(request);
  if (body.excluded) {
    await env.DB.prepare("INSERT OR IGNORE INTO training_exclusions (day, excluded_by, created_at) VALUES (?, ?, ?)")
      .bind(day, optionalText(body.by, 50, "Name"), new Date().toISOString()).run();
  } else {
    await env.DB.prepare("DELETE FROM training_exclusions WHERE day = ?").bind(day).run();
  }
  return json({ excluded_training_days: await excludedTrainingDays(env) });
}
