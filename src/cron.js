// Aufgaben nach Zeitplan (Cloudflare Cron Triggers, siehe wrangler.toml [triggers]).
//
//   stündlich   abgebrochene Uploads aufräumen (länger als 24 h im Zustand „uploading“)
//   täglich     Papierkorb: Videos, die länger als 30 Tage dort liegen, endgültig löschen
//
// Alles ist wiederholbar: Läuft ein Job doppelt oder bricht ab, macht der nächste weiter.
import { TRASH_DAYS } from "./routes/videos.js";

export const CRON = {
  hourly: "17 * * * *",
  daily: "33 3 * * *",
};

const UPLOAD_TIMEOUT_H = 24;
const BATCH = 100; // pro Lauf höchstens so viele – der Rest kommt beim nächsten Mal

const hoursAgo = (h, now) => new Date(now - h * 3600 * 1000).toISOString();

/** Abgebrochene Uploads: Datei (falls halb angekommen) und Datensatz entfernen. */
export async function cleanupUploads(env, now = Date.now()) {
  const { results } = await env.DB.prepare(
    `SELECT id, storage_key FROM video
      WHERE file_state = 'uploading' AND created_at < ? LIMIT ?`
  ).bind(hoursAgo(UPLOAD_TIMEOUT_H, now), BATCH).all();
  for (const v of results) {
    await env.BUCKET.delete(v.storage_key);
    await env.DB.prepare("DELETE FROM video WHERE id = ? AND file_state = 'uploading'").bind(v.id).run();
  }
  return results.length;
}

/** Papierkorb leeren: Dateien in R2 und Datensatz (Tänze/Tags hängen per CASCADE dran). */
export async function purgeTrash(env, now = Date.now()) {
  const { results } = await env.DB.prepare(
    `SELECT id, storage_key, play_key, thumb_key FROM video
      WHERE deleted_at IS NOT NULL AND deleted_at < ? LIMIT ?`
  ).bind(hoursAgo(TRASH_DAYS * 24, now), BATCH).all();
  for (const v of results) {
    await env.BUCKET.delete([v.storage_key, v.play_key, v.thumb_key].filter(Boolean));
    await env.DB.prepare("DELETE FROM video WHERE id = ? AND deleted_at IS NOT NULL").bind(v.id).run();
  }
  return results.length;
}

export async function runScheduled(cron, env, now = Date.now()) {
  const done = {};
  if (cron === CRON.hourly) done.uploads = await cleanupUploads(env, now);
  if (cron === CRON.daily) done.trash = await purgeTrash(env, now);
  console.log("cron", cron, JSON.stringify(done));
  return done;
}
