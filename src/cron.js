// Aufgaben nach Zeitplan (Cloudflare Cron Triggers, siehe wrangler.toml [triggers]).
//
//   stündlich   abgebrochene Uploads aufräumen (länger als 24 h im Zustand „uploading“),
//               Umwandlung anstoßen/wiederholen (höchstens 3 Versuche)
//   täglich     Papierkorb: Videos, die länger als 30 Tage dort liegen, endgültig löschen;
//               Originale 7 Tage nach erfolgreicher Umwandlung löschen
//
// Alles ist wiederholbar: Läuft ein Job doppelt oder bricht ab, macht der nächste weiter.
import { dispatchProcessing, MAX_ATTEMPTS } from "./routes/processing.js";
import { TRASH_DAYS } from "./routes/videos.js";

export const CRON = {
  hourly: "17 * * * *",
  daily: "33 3 * * *",
};

const UPLOAD_TIMEOUT_H = 24;
const RETRY_AFTER_H = 1; // so lange darf ein angestoßener Job brauchen, bevor er als verloren gilt
export const KEEP_ORIGINAL_DAYS = 7;
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

/** Umwandlung anstoßen: nie gestartet, verloren gegangen oder nach Fehler erneut. */
export async function retryProcessing(env, now = Date.now()) {
  if (!env.GH_TOKEN) return 0; // Umwandlung noch nicht eingerichtet
  const { results } = await env.DB.prepare(
    `SELECT id, storage_key, processing_attempts FROM video
      WHERE file_state = 'ready' AND deleted_at IS NULL AND raw_deleted_at IS NULL
        AND processing = 'pending' AND (dispatched_at IS NULL OR dispatched_at < ?)
      ORDER BY created_at LIMIT 20`
  ).bind(hoursAgo(RETRY_AFTER_H, now)).all();
  for (const v of results) {
    if (v.processing_attempts >= MAX_ATTEMPTS) {
      await env.DB.prepare("UPDATE video SET processing = 'failed' WHERE id = ?").bind(v.id).run();
    } else {
      await dispatchProcessing(env, v);
    }
  }
  return results.length;
}

/** Originale 7 Tage nach der Umwandlung löschen – nur wenn die Abspielfassung wirklich da ist. */
export async function deleteOriginals(env, now = Date.now()) {
  const { results } = await env.DB.prepare(
    `SELECT id, storage_key, play_key FROM video
      WHERE processing = 'done' AND play_key IS NOT NULL AND raw_deleted_at IS NULL
        AND processed_at < ? LIMIT ?`
  ).bind(hoursAgo(KEEP_ORIGINAL_DAYS * 24, now), BATCH).all();
  let deleted = 0;
  for (const v of results) {
    if (!(await env.BUCKET.head(v.play_key))) continue; // Abspielfassung fehlt → Original behalten
    await env.BUCKET.delete(v.storage_key);
    await env.DB.prepare("UPDATE video SET raw_deleted_at = ? WHERE id = ?").bind(new Date(now).toISOString(), v.id).run();
    deleted++;
  }
  return deleted;
}

export async function runScheduled(cron, env, now = Date.now()) {
  const done = {};
  if (cron === CRON.hourly) {
    done.uploads = await cleanupUploads(env, now);
    done.processing = await retryProcessing(env, now);
  }
  if (cron === CRON.daily) {
    done.trash = await purgeTrash(env, now);
    done.originals = await deleteOriginals(env, now);
  }
  console.log("cron", cron, JSON.stringify(done));
  return done;
}
