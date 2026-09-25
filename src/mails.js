// Welche Mails die App schickt (Versand: lib/mail.js):
//   - bei jedem Upload ab NOTIFY_FILE_BYTES (1 GB) sofort
//   - montags eine Wochenübersicht (Cron), nur wenn es etwas zu berichten gibt
import { escapeHtml, formatGB, sendMail } from "./lib/mail.js";

const appUrl = (env) => env.APP_URL || "https://formation.nils-meier.de";

function layout(title, body) {
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.5;color:#15181e">
  <h2 style="margin:0 0 12px;font-size:18px">${escapeHtml(title)}</h2>${body}
  <p style="margin-top:20px;font-size:12px;color:#646b78">Formation-App · automatische Nachricht</p></div>`;
}

/** Sofortmail nach einem großen Upload. */
export async function notifyLargeUpload(env, video) {
  if (video.size_bytes < Number(env.NOTIFY_FILE_BYTES || 1e9)) return false;
  const who = video.uploaded_by || "Unbekannt";
  const link = `${appUrl(env)}/videos/${video.id}`;
  return sendMail(env, {
    subject: `Großer Upload: ${formatGB(video.size_bytes)} von ${who}`,
    text: `${who} hat ein Video mit ${formatGB(video.size_bytes)} hochgeladen.\n${link}`,
    html: layout("Großer Upload", `<p><strong>${escapeHtml(who)}</strong> hat ein Video mit
      <strong>${formatGB(video.size_bytes)}</strong> hochgeladen.</p>
      <p><a href="${link}">Video ansehen</a></p>`),
  });
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
    text: `${lines.join("\n")}\n\n${appUrl(env)}/zuordnen`,
    html: layout("Wochenübersicht", `<ul style="padding-left:18px">${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>
      <p><a href="${appUrl(env)}/zuordnen">Zum Zuordnen</a></p>`),
  });
}
