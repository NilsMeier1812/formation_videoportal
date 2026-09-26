// Umwandlung in die Abspielfassung – läuft auf GitHub Actions (.github/workflows/process-video.yml,
// Skript scripts/process-video.sh), weil Workers kein ffmpeg können.
//
//   1. /complete (oder der stündliche Cron) stößt per workflow_dispatch an
//   2. der Runner holt das Original aus R2, schreibt play/<id>.mp4 und thumb/<id>.jpg
//   3. er meldet sich bei POST /api/internal/processed (Bearer CALLBACK_SECRET)
//   4. Fehlschläge werden bis zu 3-mal wiederholt, danach „failed“ (Trainer: „Neu umwandeln“)
//
// Ohne GH_TOKEN passiert nichts – die Videos bleiben „pending“ und spielen das Original.
import { codeMatches, requireRole } from "../lib/auth.js";
import { HttpError, json, readJson } from "../lib/http.js";

export const MAX_ATTEMPTS = 3;
const WORKFLOW = "process-video.yml";

/** Stößt die Umwandlung eines Videos an. Gibt true zurück, wenn GitHub angenommen hat. */
export async function dispatchProcessing(env, video) {
  if (!env.GH_TOKEN || !env.GH_REPO) return false;
  await env.DB.prepare(
    `UPDATE video SET processing = 'pending', processing_attempts = processing_attempts + 1, dispatched_at = ?
      WHERE id = ?`
  ).bind(new Date().toISOString(), video.id).run();
  try {
    const res = await fetch(`https://api.github.com/repos/${env.GH_REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.GH_TOKEN}`,
        accept: "application/vnd.github+json",
        "user-agent": "formation-portal", // ohne lehnt GitHub ab
        "content-type": "application/json",
      },
      body: JSON.stringify({ ref: env.GH_REF || "main", inputs: { video_id: video.id, storage_key: video.storage_key } }),
    });
    if (res.status !== 204) console.error("workflow_dispatch", res.status, await res.text().catch(() => ""));
    return res.status === 204;
  } catch (err) {
    console.error("workflow_dispatch", err);
    return false; // der stündliche Cron versucht es erneut
  }
}

// POST /api/internal/processed – Rückmeldung des Runners (nicht Teil der App-API)
export async function processedCallback(request, env) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!env.CALLBACK_SECRET || !(await codeMatches(token, env.CALLBACK_SECRET))) {
    throw new HttpError(401, "Nicht erlaubt");
  }
  const body = await readJson(request);
  const id = String(body.id || "");
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new HttpError(400, "Ungültige ID");
  const row = await env.DB.prepare("SELECT id, processing_attempts FROM video WHERE id = ?").bind(id).first();
  if (!row) throw new HttpError(404, "Video nicht gefunden");

  // Die Keys leitet der Worker selbst ab – nichts aus der Anfrage wird als Pfad übernommen.
  const play = body.status === "done" ? await env.BUCKET.head(`play/${id}.mp4`) : null;
  if (play) {
    const thumb = await env.BUCKET.head(`thumb/${id}.jpg`);
    const duration = Number(body.duration);
    await env.DB.prepare(
      `UPDATE video SET play_key = ?, play_size_bytes = ?, processing = 'done', processed_at = ?,
              duration_s = COALESCE(?, duration_s),
              thumb_key = COALESCE(thumb_key, ?)
        WHERE id = ?`
    ).bind(`play/${id}.mp4`, play.size, new Date().toISOString(),
      Number.isFinite(duration) && duration > 0 ? duration : null,
      thumb ? `thumb/${id}.jpg` : null, id).run();
    return json({ ok: true });
  }

  // Fehlgeschlagen (oder Datei fehlt): nochmal versuchen, bis die Versuche aufgebraucht sind
  const failed = row.processing_attempts >= MAX_ATTEMPTS;
  await env.DB.prepare("UPDATE video SET processing = ?, dispatched_at = NULL WHERE id = ?")
    .bind(failed ? "failed" : "pending", id).run();
  return json({ ok: true, retry: !failed });
}

// POST /api/videos/:id/reprocess – Trainer: Umwandlung neu starten (Zähler zurück auf 0)
export async function reprocessVideo(request, env, id) {
  await requireRole(request, env, "tagger");
  const row = await env.DB.prepare(
    "SELECT id, storage_key, raw_deleted_at FROM video WHERE id = ? AND file_state = 'ready'"
  ).bind(id).first();
  if (!row) throw new HttpError(404, "Video nicht gefunden");
  if (row.raw_deleted_at) throw new HttpError(409, "Das Original ist schon gelöscht");
  await env.DB.prepare("UPDATE video SET processing = 'pending', processing_attempts = 0 WHERE id = ?").bind(id).run();
  const started = await dispatchProcessing(env, row);
  return json({ started });
}
