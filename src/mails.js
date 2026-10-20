// Welche Mails die App schickt (Versand: lib/mail.js):
//   - nach jedem Upload: eine Mail je Upload-Reihe (mehrere Videos auf einmal = eine Mail);
//     was nicht gemeldet wurde (App vorher geschlossen), holt der stündliche Cron nach
//   - montags eine Wochenübersicht (Cron), nur wenn es etwas zu berichten gibt
import { escapeHtml, formatGB, sendMail } from "./lib/mail.js";

const appUrl = (env) => env.APP_URL || "https://formation.nils-meier.de";

function layout(title, body) {
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.5;color:#15181e">
  <h2 style="margin:0 0 12px;font-size:18px">${escapeHtml(title)}</h2>${body}
  <p style="margin-top:20px;font-size:12px;color:#646b78">Formation-App · automatische Nachricht</p></div>`;
}

const BIG_BYTES = 1e9; // ab 1 GB in der Mail hervorgehoben

/** „25.09.2026, 12:31“ (Berliner Zeit) */
function berlinTime(iso) {
  if (!iso) return null;
  return new Intl.DateTimeFormat("de-DE", {
    timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(new Date(iso));
}
const sizeText = (bytes) => (bytes >= 1e8 ? formatGB(bytes) : `${Math.max(1, Math.round(bytes / 1e6))} MB`);

/** Inhalt der Upload-Mail (rein, testbar). */
export function uploadMail(env, videos, untagged) {
  const who = [...new Set(videos.map((v) => v.uploaded_by || "Unbekannt"))].join(", ");
  const total = videos.reduce((sum, v) => sum + (v.size_bytes || 0), 0);
  const n = videos.length;
  const subject = `${n === 1 ? "Neues Video" : `${n} neue Videos`} von ${who}` + (total >= BIG_BYTES ? ` (${formatGB(total)})` : "");
  const line = (v) => [
    berlinTime(v.recorded_at) ? `aufgenommen ${berlinTime(v.recorded_at)}` : "Aufnahmezeit unbekannt",
    sizeText(v.size_bytes || 0) + (v.size_bytes >= BIG_BYTES ? " – groß" : ""),
  ].join(" · ");
  const link = (v) => `${appUrl(env)}/videos/${v.id}`;
  const todo = `${appUrl(env)}/verwalten`;
  return {
    subject,
    text: `${who} hat ${n === 1 ? "ein Video" : `${n} Videos`} hochgeladen:\n` +
      videos.map((v) => `- ${line(v)}\n  ${link(v)}`).join("\n") +
      `\n\nNoch nicht zugeordnet: ${untagged}\nZum Zuordnen: ${todo}`,
    html: layout(subject, `<p><strong>${escapeHtml(who)}</strong> hat ${n === 1 ? "ein Video" : `${n} Videos`} hochgeladen:</p>
      <ul style="padding-left:18px">${videos.map((v) => `<li><a href="${link(v)}">${escapeHtml(line(v))}</a></li>`).join("")}</ul>
      <p>Noch nicht zugeordnet: <strong>${untagged}</strong></p>
      <p><a href="${todo}" style="display:inline-block;padding:8px 14px;border-radius:8px;background:#4f6bed;color:#fff;text-decoration:none">Jetzt zuordnen</a></p>`),
  };
}

/**
 * Fertige, noch nicht gemeldete Videos in EINER Mail melden und als gemeldet markieren.
 *   ids:  nur diese (Ende einer Upload-Reihe, POST /api/videos/notify)
 *   ohne: alle, die seit mindestens 15 Minuten da sind (stündlicher Cron – falls jemand
 *         die App vor dem Ende der Reihe geschlossen hat)
 * Klappt der Versand nicht, bleiben sie offen und der Cron versucht es wieder.
 * Gibt die Zahl der gemeldeten Videos zurück.
 */
export async function notifyNewUploads(env, { ids = null, now = Date.now() } = {}) {
  if (ids && !ids.length) return 0;
  const stamp = new Date(now).toISOString();
  const where = ids ? `id IN (${ids.map(() => "?").join(", ")})` : "created_at < ?";
  const params = ids || [new Date(now - 15 * 60 * 1000).toISOString()];
  const { results } = await env.DB.prepare(
    `UPDATE video SET notified_at = ?
      WHERE file_state = 'ready' AND deleted_at IS NULL AND notified_at IS NULL AND ${where}
      RETURNING id, uploaded_by, size_bytes, recorded_at`
  ).bind(stamp, ...params).all();
  if (!results.length) return 0;
  const videos = results.sort((a, b) => String(a.recorded_at).localeCompare(String(b.recorded_at)));
  const { n: untagged } = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM video WHERE file_state = 'ready' AND deleted_at IS NULL AND tag_state = 'untagged'"
  ).first();
  const ok = await sendMail(env, uploadMail(env, videos, untagged));
  if (!ok && env.RESEND_API_KEY && env.MAIL_TO) {
    // Versand fehlgeschlagen → wieder offen, der Cron versucht es noch einmal
    await env.DB.prepare(
      `UPDATE video SET notified_at = NULL WHERE notified_at = ? AND id IN (${videos.map(() => "?").join(", ")})`
    ).bind(stamp, ...videos.map((v) => v.id)).run();
    return 0;
  }
  return videos.length;
}

/** Zahlen für die Wochenübersicht (letzte 7 Tage + aktueller Stand). */
export async function weeklyStats(env, now = Date.now()) {
  const since = new Date(now - 7 * 24 * 3600 * 1000).toISOString();
  const [uploads, state] = await env.DB.batch([
    env.DB.prepare(
      `SELECT COALESCE(uploaded_by, 'Unbekannt') AS who, COUNT(*) AS n, SUM(size_bytes) AS bytes
         FROM video WHERE created_at >= ? AND file_state != 'uploading' GROUP BY who ORDER BY n DESC`
    ).bind(since),
    env.DB.prepare(
      `SELECT COUNT(CASE WHEN file_state = 'ready' AND tag_state = 'untagged' THEN 1 END) AS untagged,
              COUNT(CASE WHEN file_state = 'ready' AND processing = 'failed' THEN 1 END) AS failed,
              COUNT(CASE WHEN deleted_at IS NOT NULL THEN 1 END) AS trashed,
              COALESCE(SUM(CASE WHEN raw_deleted_at IS NULL THEN size_bytes ELSE 0 END + COALESCE(play_size_bytes, 0)), 0) AS used
         FROM video WHERE file_state != 'missing'`
    ),
  ]);
  const s = state.results[0];
  return {
    uploads: uploads.results,
    newCount: uploads.results.reduce((sum, u) => sum + u.n, 0),
    untagged: s.untagged,
    failed: s.failed,
    trashed: s.trashed,
    used: s.used,
    quota: Number(env.QUOTA_BYTES),
  };
}

/** Wochenübersicht – nur, wenn es etwas zu berichten gibt. */
export async function sendWeeklySummary(env, now = Date.now()) {
  const st = await weeklyStats(env, now);
  const share = st.quota ? st.used / st.quota : 0;
  if (!st.newCount && !st.untagged && !st.failed && share < 0.8) return false;

  const lines = [
    `Neu hochgeladen: ${st.newCount} ${st.newCount === 1 ? "Video" : "Videos"}` +
      (st.uploads.length ? ` (${st.uploads.map((u) => `${u.who}: ${u.n}`).join(", ")})` : ""),
    `Noch nicht zugeordnet: ${st.untagged}`,
    st.failed ? `Umwandlung fehlgeschlagen: ${st.failed}` : null,
    `Speicher: ${formatGB(st.used)} von ${formatGB(st.quota)} (${Math.round(share * 100)} %)` + (share >= 0.8 ? " – bald voll!" : ""),
    st.trashed ? `Im Papierkorb: ${st.trashed}` : null,
  ].filter(Boolean);

  return sendMail(env, {
    subject: `Formation: Woche mit ${st.newCount} neuen Videos` + (st.untagged ? `, ${st.untagged} zum Zuordnen` : ""),
    text: `${lines.join("\n")}\n\n${appUrl(env)}/verwalten`,
    html: layout("Wochenübersicht", `<ul style="padding-left:18px">${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>
      <p><a href="${appUrl(env)}/verwalten">Zum Zuordnen</a></p>`),
  });
}
