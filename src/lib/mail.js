// E-Mails über Resend (https://resend.com), nur an MAIL_TO (Secret).
// Ohne RESEND_API_KEY oder MAIL_TO wird still nichts verschickt.

export function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

export function formatGB(bytes) {
  return `${(bytes / 1e9).toFixed(1).replace(".", ",")} GB`;
}

/** Schickt eine Mail; gibt true zurück, wenn Resend sie angenommen hat. Wirft nie. */
export async function sendMail(env, { subject, html, text }) {
  if (!env.RESEND_API_KEY || !env.MAIL_TO) return false;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: env.MAIL_FROM || "Formation <formation@nils-meier.de>",
        to: [env.MAIL_TO],
        subject,
        html,
        text,
      }),
    });
    if (!res.ok) console.error("resend", res.status, await res.text().catch(() => ""));
    return res.ok;
  } catch (err) {
    console.error("resend", err);
    return false;
  }
}
